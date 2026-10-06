import { decodeEventLog, decodeFunctionData, isAddress, zeroHash, type Abi, type Address, type Hex, type Log, type TransactionReceipt } from 'viem'
import { boardGateAbi, launchpadGateAbi } from './abi.js'
import { GateError } from './errors.js'
import { money } from './money.js'
import type { Authorization, RecoveredAction, RecoveryRequest, Signed } from './port.js'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function receiptEvents(logs: readonly Log[], address: Address, abi: Abi, name: string): Record<string, unknown>[] {
  return logs.filter((log) => same(log.address, address)).flatMap((log) => {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics })
      const args: unknown = decoded.args
      if (decoded.eventName !== name || typeof args !== 'object' || args === null || Array.isArray(args)) return []
      return [Object.fromEntries(Object.entries(args))]
    } catch { return [] }
  })
}
export const eventMatches = (event: Record<string, unknown>, key: string, expected: string) => typeof event[key] === 'string' && same(event[key], expected)
const authMatches = (a: Authorization, b: Authorization) => same(a.from, b.from) && a.value === b.value && a.validAfter === b.validAfter && a.validBefore === b.validBefore && same(a.nonce, b.nonce)

/** Recover only a successful original direct action, matching its authorization and stable request intent. */
export function readConfirmedAction(
  intent: RecoveryRequest,
  signed: Signed,
  addresses: { launchpad: Address; bbs: Address },
  transaction: { hash: Hex; to: Address | null; input: Hex },
  receipt: Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'>,
): RecoveredAction | undefined {
  const recipient = intent.action === 'refund' ? intent.payTo : intent.action === 'post' ? addresses.bbs : addresses.launchpad
  if (receipt.status !== 'success' || !transaction.to || !same(transaction.to, recipient) || !same(receipt.transactionHash, transaction.hash)) return undefined
  const abi = [...launchpadGateAbi, ...boardGateAbi]
  let decoded: ReturnType<typeof decodeFunctionData<typeof abi>>
  try { decoded = decodeFunctionData({ abi, data: transaction.input }) } catch { return undefined }
  const mismatch = (): never => { throw new GateError(409, 'authorization_completed', 'This authorization already completed a different request. Inspect the original transaction before another payment.', { transaction: receipt.transactionHash, status: 'confirmed', retryable: false }) }
  const unreadable = (): never => { throw new GateError(502, 'unreadable_receipt', 'The original transaction confirmed but its result could not be decoded. Inspect it before another payment.', { transaction: receipt.transactionHash, status: 'confirmed', retryable: false }) }
  const check = (auth: Authorization, signature: Hex, salt: Hex, settlement?: Hex) => {
    if (!authMatches(auth, signed.auth) || !same(signature, signed.signature) || !same(salt, signed.salt) || (signed.settlementTransaction && !same(signed.settlementTransaction, settlement ?? zeroHash))) mismatch()
  }
  if (decoded.functionName === 'refundExternalPayment') {
    const [auth, signature, settlement] = decoded.args
    if (intent.action === 'sell') return undefined
    if (intent.action !== 'refund') return mismatch()
    check(auth, signature, zeroHash, settlement)
    const refunded = receiptEvents(receipt.logs, recipient, abi, 'ExternalSettlementRefunded').filter((event) => eventMatches(event, 'from', signed.auth.from) && eventMatches(event, 'nonce', signed.auth.nonce) && eventMatches(event, 'settlementTransaction', settlement) && event.value === signed.auth.value)
    if (refunded.length !== 1) return unreadable()
    return { transaction: receipt.transactionHash, bound: false, result: { refunded: money(signed.auth.value, 6), settlementTransaction: settlement } }
  }
  const relayed = receiptEvents(receipt.logs, recipient, abi, 'Relayed').filter((event) => eventMatches(event, 'from', signed.auth.from) && eventMatches(event, 'nonce', signed.auth.nonce))
  if (relayed.length !== 1 || typeof relayed[0].relayFee !== 'bigint' || typeof relayed[0].bound !== 'boolean') return unreadable()
  const relayFee = relayed[0].relayFee
  const bound = relayed[0].bound
  let result: Record<string, unknown>
  if (decoded.functionName === 'launchWithAuthorization') {
    const [params, salt, auth, signature, settlement] = decoded.args
    if (intent.action === 'sell') return undefined
    if (intent.action !== 'launch') return mismatch()
    check(auth, signature, salt, settlement)
    if (relayed[0].action !== 0 || params.name !== intent.name || params.symbol !== intent.symbol || params.metadataURI !== intent.metadataURI || params.initialBuyUsdc !== intent.initialBuyUsdc || (intent.minTokensOut !== undefined && intent.minTokensOut !== params.minTokensOut)) return mismatch()
    const created = receiptEvents(receipt.logs, recipient, abi, 'TokenCreated').filter((event) => eventMatches(event, 'creator', signed.auth.from) && event.name === params.name && event.symbol === params.symbol && event.metadataURI === params.metadataURI)
    if (created.length !== 1 || typeof created[0].token !== 'string' || !isAddress(created[0].token)) return unreadable()
    const first = receiptEvents(receipt.logs, recipient, abi, 'Trade').filter((event) => eventMatches(event, 'trader', signed.auth.from) && eventMatches(event, 'token', created[0].token as string) && event.isBuy === true)
    if (params.initialBuyUsdc > 0n && (first.length !== 1 || typeof first[0].tokenAmount !== 'bigint')) return unreadable()
    result = { token: created[0].token, tokensOut: money(params.initialBuyUsdc > 0n && typeof first[0]?.tokenAmount === 'bigint' ? first[0].tokenAmount : 0n, 18) }
  } else if (decoded.functionName === 'buyWithAuthorization') {
    const [token, minimum, salt, auth, signature, settlement] = decoded.args
    if (intent.action === 'sell') return undefined
    if (intent.action !== 'buy') return mismatch()
    check(auth, signature, salt, settlement)
    if (relayed[0].action !== 1 || !same(token, intent.token) || auth.value - relayFee !== intent.usdcIn || (intent.minTokensOut !== undefined && intent.minTokensOut !== minimum)) return mismatch()
    const traded = receiptEvents(receipt.logs, recipient, abi, 'Trade').filter((event) => eventMatches(event, 'trader', signed.auth.from) && eventMatches(event, 'token', token) && event.isBuy === true)
    if (traded.length !== 1 || typeof traded[0].tokenAmount !== 'bigint' || typeof traded[0].usdcAmount !== 'bigint' || traded[0].usdcAmount > intent.usdcIn) return unreadable()
    result = { token, tokensOut: money(traded[0].tokenAmount, 18), usdcSpent: money(traded[0].usdcAmount, 6), refunded: money(intent.usdcIn - traded[0].usdcAmount, 6) }
  } else if (decoded.functionName === 'sellWithAuthorization') {
    const [token, minimum, salt, auth, signature] = decoded.args
    // ERC-3009 nonces belong to each asset; a different token's sale is unrelated.
    if (intent.action !== 'sell' || !same(token, intent.token)) return undefined
    check(auth, signature, salt)
    if (relayed[0].action !== 2 || auth.value !== intent.tokensIn || (intent.minUsdcOut !== undefined && intent.minUsdcOut !== minimum)) return mismatch()
    const traded = receiptEvents(receipt.logs, recipient, abi, 'Trade').filter((event) => eventMatches(event, 'trader', signed.auth.from) && eventMatches(event, 'token', token) && event.isBuy === false)
    if (traded.length !== 1 || traded[0].tokenAmount !== intent.tokensIn || typeof traded[0].usdcAmount !== 'bigint' || typeof traded[0].fee !== 'bigint') return unreadable()
    result = { token, tokensIn: money(intent.tokensIn, 18), usdcOut: money(traded[0].usdcAmount - traded[0].fee - relayFee, 6) }
  } else if (decoded.functionName === 'postWithAuthorization') {
    const [text, salt, auth, signature, settlement] = decoded.args
    if (intent.action !== 'post') return mismatch()
    check(auth, signature, salt, settlement)
    if (relayed[0].action !== 3 || text !== intent.text) return mismatch()
    const posted = receiptEvents(receipt.logs, recipient, abi, 'Message').filter((event) => eventMatches(event, 'from', signed.auth.from) && event.text === text)
    if (posted.length !== 1 || typeof posted[0].id !== 'bigint') return unreadable()
    result = { id: posted[0].id.toString() }
  } else return undefined
  return { transaction: receipt.transactionHash, bound, result }
}

