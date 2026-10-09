import { createMetadataService } from '../server/metadataService.js'

/**
 * GET  /api/metadata  uploads disabled, and which gateway to read from first
 * POST /api/metadata  retired; launches accept an externally prepared `ipfs://` URI
 *
 * Imports here and in everything this file reaches carry a `.js` extension: Vercel runs functions as native
 * Node modules, which resolve nothing without one. TypeScript, Vite and Bun all map `.js` back to the `.ts` file.
 *
 * Environment (set in Vercel, never in the repository):
 *   IPFS_GATEWAY  optional; the account's gateway host, e.g. example-name-123.mypinata.cloud
 */
function gateway(): string | undefined {
  const host = process.env.IPFS_GATEWAY?.trim().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : undefined
}

export function GET(): Response {
  return createMetadataService({ pinner: undefined, gateway: gateway() }).status()
}

export function POST(_request: Request): Response {
  return new Response(JSON.stringify({ error: 'Metadata uploads are disabled. Prepare and pin metadata externally, then pass its ipfs:// URI to the launch gateway or MCP server.' }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
