import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { isAddress, size, zeroHash, type Address, type Hex } from 'viem'
import { INITIAL_CURVE, marketCap, progressBps, quoteBuy as openingQuote, spotPrice } from '../../src/lib/curve.js'
import { gateIndex, llmsTxt, openApi } from './describe.js'
import { GateError } from './errors.js'
import { money, parseAmount, TOKEN_DECIMALS, USDC_DECIMALS, type Money } from './money.js'
import type { Authorization, ChainPort, Curve, RecoveryRequest, Signed } from './port.js'

/**
 * The x402 gate: every paid endpoint answers 402 with its terms, and acts only when the request
 * comes back carrying a signed authorization for exactly those terms.
 *
 * The ordinary path keeps payment and action atomic. A stock authorization may instead be
 * submitted directly to USDC; that prior deposit requires an explicit trusted recovery/refund.
 * The gate proves the exact direct settlement off chain. Contracts enforce signature/replay and
 * accounting rules, but trust an allowlisted relayer's settlement attestation.
 */

const X402_VERSION = 2
const MAX_TIMEOUT_SECONDS = 120
const MAX_BODY_BYTES = 16_384
const BPS = 10_000n
const DEFAULT_SLIPPAGE_BPS = 100n
const USDC_DOMAIN = { name: 'USDC', version: '2' } as const
const LAUNCH_TOKEN_DOMAIN_VERSION = '1'

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, payment-signature',
  'access-control-expose-headers': 'payment-required, payment-response, retry-after',
  'access-control-max-age': '86400',
}

type Body = Record<string, unknown>
type Priced = Money & { label: string }

interface Terms {
  requirements: PaymentRequirements
  description: string
  price: { asset: string; total: Money; breakdown: Priced[] }
  /** Extra facts worth showing next to the price, for example what a sale is expected to pay out. */
  notes?: Record<string, unknown>
}

interface Outcome {
  transaction: Hex
  result: Record<string, unknown>
}

interface Prepared {
  action: 'launch' | 'buy' | 'sell' | 'post'
  terms: Terms
  salt: Hex | undefined
  request: Body
  commitment(salt: Hex): Promise<Hex>
  run(signed: Signed): Promise<Outcome>
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...headers },
  })
}

function refusal(error: GateError, explorer?: string): Response {
  return json(error.status, { ok: false, error: error.code, message: error.message, ...error.details, ...(error.details.transaction && explorer ? { explorer: `${explorer}/tx/${error.details.transaction}` } : {}) }, error.details.retryAfter === undefined ? {} : { 'retry-after': String(error.details.retryAfter) })
}

/** The public origin the request arrived on, so terms name the URL the caller actually used. */
function originOf(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '')
  return `${proto}://${host}`
}

/** `/x402/...` however the request got here: directly, under `/api`, or through the rewrite's `path` parameter. */
export function routeOf(request: Request): string {
  const url = new URL(request.url)
  const rewritten = url.searchParams.get('path')
  const path = rewritten === null ? url.pathname.replace(/^\/api(?=\/)/, '') : `/x402/${rewritten}`
  return path.replace(/\/+$/, '') || '/'
}

async function readBody(request: Request): Promise<Body> {
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {})
          throw new GateError(413, 'body_too_large', `The request body is limited to ${MAX_BODY_BYTES} bytes.`)
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new GateError(400, 'invalid_json', 'The request body must be valid UTF-8 JSON.') }
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GateError(400, 'invalid_json', 'The request body must be JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GateError(400, 'invalid_json', 'The request body must be a JSON object.')
  }
  return parsed as Body
}

const utf8 = new TextEncoder()

function textField(body: Body, field: string, maxBytes: number, options: { optional?: boolean } = {}): string {
  const value = body[field]
  if (value === undefined || value === null) {
    if (options.optional) return ''
    throw new GateError(400, 'missing_field', `${field} is required.`)
  }
  if (typeof value !== 'string') throw new GateError(400, 'invalid_field', `${field} must be a string.`)
  const bytes = utf8.encode(value).length
  if (bytes === 0 && !options.optional) throw new GateError(400, 'invalid_field', `${field} cannot be empty.`)
  if (bytes > maxBytes) throw new GateError(400, 'invalid_field', `${field} is ${bytes} bytes; the limit is ${maxBytes}.`)
  return value
}

function addressOf(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value)) throw new GateError(400, 'invalid_address', `${field} must be a token address.`)
  return value
}

function slippageOf(body: Body): bigint {
  const value = body.slippageBps
  if (value === undefined) return DEFAULT_SLIPPAGE_BPS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5000) {
    throw new GateError(400, 'invalid_field', 'slippageBps must be a whole number from 0 to 5000.')
  }
  return BigInt(value)
}

