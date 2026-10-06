import { describe, expect, test } from 'bun:test'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequired } from '@x402/core/types'
import { zeroAddress } from 'viem'
import { addGateMoney, challengeAgreement, GATE_PREVIEW_BODY, parseGateChallenge, parseGateIndex, readGateChallenge, readGateIndex, type GateExpected } from '../gate'

const origin = 'https://agents.example'
const usdc = '0x3600000000000000000000000000000000000000'
const launchpad = '0x1111111111111111111111111111111111111111'
const bbs = '0x2222222222222222222222222222222222222222'
const expected: GateExpected = { chainId: 5042, asset: usdc, launchpad, bbs }
const money = (formatted: string, raw: string) => ({ formatted, raw })

function index() {
  return {
    name: 'Architex Agents', x402Version: 2, network: 'eip155:5042', chainId: 5042, testnet: false,
    asset: { symbol: 'USDC', address: usdc, decimals: 6, eip712: { name: 'USDC', version: '2' } },
    contracts: { launchpad, bbs },
    fees: { launchFee: money('0.25', '250000'), launchRelayFee: money('0.15', '150000'), tradeRelayFee: money('0.01', '10000'), postFee: money('0.01', '10000'), postRelayFee: money('0.02', '20000'), tradeFeeBps: 12 },
    readiness: { chainVerified: true, contractsVerified: true, relay: { configured: false, ready: false, mode: 'read-only', address: null, reason: 'No relayer configured.' } },
  }
}

function challenge() {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: `${origin}/x402/launch`, description: 'Launch a token', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'eip155:5042', asset: usdc, amount: '400000', payTo: launchpad, maxTimeoutSeconds: 120, extra: { name: 'USDC', version: '2' } }],
    extensions: {},
  }
  const body = { ...required, price: { asset: 'USDC', total: money('0.4', '400000'), breakdown: [{ label: 'Launch fee', ...money('0.25', '250000') }, { label: 'Relay fee', ...money('0.15', '150000') }] } }
  return { required, body, header: encodePaymentRequiredHeader(required) }
}

describe('mainnet gate index boundary', () => {
  test('keeps independent board relay fees and exact amounts', () => {
    const result = parseGateIndex(index(), expected)
    expect(result.network).toBe('eip155:5042')
    expect(addGateMoney(result.fees.launchFee, result.fees.launchRelayFee)).toBe('0.4')
    expect(addGateMoney(result.fees.postFee, result.fees.postRelayFee)).toBe('0.03')
    expect(result.readiness?.relay.ready).toBe(false)
  })

  test('rejects a testnet response and a testnet-configured page', () => {
    expect(() => parseGateIndex({ ...index(), chainId: 5042002, network: 'eip155:5042002', testnet: true }, expected)).toThrow('mainnet')
    expect(() => parseGateIndex(index(), { ...expected, chainId: 5042002 })).toThrow('mainnet')
    expect(() => parseGateIndex({ ...index(), testnet: true }, expected)).toThrow('mainnet')
  })

  test('rejects network, version, asset and signing-domain disagreement', () => {
    const different = index()
    different.network = 'eip155:1'
    expect(() => parseGateIndex(different, expected)).toThrow('mainnet')
    expect(() => parseGateIndex({ ...index(), x402Version: 1 }, expected)).toThrow('version 2')
    const wrongAsset = index()
    wrongAsset.asset.address = launchpad
    expect(() => parseGateIndex(wrongAsset, expected)).toThrow('different asset')
    const wrongDomain = index()
    wrongDomain.asset.eip712.version = '1'
    expect(() => parseGateIndex(wrongDomain, expected)).toThrow('signing domain')
  })

  test('does not treat zero addresses or a different deployment as ready', () => {
    expect(() => parseGateIndex({ ...index(), contracts: { launchpad: zeroAddress, bbs } }, expected)).toThrow('deployed contract')
    expect(() => parseGateIndex(index(), { ...expected, launchpad: bbs })).toThrow('deployment')
    expect(() => parseGateIndex(index(), { ...expected, bbs: launchpad })).toThrow('deployment')
    expect(parseGateIndex(index(), { ...expected, launchpad: zeroAddress, bbs: zeroAddress }).contracts.launchpad).toBe(launchpad)
  })

  test('rejects inconsistent and invalid fee representations', () => {
    const disagree = index()
    disagree.fees.launchFee.formatted = '1'
    expect(() => parseGateIndex(disagree, expected)).toThrow('disagrees')
    const negative = index()
    negative.fees.tradeRelayFee.raw = '-1'
    expect(() => parseGateIndex(negative, expected)).toThrow('atomic amount')
    const precision = index()
    precision.fees.postFee.formatted = '0.0000001'
    expect(() => parseGateIndex(precision, expected)).toThrow('disagrees')
    const overflow = index()
    overflow.fees.launchFee.raw = (1n << 256n).toString()
    expect(() => parseGateIndex(overflow, expected)).toThrow('atomic amount')
  })

  test('requires the board relay fee rather than assuming the trade fee', () => {
    const missing = index() as unknown as { fees: Record<string, unknown> }
    delete missing.fees.postRelayFee
    expect(() => parseGateIndex(missing, expected)).toThrow('Price')
  })

  test('validates reported relay status and allows older indexes without it', () => {
    const malformed = index()
    malformed.readiness.relay.mode = 'unbounded'
    expect(() => parseGateIndex(malformed, expected)).toThrow('readiness')
    const old = index() as unknown as Record<string, unknown>
    delete old.readiness
    expect(parseGateIndex(old, expected).readiness).toEqual(undefined)
  })

  test('rejects HTML and preserves an explicit unconfigured gateway reason', async () => {
    await expect(readGateIndex(origin, expected, undefined, () => Promise.resolve(new Response('<html/>')))).rejects.toThrow('readable JSON')
    await expect(readGateIndex(origin, expected, undefined, () => Promise.resolve(Response.json({ ok: false, message: 'Mainnet contracts are not configured.' }, { status: 503 })))).rejects.toThrow('Mainnet contracts')
  })
})

