import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { custom, keccak256, toHex, type Hex } from 'viem'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../index.js'
import { checkJitBudget, createJitTools, jitBudgets, JIT_JOURNAL_CAPACITY } from '../jit.js'
import { jitObject, JIT_USDC } from '../../../src/lib/jit.js'
import { approvalPrepared, fixtureAddresses, jitRpcFixture } from '../../../src/lib/__tests__/jit.test.js'
const directories:string[]=[]
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})))})
const requestId=(value:bigint)=>toHex(value,{size:32})
async function walletFixture() {
  const directory=await mkdtemp(join(tmpdir(),'architex-jit-wallet-'));directories.push(directory)
  const rpc=jitRpcFixture(),account=privateKeyToAccount(generatePrivateKey());rpc.state.payer=account.address
  const env={ARC_NETWORK:'mainnet',AGENT_ALLOW_MAINNET:'1',AGENT_MAX_PAYMENT_USDC:'2',AGENT_MAX_GAS_USDC:'0.001',AGENT_JIT_STATE_DIR:directory}
  const options={env,reader:rpc.reader,wallet:()=>({account}),walletTransport:custom({request:rpc.request},{retryCount:0})}
  return {rpc,account,env,options,tools:createJitTools(options),path:join(directory,`5042-${account.address.toLowerCase()}.json`)}
}
async function journal(path:string){const value:unknown=JSON.parse(await readFile(path,'utf8'));return jitObject(value)}
test('JIT budgets require explicit capital+gas and cannot double-count the Arc balance',()=>{
  expect(()=>jitBudgets({})).toThrow('explicit');expect(()=>jitBudgets({AGENT_MAX_PAYMENT_USDC:'1',AGENT_MAX_GAS_USDC:'0'})).toThrow('greater than zero')
  const prepared=approvalPrepared(fixtureAddresses.creator),limits=jitBudgets({AGENT_MAX_PAYMENT_USDC:'1',AGENT_MAX_GAS_USDC:'0.1'})
  expect(()=>checkJitBudget(prepared,limits,1n,10n**18n)).toThrow('same underlying')
  expect(()=>checkJitBudget(prepared,limits,10n**18n,2n*10n**18n)).toThrow('maximum transaction gas')
  checkJitBudget(prepared,limits,1n,10n**18n+1n)
  expect(()=>checkJitBudget({...prepared,usdcCommitted:{raw:'1000001',formatted:'1.000001'}},limits,1n,3n*10n**18n)).toThrow('ceiling')
})
test('opt-in and explicit budgets refuse signing before RPC preparation',async()=>{
  const f=await walletFixture();f.env.AGENT_ALLOW_MAINNET='0'
  await expect(f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('AGENT_ALLOW_MAINNET')
  f.env.AGENT_ALLOW_MAINNET='1';f.env.AGENT_MAX_GAS_USDC=''
  await expect(f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('explicit')
  expect(f.rpc.state.methods).toHaveLength(0);expect(f.rpc.state.sent).toBe(0)
})
test('signing persists exact original bytes/hash before possible broadcast and restart blocks new IDs',async()=>{
  const f=await walletFixture();f.rpc.state.broadcastUnknown=true
  f.rpc.state.beforeResult=async(method,params)=>{
    if(method==='eth_sendRawTransaction') {const active=jitObject((await journal(f.path)).active);if(typeof params[0]!=='string')throw new Error('Missing signed fixture bytes');expect(active.transaction).toBe(keccak256(params[0] as Hex));expect(active.serializedTransaction).toBe(params[0])}
  }
  const first=await f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');expect(first.status).toBe('pending');expect(f.rpc.state.sent).toBe(1)
  f.rpc.state.beforeResult=undefined
  const restarted=createJitTools(f.options),retry=await restarted.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')
  expect(retry.transaction).toBe(first.transaction);expect(f.rpc.state.sent).toBe(1)
  const blocked=await restarted.approve(requestId(2n),{kind:'launch'},JIT_USDC,'1');expect(blocked.transaction).toBe(first.transaction);expect(f.rpc.state.sent).toBe(1)
  await expect(restarted.approve(requestId(1n),{kind:'launch'},JIT_USDC,'2')).rejects.toThrow('different original')
})
test('confirmed original receipt resolves the journal after restart and exact request retries never sign again',async()=>{
  const f=await walletFixture();f.rpc.state.broadcastUnknown=true
  const first=await f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');f.rpc.state.confirmed=true
  const restarted=createJitTools(f.options),resolved=await restarted.check()
  expect(resolved.status).toBe('confirmed');expect(jitObject(jitObject(resolved).result).amountRaw).toBe('1000000');expect((await journal(f.path)).active).toBeNull()
  const repeat=await restarted.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');expect(repeat.transaction).toBe(first.transaction);expect(f.rpc.state.sent).toBe(1)
})
test('receipt hash or operation mismatch keeps the original lane blocked',async()=>{
  for(const mismatch of ['hashMismatch','receiptMismatch'] as const) {
    const f=await walletFixture();f.rpc.state.broadcastUnknown=true;await f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');f.rpc.state.confirmed=true;f.rpc.state[mismatch]=true
    await expect(createJitTools(f.options).check()).rejects.toThrow(mismatch==='hashMismatch'?'disagrees':'exact requested')
    expect((await journal(f.path)).active).not.toBeNull();expect(f.rpc.state.sent).toBe(1)
  }
})
test('wallet pending nonce or late nonce change blocks fresh signing even without an active journal',async()=>{
  const f=await walletFixture();f.rpc.state.pendingNonce=1
  await expect(f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('pending transaction outside')
  f.rpc.state.pendingNonce=0;f.rpc.state.beforeResult=async(method)=>{await Promise.resolve();if(method==='eth_estimateGas')f.rpc.state.pendingNonce=1}
  await expect(f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('changed during preparation')
  expect(f.rpc.state.sent).toBe(0)
})
test('filesystem admission serializes concurrent wallet processes and never has an unbounded queue',async()=>{
  const f=await walletFixture();f.rpc.state.broadcastUnknown=true
  let entered!:()=>void,release!:()=>void
  const admitted=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
  f.rpc.state.beforeResult=async(method)=>{if(method==='eth_estimateGas'){entered();await hold}}
  const first=f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');await admitted
  await expect(createJitTools(f.options).approve(requestId(2n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('nonce lane')
  release();await first;expect(f.rpc.state.sent).toBe(1)
})
test('retained request tombstones survive more than32 operations and full capacity refuses fresh spending',async()=>{
  const f=await walletFixture();f.rpc.state.confirmed=true
  const original=await f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1'),j=await journal(f.path)
  if(!Array.isArray(j.resolved))throw new Error('Missing resolved journal')
  const first=jitObject(j.resolved[0]);j.resolved=Array.from({length:JIT_JOURNAL_CAPACITY},(_,i)=>({...first,requestId:requestId(BigInt(i+1))}))
  await writeFile(f.path,JSON.stringify(j),{mode:0o600})
  const restarted=createJitTools(f.options),retry=await restarted.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1')
  expect(retry.transaction).toBe(original.transaction);expect(f.rpc.state.sent).toBe(1)
  await expect(restarted.approve(requestId(2000n),{kind:'launch'},JIT_USDC,'1')).rejects.toThrow('retention is full')
  expect(f.rpc.state.sent).toBe(1)
})
test('actual MCP protocol exposes distinct gas-paying tools and keyless unavailable readiness',async()=>{
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),server=createMcpServer(),client=new Client({name:'jit-protocol-check',version:'1'})
  try {
    await Promise.all([server.connect(serverTransport),client.connect(clientTransport)])
    const list=await client.listTools();expect(list.tools.find(t=>t.name==='create_jit_launch')?.annotations?.destructiveHint).toBe(true)
    expect(list.tools.find(t=>t.name==='get_jit')?.annotations?.readOnlyHint).toBe(true);expect(list.tools.some(t=>t.name==='launch_token')).toBe(true)
    const ready=await client.callTool({name:'get_jit',arguments:{}});expect(ready.isError).not.toBe(true);expect(jitObject(jitObject(ready.structuredContent).readiness).ready).toBe(false)
    const invalid=await client.callTool({name:'create_jit_launch',arguments:{requestId:'12',config:{}}});expect(invalid.isError).toBe(true)
  } finally {await client.close();await server.close()}
})

test('original reconciliation refuses wrong-chain RPC and records actual gas on a confirmed revert',async()=>{
  const f=await walletFixture();f.rpc.state.broadcastUnknown=true
  await f.tools.approve(requestId(1n),{kind:'launch'},JIT_USDC,'1');f.rpc.state.confirmed=true;f.rpc.state.chainId=1
  await expect(createJitTools(f.options).check()).rejects.toThrow('Arc mainnet');expect((await journal(f.path)).active).not.toBeNull()
  f.rpc.state.chainId=5042;f.rpc.state.reverted=true
  const result=await createJitTools(f.options).check()
  expect(result.status).toBe('reverted');expect(jitObject(jitObject(jitObject(result).result).gasCharged).raw).toBe('210000000000');expect(f.rpc.state.sent).toBe(1)
})
