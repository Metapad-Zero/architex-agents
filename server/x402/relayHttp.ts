import { createServer, type IncomingMessage } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { routeOf, type Gate } from './gate.js'

type Env = Record<string, string | undefined>
const LIMIT = 16_384

export function relayOrigin(value: string | undefined): string {
  if (!value) throw new Error('RELAYER_SERVICE_URL is not configured.')
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('RELAYER_SERVICE_URL must be an HTTPS origin (or loopback HTTP for local verification).')
  return url.origin
}

function tokenOf(env: Env): string {
  const token = env.RELAYER_SERVICE_TOKEN?.trim()
  if (!token || token.length < 32) throw new Error('RELAYER_SERVICE_TOKEN must contain at least 32 characters.')
  return token
}

function answer(status: number, error: string, message: string): Response {
  return Response.json({ ok: false, error, message }, { status, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'payment-required, payment-response' } })
}

/** Vercel holds the service credential, never the EOA key. A transport failure never creates a fresh authorization. */
export async function forwardToRelayer(request: Request, env: Env, send: typeof fetch = fetch): Promise<Response> {
  let origin: string
  let token: string
  try { origin = relayOrigin(env.RELAYER_SERVICE_URL); token = tokenOf(env) } catch { return answer(503, 'relayer_service_not_configured', 'The dedicated relayer service is not configured.') }
  const path = routeOf(request)
  const target = new URL('/internal/gate', origin)
  target.searchParams.set('path', path.replace(/^\/x402\/?/, ''))
  // Preserve board count across direct/API/rewrite forms; unrelated query keys cannot split its cache.
  if (request.method === 'GET' && path === '/x402/bbs') {
    const count = new URL(request.url).searchParams.get('count')
    if (count !== null) target.searchParams.set('count', count)
  }
  const headers = new Headers({ authorization: `Bearer ${token}` })
  for (const name of ['content-type', 'payment-signature']) { const value = request.headers.get(name); if (value) headers.set(name, value) }
  try {
    return await send(target.href, { method: request.method, headers, ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}), signal: AbortSignal.timeout(48_000), redirect: 'error' })
  } catch {
    return answer(502, 'relayer_transport_unknown', 'The relayer connection ended without a definitive result. Retry only the original PAYMENT-SIGNATURE or inspect its on-chain authorization; do not sign a new payment.')
  }
}

async function bodyOf(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const value of request) {
    const item: unknown = value
    if (!(item instanceof Uint8Array) && typeof item !== 'string') throw new Error('invalid_body')
    const chunk = typeof item === 'string' ? new TextEncoder().encode(item) : new Uint8Array(item)
    size += chunk.byteLength
    if (size > LIMIT) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}

/** One process and one instance per exclusive relayer EOA. The ChainPort owns its bounded transaction lane. */
export function createRelayerServer(options: { gate: Gate; token: string; publicOrigin: string }) {
  if (options.token.length < 32) throw new Error('The service token must contain at least 32 characters.')
  const publicOrigin = relayOrigin(options.publicOrigin)
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest()
  return createServer((incoming, outgoing) => {
    void (async () => {
      const provided = createHash('sha256').update(incoming.headers.authorization ?? '').digest()
      let response: Response
      if (!timingSafeEqual(expected, provided)) response = answer(401, 'unauthorized', 'A valid relay service credential is required.')
      else if (!incoming.url?.startsWith('/internal/gate?')) response = answer(404, 'not_found', 'This service accepts the authenticated gate route only.')
      else {
        const method = incoming.method ?? 'GET'
        const headers = new Headers()
        for (const name of ['content-type', 'payment-signature']) { const value = incoming.headers[name]; if (typeof value === 'string') headers.set(name, value) }
        const body = method === 'GET' || method === 'OPTIONS' || method === 'HEAD' ? undefined : await bodyOf(incoming)
        response = await options.gate(new Request(new URL(incoming.url, publicOrigin), { method, headers, body: body as BodyInit | undefined }))
      }
      outgoing.statusCode = response.status
      response.headers.forEach((value, key) => outgoing.setHeader(key, value))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })().catch((error: unknown) => {
      outgoing.statusCode = error instanceof Error && error.message === 'body_too_large' ? 413 : 502
      outgoing.setHeader('content-type', 'application/json')
      outgoing.setHeader('access-control-allow-origin', '*')
      outgoing.end(JSON.stringify({ ok: false, error: outgoing.statusCode === 413 ? 'body_too_large' : 'relay_failed', message: 'The service could not complete this request. Keep the original authorization for recovery.' }))
    })
  })
}