/** Derive the original intent from calldata for a transaction-status read, including refunds. */
export function describeConfirmedTransaction(addresses: { launchpad: Address; bbs: Address }, transaction: { hash: Hex; to: Address | null; input: Hex }, receipt: Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'>): (RecoveredAction & { action: RecoveryRequest['action']; payer: Address }) | undefined {
  if (!transaction.to || (!same(transaction.to, addresses.launchpad) && !same(transaction.to, addresses.bbs))) return undefined
  const abi = [...launchpadGateAbi, ...boardGateAbi]
  let decoded: ReturnType<typeof decodeFunctionData<typeof abi>>
  try { decoded = decodeFunctionData({ abi, data: transaction.input }) } catch { return undefined }
  let intent: RecoveryRequest
  let signed: Signed
  if (decoded.functionName === 'launchWithAuthorization') {
    const [params, salt, auth, signature, settlementTransaction] = decoded.args
    intent = { action: 'launch', ...params }; signed = { auth, signature, salt, settlementTransaction }
  } else if (decoded.functionName === 'buyWithAuthorization') {
    const [token, minTokensOut, salt, auth, signature, settlementTransaction] = decoded.args
    const relayed = receiptEvents(receipt.logs, transaction.to, abi, 'Relayed').filter((event) => eventMatches(event, 'from', auth.from) && eventMatches(event, 'nonce', auth.nonce))
    if (relayed.length !== 1 || typeof relayed[0].relayFee !== 'bigint') return undefined
    intent = { action: 'buy', token, minTokensOut, usdcIn: auth.value - relayed[0].relayFee }; signed = { auth, signature, salt, settlementTransaction }
  } else if (decoded.functionName === 'sellWithAuthorization') {
    const [token, minUsdcOut, salt, auth, signature] = decoded.args
    intent = { action: 'sell', token, minUsdcOut, tokensIn: auth.value }; signed = { auth, signature, salt }
  } else if (decoded.functionName === 'postWithAuthorization') {
    const [text, salt, auth, signature, settlementTransaction] = decoded.args
    intent = { action: 'post', text }; signed = { auth, signature, salt, settlementTransaction }
  } else if (decoded.functionName === 'refundExternalPayment') {
    const [auth, signature, settlementTransaction] = decoded.args
    intent = { action: 'refund', payTo: transaction.to }; signed = { auth, signature, salt: zeroHash, settlementTransaction }
  } else return undefined
  const recovered = readConfirmedAction(intent, signed, addresses, transaction, receipt)
  return recovered ? { ...recovered, action: intent.action, payer: signed.auth.from } : undefined
}