function saltOf(body: Body): Hex | undefined {
  const value = body.salt
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new GateError(400, 'invalid_field', 'salt must be 32 bytes of hex.')
  }
  return value as Hex
}

function settlementOf(body: Body): Hex | undefined {
  if (body.settlementTransaction === undefined) return undefined
  const value = body.settlementTransaction
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || value === zeroHash) throw new GateError(400, 'invalid_field', 'settlementTransaction must be a nonzero transaction hash.')
  return value as Hex
}

function withSlippage(amount: bigint, slippageBps: bigint): bigint {
  return (amount * (BPS - slippageBps)) / BPS
}

/**
 * The least the caller will accept. Left out, the gate derives it from the contract's own quote.
 * A bound request must state it, because the signature commits to the exact figure.
 */
function minimumOf(body: Body, field: string, decimals: number, salt: Hex | undefined, derive: () => bigint): bigint {
  if (body[field] !== undefined) return parseAmount(body[field], decimals, field, { allowZero: true })
  if (salt) throw new GateError(400, 'bound_needs_minimum', `With a salt, ${field} must be given: the signature commits to it.`)
  return derive()
}

function usdcTerms(port: ChainPort, payTo: Address, description: string, breakdown: Priced[]): Terms {
  const total = breakdown.reduce((sum, line) => sum + BigInt(line.raw), 0n)
  return {
    description,
    requirements: {
      scheme: 'exact',
      network: `eip155:${port.chainId}`,
      asset: port.usdc,
      amount: total.toString(),
      payTo,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { ...USDC_DOMAIN },
    },
    price: { asset: 'USDC', total: money(total, USDC_DECIMALS), breakdown },
  }
}

function line(label: string, raw: bigint, decimals = USDC_DECIMALS): Priced {
  return { label, ...money(raw, decimals) }
}

async function liveCurve(port: ChainPort, token: Address): Promise<Curve> {
  const curve = await port.curve(token)
  if (!curve) throw new GateError(404, 'unknown_token', 'No launch here has that token address.')
  if (curve.graduated) throw new GateError(400, 'curve_graduated', 'This curve has graduated. The token trades on its pool now.')
  return curve
}

async function prepareLaunch(port: ChainPort, body: Body): Promise<Prepared> {
  const name = textField(body, 'name', 32)
  const symbol = textField(body, 'symbol', 10)
  const metadataURI = textField(body, 'metadataURI', 256, { optional: true })
  const initialBuyUsdc = body.initialBuyUsdc === undefined ? 0n : parseAmount(body.initialBuyUsdc, USDC_DECIMALS, 'initialBuyUsdc', { allowZero: true })
  const salt = saltOf(body)
  const slippage = slippageOf(body)
  const minTokensOut = minimumOf(body, 'minTokensOut', TOKEN_DECIMALS, salt, () => {
    if (initialBuyUsdc === 0n) return 0n
    try {
      // A new launch has no token to quote yet; every curve opens from the same fixed state.
      return withSlippage(openingQuote(INITIAL_CURVE, initialBuyUsdc).tokensOut, slippage)
    } catch {
      throw new GateError(400, 'invalid_amount', 'initialBuyUsdc is too small to buy any tokens.')
    }
  })
  const params = { name, symbol, metadataURI, initialBuyUsdc, minTokensOut }
  const fees = await port.fees({ fresh: true })
  const breakdown = [line('Launch fee', fees.launchFee), line('Relay fee', fees.launchRelayFee)]
  if (initialBuyUsdc > 0n) breakdown.push(line('Your first buy', initialBuyUsdc))
  return {
    action: 'launch',
    terms: usdcTerms(port, port.launchpad, 'Launch a token on Architex Agents', breakdown),
    salt,
    request: { name, symbol, metadataURI, initialBuyUsdc: money(initialBuyUsdc, USDC_DECIMALS).formatted, minTokensOut: money(minTokensOut, TOKEN_DECIMALS).formatted, ...(salt ? { salt } : {}) },
    commitment: (given) => port.launchNonce(params, given),
    async run(signed) {
      const done = await port.launch(params, signed)
      return { transaction: done.transaction, result: { token: done.token, tokensOut: money(done.tokensOut, TOKEN_DECIMALS) } }
    },
  }
}