describe('unpaid challenge boundary', () => {
  test('reads a real x402 header and validates its repeated body', () => {
    const fixture = challenge()
    const result = parseGateChallenge(fixture.header, fixture.body, `${origin}/x402/launch`, expected)
    expect(result.amount).toEqual(money('0.4', '400000'))
    expect(result.payTo).toBe(launchpad)
    expect(challengeAgreement(parseGateIndex(index(), expected), result)).toEqual(undefined)
  })

  test('sends only the preview body, never a payment authorization', async () => {
    const fixture = challenge()
    const requests: { input: RequestInfo | URL; init?: RequestInit }[] = []
    const fetcher: typeof fetch = (input, init) => {
      requests.push({ input, init })
      return Promise.resolve(Response.json(fixture.body, { status: 402, headers: { 'payment-required': fixture.header } }))
    }
    await readGateChallenge(origin, expected, undefined, fetcher)
    expect(requests).toHaveLength(1)
    expect(requests[0].input).toBe(`${origin}/x402/launch`)
    expect(requests[0].init?.method).toBe('POST')
    expect(requests[0].init?.credentials).toBe('same-origin')
    const body = requests[0].init?.body
    if (typeof body !== 'string') throw new Error('Expected a JSON preview body.')
    expect(JSON.parse(body)).toEqual(GATE_PREVIEW_BODY)
    expect(new Headers(requests[0].init?.headers).has('payment-signature')).toBe(false)
  })

  test('rejects a missing or undecodable payment header', () => {
    const fixture = challenge()
    expect(() => parseGateChallenge(null, fixture.body, `${origin}/x402/launch`, expected)).toThrow('missing')
    expect(() => parseGateChallenge('not-base64', fixture.body, `${origin}/x402/launch`, expected)).toThrow('decoded')
  })

  test('rejects a different URL, network, recipient or domain', () => {
    const fixture = challenge()
    expect(() => parseGateChallenge(fixture.header, fixture.body, `${origin}/x402/post`, expected)).toThrow('different request URL')
    for (const changes of [{ network: 'eip155:5042002' }, { payTo: bbs }, { extra: { name: 'USDC', version: '1' } }]) {
      const wrong = { ...fixture.required, accepts: [{ ...fixture.required.accepts[0], ...changes }] }
      expect(() => parseGateChallenge(encodePaymentRequiredHeader(wrong as PaymentRequired), { ...fixture.body, ...wrong }, `${origin}/x402/launch`, expected)).toThrow()
    }
  })

  test('rejects challenge header and body disagreement', () => {
    const fixture = challenge()
    const body = { ...fixture.body, accepts: [{ ...fixture.body.accepts[0], amount: '500000' }] }
    expect(() => parseGateChallenge(fixture.header, body, `${origin}/x402/launch`, expected)).toThrow('header and body')
  })

  test('rejects mismatched total, breakdown, transfer method and lifetime', () => {
    const fixture = challenge()
    const total = { ...fixture.body, price: { ...fixture.body.price, total: money('0.5', '500000') } }
    expect(() => parseGateChallenge(fixture.header, total, `${origin}/x402/launch`, expected)).toThrow('breakdown')
    const breakdown = { ...fixture.body, price: { ...fixture.body.price, breakdown: [{ ...money('0.1', '100000'), label: 'Fee' }] } }
    expect(() => parseGateChallenge(fixture.header, breakdown, `${origin}/x402/launch`, expected)).toThrow('add up')
    const wrong = { ...fixture.required, accepts: [{ ...fixture.required.accepts[0], extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }] }
    expect(() => parseGateChallenge(encodePaymentRequiredHeader(wrong), { ...fixture.body, ...wrong }, `${origin}/x402/launch`, expected)).toThrow('signing domain')
    const lifetime = { ...fixture.required, accepts: [{ ...fixture.required.accepts[0], maxTimeoutSeconds: 600 }] }
    expect(() => parseGateChallenge(encodePaymentRequiredHeader(lifetime), { ...fixture.body, ...lifetime }, `${origin}/x402/launch`, expected)).toThrow('lifetime')
  })

  test('does not display fees as current if challenge and index changed between reads', () => {
    const fixture = challenge()
    const result = parseGateChallenge(fixture.header, fixture.body, `${origin}/x402/launch`, expected)
    const changed = index()
    changed.fees.launchFee = money('0.5', '500000')
    expect(challengeAgreement(parseGateIndex(changed, expected), result)).toContain('Fees changed')
  })

  test('does not mistake non-402 or non-JSON replies for a challenge', async () => {
    await expect(readGateChallenge(origin, expected, undefined, () => Promise.resolve(Response.json({ ok: true })))).rejects.toThrow('HTTP 200')
    await expect(readGateChallenge(origin, expected, undefined, () => Promise.resolve(new Response('down', { status: 503 })))).rejects.toThrow('readable JSON')
  })
})
