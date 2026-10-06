import { encodeAbiParameters, keccak256, stringToHex, toHex, verifyTypedData, type Address, type Hex } from 'viem'
import { INITIAL_CURVE, quoteBuy, quoteSell, type CurveState } from '../../../src/lib/curve.js'
import { GateError } from '../errors.js'
import { money } from '../money.js'
import type { Authorization, ChainPort, Curve, LaunchParams, RecoveryRequest, RecoveredAction, Signed } from '../port.js'

/**
 * A stand-in chain for the gate's tests: in-memory curves and balances, and the same checks the
 * real assets make on an EIP-3009 authorization (signature, window, single use, balance), so a
 * test that passes here is exercising the real signing path of a real x402 client.
 */
export const CHAIN_ID = 5042002
export const USDC: Address = '0x3600000000000000000000000000000000000000'
export const LAUNCHPAD: Address = '0x00000000000000000000000000000000000a9a9e'
export const BOARD: Address = '0x0000000000000000000000000000000000b0a2d5'

export const FEES = { launchFee: 250_000n, launchRelayFee: 150_000n, tradeRelayFee: 10_000n, postFee: 10_000n, postRelayFee: 10_000n, tradeFeeBps: 12n }

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const hashed = (text: string) => keccak256(stringToHex(text))
const typehash = (signature: string) => keccak256(stringToHex(signature))
const marked = (commitment: Hex) => toHex((0x4152435458424e44n << 192n) | (BigInt(commitment) & ((1n << 192n) - 1n)), { size: 32 })

export interface FakeChain extends ChainPort {
  balances: Map<string, bigint>
  relayed: { action: string; from: Address; bound: boolean }[]
  posts: { from: Address; text: string }[]
  tokenNames: Map<string, { name: string; symbol: string }>
  state: Map<string, Curve>
  now: () => bigint
}

