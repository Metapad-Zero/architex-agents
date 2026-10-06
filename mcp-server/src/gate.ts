import process from 'node:process'
import { ExactEvmScheme } from '@x402/evm'
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { erc20Abi, isAddress, type Address, type Hex } from 'viem'
import { parseAmount } from '../../server/x402/money.js'
import { requireAgentWallet } from './agentWallet.js'
import { chainContext } from './chain.js'

type Env = Record<string, string | undefined>
export interface GateIndex {
  x402Version: 2
  chainId: number
  network: `eip155:${number}`
  testnet: boolean
  asset: { address: string; decimals: number; eip712: { name: string; version: string } }
  contracts: { launchpad: string; bbs: string }
  fees: Record<string, { raw: string; formatted: string } | number>
  readiness?: Record<string, unknown>
}
export interface GateAnswer {
  ok: true
  action: string
  payer: Address
  bound: boolean
  transaction: Hex
  explorer: string
  result: Record<string, unknown>
}
interface ExpectedGate { chainId: number; network: `eip155:${number}`; isTestnet: boolean; usdcAddress: Address; launchpadAddress?: Address; bbsAddress?: Address; explorerBase: string }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The gate returned a malformed JSON object.')
  return value as Record<string, unknown>
}

export function gateOrigin(env: Env = process.env): string {
  const value = env.GATE_URL?.trim()
  if (!value) throw new Error('No GATE_URL is configured. Set the origin of the Architex Agents gate.')
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('GATE_URL must be an HTTPS origin, or HTTP on loopback.')
  return url.origin
}

