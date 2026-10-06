import process from 'node:process'
import { createPublicClient, http, isAddress, type Address } from 'viem'
import { arc, arcTestnet } from 'viem/chains'
import arcMainnetDeployment from '../../src/deployments/arc-mainnet.json' with { type: 'json' }
import arcTestnetDeployment from '../../src/deployments/arc-testnet.json' with { type: 'json' }

const USDC: Address = '0x3600000000000000000000000000000000000000'
const address = (value: string): Address | undefined => isAddress(value) && !/^0x0+$/i.test(value) ? value : undefined

/** Configuration is read when a tool runs, so an unavailable deployment never prevents the MCP handshake. */
export function chainContext(env: Record<string, string | undefined> = process.env, options: { deploymentRequired?: boolean } = {}) {
  const network = env.ARC_NETWORK?.trim() || 'mainnet'
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('ARC_NETWORK must be mainnet or testnet.')
  const deployment = network === 'mainnet' ? arcMainnetDeployment : arcTestnetDeployment
  const chain = network === 'mainnet' ? arc : arcTestnet
  if (deployment.chainId !== chain.id) throw new Error('The deployment manifest and configured chain disagree.')
  const launchpadAddress = address(deployment.launchpad)
  const bbsAddress = address(deployment.bbs)
  if (options.deploymentRequired !== false && (!launchpadAddress || !bbsAddress)) throw new Error(`The agents launchpad and board have not been deployed on Arc ${network}. No action is available yet.`)
  const url = new URL(env.ARC_RPC_URL || chain.rpcUrls.default.http[0])
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('ARC_RPC_URL must use HTTPS, or HTTP on loopback.')
  return { chainId: chain.id, network: `eip155:${chain.id}` as const, isTestnet: network === 'testnet', launchpadAddress, bbsAddress, usdcAddress: USDC, explorerBase: deployment.explorerBase, publicClient: createPublicClient({ chain, transport: http(url.href, { timeout: 10_000, retryCount: 1 }) }) }
}

export async function verifiedChainContext(env: Record<string, string | undefined> = process.env, options: { deploymentRequired?: boolean } = {}) {
  const context = chainContext(env, options)
  if (await context.publicClient.getChainId() !== context.chainId) throw new Error('ARC_RPC_URL serves a different chain. No action was signed.')
  return context
}
