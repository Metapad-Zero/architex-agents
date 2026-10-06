import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, toHex, zeroHash, type Hex, type Log, type TransactionReceipt } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import testnetDeployment from '../../../src/deployments/arc-testnet.json' with { type: 'json' }
import { refreshPending, SubmissionLane, usdcDomainSeparator, verifyExternalSettlement, viemPort, type PendingTransaction } from '../viemPort'
import { boardGateAbi, launchpadGateAbi, usdcAuthorizationAbi } from '../abi'
import type { Signed, TransactionStatus } from '../port'
import { BOARD, LAUNCHPAD, USDC } from './fakePort'

const hash: Hex = `0x${'12'.repeat(32)}`
const signed: Signed = { auth: { from: BOARD, value: 20_000n, validAfter: 0n, validBefore: 2_000_000_000n, nonce: `0x${'34'.repeat(32)}` }, signature: `0x${'ab'.repeat(65)}`, salt: zeroHash, settlementTransaction: hash }
function fixture() {
  const transaction = { hash, to: USDC, input: encodeFunctionData({ abi: usdcAuthorizationAbi, functionName: 'transferWithAuthorization', args: [signed.auth.from, LAUNCHPAD, signed.auth.value, signed.auth.validAfter, signed.auth.validBefore, signed.auth.nonce, signed.signature] }) }
  const log = (topics: unknown, data: Hex, logIndex: number): Log => ({ address: USDC, topics: topics as Log['topics'], data, logIndex, transactionHash: hash, transactionIndex: 0, blockHash: hash, blockNumber: 100n, removed: false })
  const used = log(encodeEventTopics({ abi: usdcAuthorizationAbi, eventName: 'AuthorizationUsed', args: { authorizer: BOARD, nonce: signed.auth.nonce } }), '0x', 0)
  const moved = log(encodeEventTopics({ abi: usdcAuthorizationAbi, eventName: 'Transfer', args: { from: BOARD, to: LAUNCHPAD } }), encodeAbiParameters([{ type: 'uint256' }], [signed.auth.value]), 1)
  const receipt = { status: 'success' as const, transactionHash: hash, logs: [used, moved] } as Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'>
  return { transaction, receipt }
}

