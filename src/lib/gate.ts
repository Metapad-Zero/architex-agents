import { decodePaymentRequiredHeader } from '@x402/core/http'
import { formatUnits, isAddress, parseUnits, zeroAddress, type Address } from 'viem'

export const GATE_PREVIEW_BODY = { name: 'Gate preview', symbol: 'GATE' } as const
export const MAINNET_NETWORK = 'eip155:5042' as const

export interface GateMoney {
  formatted: string
  raw: string
}

export interface GateIndex {
  name: string
  x402Version: 2
  network: typeof MAINNET_NETWORK
  chainId: 5042
  testnet: false
  asset: { symbol: 'USDC'; address: Address; decimals: 6; eip712: { name: 'USDC'; version: '2' } }
  contracts: { launchpad: Address; bbs: Address }
  fees: {
    launchFee: GateMoney
    launchRelayFee: GateMoney
    tradeRelayFee: GateMoney
    postFee: GateMoney
    postRelayFee: GateMoney
    tradeFeeBps: number
  }
  readiness?: {
    chainVerified: boolean
    contractsVerified: boolean
    relay: { configured: boolean; ready: boolean; mode: 'single-process' | 'forwarded' | 'read-only'; address: Address | null; reason: string | null }
  }
}

export interface GateChallenge {
  network: typeof MAINNET_NETWORK
  asset: Address
  payTo: Address
  amount: GateMoney
  timeout: number
  url: string
}

export interface GateExpected {
  chainId: number
  asset: Address
  launchpad?: Address
  bbs?: Address
}

type RecordValue = Record<string, unknown>
const UINT = /^(0|[1-9]\d{0,77})$/
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,6})?$/
const MAX_UINT = (1n << 256n) - 1n

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing or malformed.`)
  return value as RecordValue
}

function address(value: unknown, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`${label} is not a deployed contract address.`)
  return value
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function matchesDeployment(value: Address, expected: Address | undefined, label: string): void {
  if (expected && expected !== zeroAddress && !sameAddress(value, expected)) throw new Error(`${label} differs from this site's deployment.`)
}

function rawAmount(value: unknown): string {
  if (typeof value !== 'string' || !UINT.test(value) || BigInt(value) > MAX_UINT) throw new Error('The gate returned an invalid atomic amount.')
  return value
}

function money(value: unknown): GateMoney {
  const item = record(value, 'Price')
  const raw = rawAmount(item.raw)
  if (typeof item.formatted !== 'string' || item.formatted.length > 85 || !DECIMAL.test(item.formatted) || parseUnits(item.formatted, 6) !== BigInt(raw)) {
    throw new Error('The formatted price disagrees with its atomic amount.')
  }
  return { formatted: item.formatted, raw }
}

function mainnet(chainId: unknown, network: unknown, testnet: unknown, expected: GateExpected): void {
  if (expected.chainId !== 5042 || chainId !== 5042 || network !== MAINNET_NETWORK || testnet !== false) {
    throw new Error('The gate and this site must both use Arc mainnet, chain 5042.')
  }
}

/** The HTTP boundary is untrusted. A readable response is not proof it names this deployment. */
export function parseGateIndex(value: unknown, expected: GateExpected): GateIndex {
  const item = record(value, 'Gate index')
  mainnet(item.chainId, item.network, item.testnet, expected)
  if (item.x402Version !== 2 || typeof item.name !== 'string') throw new Error('The gate must report x402 version 2.')
  const asset = record(item.asset, 'Payment asset')
  const domain = record(asset.eip712, 'USDC domain')
  const assetAddress = address(asset.address, 'USDC')
  if (asset.symbol !== 'USDC' || asset.decimals !== 6 || !sameAddress(assetAddress, expected.asset) || domain.name !== 'USDC' || domain.version !== '2') {
    throw new Error('The gate returned a different asset or USDC signing domain.')
  }
  const contracts = record(item.contracts, 'Contracts')
  const launchpad = address(contracts.launchpad, 'Launchpad')
  const bbs = address(contracts.bbs, 'Board')
  matchesDeployment(launchpad, expected.launchpad, 'Launchpad')
  matchesDeployment(bbs, expected.bbs, 'Board')
  const fees = record(item.fees, 'Fees')
  if (typeof fees.tradeFeeBps !== 'number' || !Number.isInteger(fees.tradeFeeBps) || fees.tradeFeeBps < 0 || fees.tradeFeeBps > 10_000) {
    throw new Error('The gate returned an invalid curve fee.')
  }
  let readiness: GateIndex['readiness']
  if (item.readiness !== undefined) {
    const state = record(item.readiness, 'Readiness')
    const relay = record(state.relay, 'Relay status')
    if (typeof state.chainVerified !== 'boolean' || typeof state.contractsVerified !== 'boolean' || typeof relay.configured !== 'boolean' || typeof relay.ready !== 'boolean' || typeof relay.mode !== 'string' || !['single-process', 'forwarded', 'read-only'].includes(relay.mode) || (relay.reason !== null && typeof relay.reason !== 'string')) {
      throw new Error('The gate returned an invalid readiness state.')
    }
    readiness = {
      chainVerified: state.chainVerified,
      contractsVerified: state.contractsVerified,
      relay: {
        configured: relay.configured,
        ready: relay.ready,
        mode: relay.mode as 'single-process' | 'forwarded' | 'read-only',
        address: relay.address === null ? null : address(relay.address, 'Relayer'),
        reason: relay.reason,
      },
    }
  }
  return {
    name: item.name,
    x402Version: 2,
    network: MAINNET_NETWORK,
    chainId: 5042,
    testnet: false,
    asset: { symbol: 'USDC', address: assetAddress, decimals: 6, eip712: { name: 'USDC', version: '2' } },
    contracts: { launchpad, bbs },
    fees: {
      launchFee: money(fees.launchFee),
      launchRelayFee: money(fees.launchRelayFee),
      tradeRelayFee: money(fees.tradeRelayFee),
      postFee: money(fees.postFee),
      postRelayFee: money(fees.postRelayFee),
      tradeFeeBps: fees.tradeFeeBps,
    },
    ...(readiness ? { readiness } : {}),
  }
}