/** A small injectable boundary lets tests exercise the actual SDK and signer without sending a chain transaction. */
export function createGateClient(options: {
  env?: Env
  send?: typeof fetch
  expected?: () => ExpectedGate
  wallet?: typeof requireAgentWallet
  tokenName?: (token: Address) => Promise<string>
} = {}) {
  const env = options.env ?? process.env
  const send = options.send ?? fetch
  const expected = options.expected ?? (() => chainContext(env))
  const wallet = options.wallet ?? requireAgentWallet
  let cache: { origin: string; at: number; read: Promise<GateIndex> } | undefined
  let uncertain: { path: string; body: string; signature: string; payer: Address; transaction?: Hex } | undefined
  let paymentBusy = false

  async function info(fresh = false): Promise<GateIndex> {
    const origin = gateOrigin(env)
    const want = expected()
    if (!want.launchpadAddress || !want.bbsAddress) throw new Error('The configured agents deployment has no launchpad or board address.')
    const launchpad = want.launchpadAddress
    const bbs = want.bbsAddress
    if (!fresh && cache?.origin === origin && Date.now() - cache.at < 3_000) return cache.read
    const read = (async () => {
      const response = await send(`${origin}/x402`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
      if (!response.ok) throw new Error(`The gate answered ${response.status} to GET /x402.`)
      const index = record(await response.json())
      const asset = record(index.asset)
      const contracts = record(index.contracts)
      const domain = record(asset.eip712)
      if (index.x402Version !== 2 || index.chainId !== want.chainId || index.network !== want.network || index.testnet !== want.isTestnet || asset.decimals !== 6 || typeof asset.address !== 'string' || !same(asset.address, want.usdcAddress) || domain.name !== 'USDC' || domain.version !== '2' || typeof contracts.launchpad !== 'string' || !same(contracts.launchpad, launchpad) || typeof contracts.bbs !== 'string' || !same(contracts.bbs, bbs)) throw new Error('The gate network, asset, signing domain or contracts disagree with this MCP configuration. No payment was signed.')
      const fees = record(index.fees)
      for (const name of ['launchFee', 'launchRelayFee', 'tradeRelayFee', 'postFee', 'postRelayFee']) {
        const value = record(fees[name])
        if (typeof value.raw !== 'string' || !/^\d{1,78}$/.test(value.raw) || typeof value.formatted !== 'string' || parseAmount(value.formatted, 6, name, { allowZero: true }) !== BigInt(value.raw)) throw new Error('The gate fee list is malformed. No payment was signed.')
      }
      return index as unknown as GateIndex
    })()
    cache = { origin, at: Date.now(), read }
    read.catch(() => { if (cache?.read === read) cache = undefined })
    return read
  }

  async function interpret(response: Response, path: string, payer: Address, want: ExpectedGate): Promise<GateAnswer> {
    let answer: Record<string, unknown>
    try { answer = record(await response.json()) } catch { throw new Error('The paid response was unreadable. Keep the original payment and inspect its transaction before another action.') }
    if (!response.ok) {
      if (uncertain && hash(answer.transaction)) uncertain.transaction = answer.transaction
      const transaction = hash(answer.transaction) ? ` Transaction: ${answer.transaction}.` : ''
      const message = typeof answer.message === 'string' ? answer.message : typeof answer.error === 'string' ? answer.error : `The gate answered ${response.status}.`
      throw new Error(`${message}${transaction} Keep the original authorization for retry or a proved external-payment refund.`)
    }
    const header = response.headers.get('payment-response')
    let receipt
    try { receipt = header ? decodePaymentResponseHeader(header) : undefined } catch { receipt = undefined }
    if (answer.ok !== true || answer.action !== path.slice('/x402/'.length) || !hash(answer.transaction) || typeof answer.payer !== 'string' || !isAddress(answer.payer) || !same(answer.payer, payer) || !receipt || receipt.success !== true || receipt.transaction !== answer.transaction || receipt.network !== want.network || typeof receipt.payer !== 'string' || !same(receipt.payer, payer) || typeof answer.bound !== 'boolean' || typeof answer.result !== 'object' || answer.result === null || Array.isArray(answer.result) || answer.explorer !== `${want.explorerBase}/tx/${answer.transaction}`) throw new Error('The gate answer and its payment receipt disagree. Inspect the original authorization before another payment.')
    uncertain = undefined
    return { ok: true, action: answer.action, payer: answer.payer, bound: answer.bound, transaction: answer.transaction, explorer: answer.explorer, result: record(answer.result) }
  }

  async function pay(path: string, body: Record<string, unknown>, sellingToken?: Address): Promise<GateAnswer> {
    if (paymentBusy) throw new Error('Another payment attempt is in progress. No concurrent payment was signed.')
    paymentBusy = true
    try {
      if (uncertain) throw new Error(`A previous payment has an uncertain outcome.${uncertain.transaction ? ` Transaction: ${uncertain.transaction}.` : ''} Use retry_last_payment to resend its original signature; a fresh payment is blocked.`)
      if (!['/x402/launch', '/x402/buy', '/x402/sell', '/x402/post'].includes(path)) throw new Error('Unknown paid endpoint.')
      const { account } = wallet(env)
      const want = expected()
      const origin = gateOrigin(env)
      const index = await info(true)
      const readiness = index.readiness as { relay?: { ready?: boolean } } | undefined
      if (readiness?.relay?.ready !== true) throw new Error('The dedicated relayer is not ready. No payment was signed.')
      if (Boolean(sellingToken) !== (path === '/x402/sell')) throw new Error('Only a sale may authorize the launch token.')
      const cap = parseAmount(env.AGENT_MAX_PAYMENT_USDC?.trim() || '5', 6, 'AGENT_MAX_PAYMENT_USDC')
      const asset = sellingToken ?? want.usdcAddress
      const payTo = path === '/x402/post' ? want.bbsAddress as Address : want.launchpadAddress as Address
      const saleAmount = sellingToken ? parseAmount(body.tokens, 18, 'tokens') : undefined
      const fee = (field: string) => {
        const value = index.fees[field]
        if (!value || typeof value !== 'object' || !/^\d+$/.test(value.raw)) throw new Error('The gate fee list is malformed. No payment was signed.')
        return BigInt(value.raw)
      }
      const amount = path === '/x402/launch' ? fee('launchFee') + fee('launchRelayFee') + parseAmount(body.initialBuyUsdc ?? '0', 6, 'initialBuyUsdc', { allowZero: true }) : path === '/x402/buy' ? parseAmount(body.usdc, 6, 'usdc') + fee('tradeRelayFee') : path === '/x402/post' ? fee('postFee') + fee('postRelayFee') : saleAmount
      if (amount === undefined || (!sellingToken && amount > cap)) throw new Error('The request exceeds AGENT_MAX_PAYMENT_USDC. No payment was signed.')
      const name = sellingToken ? await (options.tokenName?.(sellingToken) ?? chainContext(env).publicClient.readContract({ address: sellingToken, abi: erc20Abi, functionName: 'name' })) : 'USDC'
      const bodyText = JSON.stringify(body)
      const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const signature = request.headers.get('payment-signature')
        if (signature) uncertain = { path, body: bodyText, signature, payer: account.address }
        return send(request, { signal: AbortSignal.timeout(55_000), redirect: 'error' })
      }) as typeof fetch
      const payFetch = wrapFetchWithPaymentFromConfig(tracked, {
        schemes: [{ network: want.network, client: new ExactEvmScheme(account) }],
        spendControls: { allowedAssets: [{ network: want.network, asset, maxAmountPerPayment: (sellingToken ? saleAmount as bigint : cap).toString() }] },
        policies: [(version, requirements) => requirements.filter((entry) => version === 2 && entry.scheme === 'exact' && entry.network === want.network && same(entry.asset, asset) && same(entry.payTo, payTo) && entry.amount === amount.toString() && entry.maxTimeoutSeconds === 120 && entry.extra?.name === name && entry.extra?.version === (sellingToken ? '1' : '2') && (entry.extra?.assetTransferMethod ?? 'eip3009') === 'eip3009')],
      })
      const response = await payFetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyText })
      return await interpret(response, path, account.address, want)
    } finally { paymentBusy = false }
  }

  async function retry(): Promise<GateAnswer> {
    if (paymentBusy) throw new Error('Another payment attempt is in progress. No concurrent retry was submitted.')
    paymentBusy = true
    try {
      if (!uncertain) throw new Error('There is no uncertain payment to retry.')
      const original = uncertain
      const response = await send(`${gateOrigin(env)}${original.path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': original.signature }, body: original.body, signal: AbortSignal.timeout(55_000), redirect: 'error' })
      return await interpret(response, original.path, original.payer, expected())
    } finally { paymentBusy = false }
  }

  async function transaction(transaction: Hex) {
    if (!hash(transaction)) throw new Error('transaction must be a 32-byte hash.')
    await info()
    const response = await send(`${gateOrigin(env)}/x402/transaction/${transaction}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
    if (!response.ok) throw new Error(`The gate answered ${response.status} while checking the transaction.`)
    const result = record(await response.json())
    if (result.transaction !== transaction || typeof result.status !== 'string' || !['pending', 'confirmed', 'reverted', 'not_found'].includes(result.status)) throw new Error('The gate returned an invalid transaction status.')
    if (uncertain?.transaction === transaction && result.status === 'confirmed' && typeof result.payer === 'string' && same(result.payer, uncertain.payer) && result.action === uncertain.path.slice('/x402/'.length) && result.result && typeof result.result === 'object') uncertain = undefined
    return result
  }
  return { info, pay, retry, transaction }
}

const client = createGateClient()
export const gateInfo = () => client.info()
export const payGate = (path: string, body: Record<string, unknown>, sellingToken?: Address) => client.pay(path, body, sellingToken)
export const retryLastPayment = () => client.retry()
export const getTransactionStatus = (transaction: Hex) => client.transaction(transaction)