async function prepareBuy(port: ChainPort, body: Body): Promise<Prepared> {
  const token = addressOf(body.token, 'token')
  const usdcIn = parseAmount(body.usdc, USDC_DECIMALS, 'usdc')
  const salt = saltOf(body)
  const slippage = slippageOf(body)
  await liveCurve(port, token)
  const [fees, quote] = await Promise.all([port.fees({ fresh: true }), port.quoteBuy(token, usdcIn)])
  const minTokensOut = minimumOf(body, 'minTokensOut', TOKEN_DECIMALS, salt, () => withSlippage(quote.tokensOut, slippage))
  const terms = usdcTerms(port, port.launchpad, 'Buy on a bonding curve on Architex Agents', [line('You spend', usdcIn), line('Relay fee', fees.tradeRelayFee)])
  terms.notes = { expectedTokensOut: money(quote.tokensOut, TOKEN_DECIMALS), minTokensOut: money(minTokensOut, TOKEN_DECIMALS), curveFee: money(quote.fee, USDC_DECIMALS) }
  return {
    action: 'buy',
    terms,
    salt,
    request: { token, usdc: money(usdcIn, USDC_DECIMALS).formatted, minTokensOut: money(minTokensOut, TOKEN_DECIMALS).formatted, ...(salt ? { salt } : {}) },
    commitment: (given) => port.buyNonce(token, minTokensOut, given),
    async run(signed) {
      const done = await port.buy(token, minTokensOut, signed)
      return {
        transaction: done.transaction,
        result: {
          token,
          tokensOut: money(done.tokensOut, TOKEN_DECIMALS),
          usdcSpent: money(done.usdcSpent, USDC_DECIMALS),
          // Only the buy that sells out the curve spends less than it was given.
          refunded: money(usdcIn - done.usdcSpent, USDC_DECIMALS),
        },
      }
    },
  }
}

async function prepareSell(port: ChainPort, body: Body): Promise<Prepared> {
  const token = addressOf(body.token, 'token')
  const tokensIn = parseAmount(body.tokens, TOKEN_DECIMALS, 'tokens')
  const salt = saltOf(body)
  const slippage = slippageOf(body)
  await liveCurve(port, token)
  const [fees, quote, named] = await Promise.all([port.fees({ fresh: true }), port.quoteSell(token, tokensIn), port.tokenName(token)])
  if (quote.usdcOut <= fees.tradeRelayFee) {
    throw new GateError(400, 'too_small', 'This sale would pay out less than the relay fee. Sell more, or submit it yourself.')
  }
  const expected = quote.usdcOut - fees.tradeRelayFee
  const minUsdcOut = minimumOf(body, 'minUsdcOut', USDC_DECIMALS, salt, () => withSlippage(expected, slippage))
  return {
    action: 'sell',
    terms: {
      description: `Sell ${named.symbol} back to its curve on Architex Agents`,
      // A sale is paid in the token itself: the same signature, on a different asset.
      requirements: {
        scheme: 'exact',
        network: `eip155:${port.chainId}`,
        asset: token,
        amount: tokensIn.toString(),
        payTo: port.launchpad,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { name: named.name, version: LAUNCH_TOKEN_DOMAIN_VERSION },
      },
      price: { asset: named.symbol, total: money(tokensIn, TOKEN_DECIMALS), breakdown: [line('Tokens you sell', tokensIn, TOKEN_DECIMALS)] },
      notes: {
        expectedUsdcOut: money(expected, USDC_DECIMALS),
        minUsdcOut: money(minUsdcOut, USDC_DECIMALS),
        relayFee: money(fees.tradeRelayFee, USDC_DECIMALS),
        curveFee: money(quote.fee, USDC_DECIMALS),
      },
    },
    salt,
    request: { token, tokens: money(tokensIn, TOKEN_DECIMALS).formatted, minUsdcOut: money(minUsdcOut, USDC_DECIMALS).formatted, ...(salt ? { salt } : {}) },
    commitment: (given) => port.sellNonce(token, minUsdcOut, given),
    async run(signed) {
      const done = await port.sell(token, minUsdcOut, signed)
      return { transaction: done.transaction, result: { token, tokensIn: money(tokensIn, TOKEN_DECIMALS), usdcOut: money(done.usdcOut, USDC_DECIMALS) } }
    },
  }
}

async function preparePost(port: ChainPort, body: Body): Promise<Prepared> {
  const text = textField(body, 'text', 280)
  const salt = saltOf(body)
  const fees = await port.fees({ fresh: true })
  return {
    action: 'post',
    terms: usdcTerms(port, port.bbs, 'Post to the board on Architex Agents', [line('Post fee', fees.postFee), line('Relay fee', fees.postRelayFee)]),
    salt,
    request: { text, ...(salt ? { salt } : {}) },
    commitment: (given) => port.postNonce(text, given),
    async run(signed) {
      const done = await port.post(text, signed)
      return { transaction: done.transaction, result: { id: done.id.toString() } }
    },
  }
}

const PAID: Record<string, (port: ChainPort, body: Body) => Promise<Prepared>> = {
  '/x402/launch': prepareLaunch,
  '/x402/buy': prepareBuy,
  '/x402/sell': prepareSell,
  '/x402/post': preparePost,
}