function terms(value: unknown, expected: GateExpected) {
  const item = record(value, 'Payment terms')
  const extra = record(item.extra, 'Signing domain')
  const asset = address(item.asset, 'Payment asset')
  const payTo = address(item.payTo, 'Payment recipient')
  if (expected.chainId !== 5042 || item.scheme !== 'exact' || item.network !== MAINNET_NETWORK || !sameAddress(asset, expected.asset) || extra.name !== 'USDC' || extra.version !== '2' || (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009')) {
    throw new Error('The launch challenge does not use Arc mainnet USDC and its expected signing domain.')
  }
  matchesDeployment(payTo, expected.launchpad, 'Launchpad recipient')
  if (typeof item.maxTimeoutSeconds !== 'number' || !Number.isInteger(item.maxTimeoutSeconds) || item.maxTimeoutSeconds < 1 || item.maxTimeoutSeconds > 120) throw new Error('The challenge returned an unexpected authorization lifetime.')
  return { asset, payTo, raw: rawAmount(item.amount), timeout: item.maxTimeoutSeconds }
}

export function parseGateChallenge(header: string | null, body: unknown, url: string, expected: GateExpected): GateChallenge {
  if (!header) throw new Error('The 402 response is missing its PAYMENT-REQUIRED header.')
  let decoded: unknown
  try {
    decoded = decodePaymentRequiredHeader(header)
  } catch {
    throw new Error('The PAYMENT-REQUIRED header could not be decoded.')
  }
  const required = record(decoded, 'Payment challenge')
  const repeated = record(body, 'Challenge body')
  if (required.x402Version !== 2 || repeated.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length !== 1 || !Array.isArray(repeated.accepts) || repeated.accepts.length !== 1) throw new Error('The gate returned an unsupported payment challenge.')
  if (record(required.resource, 'Resource').url !== url || record(repeated.resource, 'Resource').url !== url) throw new Error('The challenge names a different request URL.')
  const accepted = terms(required.accepts[0], expected)
  const copy = terms(repeated.accepts[0], expected)
  if (!sameAddress(copy.asset, accepted.asset) || !sameAddress(copy.payTo, accepted.payTo) || copy.raw !== accepted.raw || copy.timeout !== accepted.timeout) throw new Error('The challenge header and body disagree.')
  const price = record(repeated.price, 'Price breakdown')
  const amount = money(price.total)
  if (price.asset !== 'USDC' || amount.raw !== accepted.raw || !Array.isArray(price.breakdown)) throw new Error('The price breakdown disagrees with the signed payment terms.')
  const sum = price.breakdown.reduce<bigint>((total, line: unknown) => total + BigInt(money(line).raw), 0n)
  if (sum !== BigInt(amount.raw)) throw new Error('The price breakdown does not add up to the payment amount.')
  return { network: MAINNET_NETWORK, asset: accepted.asset, payTo: accepted.payTo, amount, timeout: accepted.timeout, url }
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error(`The gateway answered HTTP ${response.status} without readable JSON.`)
  }
}

function responseError(body: unknown, status: number): Error {
  const message = body && typeof body === 'object' && 'message' in body ? (body as RecordValue).message : undefined
  return new Error(typeof message === 'string' && message.length <= 500 ? message : `The gateway answered HTTP ${status}.`)
}

