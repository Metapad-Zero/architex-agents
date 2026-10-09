import { expect, test } from 'bun:test'
import { createJitGate } from '../gate.js'
import { createJitReader, jitObject, JIT_USDC } from '../../../src/lib/jit.js'
import { fixtureAddresses, fixtureLaunchInput, jitRpcFixture } from '../../../src/lib/__tests__/jit.test.js'
const origin='https://agents.test'
function post(path:string,value:unknown,extra:Record<string,string>={}) { return new Request(`${origin}/jit/${path}`,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(value)}) }
async function parsed(response:Response) { const value:unknown=await response.json();return jitObject(value) }
test('keyless API returns genuine unavailable index200 and list503 independently of legacy',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(createJitReader({client:rpc.client}))
  const index=await gate(new Request(`${origin}/jit`));expect(index.status).toBe(200)
  expect(jitObject((await parsed(index)).readiness).ready).toBe(false)
  const page=await gate(new Request(`${origin}/jit/launches`));expect(page.status).toBe(503);expect((await parsed(page)).error).toBe('jit_unavailable')
  expect(rpc.state.methods).toHaveLength(0);expect(page.headers.get('access-control-allow-origin')).toBe('*')
})
test('Vercel rewrite routes use the same bounded snapshot registry reads',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader),response=await gate(new Request(`${origin}/api/jit?path=launches&start=50&count=20`)),page=await parsed(response)
  expect(response.status).toBe(200);expect(page.start).toBe('50');expect(page.count).toBe(10);expect(page.nextStart).toBeNull()
  expect(rpc.state.callNames.filter(n=>n==='getLaunch')).toHaveLength(10);expect(rpc.state.methods.includes('eth_getLogs')).toBe(false)
})
test('API refuses oversize and malformed JSON before RPC and preserves CORS',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader)
  for(const request of [post('prepare-launch',{payer:fixtureAddresses.creator,config:fixtureLaunchInput()}, {'content-length':'32769'}),post('prepare-launch',{huge:'x'.repeat(32769)})]) {const r=await gate(request);expect(r.status).toBe(413);expect(r.headers.get('access-control-allow-origin')).toBe('*')}
  const invalid=await gate(new Request(`${origin}/jit/prepare-launch`,{method:'POST',headers:{'content-type':'application/json'},body:'{' }));expect(invalid.status).toBe(400)
  expect(rpc.state.methods).toHaveLength(0)
})
test('API accepts neither private keys nor payment signatures and never broadcasts',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader)
  for(const request of [post('prepare-approval',{payer:fixtureAddresses.creator,privateKey:'fixture-only',target:{kind:'launch'},currency:JIT_USDC,amount:'1'}),post('prepare-approval',{payer:fixtureAddresses.creator,target:{kind:'launch'},currency:JIT_USDC,amount:'1'},{'PAYMENT-SIGNATURE':'fixture-only'})]) {const r=await gate(request);expect(r.status).toBe(400);expect((await parsed(r)).error).toBe('jit_direct_wallet')}
  expect(rpc.state.methods).toHaveLength(0);expect(rpc.state.sent).toBe(0)
})
test('API prepares finite unsigned approvals and refuses arbitrary targets, currency and unlimited amount',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader),p=fixtureAddresses.creator
  const ok=await gate(post('prepare-approval',{payer:p,target:{kind:'launch'},currency:JIT_USDC,amount:'1'}));expect(ok.status).toBe(200)
  expect(jitObject((await parsed(ok)).transaction).to).toBe(JIT_USDC)
  for(const value of [{payer:p,target:{kind:'arbitrary'},currency:JIT_USDC,amount:'1'},{payer:p,target:{kind:'launch'},currency:fixtureAddresses.token,amount:'1'},{payer:p,target:{kind:'launch'},currency:JIT_USDC,amount:((1n<<256n)-1n).toString()}]) expect((await gate(post('prepare-approval',value))).status).toBe(400)
  expect(rpc.state.sent).toBe(0)
})
test('API normalizes launch terms but refuses insufficient initial JIT capital before approval',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader),response=await gate(post('prepare-launch',{creator:fixtureAddresses.creator,config:fixtureLaunchInput()})),prepared=await parsed(response)
  expect(response.status).toBe(200);expect(jitObject(prepared.config).seedUsdc).toBe('10');expect(jitObject(prepared.prediction).launchId).toBe(rpc.id)
  const bad=await gate(post('prepare-launch',{creator:fixtureAddresses.creator,config:{...fixtureLaunchInput(),seedUsdc:'0.000035'}}))
  expect(bad.status).toBe(400);expect((await parsed(bad)).error).toBe('insufficient_initial_capital');expect(rpc.state.sent).toBe(0)
})
test('API refuses fractional page sizes, wrong IDs, unsupported methods and preserves options',async()=>{
  const rpc=jitRpcFixture(),gate=createJitGate(rpc.reader)
  for(const path of ['launches?count=0','launches?count=51','launches?count=2.5','launches?start=-1','launches/12']) expect((await gate(new Request(`${origin}/jit/${path}`))).status).toBe(400)
  expect((await gate(new Request(`${origin}/jit`,{method:'PUT'}))).status).toBe(405)
  expect((await gate(new Request(`${origin}/jit`,{method:'OPTIONS'}))).status).toBe(204)
  expect(rpc.state.methods).toHaveLength(0)
})