function recoveryIntent(path: string, body: Body): RecoveryRequest {
  const salt = saltOf(body)
  slippageOf(body)
  const minimum = (field: string, decimals: number) => {
    if (body[field] !== undefined) return parseAmount(body[field], decimals, field, { allowZero: true })
    if (salt) throw new GateError(400, 'bound_needs_minimum', `With a salt, ${field} must be given: the signature commits to it.`)
    return undefined
  }
  if (path === '/x402/launch') return { action: 'launch', name: textField(body, 'name', 32), symbol: textField(body, 'symbol', 10), metadataURI: textField(body, 'metadataURI', 256, { optional: true }), initialBuyUsdc: body.initialBuyUsdc === undefined ? 0n : parseAmount(body.initialBuyUsdc, USDC_DECIMALS, 'initialBuyUsdc', { allowZero: true }), minTokensOut: minimum('minTokensOut', TOKEN_DECIMALS) }
  if (path === '/x402/buy') return { action: 'buy', token: addressOf(body.token, 'token'), usdcIn: parseAmount(body.usdc, USDC_DECIMALS, 'usdc'), minTokensOut: minimum('minTokensOut', TOKEN_DECIMALS) }
  if (path === '/x402/sell') return { action: 'sell', token: addressOf(body.token, 'token'), tokensIn: parseAmount(body.tokens, TOKEN_DECIMALS, 'tokens'), minUsdcOut: minimum('minUsdcOut', USDC_DECIMALS) }
  return { action: 'post', text: textField(body, 'text', 280) }
}

async function recoveryRequirements(port: ChainPort, intent: RecoveryRequest): Promise<PaymentRequirements> {
  if (intent.action === 'sell') {
    const named = await port.tokenName(intent.token)
    return { scheme: 'exact', network: `eip155:${port.chainId}`, asset: intent.token, amount: intent.tokensIn.toString(), payTo: port.launchpad, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { name: named.name, version: LAUNCH_TOKEN_DOMAIN_VERSION } }
  }
  return usdcTerms(port, intent.action === 'post' ? port.bbs : port.launchpad, 'Recover the original executed action', []).requirements
}

function success(port: ChainPort, action: string, payment: { auth: Authorization }, outcome: Outcome, bound: boolean): Response {
  return json(200, { ok: true, action, payer: payment.auth.from, bound, transaction: outcome.transaction, explorer: `${port.explorer}/tx/${outcome.transaction}`, result: outcome.result }, {
    'payment-response': encodePaymentResponseHeader({ success: true, transaction: outcome.transaction, network: `eip155:${port.chainId}`, payer: payment.auth.from }),
  })
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function wholeNumber(value: unknown, field: string): bigint {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d{1,78}$/.test(String(value))) {
    throw new GateError(402, 'invalid_payload', `authorization.${field} must be a whole number.`)
  }
  const parsed = BigInt(value)
  if (parsed > (1n << 256n) - 1n) throw new GateError(402, 'invalid_payload', `authorization.${field} exceeds uint256.`)
  return parsed
}

