import { createGate, routeOf } from '../server/x402/gate.js'
import type { ChainPort } from '../server/x402/port.js'
import { forwardToRelayer } from '../server/x402/relayHttp.js'
import { viemPort } from '../server/x402/viemPort.js'

// Serverless instances never sign transactions with a shared EOA. Only the dedicated service has the key.
let port: ChainPort | undefined
const portOf = () => (port ??= viemPort({ ...process.env, RELAYER_PRIVATE_KEY: undefined }))
const gate = createGate(portOf)
const submittingGate = createGate(portOf, { forwardPaid: (checked) => forwardToRelayer(checked, process.env) })
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function deployment(value: Record<string, unknown> | undefined) {
  const asset = record(value?.asset)
  const contracts = record(value?.contracts)
  if (!value || typeof value.chainId !== 'number' || typeof asset?.address !== 'string' || typeof contracts?.launchpad !== 'string' || typeof contracts.bbs !== 'string') return undefined
  return { chainId: value.chainId, asset: asset.address.toLowerCase(), launchpad: contracts.launchpad.toLowerCase(), bbs: contracts.bbs.toLowerCase() }
}

export async function GET(request: Request): Promise<Response> {
  // The one dedicated process owns board cache and scan admission across all serverless instances.
  if (routeOf(request) === '/x402/bbs') return forwardToRelayer(request, process.env)
  const local = await gate(request)
  if (routeOf(request) !== '/x402' || !local.ok || !process.env.RELAYER_SERVICE_URL) return local
  const relay = await forwardToRelayer(request, process.env)
  if (!relay.ok) return local
  try {
    const values: unknown[] = await Promise.all([local.clone().json(), relay.json()])
    const index = record(values[0])
    const remote = record(values[1])
    const here = deployment(index)
    const there = deployment(remote)
    const remoteReadiness = record(remote?.readiness)
    const remoteRelay = record(remoteReadiness?.relay)
    if (!here || !there || here.chainId !== there.chainId || here.asset !== there.asset || here.launchpad !== there.launchpad || here.bbs !== there.bbs || remote?.network !== index?.network || remote?.testnet !== index?.testnet || remote?.x402Version !== 2 || remoteReadiness?.chainVerified !== true || remoteReadiness.contractsVerified !== true || typeof remoteRelay?.ready !== 'boolean' || typeof remoteRelay.configured !== 'boolean' || remoteRelay.mode !== 'single-process' || (remoteRelay.ready && !remoteRelay.configured) || (remoteRelay.address !== null && (typeof remoteRelay.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(remoteRelay.address))) || (remoteRelay.reason !== null && typeof remoteRelay.reason !== 'string')) return local
    return Response.json({ ...index, readiness: { ...record(index?.readiness), relay: { ...remoteRelay, mode: 'forwarded' } } }, { headers: local.headers })
  } catch { return local }
}

export async function POST(request: Request): Promise<Response> {
  // Validate bounded input and signed identity locally; only the dedicated process owns retry state.
  return submittingGate(request)
}

export function OPTIONS(request: Request): Promise<Response> { return gate(request) }
