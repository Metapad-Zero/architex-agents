import { createJitReader, JitError, jitAddress, jitHash, jitObject, type JitReader, type JitSwapInput } from '../../src/lib/jit.js'
const MAX_BODY = 32_768
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' }
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new JitError(400, 'invalid_content_type', 'Use application/json.')
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new JitError(413, 'jit_body_too_large', 'JIT request body exceeds 32768 bytes.')
  const reader = request.body?.getReader()
  if (!reader) throw new JitError(400, 'invalid_request', 'JSON body is required.')
  const chunks: Uint8Array[] = []; let length = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    length += chunk.value.byteLength
    if (length > MAX_BODY) { await reader.cancel(); throw new JitError(413, 'jit_body_too_large', 'JIT request body exceeds 32768 bytes.') }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new JitError(400, 'invalid_request', 'Body must be valid UTF-8 JSON.') }
  return jitObject(parsed)
}
function decimal(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new JitError(400, 'invalid_amount', `${field} must be a decimal string.`)
  return value
}
function route(request: Request) {
  const url = new URL(request.url), path = url.pathname === '/api/jit' ? `/jit/${url.searchParams.get('path') ?? ''}` : url.pathname
  return { path: path.replace(/\/$/, ''), url }
}
/** This endpoint prepares unsigned calls only. No signing key, payment signature or relayer is accepted. */
export function createJitGate(reader: JitReader = createJitReader()) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    try {
      const { path, url } = route(request)
      if (request.method === 'GET') {
        if (path === '/jit') return Response.json(await reader.index(), { headers })
        if (path === '/jit/launches') {
          const countText = url.searchParams.get('count') ?? '20'
          if (!/^\d{1,2}$/.test(countText)) throw new JitError(400, 'invalid_page', 'count must be an integer from 1 to 50.')
          return Response.json(await reader.list(url.searchParams.get('start') ?? '0', Number(countText)), { headers })
        }
        if (path.startsWith('/jit/launches/')) return Response.json(await reader.detail(jitHash(path.slice('/jit/launches/'.length), 'launchId')), { headers })
        if (path.startsWith('/jit/transactions/')) return Response.json(await reader.transaction(jitHash(path.slice('/jit/transactions/'.length), 'transaction')), { headers })
        throw new JitError(404, 'jit_route_not_found', 'Unknown JIT read endpoint.')
      }
      if (request.method !== 'POST') throw new JitError(405, 'jit_method', 'Use GET for reads or POST for unsigned preparation.')
      const v = await body(request), payer = jitAddress(v.payer ?? v.creator, 'payer')
      if (v.signature !== undefined || v.privateKey !== undefined || request.headers.has('PAYMENT-SIGNATURE')) throw new JitError(400, 'jit_direct_wallet', 'JIT uses locally signed wallet transactions. This API accepts no keys or payment signatures.')
      let result: unknown
      if (path === '/jit/prepare-launch') result = await reader.prepareLaunch(payer, v.config)
      else if (path === '/jit/prepare-approval') {
        const target = jitObject(v.target, 'target')
        if (target.kind !== 'launch' && target.kind !== 'deposit' && target.kind !== 'swap') throw new JitError(400, 'invalid_target', 'Approval target must be launch, deposit or swap.')
        result = await reader.prepareApproval(payer, { kind: target.kind, launchId: target.launchId === undefined ? undefined : jitHash(target.launchId, 'launchId') }, jitAddress(v.currency, 'currency'), decimal(v.amount, 'amount'))
      } else if (path === '/jit/prepare-deposit') result = await reader.prepareDeposit(payer, jitHash(v.launchId, 'launchId'), jitAddress(v.currency, 'currency'), decimal(v.amount, 'amount'))
      else if (path === '/jit/quote-swap' || path === '/jit/prepare-swap') {
        const input: JitSwapInput = { payer, launchId: jitHash(v.launchId, 'launchId'), inputCurrency: jitAddress(v.inputCurrency, 'inputCurrency'), amount: decimal(v.amount, 'amount'), minimumOutput: decimal(v.minimumOutput, 'minimumOutput'), recipient: jitAddress(v.recipient, 'recipient'), sqrtPriceLimitX96: decimal(v.sqrtPriceLimitX96, 'sqrtPriceLimitX96'), deadline: decimal(v.deadline, 'deadline') }
        result = await reader.quoteSwap(input)
      } else if (path === '/jit/prepare-claim') result = await reader.prepareClaim(payer, jitHash(v.launchId, 'launchId'), jitAddress(v.currency, 'currency'), decimal(v.amount, 'amount'))
      else if (path === '/jit/prepare-collect') result = await reader.prepareCollect(payer, jitHash(v.launchId, 'launchId'))
      else throw new JitError(404, 'jit_route_not_found', 'Unknown JIT preparation endpoint.')
      return Response.json(result, { headers })
    } catch (error) {
      if (error instanceof JitError) return Response.json({ error: error.code, message: error.message }, { status: error.status, headers })
      // Native/provider exceptions can contain payloads; expose a bounded error without logging them.
      return Response.json({ error: 'jit_rpc', message: 'JIT chain read or simulation failed. No transaction was signed or broadcast.' }, { status: 502, headers })
    }
  }
}