/** Reads a PAYMENT-SIGNATURE header and holds it to the terms this request was actually quoted. */
function readPayment(header: string, want: PaymentRequirements, nowSeconds: bigint, options: { refund?: boolean; retry?: boolean } = {}): { auth: Authorization; signature: Hex } {
  if (header.length > 16_384) throw new GateError(402, 'invalid_payload', 'PAYMENT-SIGNATURE is too large.')
  let payload: PaymentPayload
  try {
    payload = decodePaymentSignatureHeader(header)
  } catch {
    throw new GateError(402, 'invalid_payload', 'PAYMENT-SIGNATURE could not be decoded.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new GateError(402, 'invalid_payload', 'PAYMENT-SIGNATURE must encode an object.')
  if (payload.x402Version !== X402_VERSION) throw new GateError(402, 'invalid_x402_version', 'This gate speaks x402 version 2.')
  const accepted = payload.accepted
  if (!accepted || accepted.scheme !== 'exact') throw new GateError(402, 'unsupported_scheme', 'This gate accepts the exact scheme only.')
  if (accepted.network !== want.network) throw new GateError(402, 'invalid_network', `Payment must be on ${want.network}.`)
  if (!same(String(accepted.asset), want.asset)) throw new GateError(402, 'invalid_asset', `Payment must be in the asset ${want.asset}.`)
  if (!same(String(accepted.payTo), want.payTo)) throw new GateError(402, 'invalid_pay_to', `Payment must be made to ${want.payTo}.`)
  if (accepted.extra?.name !== want.extra?.name || accepted.extra?.version !== want.extra?.version || (accepted.extra?.assetTransferMethod ?? 'eip3009') !== 'eip3009') throw new GateError(402, 'invalid_domain', 'Payment must use the advertised EIP-3009 asset domain.')

  const inner = payload.payload as { signature?: unknown; authorization?: Record<string, unknown> }
  const signature = inner?.signature
  const given = inner?.authorization
  if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature) || size(signature as Hex) > 4096) {
    throw new GateError(402, 'invalid_payload', 'payload.signature must be a hex signature.')
  }
  if (!given || typeof given !== 'object') throw new GateError(402, 'invalid_payload', 'payload.authorization is missing.')
  if (typeof given.from !== 'string' || !isAddress(given.from)) throw new GateError(402, 'invalid_payload', 'authorization.from must be an address.')
  if (typeof given.to !== 'string' || !same(given.to, want.payTo)) {
    throw new GateError(402, 'invalid_pay_to', `The authorization must pay ${want.payTo}.`)
  }
  if (typeof given.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(given.nonce)) {
    throw new GateError(402, 'invalid_payload', 'authorization.nonce must be 32 bytes of hex.')
  }
  const auth: Authorization = {
    from: given.from,
    value: wholeNumber(given.value, 'value'),
    validAfter: wholeNumber(given.validAfter, 'validAfter'),
    validBefore: wholeNumber(given.validBefore, 'validBefore'),
    nonce: given.nonce as Hex,
  }
  if (String(accepted.amount) !== auth.value.toString()) throw new GateError(402, 'invalid_amount', 'The accepted terms and signed authorization amounts disagree.')
  if (!options.refund && auth.value !== BigInt(want.amount)) {
    throw new GateError(402, 'invalid_amount', `This request costs ${want.amount} atomic units; the authorization is for ${auth.value}.`)
  }
  if (!options.refund && auth.validAfter > nowSeconds) throw new GateError(402, 'authorization_not_yet_valid', 'The authorization is not valid yet.')
  // A few seconds of headroom: it has to still be valid when the transaction lands.
  if (!options.refund && !options.retry && auth.validBefore <= nowSeconds + 3n) throw new GateError(402, 'authorization_expired', 'The authorization has expired, or is about to. A proven external payment can be refunded with the original signature.')
  if (!options.refund && auth.validBefore > nowSeconds + BigInt(MAX_TIMEOUT_SECONDS + 10)) throw new GateError(402, 'invalid_payload', 'The authorization exceeds the advertised validity window.')
  return { auth, signature: signature as Hex }
}

function paymentRequired(origin: string, path: string, terms: Terms, error: string, code?: string): Response {
  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource: { url: `${origin}${path}`, description: terms.description, mimeType: 'application/json' },
    accepts: [terms.requirements],
    extensions: {},
  }
  return json(
    402,
    { ...required, ...(code ? { code } : {}), price: terms.price, ...(terms.notes ? { notes: terms.notes } : {}) },
    { 'payment-required': encodePaymentRequiredHeader(required) },
  )
}

