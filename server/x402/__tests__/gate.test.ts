import { describe, expect, test } from 'bun:test'
import { ExactEvmScheme } from '@x402/evm'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader, wrapFetchWithPaymentFromConfig } from './x402Client'
import { keccak256, stringToHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import type { Money } from '../money'
import type { BoardMessage } from '../port'
import { GateError } from '../errors'
import { createGate, type Gate } from '../gate'
import { BOARD, CHAIN_ID, FEES, LAUNCHPAD, USDC, fakeChain } from './fakePort'

const ORIGIN = 'https://gate.test'
const NETWORK = `eip155:${CHAIN_ID}` as const

interface FixtureJson extends Record<string, unknown> {
  result: { token: Address; tokensOut: Money; tokensIn: Money; usdcOut: Money; usdcSpent: Money; refunded: Money; id: string }
  price: { total: Money; breakdown: { label: string }[] }
  accepts: PaymentRequirements[]
  requirements: PaymentRequirements
  nonce: Hex
  transaction: Hex
  notes: { relayFee: Money }
  fees: { launchFee: Money }
  endpoints: { paid: boolean; path: string }[]
  launches: { token: Address }[]
  messages: { id: string; from: Address; text: string }[]
  snapshot?: { blockNumber: string; fetchedAt: string; ageSeconds: number; ttlSeconds: number }
  charged: Money
  curveFee: Money
  paths: Record<string, unknown>
}
type FixtureResponse = Omit<Response, 'json'> & { json(): Promise<FixtureJson> }
const fixtureResponse = (response: Response): FixtureResponse => response

function setup(options: { canRelay?: boolean; clock?: () => number; forwardPaid?: Gate } = {}) {
  const clock = options.clock ?? (() => Date.now())
  const chain = fakeChain({ canRelay: options.canRelay, now: () => BigInt(Math.floor(clock() / 1000)) })
  const handle = createGate(() => chain, { now: clock, forwardPaid: options.forwardPaid })
  const gate = (request: Request) => handle(request).then(fixtureResponse)
  const account = privateKeyToAccount(generatePrivateKey())
  chain.balances.set(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`, 100_000_000n)
  const call = (path: string, init?: RequestInit) => gate(new Request(`${ORIGIN}${path}`, init))
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  /** A stock x402 client, exactly as an agent would configure one, pointed at the gate in-process. */
  const pay = (allowed: Address[] = [USDC]) =>
    wrapFetchWithPaymentFromConfig((input: RequestInfo | URL, init?: RequestInit) => gate(new Request(input, init)), {
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
      spendControls: { allowedAssets: allowed.map((asset) => ({ network: NETWORK, asset })) },
    })
  const paidPost = (path: string, body: unknown, allowed?: Address[]) =>
    pay(allowed)(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(fixtureResponse)
  return { chain, gate, account, call, post, paidPost }
}

/** A payment built by hand, for the cases a well-behaved client would never produce. */
async function signed(
  account: ReturnType<typeof privateKeyToAccount>,
  terms: { asset: string; amount: string; payTo: string; extra: Record<string, unknown>; network: string; scheme: string; maxTimeoutSeconds: number },
  overrides: Partial<{ value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }> = {},
): Promise<string> {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const authorization = {
    from: account.address,
    to: terms.payTo as Address,
    value: overrides.value ?? BigInt(terms.amount),
    validAfter: overrides.validAfter ?? nowSeconds - 600n,
    validBefore: overrides.validBefore ?? nowSeconds + 120n,
    nonce: overrides.nonce ?? keccak256(stringToHex(`${Math.random()}`)),
  }
  const signature = await account.signTypedData({
    domain: { name: String(terms.extra.name), version: String(terms.extra.version), chainId: CHAIN_ID, verifyingContract: terms.asset as Address },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: terms as never,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
      },
    },
  })
}

/** Only the named fields, so an assertion says what it is about and nothing else. */
function pick(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}

function termsOf(response: Response) {
  return Promise.resolve(decodePaymentRequiredHeader(response.headers.get('payment-required') as string).accepts[0])
}

describe('the challenge', () => {
  test('an unpaid launch is answered 402 with terms a stock client can sign', async () => {
    const { post } = setup()
    const response = await post('/x402/launch', { name: 'Example', symbol: 'EX' })
    expect(response.status).toBe(402)
    const required = decodePaymentRequiredHeader(response.headers.get('payment-required') as string)
    expect(required.x402Version).toBe(2)
    expect(required.resource.url).toBe(`${ORIGIN}/x402/launch`)
    expect(required.accepts).toEqual([
      { scheme: 'exact', network: NETWORK, asset: USDC, amount: '400000', payTo: LAUNCHPAD, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } },
    ])
    const body = await response.json()
    expect(body.price.total).toEqual({ formatted: '0.4', raw: '400000' })
    expect(body.price.breakdown.map((line: { label: string }) => line.label)).toEqual(['Launch fee', 'Relay fee'])
    expect(body.accepts).toEqual(required.accepts)
  })

  test('a first buy is added to the price of a launch', async () => {
    const { post } = setup()
    const terms = await termsOf(await post('/x402/launch', { name: 'Example', symbol: 'EX', initialBuyUsdc: '2.5' }))
    expect(terms.amount).toBe('2900000')
  })

  test('a request that could never work is refused before any terms are offered', async () => {
    const { post } = setup()
    for (const [body, code] of [
      [{ symbol: 'EX' }, 'missing_field'],
      [{ name: 'x'.repeat(33), symbol: 'EX' }, 'invalid_field'],
      [{ name: 'Example', symbol: 'ELEVENCHARS' }, 'invalid_field'],
      [{ name: 'Example', symbol: 'EX', initialBuyUsdc: '-1' }, 'invalid_amount'],
      [{ name: 'Example', symbol: 'EX', initialBuyUsdc: '1.0000001' }, 'invalid_amount'],
      [{ name: 'Example', symbol: 'EX', slippageBps: 9000 }, 'invalid_field'],
      [{ name: 'Example', symbol: 'EX', salt: '0x1234' }, 'invalid_field'],
    ] as const) {
      const response = await post('/x402/launch', body)
      expect(response.status).toBe(400)
      expect(response.headers.get('payment-required')).toBeNull()
      expect((await response.json()).error).toBe(code)
    }
  })

  test('a body that is not JSON is refused', async () => {
    const { call } = setup()
    const response = await call('/x402/post', { method: 'POST', body: 'hello' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_json')
  })
})

describe('paying with a stock x402 client', () => {
  test('launches a token, credited to the payer', async () => {
    const { paidPost, chain, account } = setup()
    const response = await paidPost('/x402/launch', { name: 'Example', symbol: 'EX', initialBuyUsdc: '5' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(pick(body, 'ok', 'action', 'payer', 'bound')).toEqual({ ok: true, action: 'launch', payer: account.address, bound: false })
    expect(BigInt(body.result.tokensOut.raw)).toBeGreaterThan(0n)
    expect(decodePaymentResponseHeader(response.headers.get('payment-response') as string)).toEqual({
      success: true,
      transaction: body.transaction,
      network: NETWORK,
      payer: account.address,
    })
    expect(chain.state.get(body.result.token.toLowerCase())?.creator).toBe(account.address)
    // 100 USDC to start, less the launch fee, the relay fee and the first buy.
    expect(chain.balances.get(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`)).toBe(100_000_000n - 400_000n - 5_000_000n)
  })

  test('buys, then sells by paying in the token itself', async () => {
    const { paidPost, chain, account } = setup()
    const launched = await (await paidPost('/x402/launch', { name: 'Example', symbol: 'EX' })).json()
    const token = launched.result.token

    const bought = await paidPost('/x402/buy', { token, usdc: '10' })
    expect(bought.status).toBe(200)
    const buy = await bought.json()
    expect(buy.result.usdcSpent.raw).toBe('10000000')
    expect(buy.result.refunded.raw).toBe('0')
    const held = BigInt(buy.result.tokensOut.raw)
    expect(chain.balances.get(`${token.toLowerCase()}:${account.address.toLowerCase()}`)).toBe(held)

    const before = chain.balances.get(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`) as bigint
    const sold = await paidPost('/x402/sell', { token, tokens: buy.result.tokensOut.formatted }, [USDC, token])
    expect(sold.status).toBe(200)
    const sell = await sold.json()
    expect(sell.action).toBe('sell')
    expect(chain.balances.get(`${token.toLowerCase()}:${account.address.toLowerCase()}`)).toBe(0n)
    expect(chain.balances.get(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`)).toBe(before + BigInt(sell.result.usdcOut.raw))
    // Out and back costs two curve fees and two relay fees, and nothing else.
    expect(BigInt(sell.result.usdcOut.raw)).toBeLessThan(10_000_000n)
    expect(BigInt(sell.result.usdcOut.raw)).toBeGreaterThan(9_900_000n)
  })

  test('the terms of a sale name the token as the asset, under its own signing domain', async () => {
    const { paidPost, post } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Example Coin', symbol: 'EX', initialBuyUsdc: '10' })).json()).result.token
    const response = await post('/x402/sell', { token, tokens: '100000' })
    expect(response.status).toBe(402)
    expect(await termsOf(response)).toEqual({
      scheme: 'exact',
      network: NETWORK,
      asset: token,
      amount: '100000000000000000000000',
      payTo: LAUNCHPAD,
      maxTimeoutSeconds: 120,
      extra: { name: 'Example Coin', version: '1' },
    })
    expect((await response.json()).notes.relayFee.raw).toBe('10000')
  })

  test('a sale too small to cover the relay fee is refused rather than relayed at a loss', async () => {
    const { paidPost, post } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Example', symbol: 'EX', initialBuyUsdc: '10' })).json()).result.token
    const response = await post('/x402/sell', { token, tokens: '1000' })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('too_small')
  })

  test('posts to the board under the payer\'s own address', async () => {
    const { paidPost, chain, account, call } = setup()
    const response = await paidPost('/x402/post', { text: 'gm from an agent' })
    expect(response.status).toBe(200)
    expect((await response.json()).result).toEqual({ id: '0' })
    expect(chain.posts).toEqual([{ from: account.address, text: 'gm from an agent' }])
    const board = await (await call('/x402/bbs')).json()
    expect(pick(board.messages[0], 'id', 'from', 'text')).toEqual({ id: '0', from: account.address, text: 'gm from an agent' })
  })

  test('a payer without the funds is told so, and nothing happens', async () => {
    const { paidPost, chain, account } = setup()
    chain.balances.set(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`, 100n)
    const response = await paidPost('/x402/launch', { name: 'Example', symbol: 'EX' })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('insufficient_funds')
    expect(chain.state.size).toBe(0)
  })
})

describe('payments that do not match the terms', () => {
  test('an authorization for the wrong amount is refused', async () => {
    const { post, account, chain } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const header = await signed(account, terms, { value: 1n })
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('invalid_amount')
    expect(chain.posts).toEqual([])
  })

  test('an authorization that pays someone else is refused', async () => {
    const { post, account } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const header = await signed(account, { ...terms, payTo: LAUNCHPAD })
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('invalid_pay_to')
  })

  test('an expired authorization is refused', async () => {
    const { post, account } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const header = await signed(account, terms, { validBefore: BigInt(Math.floor(Date.now() / 1000)) - 1n })
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('authorization_expired')
  })

  test('a payment signed by someone other than the named payer is refused', async () => {
    const { post, account, chain } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const stranger = privateKeyToAccount(generatePrivateKey())
    const forged = decodePaymentSignatureHeader(await signed(stranger, terms))
    const inner = forged.payload as { signature: Hex; authorization: { from: Address } }
    inner.authorization.from = account.address
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': Buffer.from(JSON.stringify(forged)).toString('base64') })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('invalid_signature')
    expect(chain.posts).toEqual([])
  })

  test('repeating the same payment recovers its receipt without a second action', async () => {
    const { post, account, chain } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const header = await signed(account, terms)
    const first = await (await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })).json()
    const again = await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(first)
    expect(chain.posts.length).toBe(1)
  })

  test('a header that is not a payment is refused', async () => {
    const { post } = setup()
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': 'not base64 json' })
    expect(response.status).toBe(402)
    expect((await response.json()).code).toBe('invalid_payload')
  })
})

describe('bound mode', () => {
  const salt: Hex = `0x${'ab'.repeat(32)}`

  test('a signature that commits to the parameters is relayed as bound', async () => {
    const { post, account, chain } = setup()
    const committed = await (await post('/x402/commit', { action: 'post', text: 'signed and sealed', salt })).json()
    expect(committed.requirements.payTo).toBe(BOARD)
    const header = await signed(account, committed.requirements, { nonce: committed.nonce })
    const response = await post('/x402/post', { text: 'signed and sealed', salt }, { 'payment-signature': header })
    expect(response.status).toBe(200)
    expect((await response.json()).bound).toBe(true)
    expect(chain.relayed[chain.relayed.length - 1]).toEqual({ action: 'post', from: account.address, bound: true })
  })

  test('the gate will not relay different parameters under a bound signature', async () => {
    const { post, account, chain } = setup()
    const committed = await (await post('/x402/commit', { action: 'post', text: 'what I signed', salt })).json()
    const header = await signed(account, committed.requirements, { nonce: committed.nonce })
    const response = await post('/x402/post', { text: 'what someone wanted instead', salt }, { 'payment-signature': header })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('bound_mismatch')
    expect(chain.posts).toEqual([])
  })

  test('a bound trade has to state its own minimum', async () => {
    const { post, paidPost } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Example', symbol: 'EX' })).json()).result.token
    const response = await post('/x402/buy', { token, usdc: '1', salt })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('bound_needs_minimum')
  })
})

describe('reading', () => {
  test('the index carries the live fees and every endpoint', async () => {
    const { call } = setup()
    const index = await (await call('/x402')).json()
    expect(pick(index, 'name', 'x402Version', 'network', 'chainId', 'testnet')).toEqual({ name: 'Architex Agents', x402Version: 2, network: NETWORK, chainId: CHAIN_ID, testnet: true })
    expect(index.contracts).toEqual({ launchpad: LAUNCHPAD, bbs: BOARD })
    expect(index.fees.launchFee).toEqual({ formatted: '0.25', raw: FEES.launchFee.toString() })
    expect(index.endpoints.filter((endpoint: { paid: boolean }) => endpoint.paid).map((endpoint: { path: string }) => endpoint.path)).toEqual([
      '/x402/launch',
      '/x402/buy',
      '/x402/sell',
      '/x402/post',
    ])
  })

  test('launches are listed newest first', async () => {
    const { call, paidPost } = setup()
    for (const symbol of ['ONE', 'TWO', 'THREE']) await paidPost('/x402/launch', { name: symbol, symbol })
    const listed = await (await call('/x402/launches?count=2')).json()
    expect(listed.total).toBe(3)
    expect(listed.launches.length).toBe(2)
    const newest = await (await call(`/x402/launch/${listed.launches[0].token}`)).json()
    expect(newest.token).toBe(listed.launches[0].token)
    expect(listed.launches[0].token > listed.launches[1].token).toBe(true)
  })

  test('a quote says what will be charged in all', async () => {
    const { call, paidPost } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Example', symbol: 'EX' })).json()).result.token
    const quote = await (await call(`/x402/quote/buy?token=${token}&usdc=10`)).json()
    expect(quote.charged.raw).toBe('10010000')
    expect(quote.curveFee.raw).toBe('12000')
  })

  test('the gate describes itself to models and to tools', async () => {
    const { call } = setup()
    const text = await (await call('/llms.txt')).text()
    expect(text).toContain(`POST ${ORIGIN}/x402/launch`)
    expect(text).not.toContain('—')
    const spec = await (await call('/openapi.json')).json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.servers).toEqual([{ url: ORIGIN }])
    expect(Object.keys(spec.paths)).toContain('/x402/sell')
  })

  test('an unknown token is a 404, not a guess', async () => {
    const { call, post } = setup()
    const nowhere = '0x00000000000000000000000000000000000000ff'
    expect((await call(`/x402/launch/${nowhere}`)).status).toBe(404)
    expect((await post('/x402/buy', { token: nowhere, usdc: '1' })).status).toBe(404)
  })
})

describe('public board reads', () => {
  test('all direct, API and rewritten aliases preserve default20, count0 and capped count100', async () => {
    const { call, chain } = setup()
    const counts: number[] = []
    const messages: BoardMessage[] = Array.from({ length: 100 }, (_, index) => ({ id: BigInt(99 - index), from: BOARD, time: 1_700_000_000n, text: `message ${99 - index}`, transaction: `0x${'12'.repeat(32)}` }))
    chain.messages = (count) => { counts.push(count); return Promise.resolve({ total: 100, complete: true, messages: messages.slice(0, count) }) }
    for (const [path, count] of [
      ['/x402/bbs', 20],
      ['/x402/bbs/?count=1&cacheBust=first', 1],
      ['/api/x402/bbs?count=0', 0],
      ['/api/x402/bbs/?count=100', 100],
      ['/api/x402?path=bbs&count=999999&_=second', 100],
      ['/api/x402?path=bbs%2F&count=1', 1],
      ['/api/x402/?path=bbs/', 20],
    ] as const) {
      const response = await call(path)
      expect(response.status).toBe(200)
      const board = await response.json()
      expect(board.count).toBe(count)
      expect(board.total).toBe(100)
      expect(board.completeHistory).toBe(true)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(counts).toEqual([20, 1, 0, 100, 100, 1, 20])
  })

  test('invalid counts are rejected before any board scan', async () => {
    const { call, chain } = setup()
    let scans = 0
    chain.messages = () => { scans++; return Promise.resolve({ total: 0, complete: true, messages: [] }) }
    for (const count of ['', '-1', '1.5', '1e2', '0x10', 'NaN', '1000000', ' ']) {
      const response = await call(`/api/x402?path=bbs&count=${encodeURIComponent(count)}`)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('invalid_field')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(scans).toBe(0)
  })

  test('describes the captured snapshot and limits public caching to its remaining TTL', async () => {
    const { call, chain } = setup()
    const fetchedAt = 1_700_000_000_000
    chain.readiness = () => Promise.reject(new Error('Board reads must not refresh paid readiness.'))
    chain.fees = () => Promise.reject(new Error('Board reads must not read paid fees.'))
    for (const [ageMs, ageSeconds, remaining] of [[0, 0, 15], [1234, 1, 13], [14_999, 14, 0], [15_000, 15, 0]]) {
      chain.messages = () => Promise.resolve({
        total: 123, complete: false,
        messages: [{ id: 122n, from: BOARD, time: 1_700_000_000n, text: 'latest observed message', transaction: `0x${'12'.repeat(32)}` }],
        snapshot: { blockNumber: 123_456n, fetchedAt, ageMs, ttlMs: 15_000 },
      })
      const response = await call('/x402/bbs?count=1')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe(`public, max-age=${remaining}, s-maxage=${remaining}`)
      const board = await response.json()
      expect(board.snapshot).toEqual({ blockNumber: '123456', fetchedAt: '2023-11-14T22:13:20.000Z', ageSeconds, ttlSeconds: 15 })
      expect(board.total).toBe(123)
      expect(board.completeHistory).toBe(false)
      expect(board.messages).toEqual([{ id: '122', from: BOARD, time: '2023-11-14T22:13:20.000Z', text: 'latest observed message', transaction: `0x${'12'.repeat(32)}` }])
    }
  })

  test('board quota refusals expose Retry-After while paid actions and readiness remain healthy', async () => {
    const { call, paidPost, chain } = setup()
    chain.messages = () => Promise.reject(new GateError(429, 'history_rate_limited', 'Board refreshes are limited.', { retryAfter: 17, retryable: true }))
    const response = await call('/x402/bbs')
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('payment-required')).toBeNull()
    expect(await response.json()).toEqual({ ok: false, error: 'history_rate_limited', message: 'Board refreshes are limited.', retryAfter: 17, retryable: true })
    const index = await call('/x402')
    expect(index.status).toBe(200)
    expect(index.headers.get('cache-control')).toBe('no-store')
    const post = await paidPost('/x402/post', { text: 'paid actions have a separate lane' })
    expect(post.status).toBe(200)
    expect(post.headers.get('cache-control')).toBe('no-store')
    expect(post.headers.has('payment-response')).toBe(true)
    expect(chain.posts).toHaveLength(1)
  })

  test('board failures and legacy responses without snapshot metadata remain no-store', async () => {
    const { call, chain } = setup()
    const legacy = await call('/x402/bbs?count=0')
    expect(legacy.status).toBe(200)
    expect((await legacy.json()).snapshot).toBe(undefined)
    expect(legacy.headers.get('cache-control')).toBe('no-store')
    chain.messages = () => Promise.reject(new GateError(502, 'unreadable_history', 'History could not be read.'))
    const failed = await call('/x402/bbs')
    expect(failed.status).toBe(502)
    expect((await failed.json()).error).toBe('unreadable_history')
    expect(failed.headers.get('cache-control')).toBe('no-store')
    expect(failed.headers.get('retry-after')).toBeNull()
  })
})

describe('the door itself', () => {
  test('the deployed rewrite reaches the same routes', async () => {
    const { gate } = setup()
    const response = await gate(
      new Request('https://gate.test/api/x402?path=launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Example', symbol: 'EX' }) }),
    )
    expect(response.status).toBe(402)
    expect(decodePaymentRequiredHeader(response.headers.get('payment-required') as string).resource.url).toBe('https://gate.test/x402/launch')
    expect((await gate(new Request('https://gate.test/api/x402'))).status).toBe(200)
    expect((await gate(new Request('https://gate.test/api/x402?path=llms.txt'))).headers.get('content-type')).toContain('text/plain')
  })

  test('a browser may read the payment headers from any origin', async () => {
    const { call, post } = setup()
    const preflight = await call('/x402/launch', { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('payment-signature')
    const challenge = await post('/x402/launch', { name: 'Example', symbol: 'EX' })
    expect(challenge.headers.get('access-control-allow-origin')).toBe('*')
    expect(challenge.headers.get('access-control-expose-headers')).toContain('payment-required')
  })

  test('without a relayer the gate still quotes, and says why it cannot act', async () => {
    const { post, account } = setup({ canRelay: false })
    const challenge = await post('/x402/post', { text: 'hello' })
    expect(challenge.status).toBe(402)
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': await signed(account, await termsOf(challenge)) })
    expect(response.status).toBe(503)
    expect((await response.json()).error).toBe('relayer_not_configured')
  })

  test('a gate that is not configured answers 503 instead of failing', async () => {
    const gate = createGate(() => {
      throw new Error('The launchpad and board are not deployed on Arc testnet yet.')
    })
    const response = fixtureResponse(await gate(new Request('https://gate.test/x402')))
    expect(response.status).toBe(503)
    expect((await response.json()).message).toContain('not deployed')
  })

  test('paid routes take POST and free routes take GET', async () => {
    const { call, post } = setup()
    expect((await call('/x402/launch')).status).toBe(405)
    expect((await post('/x402/launches', {})).status).toBe(405)
    expect((await call('/x402/nowhere')).status).toBe(404)
  })
})

describe('mainnet hardening and explicit recovery', () => {
  test('checks pending again after the asynchronous refusal recheck yields back to the caller', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'microtask' })))
    const transaction: Hex = `0x${'88'.repeat(32)}`
    let active: Hex | undefined
    let checks = 0
    chain.fees = () => Promise.resolve({ ...FEES, postFee: 500_000n })
    chain.pendingTransaction = () => { if (++checks === 1) queueMicrotask(() => { active = transaction }); return active }
    const response = await post('/x402/post', { text: 'microtask' }, { 'payment-signature': header })
    expect(response.status).toBe(502)
    expect((await response.json()).transaction).toBe(transaction)
    expect(checks).toBe(2)
    expect(response.headers.has('payment-required')).toBe(false)
  })
  test('rechecks a retry when another submission becomes pending during fee preparation', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'interleaving' })))
    const transaction: Hex = `0x${'66'.repeat(32)}`
    let pending = false
    let recoverReads = 0
    chain.recover = () => {
      recoverReads++
      return pending ? Promise.reject(new GateError(502, 'unconfirmed', 'Original transaction became pending.', { transaction, status: 'pending', retryable: false })) : Promise.resolve(undefined)
    }
    chain.fees = () => { pending = true; return Promise.resolve({ ...FEES, postFee: 500_000n }) }
    const response = await post('/x402/post', { text: 'interleaving' }, { 'payment-signature': header })
    expect(response.status).toBe(502)
    expect((await response.json()).transaction).toBe(transaction)
    expect(recoverReads).toBe(2)
    expect(response.headers.has('payment-required')).toBe(false)
  })
  test('the final synchronous pending guard closes a submission appearing during the last RPC recheck', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'last check' })))
    const transaction: Hex = `0x${'77'.repeat(32)}`
    let stateReads = 0
    let active: Hex | undefined
    chain.fees = () => Promise.resolve({ ...FEES, postFee: 500_000n })
    chain.pendingTransaction = () => active
    chain.authorizationUsed = () => { if (++stateReads === 2) active = transaction; return Promise.resolve(false) }
    const response = await post('/x402/post', { text: 'last check' }, { 'payment-signature': header })
    expect(response.status).toBe(502)
    expect((await response.json()).transaction).toBe(transaction)
    expect(response.headers.has('payment-required')).toBe(false)
  })
  test('a known pending original bypasses current fee rejection and reports its hash without a fresh402', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'pending' })))
    const transaction: Hex = `0x${'55'.repeat(32)}`
    chain.recover = () => Promise.reject(new GateError(502, 'unconfirmed', 'Original transaction is pending.', { transaction, status: 'pending', retryable: false }))
    chain.fees = () => Promise.resolve({ ...FEES, postFee: 500_000n })
    const response = await post('/x402/post', { text: 'pending' }, { 'payment-signature': header })
    expect(response.status).toBe(502)
    expect((await response.json()).transaction).toBe(transaction)
    expect(response.headers.has('payment-required')).toBe(false)
    expect(chain.posts.length).toBe(0)
  })
  test('serverless forwards an expired original before current fee or curve checks can hide dedicated pending state', async () => {
    let forwarded = 0
    let originalHeader: string | null = null
    const { post, chain, account } = setup({ canRelay: false, forwardPaid: (request) => {
      forwarded++; originalHeader = request.headers.get('payment-signature')
      return Promise.resolve(Response.json({ ok: false, transaction: `0x${'55'.repeat(32)}`, status: 'pending' }, { status: 502 }))
    } })
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'pending' })), { validBefore: BigInt(Math.floor(Date.now() / 1000)) - 1n })
    chain.fees = () => Promise.reject(new Error('serverless must not read mutable fees for a signed retry'))
    const response = await post('/x402/post', { text: 'pending' }, { 'payment-signature': header })
    expect(response.status).toBe(502)
    expect(forwarded).toBe(1)
    expect(originalHeader).toEqual(header)
    expect(response.headers.has('payment-required')).toBe(false)
  })
  test('serverless validates signed network, asset, domain and recipient before forwarding', async () => {
    let forwarded = 0
    const { post, account } = setup({ canRelay: false, forwardPaid: () => { forwarded++; return Promise.resolve(Response.json({})) } })
    const terms = await termsOf(await post('/x402/post', { text: 'pending' }))
    for (const changed of [{ ...terms, network: 'eip155:1' }, { ...terms, asset: LAUNCHPAD }, { ...terms, extra: { name: 'Changed', version: '2' } }, { ...terms, payTo: LAUNCHPAD }]) {
      const header = await signed(account, changed)
      expect((await post('/x402/post', { text: 'pending' }, { 'payment-signature': header })).status).toBe(402)
    }
    expect(forwarded).toBe(0)
  })
  test('used or cancelled authorizations without an action receipt never invite a fresh payment after fee changes', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'external' })))
    chain.authorizationUsed = () => Promise.resolve(true)
    chain.fees = () => Promise.resolve({ ...FEES, postFee: 500_000n })
    const response = await post('/x402/post', { text: 'external' }, { 'payment-signature': header })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('authorization_unresolved')
    expect(response.headers.has('payment-required')).toBe(false)
    expect(chain.posts.length).toBe(0)
  })
  test('recovers a graduating buy before a graduated curve can reject the retry', async () => {
    const { paidPost, post, chain, account } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Graduate', symbol: 'GRAD' })).json()).result.token
    chain.balances.set(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`, 100_000_000_000n)
    const body = { token, usdc: '30000', minTokensOut: '0' }
    const header = await signed(account, await termsOf(await post('/x402/buy', body)))
    const first = await (await post('/x402/buy', body, { 'payment-signature': header })).json()
    expect(chain.state.get(token.toLowerCase())?.graduated).toBe(true)
    const again = await post('/x402/buy', body, { 'payment-signature': header })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(first)
    expect(chain.relayed.length).toBe(2)
  })
  test('recovers a completed sale after its tokensSold and payer balance have fallen', async () => {
    const { paidPost, post, chain, account } = setup()
    const launch = await (await paidPost('/x402/launch', { name: 'Sell check', symbol: 'SELL', initialBuyUsdc: '10' })).json()
    const body = { token: launch.result.token, tokens: launch.result.tokensOut.formatted, minUsdcOut: '0' }
    const header = await signed(account, await termsOf(await post('/x402/sell', body)))
    const first = await (await post('/x402/sell', body, { 'payment-signature': header })).json()
    expect(chain.state.get(body.token.toLowerCase())?.tokensSold).toBe(0n)
    const again = await post('/x402/sell', body, { 'payment-signature': header })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(first)
    expect(chain.relayed.length).toBe(2)
  })
  test('recovers the original payment amount after fees change, including an expired retry', async () => {
    let clock = Date.now()
    const { post, chain, account } = setup({ clock: () => clock })
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'fee check' })))
    const first = await (await post('/x402/post', { text: 'fee check' }, { 'payment-signature': header })).json()
    chain.fees = () => Promise.resolve({ ...FEES, postFee: 500_000n })
    clock += 200_000
    const again = await post('/x402/post', { text: 'fee check' }, { 'payment-signature': header })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(first)
    expect(chain.posts.length).toBe(1)
  })
  test('an omitted minimum recovers the executed quote without recomputing it', async () => {
    const { post, paidPost, chain, account } = setup()
    const token = (await (await paidPost('/x402/launch', { name: 'Quote check', symbol: 'QUOTE' })).json()).result.token
    const body = { token, usdc: '1' }
    const header = await signed(account, await termsOf(await post('/x402/buy', body)))
    const first = await (await post('/x402/buy', body, { 'payment-signature': header })).json()
    chain.quoteBuy = () => Promise.reject(new Error('a fresh quote must not run for a completed payment'))
    const again = await post('/x402/buy', body, { 'payment-signature': header })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(first)
  })
  test('recovers a confirmed refund whose HTTP response was lost without another refund submission', async () => {
    const { post, chain, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'refund check' })))
    const body = { payTo: BOARD, settlementTransaction: `0x${'ab'.repeat(32)}` }
    const original = chain.refundExternal.bind(chain)
    let submissions = 0
    let confirmed: Hex | undefined
    chain.refundExternal = async (recipient, payment) => { submissions++; const done = await original(recipient, payment); confirmed = done.transaction; throw new GateError(502, 'unconfirmed', 'HTTP receipt was lost.', { transaction: done.transaction, status: 'pending' }) }
    expect((await post('/x402/refund', body, { 'payment-signature': header })).status).toBe(502)
    const again = await post('/x402/refund', body, { 'payment-signature': header })
    expect(again.status).toBe(200)
    const result = await again.json()
    expect(result.transaction).toEqual(confirmed)
    expect(result.result.refunded.raw).toBe('20000')
    expect(submissions).toBe(1)
  })
  test('a changed completed request is a conflict carrying the original transaction', async () => {
    const { post, account } = setup()
    const header = await signed(account, await termsOf(await post('/x402/post', { text: 'original' })))
    const first = await (await post('/x402/post', { text: 'original' }, { 'payment-signature': header })).json()
    const changed = await post('/x402/post', { text: 'changed' }, { 'payment-signature': header })
    expect(changed.status).toBe(409)
    expect((await changed.json()).transaction).toBe(first.transaction)
    expect(changed.headers.has('payment-required')).toBe(false)
  })
  test('limits UTF-8 bytes and rejects odd-nibble salts before any terms', async () => {
    const { post } = setup()
    const large = await post('/x402/post', { text: 'é'.repeat(9000) })
    expect(large.status).toBe(413)
    expect((await post('/x402/post', { text: 'hello', salt: `0x${'a'.repeat(63)}` })).status).toBe(400)
  })
  test('returns a marked commitment and normalized request with explicit minimums', async () => {
    const { post } = setup()
    const salt = `0x${'cd'.repeat(32)}`
    const response = await post('/x402/commit', { action: 'launch', name: 'Bound check', symbol: 'BC', initialBuyUsdc: '0', minTokensOut: '0', salt })
    expect(response.status).toBe(200)
    const commit = await response.json()
    expect(commit.nonce.startsWith('0x4152435458424e44')).toBe(true)
    expect(commit.request).toEqual({ name: 'Bound check', symbol: 'BC', metadataURI: '', initialBuyUsdc: '0', minTokensOut: '0', salt })
  })
  test('a marked authorization cannot omit its original bound salt', async () => {
    const { post, account } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const header = await signed(account, terms, { nonce: `0x4152435458424e44${'12'.repeat(24)}` })
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': header })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('bound_needs_salt')
  })
  test('pending failures expose the known hash and remain outside automatic fresh-payment challenges', async () => {
    const { post, account, chain } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const transaction: Hex = `0x${'ef'.repeat(32)}`
    chain.post = async () => { const { GateError } = await import('../errors'); throw new GateError(502, 'unconfirmed', 'Awaiting confirmation.', { transaction, status: 'pending', retryable: false }) }
    const response = await post('/x402/post', { text: 'hello' }, { 'payment-signature': await signed(account, terms) })
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.transaction).toBe(transaction)
    expect(body.status).toBe('pending')
    expect(body.explorer).toBe(`https://explorer.testnet.arc.io/tx/${transaction}`)
    expect(response.headers.has('payment-required')).toBe(false)
  })
  test('an expired original signature can request a proved external refund without a new payment', async () => {
    const { post, account } = setup()
    const terms = await termsOf(await post('/x402/post', { text: 'hello' }))
    const original = await signed(account, terms, { validBefore: BigInt(Math.floor(Date.now() / 1000)) - 100n })
    const settlementTransaction = `0x${'ab'.repeat(32)}`
    const response = await post('/x402/refund', { payTo: BOARD, settlementTransaction }, { 'payment-signature': original })
    expect(response.status).toBe(200)
    expect((await response.json()).result.refunded.raw).toBe(terms.amount)
  })
  test('transaction status rejects an invalid hash and reports a valid hash', async () => {
    const { call } = setup()
    expect((await call('/x402/transaction/0xabc')).status).toBe(400)
    const response = await call(`/x402/transaction/0x${'42'.repeat(32)}`)
    expect((await response.json()).status).toBe('confirmed')
  })
})
