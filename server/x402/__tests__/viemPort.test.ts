import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, toHex, zeroHash, type Hex, type Log, type TransactionReceipt } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import testnetDeployment from '../../../src/deployments/arc-testnet.json' with { type: 'json' }
import { refreshPending, SubmissionLane, usdcDomainSeparator, verifyExternalSettlement, viemPort, type PendingTransaction } from '../viemPort'
import { boardGateAbi, launchpadGateAbi, usdcAuthorizationAbi } from '../abi'
import { GateError } from '../errors'
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

function boardLog(id: bigint, blockNumber: bigint, logIndex = Number(id)) {
  return {
    address: getAddress(testnetDeployment.bbs),
    topics: encodeEventTopics({ abi: boardGateAbi, eventName: 'Message', args: { from: BOARD, id } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'string' }], [1_700_000_000n + id, `message ${id}`]),
    logIndex: toHex(logIndex), transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: toHex(blockNumber), removed: false,
  }
}

/** Controlled loopback RPC exercises real viem transport, ABI decoding and deployed-readiness checks. */
async function readinessRpc() {
  const state = {
    domain: usdcDomainSeparator(testnetDeployment.chainId), pendingNonce: 3, minedNonce: 3, consumed: false, methods: [] as string[],
    head: 100n, total: 0n, messages: [] as ReturnType<typeof boardLog>[],
    countsAtBlock: new Map<bigint, bigint>(), countBlocks: [] as unknown[], logQueries: [] as { fromBlock: bigint; toBlock: bigint }[],
    failBoardReads: false, onBlockNumber: undefined as (() => void) | undefined,
    beforeResult: undefined as ((method: string, params: unknown[]) => Promise<void>) | undefined,
  }
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
    if (method === 'eth_blockNumber') {
      const head = state.head
      state.onBlockNumber?.()
      return toHex(head)
    }
    if (method === 'eth_getTransactionByHash') return originalTransaction
    if (method === 'eth_getTransactionReceipt') return originalReceipt
    if (method === 'eth_getLogs') {
      const query = params[0]
      if (!record(query) || !Array.isArray(query.topics)) throw new Error('Invalid fixture log query.')
      if (query.topics[0] === originalLog.topics[0]) return [originalLog]
      if (query.topics[0] !== boardLog(0n, 0n).topics[0]) return []
      if (typeof query.fromBlock !== 'string' || typeof query.toBlock !== 'string') throw new Error('Unexpected fixture log query.')
      const fromBlock = BigInt(query.fromBlock)
      const toBlock = BigInt(query.toBlock)
      state.logQueries.push({ fromBlock, toBlock })
      return state.messages.filter((log) => BigInt(log.blockNumber) >= fromBlock && BigInt(log.blockNumber) <= toBlock)
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
        case 'messageCount': {
          state.countBlocks.push(params[1])
          if (state.failBoardReads) throw new Error('Fixture board history unavailable.')
          const total = typeof params[1] === 'string' && params[1].startsWith('0x') ? state.countsAtBlock.get(BigInt(params[1])) ?? state.total : state.total
          return encodeAbiParameters([{ type: 'uint256' }], [total])
        }
        case 'launchFee': return encodeAbiParameters([{ type: 'uint256' }], [250_000n])
        case 'launchRelayFee': return encodeAbiParameters([{ type: 'uint256' }], [150_000n])
        case 'tradeRelayFee': return encodeAbiParameters([{ type: 'uint256' }], [10_000n])
        case 'FEE_BPS': return encodeAbiParameters([{ type: 'uint256' }], [12n])
        case 'postFee': return encodeAbiParameters([{ type: 'uint256' }], [10_000n])
        case 'authorizationState': return encodeAbiParameters([{ type: 'bool' }], [false])
        default: throw new Error('Unexpected fixture contract method.')
      }
    }
    throw new Error('Unexpected fixture RPC method.')
  }
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      void (async () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!record(body) || typeof body.method !== 'string' || (body.params !== undefined && !Array.isArray(body.params))) throw new Error('Invalid fixture JSON RPC.')
        const params = Array.isArray(body.params) ? body.params as unknown[] : []
        await state.beforeResult?.(body.method, params)
        response.setHeader('content-type', 'application/json')
        try { response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: result(body.method, params) })) } catch (error) {
          if (!(error instanceof Error) || error.message !== 'Fixture board history unavailable.') throw error
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: error.message } }))
        }
      })().catch(() => { response.statusCode = 500; response.end('Unexpected fixture request.') })
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