async function paid(port: ChainPort, request: Request, path: string, nowSeconds: bigint, forwardPaid?: Gate): Promise<Response> {
  if (request.method !== 'POST') throw new GateError(405, 'method_not_allowed', `${path} takes POST.`)
  const body = await readBody(request)
  const settlementTransaction = settlementOf(body)
  if (path === '/x402/sell' && settlementTransaction) throw new GateError(400, 'unsupported_settlement', 'Sales do not accept external USDC settlement.')
  const origin = originOf(request)
  const header = request.headers.get('payment-signature')
  if (header && forwardPaid) {
    const intent = recoveryIntent(path, body)
    const original = readPayment(header, await recoveryRequirements(port, intent), nowSeconds, { refund: true })
    if (original.auth.nonce.toLowerCase().startsWith('0x4152435458424e44') && !saltOf(body)) throw new GateError(400, 'bound_needs_salt', 'A marked bound authorization requires its original salt and committed parameters.')
    // The dedicated process owns pending state; do not requote a signed retry in serverless.
    return forwardPaid(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }))
  }
  let alreadyUsed = false
  let originalRequest: { intent: RecoveryRequest; signed: Signed; asset: Address } | undefined
  const unresolved = () => new GateError(409, 'authorization_unresolved', 'This authorization was used or cancelled without a matching action receipt. Do not sign another payment. Verify its original transaction; only a proved external deposit can be recovered or refunded.', { retryable: false })
  function refuseKnownPending(): void {
    if (!originalRequest) return
    const pending = port.pendingTransaction()
    if (pending) throw new GateError(502, 'unconfirmed', 'Another request submitted a transaction while this retry was being checked. Inspect its hash; do not sign another payment.', { transaction: pending, status: 'pending', retryable: false })
  }
  async function recheckFailure(error: unknown): Promise<Response | undefined> {
    if (!originalRequest || !(error instanceof GateError) || ![400, 402, 404].includes(error.status)) return undefined
    const { intent, signed, asset } = originalRequest
    const recovered = await port.recover(intent, signed)
    if (recovered) return success(port, intent.action, signed, recovered, recovered.bound)
    alreadyUsed = alreadyUsed || await port.authorizationUsed(asset, signed.auth)
    refuseKnownPending()
    if (alreadyUsed) throw unresolved()
    return undefined
  }
  if (header) {
    const intent = recoveryIntent(path, body)
    const salt = saltOf(body)
    try {
      const requirements = await recoveryRequirements(port, intent)
      const original = readPayment(header, requirements, nowSeconds, { refund: true })
      if (original.auth.nonce.toLowerCase().startsWith('0x4152435458424e44') && !salt) throw new GateError(400, 'bound_needs_salt', 'A marked bound authorization requires its original salt and committed parameters.')
      const signed = { ...original, salt: salt ?? zeroHash, settlementTransaction }
      originalRequest = { intent, signed, asset: addressOf(requirements.asset, 'asset') }
      const recovered = await port.recover(intent, signed)
      if (recovered) return success(port, intent.action, original, recovered, recovered.bound)
      alreadyUsed = await port.authorizationUsed(addressOf(requirements.asset, 'asset'), original.auth)
    } catch (error) {
      // Malformed payments still get a fresh 402 challenge only after normal request validation.
      if (!(error instanceof GateError) || error.status !== 402) throw error
    }
  }
  let prepared: Prepared
  try { prepared = await PAID[path](port, body) } catch (error) {
    const recovered = await recheckFailure(error)
    if (recovered) return recovered
    refuseKnownPending()
    throw error
  }
  if (!header) return paymentRequired(origin, path, prepared.terms, 'PAYMENT-SIGNATURE header is required')

  let payment: { auth: Authorization; signature: Hex }
  let bound = false
  try {
    // The port checks for a completed transaction before simulating; an expired retry can still recover its receipt.
    payment = readPayment(header, prepared.terms.requirements, nowSeconds, { retry: true })
    if (payment.auth.nonce.toLowerCase().startsWith('0x4152435458424e44') && !prepared.salt) throw new GateError(400, 'bound_needs_salt', 'A marked bound authorization requires its original salt and committed parameters.')
    if (prepared.salt) {
      // The caller said these exact parameters are what it signed. Hold it to that, rather than
      // quietly relaying a payment whose signature commits to something else.
      if (!same(await prepared.commitment(prepared.salt), payment.auth.nonce)) {
        throw new GateError(400, 'bound_mismatch', 'A salt was given, but the authorization nonce is not the commitment for these parameters.')
      }
      bound = true
    }
    if (!port.canRelay) throw new GateError(503, 'relayer_not_configured', 'This gate can quote but has no relayer to act with right now.')
    const outcome = await prepared.run({ ...payment, salt: prepared.salt ?? zeroHash, settlementTransaction })
    return success(port, prepared.action, payment, outcome, bound)
  } catch (error) {
    const recovered = await recheckFailure(error)
    if (recovered) return recovered
    // Keep this synchronous and adjacent to refusal/challenge creation: await itself yields.
    refuseKnownPending()
    // A payment problem is answered the x402 way: the terms again, with the reason.
    if (error instanceof GateError && error.status === 402) return paymentRequired(origin, path, prepared.terms, error.message, error.code)
    throw error
  }
}

function describeCurve(port: ChainPort, curve: Curve) {
  const state = { virtualUsdc: curve.virtualUsdc, virtualTokens: curve.virtualTokens, tokensSold: curve.tokensSold }
  return {
    token: curve.token,
    creator: curve.creator,
    pair: curve.pair,
    graduated: curve.graduated,
    createdAt: new Date(Number(curve.createdAt) * 1000).toISOString(),
    metadataURI: curve.metadataURI || null,
    tokensSold: money(curve.tokensSold, TOKEN_DECIMALS),
    // spotPrice() is USDC (6 decimals) per whole token, scaled by 1e18: 24 decimals in all.
    spotPrice: curve.graduated ? null : money(spotPrice(state), 24),
    marketCap: curve.graduated ? null : money(marketCap(state), USDC_DECIMALS),
    progressPercent: curve.graduated ? 100 : Number(progressBps(state)) / 100,
    explorer: `${port.explorer}/address/${curve.token}`,
  }
}

function countOf(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  if (!/^\d{1,6}$/.test(raw)) throw new GateError(400, 'invalid_field', `${name} must be a whole number.`)
  return Math.min(Number(raw), max)
}

