import { expect, test } from 'bun:test'
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAbiItem, getAddress, keccak256, parseTransaction, toHex, zeroHash, type Abi, type Address, type Hex } from 'viem'
import { arc } from 'viem/chains'
import { TickMath } from '@uniswap/v3-sdk'
import { createJitReader, JIT_MANAGER, JIT_SUPPLY, JIT_USDC, JIT_VALID_UNTIL, jitHookPermissionValid, jitHookSalt, jitSqrtAtTick, jitPriceInsideRange, jitInitialCapital, jitLaunchId, jitManifest, jitObject, jitPoolId, mineJitHookSalt, parseJitIndex, parseJitLaunch, parseJitLaunchPage, verifyJitReceipt, type JitLaunchInput, type JitManifest, type JitPrepared } from '../jit.js'
import { jitErc20Abi, jitExecutorAbi, jitFactoryAbi, jitHookAbi, jitHookDeployerAbi, jitQuoterAbi, jitVaultAbi } from '../jitAbi.js'

export const fixtureAddresses = { creator: '0x1000000000000000000000000000000000000001', factory: '0x2000000000000000000000000000000000000001', deployer: '0x2000000000000000000000000000000000000002', token: '0x4000000000000000000000000000000000000001', vault: '0x4000000000000000000000000000000000000002', hook: '0x4000000000000000000000000000000000002ae0', executor: '0x4000000000000000000000000000000000000004' } as const
export function fixtureLaunchInput(): JitLaunchInput {
  return { name: 'Fixture', symbol: 'FIX', metadataURI: '', seedUsdc: '10', feeRecipient: fixtureAddresses.creator, poolFee: 3000, tickSpacing: 60,
    policy: { initialSqrtPriceX96: (1n << 96n).toString(), baselineLower: -600, baselineUpper: 600, jitLower: -120, jitUpper: 120, baselineLiquidity: '1000', jitLiquidity: '1000', maxJITAmount0: '1000000', maxJITAmount1: '1000000', minSwapAmount0: '0', minSwapAmount1: '0', validUntil: JIT_VALID_UNTIL.toString() }, creatorNonce: toHex(1n, { size: 32 }), hookSaltNonce: '0', deadline: '1800000000' }
}
export function fixtureApprovalTopics(owner:Address,spender:Address):[Hex,...Hex[]] {
  const topics=encodeEventTopics({abi:jitErc20Abi,eventName:'Approval',args:{owner,spender}}).map((t)=>{if(typeof t!=='string')throw new Error('Unexpected indexed fixture topic');return t})
  const [head,...tail]=topics
  if(!head)throw new Error('Missing fixture event topic')
  return [head,...tail]
}
const allAbi: Abi = [...jitFactoryAbi, ...jitHookAbi, ...jitVaultAbi, ...jitExecutorAbi, ...jitErc20Abi, ...jitQuoterAbi, ...jitHookDeployerAbi]
export function jitRpcFixture() {
  const a = fixtureAddresses, input = fixtureLaunchInput(), code: Hex = '0x60006000', runtime = keccak256(code)
  const manifest: JitManifest = { ...jitManifest, factory: a.factory, hookDeployer: a.deployer, runtimeHashes: { factory: runtime, hookDeployer: runtime, poolManager: runtime, quoter: runtime } }
  const pool = { currency0: JIT_USDC, currency1: a.token, fee: 3000, tickSpacing: 60, hooks: a.hook }, poolId = jitPoolId(pool)
  const state = { chainId: 5042, code, total: 60n, block: 100n, timestamp: 1700000000n, pendingNonce: 0, latestNonce: 0, balance: 100n * 10n ** 18n, allowance: 0n, badImmutable: false, feeRecipient: a.creator as Address, simulationFails: false, swapPartialFill: false, swapInputMismatch: false, confirmed: false, broadcastUnknown: false, sent: 0, transaction: undefined as Hex | undefined, serialized: undefined as Hex | undefined, payer: a.creator as Address, receiptMismatch: false, hashMismatch: false, reverted: false, callNames: [] as string[], methods: [] as string[], blocks: [] as unknown[], beforeResult: undefined as ((method: string, params: readonly unknown[]) => Promise<void>) | undefined }
  const id = jitLaunchId(a.creator,input.creatorNonce), configHash = toHex(99n,{size:32})
  const record = { creator: a.creator, token:a.token,vault:a.vault,hook:a.hook,executor:a.executor,poolId,configHash,seedUSDC:10_000_000n,createdAt:state.timestamp }
  const rpcBlock = () => ({ number:toHex(state.block),hash:toHex(123n,{size:32}),parentHash:zeroHash,timestamp:toHex(state.timestamp),baseFeePerGas:'0xf4240',gasLimit:'0x1c9c380',gasUsed:'0x0',difficulty:'0x0',totalDifficulty:'0x0',extraData:'0x',logsBloom:`0x${'00'.repeat(256)}`,miner:a.creator,mixHash:zeroHash,nonce:'0x0000000000000000',receiptsRoot:zeroHash,sha3Uncles:zeroHash,size:'0x1',stateRoot:zeroHash,transactionsRoot:zeroHash,transactions:[],uncles:[] })
  function result(method: string, params: readonly unknown[]): unknown {
    state.methods.push(method)
    if (method === 'eth_chainId') return toHex(state.chainId)
    if (method === 'eth_getCode') return state.code
    if (method === 'eth_blockNumber') return toHex(state.block)
    if (method === 'eth_getBlockByNumber') return rpcBlock()
    if (method === 'eth_getBalance') return toHex(state.balance)
    if (method === 'eth_getTransactionCount') return toHex(params[1] === 'pending' ? state.pendingNonce : state.latestNonce)
    if (method === 'eth_estimateGas') { if(state.simulationFails) throw new Error('fixture estimate revert'); return toHex(210000n) }
    if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') return toHex(1_000_000n)
    if (method === 'eth_getLogs') return []
    if (method === 'eth_sendRawTransaction') {
      if (typeof params[0] !== 'string' || !/^0x[0-9a-fA-F]+$/.test(params[0])) throw new Error('Invalid fixture signed bytes')
      state.serialized = params[0] as Hex; state.transaction = keccak256(state.serialized); state.sent++
      if(state.broadcastUnknown) throw new Error('Fixture transport lost after possible submission')
      if(state.confirmed) { state.latestNonce++; state.pendingNonce=state.latestNonce }
      return state.transaction
    }
    if (method === 'eth_getTransactionByHash') {
      if (!state.serialized || !state.transaction || params[0] !== state.transaction) return null
      const tx = parseTransaction(state.serialized)
      return { hash:state.transaction,from:state.payer,to:tx.to,input:tx.data,nonce:toHex(tx.nonce??0),gas:toHex(tx.gas??210000n),value:toHex(tx.value??0n),chainId:toHex(5042),type:'0x2',blockNumber:state.confirmed?toHex(state.block):null,blockHash:state.confirmed?toHex(123n,{size:32}):null,transactionIndex:state.confirmed?'0x0':null,gasPrice:toHex(tx.maxFeePerGas??1n),maxFeePerGas:toHex(tx.maxFeePerGas??1n),maxPriorityFeePerGas:toHex(tx.maxPriorityFeePerGas??1n),accessList:[],r:tx.r,s:tx.s,v:toHex(tx.v??27n),yParity:toHex(tx.yParity??0) }
    }
    if (method === 'eth_getTransactionReceipt') {
      if (!state.confirmed || !state.transaction || !state.serialized) return null
      const tx = parseTransaction(state.serialized), decoded = decodeFunctionData({abi:allAbi,data:tx.data??'0x'}), args = decoded.args??[]
      let logs: unknown[] = []
      if(decoded.functionName==='approve') {
        const owner = state.receiptMismatch ? a.factory : state.payer, spender = args[0]
        if(typeof spender!=='string') throw new Error('Invalid approval fixture')
        logs = [{ address:tx.to,topics:fixtureApprovalTopics(owner,spender as Address),data:encodeAbiParameters([{type:'uint256'}],[BigInt(String(args[1]))]),blockNumber:toHex(state.block),blockHash:toHex(123n,{size:32}),transactionHash:state.transaction,transactionIndex:'0x0',logIndex:'0x0',removed:false }]
      }
      return {transactionHash:state.hashMismatch?zeroHash:state.transaction,transactionIndex:'0x0',blockHash:toHex(123n,{size:32}),blockNumber:toHex(state.block),from:state.payer,to:tx.to,cumulativeGasUsed:toHex(210000n),gasUsed:toHex(210000n),effectiveGasPrice:toHex(1_000_000n),logsBloom:`0x${'00'.repeat(256)}`,logs,status:state.reverted?'0x0':'0x1',type:'0x2',contractAddress:null}
    }
    if(method!=='eth_call') throw new Error(`Unexpected fixture method ${method}`)
    const call=params[0]
    if(!call || typeof call!=='object' || !('data'in call) || typeof call.data!=='string' || !('to'in call) || typeof call.to!=='string') throw new Error('Invalid fixture call')
    const rawDecoded:unknown=decodeFunctionData({abi:allAbi,data:call.data as Hex})
    if(!rawDecoded || typeof rawDecoded!=='object' || !('functionName' in rawDecoded) || typeof rawDecoded.functionName!=='string')throw new Error('Invalid decoded fixture call')
    const name=rawDecoded.functionName, args:readonly unknown[]='args'in rawDecoded && Array.isArray(rawDecoded.args)?rawDecoded.args:[]
    state.callNames.push(name);state.blocks.push(params[1])
    const item=getAbiItem({abi:allAbi,name})
    if(!item || item.type!=='function') throw new Error('Invalid fixture ABI')
    const encode=(value:unknown)=>encodeAbiParameters(item.outputs,[value])
    switch(name) {
      case 'poolManager':return encode(state.badImmutable?a.factory:JIT_MANAGER)
      case 'quote':return encode(JIT_USDC)
      case 'hookDeployer':return encode(a.deployer)
      case 'POOL_FEE':return encode(3000)
      case 'TICK_SPACING':return encode(60)
      case 'TOKEN_SUPPLY':return encode(JIT_SUPPLY)
      case 'name':return encode(call.to.toLowerCase()===JIT_USDC.toLowerCase()?'USDC':'Fixture')
      case 'symbol':return encode('FIX')
      case 'version':return encode('2')
      case 'decimals':return encode(call.to.toLowerCase()===JIT_USDC.toLowerCase()?6:18)
      case 'totalSupply':return encode(JIT_SUPPLY)
      case 'balanceOf':return encode(100_000_000n)
      case 'allowance':return encode(state.allowance)
      case 'usedNonce':return encode(false)
      case 'launchesLength':return encode(state.total)
      case 'launchIdAt':return encode(toHex(BigInt(String(args[0]))+1n,{size:32}))
      case 'getLaunch':return encode(record)
      case 'predictLaunch':return encode({launchId:id,configHash,token:a.token,vault:a.vault,hook:a.hook,executor:a.executor,hookInitCodeHash:toHex(88n,{size:32})})
      case 'configHash':return encode(configHash)
      case 'hookSalt':return encode(jitHookSalt(id,BigInt(String(args[1]))))
      case 'token':return encode(a.token)
      case 'vault':return encode(a.vault)
      case 'hook':return encode(a.hook)
      case 'feeRecipient':return encode(state.feeRecipient)
      case 'currency0':return encode(JIT_USDC)
      case 'currency1':return encode(a.token)
      case 'poolId':return encode(poolId)
      case 'getPoolKey':return encode(pool)
      case 'baselineSeeded':return encode(true)
      case 'currentSqrtPriceX96':return encode(1n<<96n)
      case 'cashBalance':case 'claimBalance':case 'availableInventory':case 'principalDeposited':case 'feeCredits':case 'feesClaimed':return encode(1000n)
      case 'initialSqrtPriceX96':case 'baselineLiquidity':case 'jitLiquidity':case 'maxJITAmount0':case 'maxJITAmount1':case 'minSwapAmount0':case 'minSwapAmount1':case 'validUntil':return encode(BigInt(input.policy[name]))
      case 'baselineLower':case 'baselineUpper':case 'jitLower':case 'jitUpper':return encode(input.policy[name])
      case 'quoteExactInputSingle':return encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[1_000_000n,210000n])
      case 'swap': {
        const request=jitObject(args[0])
        if(typeof request.maximumInput!=='bigint'||typeof request.minimumOutput!=='bigint')throw new Error('Invalid fixture swap')
        if(state.allowance<request.maximumInput)throw new Error('Fixture executor allowance failure')
        if(state.swapPartialFill)throw new Error('Fixture executor full-fill refusal at price limit')
        if(request.minimumOutput>1_000_000n)throw new Error('Fixture executor minimum-output refusal')
        return encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[state.swapInputMismatch?request.maximumInput-1n:request.maximumInput,1_000_000n])
      }
      case 'approve':if(state.simulationFails)throw new Error('Fixture simulation revert');return encode(true)
      case 'launch':if(state.simulationFails)throw new Error('Fixture simulation revert');return encode(record)
      case 'deposit':case 'claimFees':case 'collectBaselineFees':return '0x'
      default:throw new Error(`Unexpected fixture function ${name}`)
    }
  }
  const request=async({method,params}:{method:string;params?:unknown})=>{const p:readonly unknown[]=Array.isArray(params)?params:[];await state.beforeResult?.(method,p);return result(method,p)}
  const transport=custom({request},{retryCount:0})
  const client=createPublicClient({chain:arc,transport}), reader=createJitReader({client,manifest})
  return {state,manifest,client,reader,request,transport,id,record,poolId}
}

