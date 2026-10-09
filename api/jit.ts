import { createJitGate } from '../server/jit/gate.js'
import { createJitPublicClient, createJitReader } from '../src/lib/jit.js'
let gate: ReturnType<typeof createJitGate> | undefined
async function handle(request: Request): Promise<Response> {
  try { return await (gate ??= createJitGate(createJitReader({ client: createJitPublicClient(process.env.ARC_RPC_URL) })))(request) }
  catch { return Response.json({ error: 'jit_configuration', message: 'JIT read-only RPC configuration is unavailable. No transaction was signed.' }, { status: 503, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' } }) }
}
export const GET = (request: Request) => handle(request)
export const POST = (request: Request) => handle(request)
export const OPTIONS = (request: Request) => handle(request)