async function free(port: ChainPort, request: Request, path: string): Promise<Response | undefined> {
  const url = new URL(request.url)
  const origin = originOf(request)

  if (path === '/x402') return json(200, gateIndex(port, await port.fees(), await port.readiness()))
  if (path.startsWith('/x402/transaction/')) {
    const hash = path.slice('/x402/transaction/'.length)
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new GateError(400, 'invalid_field', 'transaction must be a 32-byte hash.')
    return json(200, { ...(await port.transaction(hash as Hex)), explorer: `${port.explorer}/tx/${hash}` })
  }
  if (path === '/llms.txt' || path === '/x402/llms.txt') {
    return new Response(llmsTxt(gateIndex(port, await port.fees()), origin), {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60', ...CORS },
    })
  }
  if (path === '/openapi.json' || path === '/x402/openapi.json') {
    return json(200, openApi(gateIndex(port, await port.fees()), origin), { 'cache-control': 'public, max-age=60' })
  }

  if (path === '/x402/launches') {
    const count = countOf(url, 'count', 20, 50)
    const skip = countOf(url, 'start', 0, 100_000)
    // The contract lists oldest first; this reads the same pages from the other end.
    const { total } = await port.curves(0, 0)
    const end = Math.max(total - skip, 0)
    const begin = Math.max(end - count, 0)
    const page = end > begin ? (await port.curves(begin, end - begin)).curves : []
    return json(200, { total, start: skip, count: page.length, launches: page.reverse().map((curve) => describeCurve(port, curve)) })
  }

  if (path.startsWith('/x402/launch/')) {
    const curve = await port.curve(addressOf(path.slice('/x402/launch/'.length), 'token'))
    if (!curve) throw new GateError(404, 'unknown_token', 'No launch here has that token address.')
    return json(200, describeCurve(port, curve))
  }

  if (path === '/x402/quote/buy') {
    const token = addressOf(url.searchParams.get('token'), 'token')
    const usdcIn = parseAmount(url.searchParams.get('usdc'), USDC_DECIMALS, 'usdc')
    await liveCurve(port, token)
    const [fees, quote] = await Promise.all([port.fees(), port.quoteBuy(token, usdcIn)])
    return json(200, {
      token,
      tokensOut: money(quote.tokensOut, TOKEN_DECIMALS),
      curveFee: money(quote.fee, USDC_DECIMALS),
      usdcSpent: money(quote.usdcSpent, USDC_DECIMALS),
      graduates: quote.graduates,
      relayFee: money(fees.tradeRelayFee, USDC_DECIMALS),
      charged: money(usdcIn + fees.tradeRelayFee, USDC_DECIMALS),
    })
  }

  if (path === '/x402/quote/sell') {
    const token = addressOf(url.searchParams.get('token'), 'token')
    const tokensIn = parseAmount(url.searchParams.get('tokens'), TOKEN_DECIMALS, 'tokens')
    await liveCurve(port, token)
    const [fees, quote] = await Promise.all([port.fees(), port.quoteSell(token, tokensIn)])
    const received = quote.usdcOut > fees.tradeRelayFee ? quote.usdcOut - fees.tradeRelayFee : 0n
    return json(200, {
      token,
      tokensIn: money(tokensIn, TOKEN_DECIMALS),
      curveFee: money(quote.fee, USDC_DECIMALS),
      relayFee: money(fees.tradeRelayFee, USDC_DECIMALS),
      usdcOut: money(received, USDC_DECIMALS),
    })
  }

  if (path === '/x402/bbs') {
    const board = await port.messages(countOf(url, 'count', 20, 100))
    const remaining = board.snapshot ? Math.max(0, Math.floor((board.snapshot.ttlMs - board.snapshot.ageMs) / 1000)) : 0
    return json(200, {
      total: board.total,
      count: board.messages.length,
      completeHistory: board.complete,
      ...(board.snapshot ? { snapshot: {
        blockNumber: board.snapshot.blockNumber.toString(),
        fetchedAt: new Date(board.snapshot.fetchedAt).toISOString(),
        ageSeconds: Math.floor(board.snapshot.ageMs / 1000),
        ttlSeconds: board.snapshot.ttlMs / 1000,
      } } : {}),
      messages: board.messages.map((message) => ({
        id: message.id.toString(),
        from: message.from,
        time: new Date(Number(message.time) * 1000).toISOString(),
        text: message.text,
        transaction: message.transaction,
      })),
    }, board.snapshot ? { 'cache-control': `public, max-age=${remaining}, s-maxage=${remaining}` } : {})
  }

  return undefined
}

