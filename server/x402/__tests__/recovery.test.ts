import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroHash, type Address, type Hex, type TransactionReceipt } from 'viem'
import { boardGateAbi, launchpadGateAbi } from '../abi'
import { describeConfirmedTransaction, readConfirmedAction } from '../recovery'
import type { RecoveryRequest, Signed } from '../port'
import { BOARD, LAUNCHPAD } from './fakePort'

const hash: Hex = `0x${'12'.repeat(32)}`
const payer: Address = '0x00000000000000000000000000000000000000aa'
const token: Address = '0x00000000000000000000000000000000000000bb'
const auth = { from: payer, value: 1_010_000n, validAfter: 0n, validBefore: 2_000_000_000n, nonce: hash }
const signed: Signed = { auth, signature: '0x1234', salt: zeroHash }
const addresses = { launchpad: LAUNCHPAD, bbs: BOARD }
type MinedLog = TransactionReceipt['logs'][number]
function log(address: Address, topics: readonly unknown[], data: Hex, logIndex: number): MinedLog {
  const flat = topics.filter((topic): topic is Hex => typeof topic === 'string' && topic.startsWith('0x'))
  if (flat.length !== topics.length || flat.length === 0) throw new Error('Invalid fixture topics.')
  return { address, topics: [flat[0], ...flat.slice(1)], data, logIndex, transactionHash: hash, transactionIndex: 0, blockHash: hash, blockNumber: 100n, removed: false }
}
function relay(action: number, fee = 10_000n) {
  return log(LAUNCHPAD, encodeEventTopics({ abi: launchpadGateAbi, eventName: 'Relayed', args: { relayer: BOARD, from: payer, nonce: hash } }), encodeAbiParameters([{ type: 'uint8' }, { type: 'bool' }, { type: 'uint256' }], [action, false, fee]), 0)
}
function trade(isBuy: boolean) {
  return log(LAUNCHPAD, encodeEventTopics({ abi: launchpadGateAbi, eventName: 'Trade', args: { token, trader: payer } }), encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [isBuy, 900_000n, 1_000_000n, 1_000n, 10_000_000n, 100_000_000n]), 1)
}
const receipt = (logs: MinedLog[]): Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'> => ({ status: 'success', transactionHash: hash, logs })
function buy() {
  const intent: RecoveryRequest = { action: 'buy', token, usdcIn: 1_000_000n }
  const transaction = { hash, to: LAUNCHPAD, input: encodeFunctionData({ abi: launchpadGateAbi, functionName: 'buyWithAuthorization', args: [token, 500_000n, zeroHash, auth, signed.signature, zeroHash] }) }
  return { intent, transaction, receipt: receipt([relay(1), trade(true)]) }
}
describe('confirmed original calldata and receipts', () => {
  test('recovers the executed buy amount/refund and original minimum without current fees or quotes', () => {
    const f = buy()
    const recovered = readConfirmedAction(f.intent, signed, addresses, f.transaction, f.receipt)
    expect(recovered).toEqual({ transaction: hash, bound: false, result: { token, tokensOut: { raw: '1000000', formatted: '0.000000000001' }, usdcSpent: { raw: '900000', formatted: '0.9' }, refunded: { raw: '100000', formatted: '0.1' } } })
    const status = describeConfirmedTransaction(addresses, f.transaction, f.receipt)
    expect(status?.action).toBe('buy')
    expect(status?.payer.toLowerCase()).toBe(payer)
    expect(status?.result).toEqual(recovered?.result)
  })
  test('matches every signed authorization field and rejects altered stable parameters or explicit minimums with the original hash', () => {
    const f = buy()
    for (const payment of [{ ...signed, signature: '0xab' as Hex }, { ...signed, salt: hash }, { ...signed, auth: { ...auth, value: 2n } }, { ...signed, auth: { ...auth, validAfter: 1n } }, { ...signed, auth: { ...auth, validBefore: 1n } }, { ...signed, settlementTransaction: hash }]) expect(() => readConfirmedAction(f.intent, payment, addresses, f.transaction, f.receipt)).toThrow('different request')
    for (const intent of [{ action: 'buy' as const, token, usdcIn: 2n }, { action: 'buy' as const, token, usdcIn: 1_000_000n, minTokensOut: 0n }, { action: 'launch' as const, name: 'tampered', symbol: 'BAD', metadataURI: '', initialBuyUsdc: 0n }]) expect(() => readConfirmedAction(intent, signed, addresses, f.transaction, f.receipt)).toThrow('different request')
  })
  test('never turns a reverted, redirected, ambiguous or mismatched receipt into a successful action', () => {
    const f = buy()
    expect(readConfirmedAction(f.intent, signed, addresses, f.transaction, { ...f.receipt, status: 'reverted' })).toEqual(undefined)
    expect(readConfirmedAction(f.intent, signed, addresses, { ...f.transaction, to: BOARD }, f.receipt)).toEqual(undefined)
    expect(readConfirmedAction(f.intent, signed, addresses, f.transaction, { ...f.receipt, transactionHash: zeroHash })).toEqual(undefined)
    expect(() => readConfirmedAction(f.intent, signed, addresses, f.transaction, { ...f.receipt, logs: [relay(1), relay(1), trade(true)] })).toThrow('could not be decoded')
    expect(() => readConfirmedAction(f.intent, signed, addresses, f.transaction, receipt([relay(1)]))).toThrow('could not be decoded')
  })
  test('recovers a completed sale with its original net proceeds, keeping separate token nonces separate', () => {
    const sale = { ...signed, auth: { ...auth, value: 1_000_000n } }
    const intent: RecoveryRequest = { action: 'sell', token, tokensIn: sale.auth.value }
    const transaction = { hash, to: LAUNCHPAD, input: encodeFunctionData({ abi: launchpadGateAbi, functionName: 'sellWithAuthorization', args: [token, 0n, zeroHash, sale.auth, sale.signature] }) }
    expect(readConfirmedAction(intent, sale, addresses, transaction, receipt([relay(2), trade(false)]))?.result).toEqual({ token, tokensIn: { raw: '1000000', formatted: '0.000000000001' }, usdcOut: { raw: '889000', formatted: '0.889' } })
    expect(readConfirmedAction({ ...intent, token: BOARD }, sale, addresses, transaction, receipt([relay(2), trade(false)]))).toEqual(undefined)
  })
  test('recovers a confirmed refund from its calldata and refund event without requiring a Relayed event', () => {
    const original: Signed = { ...signed, settlementTransaction: hash }
    const transaction = { hash, to: BOARD, input: encodeFunctionData({ abi: boardGateAbi, functionName: 'refundExternalPayment', args: [auth, original.signature, hash] }) }
    const refunded = log(BOARD, encodeEventTopics({ abi: boardGateAbi, eventName: 'ExternalSettlementRefunded', args: { from: payer, nonce: hash, settlementTransaction: hash } }), encodeAbiParameters([{ type: 'uint256' }], [auth.value]), 0)
    const evidence = receipt([refunded])
    const recovered = readConfirmedAction({ action: 'refund', payTo: BOARD }, original, addresses, transaction, evidence)
    expect(recovered?.result).toEqual({ refunded: { raw: '1010000', formatted: '1.01' }, settlementTransaction: hash })
    expect(describeConfirmedTransaction(addresses, transaction, evidence)?.action).toBe('refund')
    expect(() => readConfirmedAction({ action: 'refund', payTo: BOARD }, { ...original, signature: '0xab' }, addresses, transaction, evidence)).toThrow('different request')
  })
})
