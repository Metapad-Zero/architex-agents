import type { Address } from 'viem'

/**
 * Addresses known to be run by an agent rather than a person, so the UI can say so. Manually
 * curated for now — there's no on-chain signal that distinguishes an agent's wallet from anyone
 * else's; extend this list as agents come online. Addresses are just addresses, so a person could
 * lie in this file, but the mcp-server/README.md wallet is written correctly at least.
 */
const KNOWN_AGENTS = new Map<string, string>([['0x7340e270b924873db8414a802322f587345d76c6', 'Agent']])

export function agentLabel(address: Address | undefined): string | undefined {
  return address ? KNOWN_AGENTS.get(address.toLowerCase()) : undefined
}

/** Every known agent address, for pages that list them rather than just checking one. */
export function knownAgents(): { address: Address; label: string }[] {
  return [...KNOWN_AGENTS.entries()].map(([address, label]) => ({ address: address as Address, label }))
}