const rpcServers: Server[] = []
afterEach(async () => { await Promise.all(rpcServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

/** Controlled loopback RPC exercises real viem transport, ABI decoding and deployed-readiness checks. */
async function readinessRpc() {
  const state = { domain: usdcDomainSeparator(testnetDeployment.chainId), pendingNonce: 3, minedNonce: 3, consumed: false, methods: [] as string[] }
  const bbs = getAddress(testnetDeployment.bbs)
  const originalLog = {
    address: bbs, topics: encodeEventTopics({ abi: boardGateAbi, eventName: 'ExternalSettlementRefunded', args: { from: signed.auth.from, nonce: signed.auth.nonce, settlementTransaction: hash } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [signed.auth.value]), logIndex: '0x0', transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: '0x64', removed: false,
  }
  const originalTransaction = {
    hash, to: bbs, from: BOARD, input: encodeFunctionData({ abi: boardGateAbi, functionName: 'refundExternalPayment', args: [signed.auth, signed.signature, hash] }),
    blockHash: hash, blockNumber: '0x64', transactionIndex: '0x0', nonce: '0x0', gas: '0x10000', gasPrice: '0x1', value: '0x0', type: '0x0', r: zeroHash, s: zeroHash, v: '0x1b',
  }
  const originalReceipt = {
    status: '0x1', transactionHash: hash, blockHash: hash, blockNumber: '0x64', transactionIndex: '0x0', from: BOARD, to: bbs,
    cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null, type: '0x0', logsBloom: `0x${'00'.repeat(256)}`, logs: [originalLog],
  }
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  function result(method: string, params: unknown[]): unknown {
    state.methods.push(method)
    if (method === 'eth_chainId') return toHex(testnetDeployment.chainId)
    if (method === 'eth_getCode') return '0x60006000'
    if (method === 'eth_getBalance') return '0x1'
    if (method === 'eth_getTransactionCount') return toHex(params[1] === 'pending' ? state.pendingNonce : state.minedNonce)
    if (method === 'eth_blockNumber') return '0x64'
    if (method === 'eth_getTransactionByHash') return originalTransaction
    if (method === 'eth_getTransactionReceipt') return originalReceipt
    if (method === 'eth_getLogs') {
      const query = params[0]
      return record(query) && Array.isArray(query.topics) && query.topics[0] === originalLog.topics[0] ? [originalLog] : []
    }
    if (method === 'eth_call') {
      const call = params[0]
      if (!record(call) || typeof call.data !== 'string' || !call.data.startsWith('0x')) throw new Error('Invalid fixture call.')
      const decoded = decodeFunctionData({ abi: [...usdcAuthorizationAbi, ...launchpadGateAbi, ...boardGateAbi], data: call.data as Hex })
      switch (decoded.functionName) {
        case 'name': return encodeAbiParameters([{ type: 'string' }], ['USDC'])
        case 'version': return encodeAbiParameters([{ type: 'string' }], ['2'])
        case 'decimals': return encodeAbiParameters([{ type: 'uint8' }], [6])
        case 'DOMAIN_SEPARATOR': return encodeAbiParameters([{ type: 'bytes32' }], [state.domain])
        case 'usdc': return encodeAbiParameters([{ type: 'address' }], [USDC])
        case 'factory': return encodeAbiParameters([{ type: 'address' }], [getAddress(testnetDeployment.factory)])
        case 'launchpad': return encodeAbiParameters([{ type: 'address' }], [getAddress(testnetDeployment.launchpad)])
        case 'launchNonce': case 'postNonce': return encodeAbiParameters([{ type: 'bytes32' }], [`0x4152435458424e44${'00'.repeat(24)}`])
        case 'isRelayer': return encodeAbiParameters([{ type: 'bool' }], [true])
        case 'paymentConsumed': return encodeAbiParameters([{ type: 'bool' }], [state.consumed])
        default: throw new Error('Unexpected fixture contract method.')
      }
    }
    throw new Error('Unexpected fixture RPC method.')
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!record(body) || typeof body.method !== 'string' || (body.params !== undefined && !Array.isArray(body.params))) throw new Error('Invalid fixture JSON RPC.')
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: result(body.method, Array.isArray(body.params) ? body.params as unknown[] : []) }))
      } catch { response.statusCode = 500; response.end('Unexpected fixture request.') }
    })
  })
  rpcServers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture RPC port.')
  const env = { ARC_NETWORK: 'testnet', ARC_RPC_URL: `http://127.0.0.1:${address.port}`, RELAYER_MODE: 'single-process', RELAYER_PRIVATE_KEY: generatePrivateKey() }
  return { state, env, bbs }
}

describe('USDC domain readiness', () => {
  test('installed viem computes the separator verified on Arc mainnet', () => {
    expect(usdcDomainSeparator(5042)).toBe('0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84')
    expect(usdcDomainSeparator(5042002) === usdcDomainSeparator(5042)).toBe(false)
  })
  test('actual port readiness accepts the installed viem domain hash and rejects a mismatched separator', async () => {
    const rpc = await readinessRpc()
    expect((await viemPort(rpc.env).readiness()).relay.ready).toBe(true)
    rpc.state.domain = zeroHash
    await expect(viemPort(rpc.env).readiness()).rejects.toThrow('USDC signing domain')
    expect(rpc.state.methods.some((method) => method.includes('send') || method.includes('sign'))).toBe(false)
  })
  test('RPC pending nonce after restart refuses unfinished retries without inventing a hash, but recovers completed originals', async () => {
    const rpc = await readinessRpc()
    rpc.state.pendingNonce++
    const port = viemPort(rpc.env)
    const ready = await port.readiness()
    expect(ready.relay.ready).toBe(false)
    expect(ready.relay.reason).toContain('unresolved relayer transaction')
    try { await port.recover({ action: 'refund', payTo: rpc.bbs }, signed); throw new Error('Expected pending nonce refusal.') } catch (error) {
      if (!(error instanceof Error) || !('status' in error) || !('code' in error) || !('details' in error)) throw error
      expect(error.status).toBe(503)
      expect(error.code).toBe('relayer_nonce_busy')
      expect(error.details).toEqual({ retryable: false })
    }
    rpc.state.consumed = true
    expect((await port.recover({ action: 'refund', payTo: rpc.bbs }, signed))?.transaction).toBe(hash)
    rpc.state.pendingNonce = rpc.state.minedNonce
    expect((await port.readiness()).relay.ready).toBe(true)
    expect(rpc.state.methods.some((method) => method.includes('send') || method.includes('sign'))).toBe(false)
  })
})

