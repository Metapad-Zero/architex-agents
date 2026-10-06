import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createGateClient, gateOrigin } from '../gate.js'
import { createGate } from '../../../server/x402/gate.js'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { BOARD, LAUNCHPAD, USDC, fakeChain } from '../../../server/x402/__tests__/fakePort.js'

function setup(change?: (request: Request, response: Response) => Promise<Response>) {
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = fakeChain({ chainId: 5042 })
  chain.balances.set(`${USDC.toLowerCase()}:${account.address.toLowerCase()}`, 100_000_000n)
  const gate = createGate(() => chain)
  let signatures = 0
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.headers.has('payment-signature')) signatures++
    const response = await gate(request)
    return change ? change(request, response) : response
  }) as typeof fetch
  const client = createGateClient({ env: { GATE_URL: 'https://gate.test', ARC_NETWORK: 'mainnet', AGENT_ALLOW_MAINNET: '1', AGENT_MAX_PAYMENT_USDC: '5' }, send, expected: () => ({ chainId: 5042, network: 'eip155:5042', isTestnet: false, usdcAddress: USDC, launchpadAddress: LAUNCHPAD, bbsAddress: BOARD, explorerBase: 'https://explorer.arc.io' }), wallet: () => ({ account }), tokenName: async (token) => (await chain.tokenName(token)).name })
  return { client, chain, account, signatures: () => signatures }
}

describe('MCP payment policy using the installed stock x402 client', () => {
  test('refuses concurrent payment calls before a second signature can overwrite recovery state', async () => {
    let entered!: () => void
    let release!: () => void
    const atIndex = new Promise<void>((resolve) => { entered = resolve })
    const resume = new Promise<void>((resolve) => { release = resolve })
    const { client, signatures, chain } = setup(async (request, response) => {
      if (request.method === 'GET') { entered(); await resume }
      return response
    })
    const first = client.pay('/x402/post', { text: 'first' })
    await atIndex
    await expect(client.pay('/x402/post', { text: 'second' })).rejects.toThrow('in progress')
    expect(signatures()).toBe(0)
    release()
    expect((await first).result).toEqual({ id: '0' })
    expect(signatures()).toBe(1)
    expect(chain.posts.length).toBe(1)
  })
  test('completes mainnet-shaped launch, buy, sell and post with exact receipt agreement', async () => {
    const { client, chain, account } = setup()
    const launch = await client.pay('/x402/launch', { name: 'MCP check', symbol: 'MCP', initialBuyUsdc: '0' })
    const token = launch.result.token as `0x${string}`
    await client.pay('/x402/buy', { token, usdc: '1' })
    const balance = chain.balances.get(`${token.toLowerCase()}:${account.address.toLowerCase()}`) as bigint
    const { formatUnits } = await import('viem')
    await client.pay('/x402/sell', { token, tokens: formatUnits(balance, 18) }, token)
    expect((await client.pay('/x402/post', { text: 'hello' })).payer).toBe(account.address)
    expect(chain.posts).toEqual([{ from: account.address, text: 'hello' }])
  })
  test('rejects mismatched network before signing', async () => {
    const { client, signatures } = setup(async (request, response) => {
      if (request.method === 'GET') { const index: unknown = await response.json(); return Response.json({ ...(index as Record<string, unknown>), network: 'eip155:1' }) }
      return response
    })
    await expect(client.pay('/x402/post', { text: 'hello' })).rejects.toThrow('disagree')
    expect(signatures()).toBe(0)
  })
  test('rejects a changed recipient, domain, method or amount before the signer sends a payload', async () => {
    const changes: ((term: PaymentRequirements) => void)[] = [(term) => { term.payTo = LAUNCHPAD }, (term) => { term.extra = { ...term.extra, name: 'Changed' } }, (term) => { term.extra = { ...term.extra, assetTransferMethod: 'permit2' } }, (term) => { term.amount = '30000' }]
    for (const mutate of changes) {
      const { client, signatures } = setup((request, response) => {
        if (request.method === 'POST' && response.status === 402) {
          const required = decodePaymentRequiredHeader(response.headers.get('payment-required') ?? ''); mutate(required.accepts[0])
          const headers = new Headers(response.headers); headers.set('payment-required', encodePaymentRequiredHeader(required))
          return Promise.resolve(Response.json(required, { status: 402, headers }))
        }
        return Promise.resolve(response)
      })
      await expect(client.pay('/x402/post', { text: 'hello' })).rejects.toThrow('filtered')
      expect(signatures()).toBe(0)
    }
  })
  test('blocks excess USDC and unrecognized origin shapes before signing', async () => {
    const { client, signatures } = setup()
    await expect(client.pay('/x402/buy', { token: LAUNCHPAD, usdc: '10' })).rejects.toThrow('exceeds')
    expect(signatures()).toBe(0)
    for (const GATE_URL of ['https://gate.test/path', 'https://a:b@gate.test', 'http://gate.test', 'https://gate.test?x=1']) expect(() => gateOrigin({ GATE_URL })).toThrow()
  })
  test('retains the original authorization on a lost response and blocks a fresh payment', async () => {
    let lose = true
    const { client, signatures, chain } = setup((request, response) => {
      if (request.headers.has('payment-signature') && lose) { lose = false; return Promise.reject(new Error('connection lost after submission')) }
      return Promise.resolve(response)
    })
    await expect(client.pay('/x402/post', { text: 'once' })).rejects.toThrow('connection lost')
    expect(chain.posts.length).toBe(1)
    await expect(client.pay('/x402/post', { text: 'new' })).rejects.toThrow('uncertain')
    expect(signatures()).toBe(1)
    expect((await client.retry()).result).toEqual({ id: '0' })
    expect(signatures()).toBe(2)
    expect(chain.posts.length).toBe(1)
  })
  test('does not accept a false settlement response merely because the hash matches', async () => {
    const { client } = setup(async (request, response) => {
      if (request.headers.has('payment-signature') && response.ok) {
        const headers = new Headers(response.headers)
        const receipt = decodePaymentResponseHeader(headers.get('payment-response') ?? '')
        receipt.success = false
        headers.set('payment-response', encodePaymentResponseHeader(receipt))
        return new Response(await response.text(), { headers })
      }
      return response
    })
    await expect(client.pay('/x402/post', { text: 'receipt check' })).rejects.toThrow('disagree')
  })
})
