import { loadEnv, type Connect, type Plugin } from 'vite'
import { createJitPublicClient, createJitReader, JitError } from '../../src/lib/jit.js'
import { createJitGate } from './gate.js'

async function readBody(request: Connect.IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const value of request) {
    const chunk: unknown = value
    if (!(chunk instanceof Uint8Array)) throw new JitError(400, 'invalid_request', 'Expected a byte stream.')
    size += chunk.byteLength
    if (size > 32_768) throw new JitError(413, 'jit_body_too_large', 'JIT request body exceeds 32768 bytes.')
    chunks.push(new Uint8Array(chunk))
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** Local development and preview use the same keyless JIT gate as the deployed API. */
export function devJitGate(): Plugin {
  let gate: ReturnType<typeof createJitGate> | undefined
  let rpcUrl: string | undefined
  const mount = (middlewares: Connect.Server) => {
    middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/jit' && !url.pathname.startsWith('/jit/') && url.pathname !== '/api/jit') return next()
      void (async () => {
        gate ??= createJitGate(createJitReader({ client: createJitPublicClient(rpcUrl) }))
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
        const method = request.method ?? 'GET'
        const body = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : await readBody(request) as BodyInit
        const result = await gate(new Request(url, { method, headers, body }))
        response.statusCode = result.status
        result.headers.forEach((value, name) => response.setHeader(name, value))
        response.end(Buffer.from(await result.arrayBuffer()))
      })().catch((error: unknown) => {
        const known = error instanceof JitError
        response.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ error: known ? error.code : 'jit_configuration', message: known ? error.message : 'The local keyless JIT service is unavailable.' }))
      })
    })
  }
  return {
    name: 'architex-dev-jit-gate',
    apply: 'serve',
    configResolved(config) { rpcUrl = process.env.ARC_RPC_URL ?? loadEnv(config.mode, config.root, 'ARC_').ARC_RPC_URL },
    configureServer(server) { mount(server.middlewares) },
    configurePreviewServer(server) { mount(server.middlewares) },
  }
}