/** Refunds a proven prior direct deposit to its original payer; it creates no new payment. */
async function refund(port: ChainPort, request: Request, nowSeconds: bigint, forwardPaid?: Gate): Promise<Response> {
  if (request.method !== 'POST') throw new GateError(405, 'method_not_allowed', '/x402/refund takes POST.')
  const body = await readBody(request)
  const settlementTransaction = settlementOf(body)
  if (!settlementTransaction) throw new GateError(400, 'missing_settlement', 'settlementTransaction is required.')
  const recipient = addressOf(body.payTo, 'payTo')
  if (!same(recipient, port.launchpad) && !same(recipient, port.bbs)) throw new GateError(400, 'invalid_pay_to', 'payTo must be the original launchpad or board recipient.')
  const header = request.headers.get('payment-signature')
  if (!header) throw new GateError(400, 'missing_payment', 'The original PAYMENT-SIGNATURE is required. Do not sign a new payment.')
  const terms = usdcTerms(port, recipient, 'Refund the original external payment', []).requirements
  const payment = readPayment(header, terms, nowSeconds, { refund: true })
  if (payment.auth.value === 0n) throw new GateError(400, 'zero_refund', 'A zero-value payment needs no refund transaction.')
  if (forwardPaid) return forwardPaid(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) }))
  const signed = { ...payment, salt: zeroHash, settlementTransaction }
  const recovered = await port.recover({ action: 'refund', payTo: recipient }, signed)
  if (recovered) return json(200, { ok: true, action: 'refund', payer: payment.auth.from, transaction: recovered.transaction, explorer: `${port.explorer}/tx/${recovered.transaction}`, result: recovered.result })
  if (!port.canRelay) throw new GateError(503, 'relayer_not_configured', 'The dedicated relayer is not configured.')
  const done = await port.refundExternal(recipient, signed)
  return json(200, { ok: true, action: 'refund', payer: payment.auth.from, transaction: done.transaction, explorer: `${port.explorer}/tx/${done.transaction}`, result: { refunded: money(done.amount, USDC_DECIMALS), settlementTransaction } })
}

/**
 * For callers that sign their own authorizations: the nonce that commits to a request's exact
 * parameters, and the terms to sign. Free, and checkable against the contract's own views.
 */
async function commit(port: ChainPort, request: Request): Promise<Response> {
  if (request.method !== 'POST') throw new GateError(405, 'method_not_allowed', '/x402/commit takes POST.')
  const body = await readBody(request)
  const prepare = typeof body.action === 'string' ? PAID[`/x402/${body.action}`] : undefined
  if (!prepare) throw new GateError(400, 'invalid_field', 'action must be one of launch, buy, sell, post.')
  if (body.salt === undefined) throw new GateError(400, 'missing_field', 'salt is required: 32 random bytes of hex, chosen by you.')
  const prepared = await prepare(port, body)
  const salt = prepared.salt as Hex
  return json(200, {
    action: prepared.action,
    salt,
    nonce: await prepared.commitment(salt),
    request: prepared.request,
    requirements: prepared.terms.requirements,
    price: prepared.terms.price,
    ...(prepared.terms.notes ? { notes: prepared.terms.notes } : {}),
  })
}

export type Gate = (request: Request) => Promise<Response>

/**
 * `port` is a function so that a missing deployment or a bad key surfaces as a plain 503 on the
 * request that needed it, instead of taking the whole function down at import time.
 */
export function createGate(port: () => ChainPort, options: { now?: () => number; forwardPaid?: Gate } = {}): Gate {
  const now = options.now ?? (() => Date.now())
  return async (request) => {
    let explorer: string | undefined
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const path = routeOf(request)
      let chain: ChainPort
      try {
        chain = port()
        explorer = chain.explorer
      } catch (error) {
        throw new GateError(503, 'not_configured', error instanceof Error ? error.message : 'The gate is not configured.')
      }
      if (path in PAID) return await paid(chain, request, path, BigInt(Math.floor(now() / 1000)), options.forwardPaid)
      if (path === '/x402/refund') return await refund(chain, request, BigInt(Math.floor(now() / 1000)), options.forwardPaid)
      if (path === '/x402/commit') return await commit(chain, request)
      if (request.method !== 'GET') throw new GateError(405, 'method_not_allowed', `${path} takes GET.`)
      const answer = await free(chain, request, path)
      if (answer) return answer
      throw new GateError(404, 'not_found', `There is nothing at ${path}. GET /x402 lists every endpoint.`)
    } catch (error) {
      if (error instanceof GateError) return refusal(error, explorer)
      console.error('x402 gate failed', { kind: error instanceof Error ? error.name : 'UnknownError' })
      const message =
        request.method === 'POST'
          ? 'The gate could not complete the request. If a payment was sent, the same authorization cannot be charged twice.'
          : 'The gate could not read the chain just now.'
      return json(502, { ok: false, error: 'gate_failed', message })
    }
  }
}
