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
