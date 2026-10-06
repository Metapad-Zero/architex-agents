import process from 'node:process'
import { privateKeyToAccount } from 'viem/accounts'

/** The key is parsed only for a paid tool or wallet read, never at protocol initialization. */
export function requireAgentWallet(env: Record<string, string | undefined> = process.env) {
  const network = env.ARC_NETWORK?.trim() || 'mainnet'
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('ARC_NETWORK must be mainnet or testnet.')
  const key = env.AGENT_PRIVATE_KEY?.trim()
  if (!key) throw new Error('No AGENT_PRIVATE_KEY is configured. This MCP server is read-only.')
  if (network === 'mainnet' && env.AGENT_ALLOW_MAINNET !== '1') throw new Error('Mainnet signing requires AGENT_ALLOW_MAINNET=1.')
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('AGENT_PRIVATE_KEY is not a valid private key.')
  try { return { account: privateKeyToAccount(key as `0x${string}`) } } catch { throw new Error('AGENT_PRIVATE_KEY is not a valid private key.') }
}