export async function readGateIndex(origin: string, expected: GateExpected, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<GateIndex> {
  const response = await fetcher(`${origin}/x402`, { signal, credentials: 'same-origin', cache: 'no-store' })
  const body = await jsonBody(response)
  if (!response.ok) throw responseError(body, response.status)
  return parseGateIndex(body, expected)
}

/** Only an unpaid request. This module never imports a signer or adds PAYMENT-SIGNATURE. */
export async function readGateChallenge(origin: string, expected: GateExpected, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<GateChallenge> {
  const url = `${origin}/x402/launch`
  const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(GATE_PREVIEW_BODY), signal, credentials: 'same-origin', cache: 'no-store' })
  const body = await jsonBody(response)
  if (response.status !== 402) throw responseError(body, response.status)
  return parseGateChallenge(response.headers.get('payment-required'), body, url, expected)
}

export function challengeAgreement(index: GateIndex, challenge: GateChallenge): string | undefined {
  if (!sameAddress(index.contracts.launchpad, challenge.payTo) || !sameAddress(index.asset.address, challenge.asset)) return 'The challenge and index name different contracts. Refresh before using this gateway.'
  const launchCost = BigInt(index.fees.launchFee.raw) + BigInt(index.fees.launchRelayFee.raw)
  if (launchCost !== BigInt(challenge.amount.raw)) return 'Fees changed while the page was reading them. Refresh for matching terms.'
  return undefined
}

export function addGateMoney(...values: GateMoney[]): string {
  return formatUnits(values.reduce((sum, value) => sum + BigInt(value.raw), 0n), 6)
}

export function stockQuickstart(origin: string, usdc: Address): string {
  return `import { ExactEvmScheme } from '@x402/evm'
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch'
import { privateKeyToAccount } from 'viem/accounts'

const origin = ${JSON.stringify(origin)}
const network = 'eip155:5042'
const usdc = ${JSON.stringify(usdc)}
const key = process.env.AGENT_PRIVATE_KEY
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set AGENT_PRIVATE_KEY locally')
const account = privateKeyToAccount(key as \`0x\${string}\`)
const discovery = await fetch(origin + '/x402')
if (!discovery.ok) throw new Error('The gateway is unavailable')
const gate = await discovery.json()
if (gate.chainId !== 5042 || gate.network !== network || gate.testnet !== false ||
    gate.asset?.address?.toLowerCase() !== usdc.toLowerCase() ||
    !/^0x[0-9a-fA-F]{40}$/.test(gate.contracts?.launchpad ?? '') ||
    /^0x0{40}$/.test(gate.contracts.launchpad) || !gate.readiness?.chainVerified ||
    !gate.readiness?.contractsVerified || !gate.readiness?.relay?.ready) {
  throw new Error('Mainnet gate or relayer is not ready')
}
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network, client: new ExactEvmScheme(account) }],
  spendControls: {
    allowedAssets: [{ network, asset: usdc, maxAmountPerPayment: '5000000' }],
  },
  policies: [(_, terms) => terms.filter(r =>
    r.scheme === 'exact' && r.network === network &&
    r.asset.toLowerCase() === usdc.toLowerCase() &&
    r.payTo.toLowerCase() === gate.contracts.launchpad.toLowerCase() &&
    r.extra?.name === 'USDC' && r.extra?.version === '2' &&
    (r.extra?.assetTransferMethod ?? 'eip3009') === 'eip3009'
  )],
})

// Running this creates a real token and spends mainnet USDC.
const response = await pay(origin + '/x402/launch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'My agent token', symbol: 'AGENT' }),
})
const result = await response.json()
if (!response.ok) {
  // A pending transaction must be checked before any new payment is signed.
  throw new Error(JSON.stringify(result))
}
const header = response.headers.get('payment-response')
if (!header) throw new Error('Missing payment receipt; inspect the transaction before retrying')
const receipt = decodePaymentResponseHeader(header)
if (!receipt.success || receipt.network !== network ||
    receipt.payer?.toLowerCase() !== account.address.toLowerCase() ||
    receipt.transaction !== result.transaction) {
  throw new Error('Payment receipt disagrees with the result; inspect it before retrying')
}
console.log(result)
`
}

export function mcpQuickstart(origin: string): string {
  return JSON.stringify({
    mcpServers: {
      'architex-agents': {
        command: 'bun',
        args: ['--no-install', 'run', '/absolute/path/to/architex-agents-mcp/mcp-server/src/index.ts'],
        env: { ARC_NETWORK: 'mainnet', GATE_URL: origin, AGENT_MAX_PAYMENT_USDC: '5' },
      },
    },
  }, null, 2)
}

export function mcpInstall(origin: string): string {
  const download = `${origin}/downloads/architex-agents-mcp.tar.gz`.replace(/'/g, "'\\''")
  return `curl --fail --location '${download}' --output architex-agents-mcp.tar.gz
tar -xzf architex-agents-mcp.tar.gz
cd architex-agents-mcp
bun install --frozen-lockfile
printf '%s/mcp-server/src/index.ts\\n' "$PWD"`
}