export function fakeChain(options: { canRelay?: boolean; now?: () => bigint; chainId?: number } = {}): FakeChain {
  const chainId = options.chainId ?? CHAIN_ID
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)))
  const used = new Set<string>()
  const balances = new Map<string, bigint>()
  const state = new Map<string, Curve>()
  const tokenNames = new Map<string, { name: string; symbol: string }>()
  const relayed: FakeChain['relayed'] = []
  const posts: FakeChain['posts'] = []
  let launched = 0
  let transactionCount = 0
  const completed: { intent: RecoveryRequest; signed: Signed; result: RecoveredAction }[] = []

  const holding = (asset: Address, owner: Address) => `${asset.toLowerCase()}:${owner.toLowerCase()}`
  const curveOf = (token: Address) => state.get(token.toLowerCase())
  const asState = (curve: Curve): CurveState => ({ virtualUsdc: curve.virtualUsdc, virtualTokens: curve.virtualTokens, tokensSold: curve.tokensSold })

  /** What the asset's transferWithAuthorization would do: check everything, then move the money. */
  async function settle(asset: Address, domainName: string, domainVersion: string, payTo: Address, signed: Signed, commitment: Hex, action: string): Promise<boolean> {
    const auth: Authorization = signed.auth
    const valid = await verifyTypedData({
      address: auth.from,
      domain: { name: domainName, version: domainVersion, chainId, verifyingContract: asset },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: payTo, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce },
      signature: signed.signature,
    })
    if (!valid) throw new GateError(402, 'invalid_signature', 'The signature does not match the authorization.')
    if (auth.validAfter >= now()) throw new GateError(402, 'authorization_not_yet_valid', 'The authorization is not valid yet.')
    if (auth.validBefore <= now()) throw new GateError(402, 'authorization_expired', 'The authorization has expired. Sign a new one.')
    const once = `${asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce}`
    if (used.has(once)) throw new GateError(402, 'authorization_used', 'That authorization has already been used. Sign a new one.')
    const held = balances.get(holding(asset, auth.from)) ?? 0n
    if (held < auth.value) throw new GateError(402, 'insufficient_funds', 'The payer does not hold enough to cover this.')
    used.add(once)
    balances.set(holding(asset, auth.from), held - auth.value)
    const bound = commitment.toLowerCase() === auth.nonce.toLowerCase()
    relayed.push({ action, from: auth.from, bound })
    return bound
  }

  const launchNonce = (p: LaunchParams, salt: Hex) =>
    marked(keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }],
        [
          typehash('Launch(string name,string symbol,string metadataURI,uint256 initialBuyUsdc,uint256 minTokensOut,bytes32 salt)'),
          hashed(p.name),
          hashed(p.symbol),
          hashed(p.metadataURI),
          p.initialBuyUsdc,
          p.minTokensOut,
          salt,
        ],
      ),
    ))
  const tradeNonce = (signature: string, token: Address, minimum: bigint, salt: Hex) =>
    marked(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [typehash(signature), token, minimum, salt])))
  const buyNonce = (token: Address, minimum: bigint, salt: Hex) => tradeNonce('Buy(address token,uint256 minTokensOut,bytes32 salt)', token, minimum, salt)
  const sellNonce = (token: Address, minimum: bigint, salt: Hex) => tradeNonce('Sell(address token,uint256 minUsdcOut,bytes32 salt)', token, minimum, salt)
  const postNonce = (text: string, salt: Hex) =>
    marked(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [typehash('Post(string text,bytes32 salt)'), hashed(text), salt])))

  const transaction = (): Hex => `0x${(++transactionCount).toString(16).padStart(64, '0')}`
  const remember = (intent: RecoveryRequest, signed: Signed, transaction: Hex, result: Record<string, unknown>) => {
    completed.push({ intent, signed, result: { transaction, result, bound: relayed[relayed.length - 1]?.bound ?? false } })
  }
  const credit = (asset: Address, owner: Address, amount: bigint) => balances.set(holding(asset, owner), (balances.get(holding(asset, owner)) ?? 0n) + amount)

  function applyBuy(curve: Curve, usdcIn: bigint, minTokensOut: bigint, buyer: Address) {
    const quote = quoteBuy(asState(curve), usdcIn)
    if (quote.tokensOut < minTokensOut) throw new GateError(400, 'slippage_exceeded', 'The price moved past your limit. Ask for a fresh quote and try again.')
    Object.assign(curve, quote.next, { graduated: quote.graduates })
    credit(curve.token, buyer, quote.tokensOut)
    if (quote.usdcSpent < usdcIn) credit(USDC, buyer, usdcIn - quote.usdcSpent)
    return quote
  }

  return {
    chainId,
    testnet: chainId !== 5042,
    explorer: chainId === 5042 ? 'https://explorer.arc.io' : 'https://explorer.testnet.arc.io',
    usdc: USDC,
    launchpad: LAUNCHPAD,
    bbs: BOARD,
    canRelay: options.canRelay ?? true,
    readiness: () => Promise.resolve({ chainVerified: true, contractsVerified: true, relay: { configured: options.canRelay ?? true, ready: options.canRelay ?? true, mode: 'single-process' as const, address: null, reason: null } }),
    transaction: (hash) => Promise.resolve({ transaction: hash, status: 'confirmed' as const }),
    authorizationUsed: (asset, auth) => Promise.resolve(used.has(`${asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce}`)),
    pendingTransaction: () => undefined,
    refundExternal: (recipient, signed) => {
      const hash = transaction()
      remember({ action: 'refund', payTo: recipient }, signed, hash, { refunded: money(signed.auth.value, 6), settlementTransaction: signed.settlementTransaction })
      return Promise.resolve({ transaction: hash, relayFee: 0n, amount: signed.auth.value })
    },
    recover: (intent, signed) => {
      const previous = completed.find((record) => record.signed.auth.nonce === signed.auth.nonce && record.signed.auth.from === signed.auth.from && (record.intent.action === 'sell') === (intent.action === 'sell') && (intent.action !== 'sell' || (record.intent.action === 'sell' && record.intent.token === intent.token)))
      if (!previous) return Promise.resolve(undefined)
      const original = previous.intent as unknown as Record<string, unknown>
      const equal = Object.entries(intent).every(([key, value]) => value === undefined || original[key] === value) && previous.signed.signature === signed.signature && previous.signed.salt === signed.salt && Object.entries(signed.auth).every(([key, value]) => (previous.signed.auth as unknown as Record<string, unknown>)[key] === value)
      if (!equal) return Promise.reject(new GateError(409, 'authorization_completed', 'This authorization already completed a different request.', { transaction: previous.result.transaction, status: 'confirmed', retryable: false }))
      return Promise.resolve(previous.result)
    },
    balances,
    relayed,
    posts,
    tokenNames,
    state,
    now,

    fees: () => Promise.resolve(FEES),
    curve: (token) => Promise.resolve(curveOf(token)),
    curves: (start, count) => {
      const all = [...state.values()]
      return Promise.resolve({ total: all.length, curves: all.slice(start, start + count) })
    },
    tokenName: (token) => {
      const named = tokenNames.get(token.toLowerCase())
      return named ? Promise.resolve(named) : Promise.reject(new Error('no such token'))
    },
    quoteBuy: (token, usdcIn) => {
      const { tokensOut, fee, usdcSpent, graduates } = quoteBuy(asState(curveOf(token) as Curve), usdcIn)
      return Promise.resolve({ tokensOut, fee, usdcSpent, graduates })
    },
    quoteSell: (token, tokensIn) => {
      try {
        const { usdcOut, fee } = quoteSell(asState(curveOf(token) as Curve), tokensIn)
        return Promise.resolve({ usdcOut, fee })
      } catch {
        return Promise.reject(new GateError(400, 'exceeds_sold', 'That is more tokens than this curve has sold.'))
      }
    },
    messages: (count) =>
      Promise.resolve({
        total: posts.length,
        complete: true,
        messages: posts
          .map((post, index) => ({ id: BigInt(index), from: post.from, time: now(), text: post.text, transaction: `0x${'0'.repeat(64)}` as const }))
          .reverse()
          .slice(0, count),
      }),

    launchNonce: (params, salt) => Promise.resolve(launchNonce(params, salt)),
    buyNonce: (token, minimum, salt) => Promise.resolve(buyNonce(token, minimum, salt)),
    sellNonce: (token, minimum, salt) => Promise.resolve(sellNonce(token, minimum, salt)),
    postNonce: (text, salt) => Promise.resolve(postNonce(text, salt)),

    async launch(params, signed) {
      if (signed.auth.value !== FEES.launchFee + FEES.launchRelayFee + params.initialBuyUsdc) throw new GateError(400, 'would_revert', 'wrong value')
      await settle(USDC, 'USDC', '2', LAUNCHPAD, signed, launchNonce(params, signed.salt), 'launch')
      launched += 1
      const token: Address = `0x${launched.toString(16).padStart(40, '0')}`
      const curve: Curve = { token, creator: signed.auth.from, pair: LAUNCHPAD, ...INITIAL_CURVE, createdAt: now(), graduated: false, metadataURI: params.metadataURI }
      state.set(token.toLowerCase(), curve)
      tokenNames.set(token.toLowerCase(), { name: params.name, symbol: params.symbol })
      const tokensOut = params.initialBuyUsdc > 0n ? applyBuy(curve, params.initialBuyUsdc, params.minTokensOut, signed.auth.from).tokensOut : 0n
      const hash = transaction()
      remember({ action: 'launch', ...params }, signed, hash, { token, tokensOut: money(tokensOut, 18) })
      return { transaction: hash, relayFee: FEES.launchRelayFee, token, tokensOut }
    },

    async buy(token, minTokensOut, signed) {
      const curve = curveOf(token) as Curve
      const usdcIn = signed.auth.value - FEES.tradeRelayFee
      // Quote before settling, as the contract's revert would: a refused trade moves no money.
      if (quoteBuy(asState(curve), usdcIn).tokensOut < minTokensOut) throw new GateError(400, 'slippage_exceeded', 'The price moved past your limit. Ask for a fresh quote and try again.')
      await settle(USDC, 'USDC', '2', LAUNCHPAD, signed, buyNonce(token, minTokensOut, signed.salt), 'buy')
      const quote = applyBuy(curve, usdcIn, minTokensOut, signed.auth.from)
      const hash = transaction()
      remember({ action: 'buy', token, usdcIn, minTokensOut }, signed, hash, { token, tokensOut: money(quote.tokensOut, 18), usdcSpent: money(quote.usdcSpent, 6), refunded: money(usdcIn - quote.usdcSpent, 6) })
      return { transaction: hash, relayFee: FEES.tradeRelayFee, tokensOut: quote.tokensOut, usdcSpent: quote.usdcSpent }
    },

    async sell(token, minUsdcOut, signed) {
      const curve = curveOf(token) as Curve
      const named = tokenNames.get(token.toLowerCase()) as { name: string }
      const quote = quoteSell(asState(curve), signed.auth.value)
      const received = quote.usdcOut - FEES.tradeRelayFee
      if (received < minUsdcOut) throw new GateError(400, 'slippage_exceeded', 'The price moved past your limit. Ask for a fresh quote and try again.')
      await settle(token, named.name, '1', LAUNCHPAD, signed, sellNonce(token, minUsdcOut, signed.salt), 'sell')
      Object.assign(curve, quote.next)
      credit(USDC, signed.auth.from, received)
      const hash = transaction()
      remember({ action: 'sell', token, tokensIn: signed.auth.value, minUsdcOut }, signed, hash, { token, tokensIn: money(signed.auth.value, 18), usdcOut: money(received, 6) })
      return { transaction: hash, relayFee: FEES.tradeRelayFee, usdcOut: received }
    },

    async post(text, signed) {
      await settle(USDC, 'USDC', '2', BOARD, signed, postNonce(text, signed.salt), 'post')
      posts.push({ from: signed.auth.from, text })
      const hash = transaction()
      const id = BigInt(posts.length - 1)
      remember({ action: 'post', text }, signed, hash, { id: id.toString() })
      return { transaction: hash, relayFee: FEES.postRelayFee, id }
    },
  }
}
