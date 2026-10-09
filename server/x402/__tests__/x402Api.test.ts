import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GET } from '../../../api/x402'

const originalFetch = globalThis.fetch
const envKeys = ['ARC_NETWORK', 'ARC_RPC_URL', 'RELAYER_PRIVATE_KEY', 'RELAYER_SERVICE_URL', 'RELAYER_SERVICE_TOKEN'] as const
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const token = 'a'.repeat(40)
const outgoing: { url: string; method: string; authorization: string | null }[] = []
const snapshot = { blockNumber: '123456', fetchedAt: '2023-11-14T22:13:20.000Z', ageSeconds: 2, ttlSeconds: 15 }

beforeEach(() => {
  process.env.ARC_NETWORK = 'mainnet'
  process.env.ARC_RPC_URL = 'https://unused-rpc.example'
  delete process.env.RELAYER_PRIVATE_KEY
  process.env.RELAYER_SERVICE_URL = 'https://relay.example'
  process.env.RELAYER_SERVICE_TOKEN = token
  outgoing.length = 0
  // The production entry point is exercised directly; all outbound traffic stays in this fixture.
  globalThis.fetch = (input, init) => {
    outgoing.push({ url: input instanceof Request ? input.url : String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
    return Promise.resolve(Response.json({ total: 101, count: 1, completeHistory: false, messages: [], snapshot }, { headers: { 'cache-control': 'public, max-age=13, s-maxage=13' } }))
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const read = (path: string) => GET(new Request(`https://agents.example${path}`))

describe('serverless public board forwarding', () => {
  test('forwards every board alias before constructing the undeployed mainnet port', async () => {
    const local = await read('/x402')
    expect(local.status).toBe(503)
    expect((await local.json() as { error: string }).error).toBe('not_configured')
    expect(outgoing).toHaveLength(0)
    for (const [path, count] of [
      ['/x402/bbs', null],
      ['/x402/bbs/?count=0&cacheBust=first', '0'],
      ['/api/x402/bbs?count=1&_=second', '1'],
      ['/api/x402/bbs/?count=100', '100'],
      ['/api/x402?path=bbs&count=999999&nonce=third', '999999'],
      ['/api/x402?path=bbs%2F&count=1', '1'],
      ['/api/x402/?path=bbs/&count=100', '100'],
    ] as const) {
      const response = await read(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=13, s-maxage=13')
      expect(await response.json()).toEqual({ total: 101, count: 1, completeHistory: false, messages: [], snapshot })
      const sent = outgoing[outgoing.length - 1]
      const url = new URL(sent.url)
      expect(url.origin).toBe('https://relay.example')
      expect(url.pathname).toBe('/internal/gate')
      expect([...url.searchParams.entries()]).toEqual(count === null ? [['path', 'bbs']] : [['path', 'bbs'], ['count', count]])
      expect(sent.method).toBe('GET')
      expect(sent.authorization).toBe(`Bearer ${token}`)
    }
    expect(outgoing).toHaveLength(7)
  })

  test('board reads still forward when malformed local network configuration would reject port construction', async () => {
    process.env.ARC_NETWORK = 'maninet'
    expect((await read('/x402')).status).toBe(503)
    expect(outgoing).toHaveLength(0)
    const board = await read('/api/x402?path=bbs&count=1')
    expect(board.status).toBe(200)
    expect((await board.json() as { snapshot: typeof snapshot }).snapshot).toEqual(snapshot)
    expect(outgoing).toHaveLength(1)
  })

  test('missing service configuration returns the forwarding refusal without local fallback', async () => {
    for (const [url, credential] of [[undefined, token], ['https://relay.example', undefined], ['https://relay.example', 'short']] as const) {
      if (url === undefined) delete process.env.RELAYER_SERVICE_URL
      else process.env.RELAYER_SERVICE_URL = url
      if (credential === undefined) delete process.env.RELAYER_SERVICE_TOKEN
      else process.env.RELAYER_SERVICE_TOKEN = credential
      const response = await read('/x402/bbs?count=0')
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await response.json() as { error: string }).error).toBe('relayer_service_not_configured')
    }
    expect(outgoing).toHaveLength(0)
  })

  test('returns remote validation, quota and unavailable responses without fallback or header changes', async () => {
    for (const [status, error] of [[400, 'invalid_field'], [429, 'history_rate_limited'], [503, 'contracts_unavailable']] as const) {
      globalThis.fetch = () => Promise.resolve(Response.json({ ok: false, error, retryAfter: 11 }, { status, headers: { 'cache-control': 'no-store', 'retry-after': '11' } }))
      const response = await read('/api/x402?path=bbs&count=1.5')
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('retry-after')).toBe('11')
      expect(await response.json()).toEqual({ ok: false, error, retryAfter: 11 })
    }
  })

  test('transport errors return the forwarding error without invoking local board history', async () => {
    let sent = 0
    globalThis.fetch = () => { sent++; return Promise.reject(new Error('fixture connection lost')) }
    const response = await read('/api/x402/bbs/?count=100')
    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json() as { error: string }).error).toBe('relayer_transport_unknown')
    expect(sent).toBe(1)
  })
})