export function approvalPrepared(payer:Address):JitPrepared {
  return {kind:'approve',payer,transaction:{chainId:5042,value:'0',to:JIT_USDC,data:'0x095ea7b3'},usdcCommitted:{raw:'1000000',formatted:'1'},tokenCommitted:{raw:'0',formatted:'0'},expected:{currency:JIT_USDC,spender:fixtureAddresses.factory,amount:'1000000'},simulation:{executable:true,reason:'fixture',gasEstimate:'210000'}}
}

test('unavailable mainnet JIT is independent of legacy addresses and performs no RPC',async()=>{
  const rpc=jitRpcFixture(), reader=createJitReader({client:rpc.client})
  const index=await reader.index()
  expect(index.readiness.ready).toBe(false);expect(index.contracts.factory).toBe('0x0000000000000000000000000000000000000000');expect(rpc.state.methods).toHaveLength(0)
  await expect(reader.list()).rejects.toThrow('not deployed')
})
test('actual viem readiness checks exact runtime, chain and immutable identity',async()=>{
  const rpc=jitRpcFixture();expect((await rpc.reader.index()).readiness.ready).toBe(true)
  rpc.state.code='0x6001';expect((await rpc.reader.index()).readiness.ready).toBe(false)
  rpc.state.code='0x60006000';rpc.state.badImmutable=true;expect((await rpc.reader.index()).readiness.ready).toBe(false)
  rpc.state.badImmutable=false;rpc.state.chainId=1;expect((await rpc.reader.index()).readiness.ready).toBe(false)
  expect(rpc.state.sent).toBe(0)
})
test('registry paging caps actual reads and pins one snapshot without loading detail or logs',async()=>{
  const rpc=jitRpcFixture(), page=await rpc.reader.list('0',50)
  expect(page.count).toBe(50);expect(page.total).toBe('60');expect(page.nextStart).toBe('50')
  expect(rpc.state.callNames.filter((n)=>n==='getLaunch')).toHaveLength(50)
  expect(rpc.state.callNames.filter((n)=>n==='launchIdAt')).toHaveLength(50)
  expect(rpc.state.methods.includes('eth_getLogs')).toBe(false)
  expect(rpc.state.callNames.includes('cashBalance')).toBe(false)
  expect(new Set(rpc.state.blocks)).toEqual(new Set(['0x64']))
  await expect(rpc.reader.list('0',51)).rejects.toThrow('1 to 50')
})
test('detail reads actual pool wiring, asset decimals, inventory and immutable fee recipient',async()=>{
  const rpc=jitRpcFixture(), detail=await rpc.reader.detail(rpc.id)
  expect(detail.feeRecipient).toBe(fixtureAddresses.creator);expect(detail.tokenSupply.raw).toBe(JIT_SUPPLY.toString())
  expect(detail.policy.validUntil).toBe(JIT_VALID_UNTIL.toString());expect(detail.inventory.map(i=>i.decimals)).toEqual([6,18]);expect(detail.jitInRange).toBe(true)
  expect(detail.metadataURI).toBeNull();expect(JSON.parse(JSON.stringify(detail))).toBeDefined()
})
test('quotes pin Quoter, exact payer calldata and gas estimate to the reported block',async()=>{
  const rpc=jitRpcFixture(),payer=fixtureAddresses.creator,recipient=fixtureAddresses.deployer,limit=jitSqrtAtTick(-60)
  rpc.state.allowance=1_000_000n
  const observed:{method:string;transaction:Record<string,unknown>;blockTag:unknown}[]=[],quoted:Record<string,unknown>[]=[]
  rpc.state.beforeResult=async(method,params)=>{
    await Promise.resolve()
    if(method!=='eth_call'&&method!=='eth_estimateGas')return
    const transaction=jitObject(params[0])
    if(transaction.to===rpc.record.executor&&transaction.from===payer)observed.push({method,transaction,blockTag:params[1]})
    if(method==='eth_call'&&typeof transaction.to==='string'&&transaction.to.toLowerCase()===rpc.manifest.quoter.toLowerCase()&&typeof transaction.data==='string') {
      const call=decodeFunctionData({abi:jitQuoterAbi,data:transaction.data as Hex})
      if(call.functionName==='quoteExactInputSingle') {quoted.push({transaction,blockTag:params[1],request:call.args[0]});rpc.state.block=101n}
    }
  }
  const value={launchId:rpc.id,payer,recipient,inputCurrency:JIT_USDC,amount:'1',minimumOutput:'0.0000000000005',sqrtPriceLimitX96:limit.toString(),deadline:'1800000000'}
  const result=await rpc.reader.quoteSwap(value)
  expect(result.simulation.executable).toBe(true);expect(result.quote.blockNumber).toBe('100');expect(rpc.state.block).toBe(101n)
  expect(quoted).toHaveLength(1);expect(quoted[0]?.blockTag).toBe('0x64')
  expect(quoted[0]?.request).toEqual({poolKey:{currency0:JIT_USDC,currency1:rpc.record.token,fee:3000,tickSpacing:60,hooks:getAddress(rpc.record.hook)},zeroForOne:true,exactAmount:1_000_000n,hookData:'0x'})
  expect(observed.map(c=>c.method)).toEqual(['eth_call','eth_estimateGas','eth_call'])
  for(const call of observed) {expect(call.blockTag).toBe('0x64');expect(call.transaction.data).toBe(result.transaction.data);expect(call.transaction.from).toBe(payer)}
  const decoded=decodeFunctionData({abi:jitExecutorAbi,data:result.transaction.data})
  if(decoded.functionName!=='swap')throw new Error('Expected executor swap')
  expect(decoded.args[0]).toEqual({zeroForOne:true,amountSpecified:-1_000_000n,sqrtPriceLimitX96:limit,maximumInput:1_000_000n,minimumOutput:500_000n,recipient,deadline:1_800_000_000n,allowPartialFill:false})
  expect(result.quote.exactExecutor?.amountIn.raw).toBe('1000000');expect(result.quote.exactExecutor?.amountOut.raw).toBe('1000000');expect(result.quote.partialFill).toBe(false);expect(rpc.state.sent).toBe(0)
})
test('quotes retain Quoter information but refuse executable status on allowance, fill or output failure',async()=>{
  for(const failure of ['allowance','partial','minimum'] as const) {
    const rpc=jitRpcFixture();rpc.state.allowance=failure==='allowance'?0n:1_000_000n;rpc.state.swapPartialFill=failure==='partial'
    const result=await rpc.reader.quoteSwap({launchId:rpc.id,payer:fixtureAddresses.creator,recipient:fixtureAddresses.creator,inputCurrency:JIT_USDC,amount:'1',minimumOutput:failure==='minimum'?'0.000000000002':'0.0000000000005',sqrtPriceLimitX96:jitSqrtAtTick(-60).toString(),deadline:'1800000000'})
    expect(result.simulation.executable).toBe(false);expect(result.simulation.gasEstimate).toBeNull();expect(result.quote.exactExecutor).toBeNull();expect(result.quote.amountOut.raw).toBe('1000000');expect(rpc.state.sent).toBe(0)
  }
})
test('quotes reject a purported successful executor result that does not consume exact input',async()=>{
  const rpc=jitRpcFixture();rpc.state.allowance=1_000_000n;rpc.state.swapInputMismatch=true
  await expect(rpc.reader.quoteSwap({launchId:rpc.id,payer:fixtureAddresses.creator,recipient:fixtureAddresses.creator,inputCurrency:JIT_USDC,amount:'1',minimumOutput:'0.0000000000005',sqrtPriceLimitX96:jitSqrtAtTick(-60).toString(),deadline:'1800000000'})).rejects.toThrow('full input')
  expect(rpc.state.sent).toBe(0)
})
test('launch normalization rejects precision, UTF8 overflow, invalid ranges, deadlines and mismatched permanent policy',()=>{
  const input=fixtureLaunchInput();expect(parseJitLaunch(input).input).toEqual(input)
  for(const bad of [{...input,seedUsdc:'1.0000001'},{...input,name:'é'.repeat(17)},{...input,metadataURI:'x'.repeat(257)},{...input,deadline:(1n<<64n).toString()},{...input,policy:{...input.policy,validUntil:'1700000010'}},{...input,policy:{...input.policy,baselineLower:-120}}]) expect(()=>parseJitLaunch(bad)).toThrow()
})
test('rounded baseline plus initial JIT requirements must fit seed and caps before approval',()=>{
  const config=parseJitLaunch(fixtureLaunchInput()).config, capital=jitInitialCapital(config,fixtureAddresses.token)
  expect(capital.baseline.amount0.raw).toBe('30');expect(capital.initialJit.amount0.raw).toBe('6')
  expect(()=>jitInitialCapital({...config,seedUSDC:35n},fixtureAddresses.token)).toThrow('cover rounded baseline')
  expect(()=>jitInitialCapital({...config,policy:{...config.policy,maxJITAmount0:5n}},fixtureAddresses.token)).toThrow('immutable caps')
})
test('local salt miner uses installed keccak and CREATE2 with exact factory domain',()=>{
  const prediction={launchId:jitLaunchId(fixtureAddresses.creator,toHex(1n,{size:32})),hookInitCodeHash:toHex(88n,{size:32})}, result=mineJitHookSalt(fixtureAddresses.deployer,prediction,0n,200000)
  expect(jitHookPermissionValid(result.hook)).toBe(true);expect(result.nonce).toBeGreaterThan(0n)
  expect(()=>mineJitHookSalt(fixtureAddresses.deployer,prediction,0n,200001)).toThrow('200000')
})
test('wire readiness and pages reject invented deployment success, network, money and unbounded count',async()=>{
  const rpc=jitRpcFixture(), index=await createJitReader({client:rpc.client}).index()
  expect(parseJitIndex(index)).toEqual(index)
  expect(()=>parseJitIndex({...index,readiness:{...index.readiness,ready:true,deploymentVerified:true}})).toThrow('disagree')
  expect(()=>parseJitIndex({...index,chainId:1})).toThrow('disagree')
  expect(()=>parseJitIndex({...index,tokenSupply:{raw:'1',formatted:'1'}})).toThrow('disagree')
  expect(()=>parseJitLaunchPage({start:'0',count:51,total:'60',nextStart:'51',blockNumber:'100',launches:[]})).toThrow('bounded')
})
test('receipt verification rejects wrong payer, value, recipient, origin and reverted status',()=>{
  const p=approvalPrepared(fixtureAddresses.creator), topics=fixtureApprovalTopics(fixtureAddresses.creator,fixtureAddresses.factory)
  const log={address:JIT_USDC,topics,data:encodeAbiParameters([{type:'uint256'}],[1_000_000n]),blockNumber:100n,blockHash:zeroHash,transactionHash:zeroHash,transactionIndex:0,logIndex:0,removed:false}
  verifyJitReceipt(p,{status:'success',logs:[log]})
  expect(()=>verifyJitReceipt(p,{status:'reverted',logs:[log]})).toThrow('reverted')
  expect(()=>verifyJitReceipt(p,{status:'success',logs:[{...log,address:fixtureAddresses.factory}]})).toThrow('exact requested')
  expect(()=>verifyJitReceipt(p,{status:'success',logs:[{...log,data:encodeAbiParameters([{type:'uint256'}],[2n])}]})).toThrow('exact requested')
  expect(()=>verifyJitReceipt(p,{status:'success',logs:[{...log,topics:fixtureApprovalTopics(fixtureAddresses.vault,fixtureAddresses.factory)}]})).toThrow('exact requested')
})

test('integer TickMath matches the installed upstream SDK at boundaries and every multiplier bit',()=>{
  const ticks=[0,1,-1,60,-60,600,-600,887220,-887220,887272,-887272,...Array.from({length:20},(_,bit)=>1<<bit)]
  for(const tick of ticks) if(tick<=887272) { expect(jitSqrtAtTick(tick).toString()).toBe(TickMath.getSqrtRatioAtTick(tick).toString());expect(jitSqrtAtTick(-tick).toString()).toBe(TickMath.getSqrtRatioAtTick(-tick).toString()) }
  expect(()=>jitSqrtAtTick(887273)).toThrow('range')
})

test('reported price eligibility matches strict core JIT range boundaries',()=>{
  const lower=jitSqrtAtTick(-120),upper=jitSqrtAtTick(120)
  expect(jitPriceInsideRange(lower,-120,120)).toBe(false);expect(jitPriceInsideRange(upper,-120,120)).toBe(false)
  expect(jitPriceInsideRange(lower+1n,-120,120)).toBe(true);expect(jitPriceInsideRange(upper-1n,-120,120)).toBe(true)
})
