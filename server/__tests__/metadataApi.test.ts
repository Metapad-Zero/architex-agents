import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cidForBytes } from '../../src/lib/cid'

const originalFetch = globalThis.fetch
const originalJwt = process.env.PINATA_JWT
const originalGateway = process.env.IPFS_GATEWAY
const outgoing: { url: string; method: string }[] = []
const details = { name: 'Smoke', symbol: 'SMK', description: 'Public API regression test.' }

beforeEach(() => {
  process.env.PINATA_JWT = 'metadata-api-test-key'
  process.env.IPFS_GATEWAY = 'example-name-123.mypinata.cloud'
  outgoing.length = 0
  // Even the vulnerable route can only pin into this fixture; no network request leaves the test.
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    outgoing.push({ url, method })
    if (url === 'https://uploads.pinata.cloud/v3/files' && method === 'POST' && init?.body instanceof FormData) {
      const file = init.body.get('file')
      if (file instanceof Blob) {
        const cid = await cidForBytes(new Uint8Array(await file.arrayBuffer()))
        return new Response(JSON.stringify({ data: { id: `fixture-${outgoing.length}`, cid } }), { headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(null, { status: 204 })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalJwt === undefined) delete process.env.PINATA_JWT
  else process.env.PINATA_JWT = originalJwt
  if (originalGateway === undefined) delete process.env.IPFS_GATEWAY
  else process.env.IPFS_GATEWAY = originalGateway
  expect(outgoing).toEqual([])
})

function post(origin?: string, body = JSON.stringify(details), query = ''): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin !== undefined) headers.set('origin', origin)
  return new Request(`https://architex.fun/api/metadata${query}`, { method: 'POST', headers, body })
}

async function expectRetired(request: Request): Promise<void> {
  const { POST } = await import('../../api/metadata')
  const usedBefore = request.bodyUsed
  const response = POST(request)
  expect(response.status).toBe(410)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json() as { error: string }
  expect(body.error).toContain('ipfs://')
  expect(body.error).toContain('launch gateway or MCP server')
  expect(request.bodyUsed).toBe(usedBefore)
}

describe('production metadata POST is retired', () => {
  test('returns 410 with omitted or forged Origin even with Pinata configured', async () => {
    for (const origin of [undefined, 'https://architex.fun', 'https://attacker.example', 'null', 'not a URL']) {
      await expectRetired(post(origin))
    }
  })

  test('query flags and spoofed client addresses cannot re-enable uploads', async () => {
    for (const query of ['?enabled=true', '?upload=true', '?PINATA_JWT=another-key', '?action=save&metadataURI=ipfs%3A%2F%2Fexample']) {
      const request = post('https://architex.fun', JSON.stringify(details), query)
      request.headers.set('x-real-ip', '192.0.2.1')
      request.headers.set('x-forwarded-for', '192.0.2.2, 192.0.2.3')
      await expectRetired(request)
    }
  })

  test('malformed, oversized and non-JSON bodies cannot reach pinning', async () => {
    for (const body of ['{not json', '[]', 'null', 'x'.repeat(400_001), JSON.stringify({ ...details, image: 'not base64' })]) {
      await expectRetired(post(undefined, body))
    }
    const plainText = post(undefined, 'token details')
    plainText.headers.set('content-type', 'text/plain')
    await expectRetired(plainText)
    const oversizedHeader = post()
    oversizedHeader.headers.set('content-length', '400001')
    await expectRetired(oversizedHeader)
    const noContentType = post()
    noContentType.headers.delete('content-type')
    await expectRetired(noContentType)
  })

  test('answers even when the request body has already been consumed', async () => {
    const request = post()
    await request.text()
    await expectRetired(request)
  })

  test('configured, empty and absent Pinata credentials all leave uploads disabled', async () => {
    for (const jwt of ['metadata-api-test-key', '', '  ', undefined]) {
      if (jwt === undefined) delete process.env.PINATA_JWT
      else process.env.PINATA_JWT = jwt
      await expectRetired(post())
    }
  })
})

describe('production metadata GET preserves discovery', () => {
  for (const [configured, expected] of [
    ['example-name-123.mypinata.cloud', 'https://example-name-123.mypinata.cloud'],
    ['https://example-name-123.mypinata.cloud', 'https://example-name-123.mypinata.cloud'],
    [' https://example-name-123.mypinata.cloud/// ', 'https://example-name-123.mypinata.cloud'],
    ['ipfs.architex.fun', 'https://ipfs.architex.fun'],
  ]) {
    test(`discovers ${configured.trim()} with uploads disabled`, async () => {
      process.env.IPFS_GATEWAY = configured
      const { GET } = await import('../../api/metadata')
      const response = GET()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('public, max-age=300')
      expect(await response.json()).toEqual({ enabled: false, gateway: expected, limits: { imageBytes: 262_144, descriptionChars: 280 } })
    })
  }

  for (const configured of ['http://example.mypinata.cloud', 'https://example.mypinata.cloud/path', 'https://user:pass@example.mypinata.cloud', 'https://example.mypinata.cloud?upload=true', 'https://example.mypinata.cloud#fragment', 'https://example.mypinata.cloud:8443', 'not a host']) {
    test(`omits invalid gateway ${configured}`, async () => {
      process.env.IPFS_GATEWAY = configured
      const { GET } = await import('../../api/metadata')
      expect(await GET().json()).toEqual({ enabled: false, gateway: null, limits: { imageBytes: 262_144, descriptionChars: 280 } })
    })
  }

  test('keeps status and limits available without Pinata or a gateway', async () => {
    delete process.env.PINATA_JWT
    delete process.env.IPFS_GATEWAY
    const { GET } = await import('../../api/metadata')
    expect(await GET().json()).toEqual({ enabled: false, gateway: null, limits: { imageBytes: 262_144, descriptionChars: 280 } })
  })
})