describe('exact external settlement proof', () => {
  test('accepts the exact successful direct USDC call and paired events', () => { const f = fixture(); expect(verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, f.receipt)).toBe(hash) })
  test('rejects reverted, uncorrelated or batched receipts', () => {
    const f = fixture()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, status: 'reverted' })).toThrow()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, logs: [...f.receipt.logs].reverse() })).toThrow()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, logs: [...f.receipt.logs, ...f.receipt.logs] })).toThrow()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, { ...f.transaction, to: LAUNCHPAD }, f.receipt)).toThrow()
  })
  test('requires every authorization field and signature, not just matching receipt membership', () => {
    const f = fixture()
    for (const auth of [{ ...signed.auth, value: 1n }, { ...signed.auth, validAfter: 1n }, { ...signed.auth, validBefore: 1n }, { ...signed.auth, nonce: zeroHash }, { ...signed.auth, from: LAUNCHPAD }]) expect(() => verifyExternalSettlement({ ...signed, auth }, LAUNCHPAD, f.transaction, f.receipt)).toThrow()
    expect(() => verifyExternalSettlement({ ...signed, signature: '0x00' }, LAUNCHPAD, f.transaction, f.receipt)).toThrow()
    expect(() => verifyExternalSettlement(signed, BOARD, f.transaction, f.receipt)).toThrow()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, transactionHash: zeroHash })).toThrow()
    expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, logs: [f.receipt.logs[0]] })).toThrow()
  })
  test('a cancellation or used nonce alone is never settlement evidence', () => { const f = fixture(); expect(() => verifyExternalSettlement(signed, LAUNCHPAD, f.transaction, { ...f.receipt, logs: [] })).toThrow() })
})

describe('dedicated submission lane', () => {
  test('a delayed TX1 readiness read cannot clear TX2 that started while it awaited the RPC', async () => {
    const first: PendingTransaction = { transaction: hash, data: '0x', address: LAUNCHPAD, nonce: 1 }
    const second: PendingTransaction = { ...first, transaction: zeroHash, nonce: 2 }
    const slot: { current?: PendingTransaction } = { current: first }
    let finish!: (state: TransactionStatus) => void
    const reading = refreshPending(slot, () => new Promise<TransactionStatus>((resolve) => { finish = resolve }))
    slot.current = second
    finish({ transaction: hash, status: 'confirmed' })
    expect(await reading).toBe(second)
    expect(slot.current).toBe(second)
  })
  test('clears only its observed terminal transaction and retains pending or not-found submissions', async () => {
    for (const state of ['pending', 'not_found', 'confirmed', 'reverted'] as const) {
      const original: PendingTransaction = { transaction: hash, data: '0x', address: LAUNCHPAD, nonce: 1 }
      const slot: { current?: PendingTransaction } = { current: original }
      const result = await refreshPending(slot, () => Promise.resolve({ transaction: hash, status: state }))
      expect(result).toEqual(state === 'pending' || state === 'not_found' ? original : undefined)
    }
  })
  test('rejects concurrent work immediately, without a second submission or queue', async () => {
    const lane = new SubmissionLane()
    let finish!: () => void
    let sent = 0
    const first = lane.run(async () => { sent++; await new Promise<void>((resolve) => { finish = resolve }); return 'confirmed' })
    expect(lane.busy).toBe(true)
    await expect(lane.run(() => { sent++; return Promise.resolve('second') })).rejects.toThrow('relayer is busy')
    expect(sent).toBe(1)
    finish()
    expect(await first).toBe('confirmed')
    expect(lane.busy).toBe(false)
  })
  test('releases a failed operation for the next explicitly requested attempt', async () => {
    const lane = new SubmissionLane()
    await expect(lane.run(() => Promise.reject(new Error('simulation refused')))).rejects.toThrow('simulation refused')
    expect(await lane.run(() => Promise.resolve('next'))).toBe('next')
  })
  test('rejects network typos before any client or signature is created', () => { expect(() => viemPort({ ARC_NETWORK: 'maninet' })).toThrow('ARC_NETWORK') })
})
