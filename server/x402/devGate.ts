import { loadEnv, type Connect, type Plugin } from 'vite'
import { createGate, type Gate } from './gate.js'
import type { ChainPort } from './port.js'
import { viemPort } from './viemPort.js'
import { GateError } from './errors.js'

/**
 * The x402 gate under `vite dev`, the same code the deployed function runs, against the real chain.
 *
 * The relayer key is read from `.env.local` by name and handed to the server side only; it is not
 * a `VITE_` variable, so it can never reach the browser bundle. Nothing here is built or deployed.
 */
async function readBody(req: Connect.IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const value of req) {
    const item: unknown = value
    if (!(item instanceof Uint8Array)) throw new GateError(400, 'invalid_body', 'Expected a byte stream.')
    size += item.byteLength
    if (size > 16_384) throw new GateError(413, 'body_too_large', 'The request body is limited to 16384 bytes.')
    chunks.push(new Uint8Array(item))
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export function devGate(): Plugin {
  let gate: Gate | undefined
  return {
    name: 'architex-dev-gate',
    apply: 'serve',
    configResolved(config) {
      const env = { ...process.env, ...loadEnv(config.mode, config.root, '') }
      let port: ChainPort | undefined
      gate = createGate(() => (port ??= viemPort(env)))
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void (async () => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
          const ours = url.pathname === '/x402' || url.pathname.startsWith('/x402/') || url.pathname === '/openapi.json'
          if (!ours || !gate) return next()
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value)
          const method = req.method ?? 'GET'
          const body = method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : ((await readBody(req)) as BodyInit)
          const response = await gate(new Request(url, { method, headers, body }))
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        })().catch((error: unknown) => {
          if (!(error instanceof GateError)) return next(error)
          res.statusCode = error.status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: error.code, message: error.message }))
        })
      })
    },
  }
}
