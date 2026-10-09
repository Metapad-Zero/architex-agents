import { afterEach, expect, test } from 'bun:test'
import type { Server } from 'node:http'
import { createRelayerServer, forwardToRelayer, relayOrigin } from '../relayHttp'

const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })
const token = 'a'.repeat(40)
test('authenticates the service before a gate call and preserves the public resource origin', async () => {
  let calls = 0
  const server = createRelayerServer({ token, publicOrigin: 'https://agents.example', gate: (request) => { calls++; return Promise.resolve(Response.json({ url: request.url, signature: request.headers.get('payment-signature') })) } })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const origin = `http://127.0.0.1:${address.port}`
  expect((await fetch(`${origin}/internal/gate?path=launch`)).status).toBe(401)
  expect(calls).toBe(0)
  const response = await forwardToRelayer(new Request('https://agents.example/api/x402?path=launch', { method: 'POST', headers: { 'payment-signature': 'original' }, body: '{}' }), { RELAYER_SERVICE_URL: origin, RELAYER_SERVICE_TOKEN: token })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ url: 'https://agents.example/internal/gate?path=launch', signature: 'original' })
  expect(calls).toBe(1)
})
test('rejects credential-bearing/path origins and returns uncertainty without claiming a hash', async () => {
  for (const origin of ['http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1']) expect(() => relayOrigin(origin)).toThrow()
  const response = await forwardToRelayer(new Request('https://agents.example/x402/post', { method: 'POST', body: '{}' }), { RELAYER_SERVICE_URL: 'https://relay.example', RELAYER_SERVICE_TOKEN: token }, () => Promise.reject(new Error('connection lost')))
  expect(response.status).toBe(502)
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  const body = await response.json() as Record<string, unknown>
  expect(body.error).toBe('relayer_transport_unknown')
  expect(body.transaction).toEqual(undefined)
})

test('all board aliases forward count through the authenticated service while dropping cache-busting queries', async () => {
  let calls = 0
  const server = createRelayerServer({ token, publicOrigin: 'https://agents.example', gate: (request) => {
    calls++
    return Promise.resolve(Response.json({ url: request.url, method: request.method }, { headers: { 'cache-control': 'public, max-age=7, s-maxage=7' } }))
  } })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const env = { RELAYER_SERVICE_URL: `http://127.0.0.1:${address.port}`, RELAYER_SERVICE_TOKEN: token }
  for (const [path, count] of [
    ['/x402/bbs?count=0&_=one', '0'],
    ['/x402/bbs/?count=1&nonce=two', '1'],
    ['/api/x402/bbs?count=100&cacheBust=three', '100'],
    ['/api/x402/bbs/?count=999999', '999999'],
    ['/api/x402?path=bbs&count=1', '1'],
    ['/api/x402/?path=bbs%2F&count=100', '100'],
    ['/x402/bbs?cacheBust=default', null],
  ] as const) {
    const response = await forwardToRelayer(new Request(`https://agents.example${path}`), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=7, s-maxage=7')
    const body = await response.json() as { url: string; method: string }
    const url = new URL(body.url)
    expect(url.origin).toBe('https://agents.example')
    expect(url.pathname).toBe('/internal/gate')
    expect(url.searchParams.get('path')).toBe('bbs')
    expect(url.searchParams.get('count')).toBe(count)
    expect([...url.searchParams.keys()]).toEqual(count === null ? ['path'] : ['path', 'count'])
    expect(body.method).toBe('GET')
  }
  expect(calls).toBe(7)
})

test('preserves invalid raw board counts for gate validation and propagates quota headers unchanged', async () => {
  const env = { RELAYER_SERVICE_URL: 'https://relay.example', RELAYER_SERVICE_TOKEN: token }
  const counts: (string | null)[] = []
  const send: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    counts.push(url.searchParams.get('count'))
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('error')
    return Promise.resolve(Response.json({ error: 'history_rate_limited', retryAfter: 23 }, { status: 429, headers: { 'retry-after': '23', 'cache-control': 'no-store' } }))
  }
  for (const count of ['', '-1', '1.5', '1000000', ' ']) {
    const response = await forwardToRelayer(new Request(`https://agents.example/api/x402?path=bbs&count=${encodeURIComponent(count)}&cacheBust=ignored`), env, send)
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('23')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'history_rate_limited', retryAfter: 23 })
  }
  expect(counts).toEqual(['', '-1', '1.5', '1000000', ' '])
  await forwardToRelayer(new Request('https://agents.example/x402/post?count=100&cacheBust=ignored', { method: 'POST', headers: { 'payment-signature': 'original' }, body: '{}' }), env, (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    expect([...url.searchParams.entries()]).toEqual([['path', 'post']])
    expect(new Headers(init?.headers).get('payment-signature')).toBe('original')
    return Promise.resolve(Response.json({ ok: true }))
  })
})