describe('bounded board snapshots', () => {
  test('coalesces count0, count1 and capped reads into one max100 snapshot until the exact TTL boundary', async () => {
    const rpc = await readinessRpc()
    rpc.state.head = 50_000n
    rpc.state.total = 150n
    rpc.state.messages = Array.from({ length: 150 }, (_, id) => boardLog(BigInt(id), rpc.state.head))
    let clock = 1_700_000_000_000
    const port = viemPort(rpc.env, { now: () => clock })
    let entered!: () => void
    let release!: () => void
    const scanning = new Promise<void>((resolve) => { entered = resolve })
    const hold = new Promise<void>((resolve) => { release = resolve })
    rpc.state.beforeResult = async (method) => { if (method === 'eth_getLogs') { entered(); await hold } }
    const originalNow = Date.now
    Date.now = () => clock
    try {
      const pending = [0, 1, 100, 1000].map((count) => port.messages(count))
      await scanning
      expect(rpc.state.countBlocks).toEqual([toHex(50_000n)])
      release()
      const [empty, one, hundred, capped] = await Promise.all(pending)
      rpc.state.beforeResult = undefined
      expect(empty.messages).toHaveLength(0)
      expect(one.messages.map((message) => message.id)).toEqual([149n])
      expect(hundred.messages.map((message) => message.id)).toEqual(Array.from({ length: 100 }, (_, index) => BigInt(149 - index)))
      expect(capped).toEqual(hundred)
      expect(hundred.total).toBe(150)
      expect(hundred.complete).toBe(true)
      expect(hundred.snapshot).toEqual({ blockNumber: 50_000n, fetchedAt: clock, ageMs: 0, ttlMs: 15_000 })
      expect(rpc.state.logQueries).toHaveLength(1)
      const reads = rpc.state.methods.length

      // Expire chain verification independently while the board snapshot remains fresh.
      clock += 14_999
      const fresh = await port.messages(1)
      expect(fresh.snapshot?.ageMs).toBe(14_999)
      expect(fresh.messages[0].id).toBe(149n)
      expect(rpc.state.methods).toHaveLength(reads)

      clock++
      rpc.state.head++
      rpc.state.total++
      rpc.state.messages.push(boardLog(150n, rpc.state.head))
      const renewed = await port.messages(100)
      expect(renewed.messages[0].id).toBe(150n)
      expect(renewed.total).toBe(151)
      expect(renewed.snapshot).toEqual({ blockNumber: 50_001n, fetchedAt: clock, ageMs: 0, ttlMs: 15_000 })
      expect(rpc.state.countBlocks).toEqual([toHex(50_000n), toHex(50_001n)])
      expect(rpc.state.logQueries).toHaveLength(2)
    } finally {
      release()
      Date.now = originalNow
    }
  })

  test('anchors the total and every event window to the captured block while the chain advances', async () => {
    const rpc = await readinessRpc()
    rpc.state.head = 50_000n
    rpc.state.total = 1n
    rpc.state.countsAtBlock.set(50_000n, 1n)
    rpc.state.messages = [boardLog(0n, 50_000n), boardLog(1n, 50_001n)]
    rpc.state.onBlockNumber = () => { rpc.state.head = 50_001n; rpc.state.total = 2n }
    const board = await viemPort(rpc.env, { now: () => 123_000 }).messages(100)
    expect(board.total).toBe(1)
    expect(board.messages.map((message) => message.id)).toEqual([0n])
    expect(board.snapshot?.blockNumber).toBe(50_000n)
    expect(rpc.state.countBlocks).toEqual([toHex(50_000n)])
    expect(rpc.state.logQueries).toEqual([{ fromBlock: 48_100n, toBlock: 50_000n }])
  })

  test('an empty board captures its total without scanning logs, including a count0-first request', async () => {
    const rpc = await readinessRpc()
    rpc.state.head = 100_000n
    const port = viemPort(rpc.env, { now: () => 10_000 })
    const board = await port.messages(0)
    expect(board.total).toBe(0)
    expect(board.complete).toBe(true)
    expect(board.messages).toEqual([])
    expect(board.snapshot).toEqual({ blockNumber: 100_000n, fetchedAt: 10_000, ageMs: 0, ttlMs: 15_000 })
    expect(rpc.state.countBlocks).toEqual([toHex(100_000n)])
    expect(rpc.state.logQueries).toHaveLength(0)
    const reads = rpc.state.methods.length
    expect((await port.messages(100)).messages).toEqual([])
    expect(rpc.state.methods).toHaveLength(reads)
  })

  test('keeps the 20-window limit and incomplete flag even when the requested page is already full', async () => {
    const rpc = await readinessRpc()
    rpc.state.head = 100_000n
    rpc.state.total = 200n
    rpc.state.messages = Array.from({ length: 100 }, (_, index) => boardLog(BigInt(100 + index), rpc.state.head))
    const port = viemPort(rpc.env, { now: () => 10_000 })
    const one = await port.messages(1)
    expect(one.total).toBe(200)
    expect(one.messages.map((message) => message.id)).toEqual([199n])
    expect(one.complete).toBe(false)
    expect(rpc.state.logQueries).toHaveLength(20)
    for (let index = 0; index < rpc.state.logQueries.length; index++) {
      const toBlock = 100_000n - BigInt(index) * 1_901n
      expect(rpc.state.logQueries[index]).toEqual({ fromBlock: toBlock - 1_900n, toBlock })
    }
    expect((await port.messages(100)).messages).toHaveLength(100)
    expect(rpc.state.logQueries).toHaveLength(20)
  })

  test('duplicate or out-of-range IDs are refused instead of falsely proving complete history', async () => {
    for (const ids of [[1n, 1n], [2n]]) {
      const rpc = await readinessRpc()
      rpc.state.head = 100_000n
      rpc.state.total = 2n
      rpc.state.messages = ids.map((id, index) => boardLog(id, rpc.state.head, index))
      try { await viemPort(rpc.env, { now: () => 10_000 }).messages(100); throw new Error('Expected inconsistent board history refusal.') } catch (error) {
        if (!(error instanceof GateError)) throw error
        expect(error.status).toBe(502)
        expect(error.code).toBe('unreadable_history')
      }
      expect(rpc.state.logQueries).toHaveLength(1)
    }
  })

  test('reaching block0 with missing immutable IDs is refused and never cached as complete history', async () => {
    const rpc = await readinessRpc()
    rpc.state.total = 2n
    rpc.state.messages = [boardLog(1n, rpc.state.head)]
    const port = viemPort(rpc.env, { now: () => 10_000 })
    try { await port.messages(1); throw new Error('Expected missing board history refusal.') } catch (error) {
      if (!(error instanceof GateError)) throw error
      expect(error.status).toBe(502)
      expect(error.code).toBe('unreadable_history')
    }
    rpc.state.messages.unshift(boardLog(0n, rpc.state.head))
    const complete = await port.messages(100)
    expect(complete.total).toBe(2)
    expect(complete.complete).toBe(true)
    expect(complete.messages.map((message) => message.id)).toEqual([1n, 0n])
    expect(rpc.state.countBlocks).toHaveLength(2)
    expect(rpc.state.logQueries).toEqual([{ fromBlock: 0n, toBlock: 100n }, { fromBlock: 0n, toBlock: 100n }])
  })

  test('charges failed refreshes to the same fixed budget, refuses without RPC and resets after 60 seconds', async () => {
    const rpc = await readinessRpc()
    rpc.state.head = 50_000n
    rpc.state.total = 1n
    rpc.state.messages = [boardLog(0n, rpc.state.head)]
    let clock = 0
    const port = viemPort(rpc.env, { now: () => clock })
    rpc.state.failBoardReads = true
    for (clock of [0, 1000]) {
      const failures = await Promise.allSettled([0, 1, 100].map((count) => port.messages(count)))
      for (const failure of failures) {
        expect(failure.status).toBe('rejected')
        if (failure.status === 'rejected') expect(String(failure.reason)).toContain('Fixture board history unavailable.')
      }
    }
    clock = 2000
    rpc.state.failBoardReads = false
    expect((await port.messages(1)).messages).toHaveLength(1)
    clock = 17_000
    rpc.state.failBoardReads = true
    await expect(port.messages(100)).rejects.toThrow('Fixture board history unavailable.')
    expect(rpc.state.countBlocks).toHaveLength(4)
    rpc.state.failBoardReads = false
    for (const [at, retryAfter] of [[17_001, 43], [59_999, 1]]) {
      clock = at
      const reads = rpc.state.methods.length
      try { await port.messages(0); throw new Error('Expected a board refresh refusal.') } catch (error) {
        if (!(error instanceof GateError)) throw error
        expect(error.status).toBe(429)
        expect(error.code).toBe('history_rate_limited')
        expect(error.details.retryAfter).toBe(retryAfter)
      }
      expect(rpc.state.methods).toHaveLength(reads)
    }
    expect((await port.readiness()).relay.ready).toBe(true)
    expect((await port.fees()).postFee).toBe(10_000n)
    expect(await port.postNonce('independent paid terms', zeroHash)).toBe(`0x4152435458424e44${'00'.repeat(24)}`)
    clock = 60_000
    expect((await port.messages(100)).snapshot?.ageMs).toBe(0)
    expect(rpc.state.countBlocks).toHaveLength(5)
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
