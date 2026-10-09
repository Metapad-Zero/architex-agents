import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient,
  decodeEventLog, decodeFunctionData, encodeFunctionData, getAbiItem, hashDomain, http,
  isAddress, keccak256, parseSignature, parseUnits, zeroHash,
  type Abi, type Address, type Chain, type Hex, type Log, type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc, arcTestnet } from 'viem/chains'
import mainnetDeployment from '../../src/deployments/arc-mainnet.json' with { type: 'json' }
import testnetDeployment from '../../src/deployments/arc-testnet.json' with { type: 'json' }
import { readLogWindows } from '../../src/lib/rpcLogs.js'
import { boardGateAbi, launchpadGateAbi, launchTokenGateAbi, usdcAuthorizationAbi } from './abi.js'
import { GateError } from './errors.js'
import { describeConfirmedTransaction, eventMatches, readConfirmedAction, receiptEvents } from './recovery.js'
import type { ChainPort, Curve, Fees, Readiness, RecoveredAction, RecoveryRequest, Signed, TransactionStatus } from './port.js'

const USDC: Address = '0x3600000000000000000000000000000000000000'
const CONFIRM_WITHIN_MS = 40_000
const BOARD_WINDOWS = 20
const BOARD_SNAPSHOT_TTL_MS = 15_000
const BOARD_SCAN_WINDOW_MS = 60_000
const BOARD_SCAN_LIMIT = 4
const READINESS_FRESH_MS = 10_000

/** hashDomain requires the domain fields explicitly in the installed viem API. */
export function usdcDomainSeparator(chainId: number): Hex {
  return hashDomain({
    domain: { name: 'USDC', version: '2', chainId: BigInt(chainId), verifyingContract: USDC },
    types: { EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ] },
  })
}

type Env = Record<string, string | undefined>
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const definite = (value: string): Address | undefined => isAddress(value) && !/^0x0+$/i.test(value) ? value : undefined

const BY_NAME: Record<string, [status: 400 | 402 | 404, code: string, message: string]> = {
  SlippageExceeded: [400, 'slippage_exceeded', 'The price moved past your limit. Ask for a fresh quote and try again.'],
  UnknownToken: [404, 'unknown_token', 'No launch here has that token address.'],
  CurveGraduated: [400, 'curve_graduated', 'This curve has graduated. The token trades on its pool now.'],
  ExceedsSold: [400, 'exceeds_sold', 'That is more tokens than this curve has sold.'],
  ZeroAmount: [400, 'invalid_amount', 'The amount is too small to trade.'],
  InvalidName: [400, 'invalid_field', 'name must be 1 to 32 bytes.'],
  InvalidSymbol: [400, 'invalid_field', 'symbol must be 1 to 10 bytes.'],
  InvalidMetadata: [400, 'invalid_field', 'metadataURI must be at most 256 bytes.'],
  TextTooLong: [400, 'invalid_field', 'text must be at most 280 bytes.'],
  Forbidden: [402, 'not_relayable', 'This relayer is not allowed to submit that authorization.'],
  AuthorizationAlreadyUsed: [402, 'authorization_used', 'That authorization has already been used. Check its transaction before signing another payment.'],
  PaymentAlreadyConsumed: [402, 'authorization_used', 'That authorization has already been consumed. Check its transaction before signing another payment.'],
  AuthorizationExpired: [402, 'authorization_expired', 'The authorization has expired.'],
  AuthorizationNotYetValid: [402, 'authorization_not_yet_valid', 'The authorization is not valid yet.'],
  InvalidSignature: [402, 'invalid_signature', 'The signature does not match the authorization.'],
  BoundNonceMismatch: [400, 'bound_mismatch', 'The marked bound nonce does not match this action and its parameters. No action was sent.'],
  RecoveryRelayerRequired: [402, 'not_relayable', 'Recovery requires an allowlisted relayer to verify the prior settlement.'],
  SettlementAttestationRequired: [402, 'settlement_required', 'This authorization was already submitted. Its original settlement must be verified before recovery.'],
  SettlementNotConsumed: [402, 'invalid_settlement', 'The asset has not consumed this authorization.'],
  InsufficientUnaccountedBalance: [400, 'settlement_unavailable', 'The proven external payment is no longer available for recovery.'],
  PaymentAmountMismatch: [402, 'invalid_amount', 'The asset transferred a different amount than authorized.'],
  PaymentValueMismatch: [402, 'invalid_amount', 'The authorization amount does not match the current action fee.'],
  RelayFeeExceedsProceeds: [400, 'too_small', 'This sale would not cover its relay fee.'],
  ERC20InsufficientBalance: [402, 'insufficient_funds', 'The payer does not hold enough to cover this.'],
}
const BY_REASON: [RegExp, string, string][] = [
  [/invalid signature|ECRecover/i, 'invalid_signature', 'The signature does not match the authorization.'],
  [/used or canceled|already used/i, 'authorization_used', 'That authorization has already been used or cancelled. Check it before signing another payment.'],
  [/not yet valid/i, 'authorization_not_yet_valid', 'The authorization is not valid yet.'],
  [/expired/i, 'authorization_expired', 'The authorization has expired.'],
  [/exceeds balance|insufficient/i, 'insufficient_funds', 'The payer does not hold enough to cover this.'],
]

function refuse(error: unknown): never {
  if (error instanceof GateError) throw error
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const named = reverted.data?.errorName ? BY_NAME[reverted.data.errorName] : undefined
      if (named) throw new GateError(...named)
      for (const [pattern, code, message] of BY_REASON) if (pattern.test(reverted.reason ?? reverted.shortMessage)) throw new GateError(402, code, message)
      throw new GateError(400, 'would_revert', 'The contract would refuse this request. No transaction was sent.')
    }
  }
  throw new GateError(503, 'rpc_unavailable', 'The RPC could not simulate this request. No transaction was sent.')
}

/** Capacity one, with immediate backpressure. There is no queue in which authorizations can expire. */
export class SubmissionLane {
  private active = false
  get busy() { return this.active }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) throw new GateError(503, 'relay_busy', 'The relayer is busy. Retry the same signed request later.', { retryable: true })
    this.active = true
    try { return await work() } finally { this.active = false }
  }
}

export interface PendingTransaction { transaction: Hex; data: Hex; address: Address; nonce: number }
/** A delayed read of TX1 must never clear a newer TX2 occupying the same EOA lane. */
export async function refreshPending(slot: { current?: PendingTransaction }, read: (hash: Hex) => Promise<TransactionStatus>): Promise<PendingTransaction | undefined> {
  const observed = slot.current
  if (observed) {
    const state = await read(observed.transaction)
    if (slot.current === observed && (state.status === 'confirmed' || state.status === 'reverted')) slot.current = undefined
  }
  return slot.current
}

/** Only direct USDC calls are accepted. A receipt-wide event search cannot associate a transfer with its nonce. */
export function verifyExternalSettlement(
  signed: Signed,
  recipient: Address,
  transaction: { hash: Hex; to: Address | null; input: Hex },
  receipt: Pick<TransactionReceipt, 'status' | 'transactionHash' | 'logs'>,
): Hex {
  const reject = () => { throw new GateError(400, 'invalid_settlement', 'The settlement must be a successful direct USDC transferWithAuthorization with exactly this authorization and signature.') }
  if (!signed.settlementTransaction || signed.settlementTransaction === zeroHash || !same(transaction.hash, signed.settlementTransaction) || !same(receipt.transactionHash, transaction.hash) || receipt.status !== 'success' || !transaction.to || !same(transaction.to, USDC)) reject()
  let decoded: ReturnType<typeof decodeFunctionData>
  try { decoded = decodeFunctionData({ abi: usdcAuthorizationAbi, data: transaction.input }) } catch { return reject() }
  const args = decoded.args as readonly unknown[] | undefined
  if (decoded.functionName !== 'transferWithAuthorization' || !args || (args.length !== 7 && args.length !== 9)) return reject()
  const a = signed.auth
  if (typeof args[0] !== 'string' || !same(args[0], a.from) || typeof args[1] !== 'string' || !same(args[1], recipient) || args[2] !== a.value || args[3] !== a.validAfter || args[4] !== a.validBefore || !same(String(args[5]), a.nonce)) return reject()
  if (args.length === 7) {
    if (typeof args[6] !== 'string' || !same(args[6], signed.signature)) return reject()
  } else {
    let signature: ReturnType<typeof parseSignature>
    try { signature = parseSignature(signed.signature) } catch { return reject() }
    if (BigInt(args[6] as number) !== signature.v || !same(String(args[7]), signature.r) || !same(String(args[8]), signature.s)) return reject()
  }
  const logs = receipt.logs.filter((log) => same(log.address, USDC))
  // The pinned USDC implementation emits AuthorizationUsed immediately before its Transfer.
  if (logs.length !== 2) return reject()
  try {
    const used = decodeEventLog({ abi: usdcAuthorizationAbi, data: logs[0].data, topics: logs[0].topics })
    const moved = decodeEventLog({ abi: usdcAuthorizationAbi, data: logs[1].data, topics: logs[1].topics })
    if (used.eventName !== 'AuthorizationUsed' || moved.eventName !== 'Transfer' || !same(used.args.authorizer, a.from) || !same(used.args.nonce, a.nonce) || !same(moved.args.from, a.from) || !same(moved.args.to, recipient) || moved.args.value !== a.value) return reject()
  } catch { return reject() }
  return transaction.hash
}

export function viemPort(env: Env, options: { now?: () => number } = {}): ChainPort {
  const now = options.now ?? (() => Date.now())
  const network = env.ARC_NETWORK?.trim() || 'mainnet'
  if (network !== 'mainnet' && network !== 'testnet') throw new Error('ARC_NETWORK must be mainnet or testnet.')
  const deployment = network === 'mainnet' ? mainnetDeployment : testnetDeployment
  const configuredLaunchpad = definite(deployment.launchpad)
  const configuredBoard = definite(deployment.bbs)
  if (!configuredLaunchpad || !configuredBoard) throw new Error(`The launchpad and board are not deployed on Arc ${network} yet.`)
  const launchpad: Address = configuredLaunchpad
  const bbs: Address = configuredBoard
  const chain: Chain = network === 'mainnet' ? arc : arcTestnet
  if (deployment.chainId !== chain.id) throw new Error('The deployment manifest and configured chain disagree.')
  let rpcUrl: string = chain.rpcUrls.default.http[0]
  if (env.ARC_RPC_URL) {
    const parsed = new URL(env.ARC_RPC_URL)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('ARC_RPC_URL must use HTTPS, or HTTP on loopback.')
    rpcUrl = parsed.href
  }
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 1 })
  const client = createPublicClient({ chain, transport })
  const key = env.RELAYER_PRIVATE_KEY?.trim()
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('RELAYER_PRIVATE_KEY is not a valid private key.')
  if (key && env.RELAYER_MODE !== 'single-process') throw new Error('Signing requires RELAYER_MODE=single-process on one dedicated relayer instance.')
  if (key && network === 'mainnet' && env.GATE_ALLOW_MAINNET !== '1') throw new Error('Mainnet signing requires GATE_ALLOW_MAINNET=1.')
  let relayer: ReturnType<typeof privateKeyToAccount> | undefined
  try { relayer = key ? privateKeyToAccount(key as Hex) : undefined } catch { throw new Error('RELAYER_PRIVATE_KEY is not a valid private key.') }
  const wallet = relayer ? createWalletClient({ account: relayer, chain, transport }) : undefined
  const gasCap = env.RELAYER_MAX_GAS_USDC?.trim() || '0.5'
  if (!/^\d+(\.\d{1,18})?$/.test(gasCap) || parseUnits(gasCap, 18) === 0n) throw new Error('RELAYER_MAX_GAS_USDC must be a positive decimal amount.')
  const gasCapRaw = parseUnits(gasCap, 18)
  let feesRead: { at: number; value: Fees } | undefined
  let verified: { at: number; value: Promise<void> } | undefined
  const pending: { current?: PendingTransaction } = {}
  const lane = new SubmissionLane()
  type BoardSnapshot = Omit<Awaited<ReturnType<ChainPort['messages']>>, 'snapshot'> & { blockNumber: bigint; fetchedAt: number }
  let boardSnapshot: BoardSnapshot | undefined
  let boardRefresh: Promise<BoardSnapshot> | undefined
  let boardBudget: { at: number; attempts: number } | undefined

  const padReadAbi: Abi = launchpadGateAbi
  const boardReadAbi: Abi = boardGateAbi
  const readLaunchpad = <T>(functionName: string, args: readonly unknown[] = []) => client.readContract({ address: launchpad, abi: padReadAbi, functionName, args }) as Promise<T>
  const readBoard = <T>(functionName: string, args: readonly unknown[] = []) => client.readContract({ address: bbs, abi: boardReadAbi, functionName, args }) as Promise<T>

  async function verifyChain() {
    if (verified && Date.now() - verified.at < READINESS_FRESH_MS) return verified.value
    const value = (async () => {
      const [rpcChain, usdcCode, padCode, boardCode, padUsdc, boardUsdc, name, version, decimals, domain, boardLaunchpad, factory, launchMarker, postMarker] = await Promise.all([
        client.getChainId(), client.getBytecode({ address: USDC }), client.getBytecode({ address: launchpad }), client.getBytecode({ address: bbs }),
        readLaunchpad<Address>('usdc'), readBoard<Address>('usdc'),
        client.readContract({ address: USDC, abi: usdcAuthorizationAbi, functionName: 'name' }),
        client.readContract({ address: USDC, abi: usdcAuthorizationAbi, functionName: 'version' }),
        client.readContract({ address: USDC, abi: usdcAuthorizationAbi, functionName: 'decimals' }),
        client.readContract({ address: USDC, abi: usdcAuthorizationAbi, functionName: 'DOMAIN_SEPARATOR' }),
        readBoard<Address>('launchpad'), readLaunchpad<Address>('factory'),
        readLaunchpad<Hex>('launchNonce', [{ name: 'Readiness', symbol: 'READY', metadataURI: '', initialBuyUsdc: 0n, minTokensOut: 0n }, zeroHash]),
        readBoard<Hex>('postNonce', ['Readiness', zeroHash]),
      ])
      if (rpcChain !== chain.id) throw new GateError(503, 'wrong_rpc_chain', 'The configured RPC serves a different chain.')
      if (!usdcCode || usdcCode === '0x' || !padCode || padCode === '0x' || !boardCode || boardCode === '0x') throw new GateError(503, 'contracts_unavailable', 'A configured contract has no deployed code.')
      const expectedDomain = usdcDomainSeparator(chain.id)
      if (!same(padUsdc, USDC) || !same(boardUsdc, USDC) || name !== 'USDC' || version !== '2' || decimals !== 6 || domain !== expectedDomain) throw new GateError(503, 'asset_mismatch', 'The configured contracts or USDC signing domain do not match this chain.')
      if (!same(boardLaunchpad, launchpad) || !same(factory, deployment.factory) || !launchMarker.startsWith('0x4152435458424e44') || !postMarker.startsWith('0x4152435458424e44')) throw new GateError(503, 'contract_version_mismatch', 'The board, factory or authorization helper version does not match this agents deployment.')
    })()
    verified = { at: Date.now(), value }
    value.catch(() => { verified = undefined })
    return value
  }

  async function readiness(): Promise<Readiness> {
    await verifyChain()
    await refreshPending(pending, status)
    let ready = false
    let reason: string | null = 'This instance serves reads and quotes. Paid actions require the dedicated relayer.'
    if (relayer) {
      const [padAllowed, boardAllowed, balance, nonce, minedNonce] = await Promise.all([
        readLaunchpad<boolean>('isRelayer', [relayer.address]), readBoard<boolean>('isRelayer', [relayer.address]), client.getBalance({ address: relayer.address }),
        client.getTransactionCount({ address: relayer.address, blockTag: 'pending' }), client.getTransactionCount({ address: relayer.address, blockTag: 'latest' }),
      ])
      ready = padAllowed && boardAllowed && balance > 0n && nonce === minedNonce
      reason = !padAllowed || !boardAllowed ? 'The configured relayer is not allowlisted by both contracts.' : balance === 0n ? 'The configured relayer has no native USDC for gas.' : nonce !== minedNonce ? 'The RPC reports an unresolved relayer transaction. Reconcile the account before another payment.' : null
      if (pending.current || lane.busy) { ready = false; reason = 'The relayer has one transaction in progress.' }
    }
    return { chainVerified: true, contractsVerified: true, relay: { configured: Boolean(relayer), ready, mode: relayer ? 'single-process' : 'read-only', address: relayer?.address ?? null, reason } }
  }

  async function status(hash: Hex): Promise<TransactionStatus> {
    await verifyChain()
    try {
      const receipt = await client.getTransactionReceipt({ hash })
      const state: TransactionStatus = { transaction: receipt.transactionHash, status: receipt.status === 'success' ? 'confirmed' : 'reverted', blockNumber: receipt.blockNumber.toString() }
      if (receipt.status !== 'success') return state
      const transaction = await client.getTransaction({ hash: receipt.transactionHash })
      const original = describeConfirmedTransaction({ launchpad, bbs }, transaction, receipt)
      return original ? { ...state, action: original.action, payer: original.payer, result: original.result } : state
    } catch (error) {
      if (!(error instanceof BaseError) || !error.name.includes('NotFound')) throw new GateError(503, 'rpc_unavailable', 'The RPC could not read this transaction.')
      try { await client.getTransaction({ hash }); return { transaction: hash, status: 'pending' } } catch (txError) {
        if (txError instanceof BaseError && txError.name.includes('NotFound')) return { transaction: hash, status: 'not_found' }
        throw new GateError(503, 'rpc_unavailable', 'The RPC could not read this transaction.')
      }
    }
  }

  function events(logs: Log[], address: Address, abi: Abi, eventName: string): Record<string, unknown>[] {
    return receiptEvents(logs, address, abi, eventName)
  }

  function refusePending(): void {
    const active = pending.current
    if (active) throw new GateError(502, 'unconfirmed', 'The relayer has a sent transaction awaiting reconciliation. Inspect its hash; retry only the original authorization, and do not sign another payment.', { transaction: active.transaction, status: 'pending', retryable: false })
  }

  async function recover(intent: RecoveryRequest, signed: Signed): Promise<RecoveredAction | undefined> {
    await verifyChain()
    await refreshPending(pending, status)
    const recipient = intent.action === 'refund' ? intent.payTo : intent.action === 'post' ? bbs : launchpad
    const asset = intent.action === 'sell' ? intent.token : USDC
    const abi = same(recipient, bbs) ? boardGateAbi : launchpadGateAbi
    const consumed = await client.readContract({ address: recipient, abi, functionName: 'paymentConsumed', args: [asset, signed.auth.from, signed.auth.nonce] })
    if (!consumed) {
      // A different request can have signed while the consumed-state RPC was in flight.
      refusePending()
      if (relayer) {
        const [nonce, minedNonce] = await Promise.all([client.getTransactionCount({ address: relayer.address, blockTag: 'pending' }), client.getTransactionCount({ address: relayer.address, blockTag: 'latest' })])
        // Recheck the synchronous slot after the RPC awaits, preserving a known sent hash.
        refusePending()
        if (nonce !== minedNonce) throw new GateError(503, 'relayer_nonce_busy', 'The RPC reports an unresolved relayer transaction. Reconcile the account before retrying the original authorization; do not sign another payment.', { retryable: false })
      }
      return undefined
    }
    const head = await client.getBlockNumber()
    const relayed = getAbiItem({ abi: launchpadGateAbi, name: 'Relayed' })
    const refunded = getAbiItem({ abi: launchpadGateAbi, name: 'ExternalSettlementRefunded' })
    const reads = await Promise.all([
      readLogWindows({ head, windows: 2, read: (fromBlock, toBlock) => client.getLogs({ address: recipient, event: relayed, args: { from: signed.auth.from, nonce: signed.auth.nonce }, fromBlock, toBlock }) }),
      readLogWindows({ head, windows: 2, read: (fromBlock, toBlock) => client.getLogs({ address: recipient, event: refunded, args: { from: signed.auth.from, nonce: signed.auth.nonce }, fromBlock, toBlock }) }),
    ])
    const hashes = new Set(reads.flatMap((read) => read.logs.map((log) => log.transactionHash)))
    for (const hash of hashes) {
      const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
      const result = readConfirmedAction(intent, signed, { launchpad, bbs }, transaction, receipt)
      if (result) return result
    }
    throw new GateError(409, 'authorization_completed', 'This payment was already consumed, but its receipt is outside the recent recovery window. Check the original transaction hash; do not sign another payment.', { retryable: false })
  }

  function receiptFee(logs: Log[], address: Address, abi: Abi, signed: Signed, action: number): bigint {
    const found = events(logs, address, abi, 'Relayed').filter((entry) => eventMatches(entry, 'from', signed.auth.from) && eventMatches(entry, 'nonce', signed.auth.nonce) && entry.action === action)
    if (found.length !== 1 || typeof found[0].relayFee !== 'bigint') throw new GateError(502, 'unreadable_receipt', 'The confirmed receipt did not contain the expected payer, authorization and action.')
    return found[0].relayFee
  }

  async function settledProof(address: Address, signed: Signed): Promise<Hex> {
    await verifyChain()
    if (signed.settlementTransaction && signed.settlementTransaction !== zeroHash) {
      const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: signed.settlementTransaction }), client.getTransactionReceipt({ hash: signed.settlementTransaction })])
      return verifyExternalSettlement(signed, address, transaction, receipt)
    }
    const used = await client.readContract({ address: USDC, abi: usdcAuthorizationAbi, functionName: 'authorizationState', args: [signed.auth.from, signed.auth.nonce] })
    if (!used) return zeroHash
    const head = await client.getBlockNumber()
    const event = getAbiItem({ abi: usdcAuthorizationAbi, name: 'AuthorizationUsed' })
    const { logs } = await readLogWindows({ head, windows: 2, read: (fromBlock, toBlock) => client.getLogs({ address: USDC, event, args: { authorizer: signed.auth.from, nonce: signed.auth.nonce }, fromBlock, toBlock }) })
    for (const log of logs) {
      const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: log.transactionHash }), client.getTransactionReceipt({ hash: log.transactionHash })])
      // A previously completed atomic call is handled by the exact-calldata receipt lookup.
      if (transaction.to && same(transaction.to, address)) return zeroHash
      try { return verifyExternalSettlement({ ...signed, settlementTransaction: transaction.hash }, address, transaction, receipt) } catch (error) { if (!(error instanceof GateError)) throw error }
    }
    throw new GateError(409, 'settlement_unproven', 'This authorization was used or cancelled, but its exact direct payment could not be proved. Do not sign another payment. Supply the original settlement transaction for recovery or refund.', { retryable: false })
  }

  /** Match the original calldata as well as its nonce; never return another action's replacement receipt. */
  async function completed(call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }, signed: Signed, data: Hex): Promise<{ transaction: Hex; logs: Log[] } | undefined> {
    const head = await client.getBlockNumber()
    const refunding = call.functionName === 'refundExternalPayment'
    const event = getAbiItem({ abi: launchpadGateAbi, name: 'Relayed' })
    const refundEvent = getAbiItem({ abi: launchpadGateAbi, name: 'ExternalSettlementRefunded' })
    const filters = { from: signed.auth.from, nonce: signed.auth.nonce }
    const logs = refunding
      ? (await readLogWindows({ head, windows: 2, read: (fromBlock, toBlock) => client.getLogs({ address: call.address, event: refundEvent, args: filters, fromBlock, toBlock }) })).logs.map((log) => ({ transactionHash: log.transactionHash, action: undefined }))
      : (await readLogWindows({ head, windows: 2, read: (fromBlock, toBlock) => client.getLogs({ address: call.address, event, args: filters, fromBlock, toBlock }) })).logs.map((log) => ({ transactionHash: log.transactionHash, action: log.args.action }))
    for (const found of logs) {
      const selling = call.functionName === 'sellWithAuthorization'
      if (!refunding && (found.action === 2) !== selling) continue
      const [transaction, receipt] = await Promise.all([client.getTransaction({ hash: found.transactionHash }), client.getTransactionReceipt({ hash: found.transactionHash })])
      if (receipt.status !== 'success') continue
      if (selling) {
        const original = decodeFunctionData({ abi: launchpadGateAbi, data: transaction.input })
        if (!original.args || typeof original.args[0] !== 'string' || typeof call.args[0] !== 'string' || !same(original.args[0], call.args[0])) continue
      }
      if (!transaction.to || !same(transaction.to, call.address) || !same(transaction.input, data)) throw new GateError(409, 'authorization_completed', 'This authorization already completed a request. Inspect its transaction before signing another payment.', { transaction: receipt.transactionHash, status: 'confirmed', retryable: false })
      return { transaction: receipt.transactionHash, logs: receipt.logs }
    }
    return undefined
  }

  async function relay(call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }, signed: Signed): Promise<{ transaction: Hex; logs: Log[] }> {
    if (!relayer || !wallet) throw new GateError(503, 'relayer_not_configured', 'This gate can quote but the dedicated relayer is not configured.')
    await verifyChain()
    const data = encodeFunctionData(call)
    return lane.run(async () => {
      const active = await refreshPending(pending, status)
      if (active) throw new GateError(502, 'unconfirmed', 'The relayer is waiting for a sent transaction. Check it before retrying the same authorization.', { transaction: active.transaction, status: 'pending', retryable: false })
      const previous = await completed(call, signed, data)
      if (previous) return previous
      const ready = await readiness()
      // readiness reports this active submission as busy; role checks remain required.
      const [padAllowed, boardAllowed] = await Promise.all([readLaunchpad<boolean>('isRelayer', [relayer.address]), readBoard<boolean>('isRelayer', [relayer.address])])
      if (!ready.chainVerified || !padAllowed || !boardAllowed) throw new GateError(503, 'relayer_not_allowed', 'The dedicated relayer is not allowlisted by both contracts.')
      try { await client.simulateContract({ ...call, account: relayer }) } catch (error) { refuse(error) }
      const [nonce, minedNonce] = await Promise.all([client.getTransactionCount({ address: relayer.address, blockTag: 'pending' }), client.getTransactionCount({ address: relayer.address, blockTag: 'latest' })])
      if (nonce !== minedNonce) throw new GateError(503, 'relayer_nonce_busy', 'This relayer account has another pending transaction. It must be used by one submission process only.', { retryable: true })
      const request = await wallet.prepareTransactionRequest({ to: call.address, data, nonce })
      const maxFee = request.maxFeePerGas ?? request.gasPrice ?? 0n
      if (!request.gas || maxFee === 0n || request.gas * maxFee > gasCapRaw) throw new GateError(503, 'gas_budget_exceeded', 'The estimated transaction exceeds the configured relayer gas ceiling. No transaction was sent.')
      if (await client.getBalance({ address: relayer.address }) < request.gas * maxFee) throw new GateError(503, 'insufficient_relayer_gas', 'The relayer cannot cover this transaction gas estimate. No transaction was sent.')
      const serializedTransaction = await wallet.signTransaction(request)
      const transaction = keccak256(serializedTransaction)
      pending.current = { transaction, data, address: call.address, nonce }
      try { await client.sendRawTransaction({ serializedTransaction }) } catch {
        // A timed-out RPC may have accepted the signed bytes. Retain the lane and exact hash.
        throw new GateError(502, 'submission_unknown', 'The signed transaction may have been accepted by the RPC. Check its hash before retrying; do not sign another payment.', { transaction, status: 'pending', retryable: false })
      }
      let receipt
      try { receipt = await client.waitForTransactionReceipt({ hash: transaction, timeout: CONFIRM_WITHIN_MS }) } catch {
        throw new GateError(502, 'unconfirmed', 'The transaction was sent and is awaiting confirmation. Check its hash before retrying; do not sign another payment.', { transaction, status: 'pending', retryable: false })
      }
      if (pending.current?.transaction === transaction) pending.current = undefined
      if (receipt.transactionHash !== transaction) {
        const replacement = await client.getTransaction({ hash: receipt.transactionHash })
        if (!replacement.to || !same(replacement.to, call.address) || !same(replacement.input, data)) throw new GateError(409, 'nonce_replaced', 'A different transaction used this relayer nonce. Inspect it before retrying the same authorization.', { transaction: receipt.transactionHash, status: receipt.status === 'success' ? 'confirmed' : 'reverted', retryable: false })
      }
      if (receipt.status !== 'success') throw new GateError(502, 'reverted', 'The transaction reverted. Its atomic payment and action did not complete. An externally settled payment remains recoverable or refundable.', { transaction: receipt.transactionHash, status: 'reverted', retryable: false })
      return { transaction: receipt.transactionHash, logs: receipt.logs }
    })
  }

  const auth = (signed: Signed) => ({ ...signed.auth })
  const unreadable = (transaction: Hex): never => { throw new GateError(502, 'unreadable_receipt', 'The transaction confirmed but its expected action could not be decoded. Inspect the transaction before another payment.', { transaction, status: 'confirmed', retryable: false }) }

  async function readBoardSnapshot(): Promise<BoardSnapshot> {
    await verifyChain()
    const head = await client.getBlockNumber({ cacheTime: 0 })
    const total = await client.readContract({ address: bbs, abi: boardGateAbi, functionName: 'messageCount', blockNumber: head })
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new GateError(502, 'unreadable_history', 'The board count could not be represented safely.')
    if (total === 0n) return { total: 0, complete: true, messages: [], blockNumber: head, fetchedAt: now() }
    const event = getAbiItem({ abi: boardGateAbi, name: 'Message' })
    const ids = new Set<bigint>()
    const { logs, complete } = await readLogWindows({
      head, windows: BOARD_WINDOWS,
      read: async (fromBlock, toBlock) => {
        const logs = await client.getLogs({ address: bbs, event, fromBlock, toBlock })
        for (const log of logs) {
          if (log.args.id === undefined || log.args.id >= total || ids.has(log.args.id)) throw new GateError(502, 'unreadable_history', 'The board history did not match its snapshot count.')
          ids.add(log.args.id)
        }
        return logs
      },
      // The immutable 0..total-1 IDs prove there are no older messages to scan.
      reachedStart: () => Promise.resolve(BigInt(ids.size) === total),
    })
    if (complete && BigInt(ids.size) !== total) throw new GateError(502, 'unreadable_history', 'The complete board history did not match its snapshot count.')
    const messages = logs.sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex).slice(0, 100).map((log) => {
      if (log.args.id === undefined || !log.args.from || log.args.time === undefined || log.args.text === undefined) throw new GateError(502, 'unreadable_history', 'A board event could not be decoded.')
      return { id: log.args.id, from: log.args.from, time: log.args.time, text: log.args.text, transaction: log.transactionHash }
    })
    return { total: Number(total), complete, messages, blockNumber: head, fetchedAt: now() }
  }

  async function messages(count: number): ReturnType<ChainPort['messages']> {
    if (!Number.isInteger(count) || count < 0) throw new GateError(400, 'invalid_field', 'count must be a nonnegative whole number.')
    const at = now()
    const age = boardSnapshot ? at - boardSnapshot.fetchedAt : BOARD_SNAPSHOT_TTL_MS
    let value = age >= 0 && age < BOARD_SNAPSHOT_TTL_MS ? boardSnapshot : undefined
    if (!value) {
      if (!boardRefresh) {
        if (!boardBudget || at - boardBudget.at >= BOARD_SCAN_WINDOW_MS) boardBudget = { at, attempts: 0 }
        if (boardBudget.attempts >= BOARD_SCAN_LIMIT) throw new GateError(429, 'history_rate_limited', 'Board history refreshes are temporarily limited. Retry after the indicated delay.', { retryable: true, retryAfter: Math.max(1, Math.ceil((boardBudget.at + BOARD_SCAN_WINDOW_MS - at) / 1000)) })
        // Charge failed attempts too; retries cannot bypass the service-wide RPC budget.
        boardBudget.attempts++
        boardRefresh = (async () => {
          try { const snapshot = await readBoardSnapshot(); boardSnapshot = snapshot; return snapshot } finally { boardRefresh = undefined }
        })()
      }
      value = await boardRefresh
    }
    return {
      total: value.total, complete: value.complete, messages: value.messages.slice(0, Math.min(count, 100)),
      snapshot: { blockNumber: value.blockNumber, fetchedAt: value.fetchedAt, ageMs: Math.max(0, now() - value.fetchedAt), ttlMs: BOARD_SNAPSHOT_TTL_MS },
    }
  }

  return {
    chainId: chain.id, testnet: network === 'testnet', explorer: deployment.explorerBase, usdc: USDC, launchpad, bbs, canRelay: Boolean(relayer), readiness, transaction: status, recover, pendingTransaction: () => pending.current?.transaction,
    async authorizationUsed(asset, auth) { await verifyChain(); return client.readContract({ address: asset, abi: launchTokenGateAbi, functionName: 'authorizationState', args: [auth.from, auth.nonce] }) },
    async fees(options) {
      await verifyChain()
      if (!options?.fresh && feesRead && Date.now() - feesRead.at < 3_000) return feesRead.value
      const [launchFee, launchRelayFee, tradeRelayFee, tradeFeeBps, postFee, postRelayFee] = await Promise.all([readLaunchpad<bigint>('launchFee'), readLaunchpad<bigint>('launchRelayFee'), readLaunchpad<bigint>('tradeRelayFee'), readLaunchpad<bigint>('FEE_BPS'), readBoard<bigint>('postFee'), readBoard<bigint>('tradeRelayFee')])
      const value = { launchFee, launchRelayFee, tradeRelayFee, tradeFeeBps, postFee, postRelayFee }
      feesRead = { at: Date.now(), value }
      return value
    },
    async curve(token) { await verifyChain(); const curve = await readLaunchpad<Curve>('curves', [token]); return curve.createdAt === 0n ? undefined : curve },
    async curves(start, count) { await verifyChain(); const total = Number(await readLaunchpad<bigint>('tokensLength')); return { total, curves: count === 0 ? [] : [...await readLaunchpad<readonly Curve[]>('curvesPage', [BigInt(start), BigInt(count)])] } },
    async tokenName(token) { const [name, symbol] = await Promise.all([client.readContract({ address: token, abi: launchTokenGateAbi, functionName: 'name' }), client.readContract({ address: token, abi: launchTokenGateAbi, functionName: 'symbol' })]); return { name, symbol } },
    async quoteBuy(token, usdcIn) { try { const [tokensOut, fee, usdcSpent, graduates] = await readLaunchpad<readonly [bigint, bigint, bigint, boolean]>('quoteBuy', [token, usdcIn]); return { tokensOut, fee, usdcSpent, graduates } } catch (error) { refuse(error) } },
    async quoteSell(token, tokensIn) { try { const [usdcOut, fee] = await readLaunchpad<readonly [bigint, bigint]>('quoteSell', [token, tokensIn]); return { usdcOut, fee } } catch (error) { refuse(error) } },
    messages,
    launchNonce: (params, salt) => readLaunchpad<Hex>('launchNonce', [params, salt]), buyNonce: (token, minimum, salt) => readLaunchpad<Hex>('buyNonce', [token, minimum, salt]), sellNonce: (token, minimum, salt) => readLaunchpad<Hex>('sellNonce', [token, minimum, salt]), postNonce: (text, salt) => readBoard<Hex>('postNonce', [text, salt]),
    async launch(params, signed) {
      const settlement = await settledProof(launchpad, signed)
      const { transaction, logs } = await relay({ address: launchpad, abi: launchpadGateAbi, functionName: 'launchWithAuthorization', args: [params, signed.salt, auth(signed), signed.signature, settlement] }, signed)
      const created = events(logs, launchpad, launchpadGateAbi, 'TokenCreated').find((entry) => eventMatches(entry, 'creator', signed.auth.from))
      if (!created || typeof created.token !== 'string' || !isAddress(created.token)) return unreadable(transaction)
      const firstBuy = events(logs, launchpad, launchpadGateAbi, 'Trade').find((entry) => entry.isBuy === true && eventMatches(entry, 'trader', signed.auth.from) && eventMatches(entry, 'token', created.token as string))
      if (params.initialBuyUsdc > 0n && typeof firstBuy?.tokenAmount !== 'bigint') return unreadable(transaction)
      return { transaction, relayFee: receiptFee(logs, launchpad, launchpadGateAbi, signed, 0), token: created.token, tokensOut: typeof firstBuy?.tokenAmount === 'bigint' ? firstBuy.tokenAmount : 0n }
    },
    async buy(token, minimum, signed) {
      const settlement = await settledProof(launchpad, signed)
      const { transaction, logs } = await relay({ address: launchpad, abi: launchpadGateAbi, functionName: 'buyWithAuthorization', args: [token, minimum, signed.salt, auth(signed), signed.signature, settlement] }, signed)
      const trade = events(logs, launchpad, launchpadGateAbi, 'Trade').find((entry) => entry.isBuy === true && eventMatches(entry, 'trader', signed.auth.from) && eventMatches(entry, 'token', token))
      if (!trade || typeof trade.tokenAmount !== 'bigint' || typeof trade.usdcAmount !== 'bigint') return unreadable(transaction)
      return { transaction, relayFee: receiptFee(logs, launchpad, launchpadGateAbi, signed, 1), tokensOut: trade.tokenAmount, usdcSpent: trade.usdcAmount }
    },
    async sell(token, minimum, signed) {
      if (signed.settlementTransaction && signed.settlementTransaction !== zeroHash) throw new GateError(400, 'unsupported_settlement', 'Sales do not accept external USDC settlement.')
      const { transaction, logs } = await relay({ address: launchpad, abi: launchpadGateAbi, functionName: 'sellWithAuthorization', args: [token, minimum, signed.salt, auth(signed), signed.signature] }, signed)
      const trade = events(logs, launchpad, launchpadGateAbi, 'Trade').find((entry) => entry.isBuy === false && eventMatches(entry, 'trader', signed.auth.from) && eventMatches(entry, 'token', token))
      if (!trade || typeof trade.usdcAmount !== 'bigint' || typeof trade.fee !== 'bigint') return unreadable(transaction)
      const relayFee = receiptFee(logs, launchpad, launchpadGateAbi, signed, 2)
      return { transaction, relayFee, usdcOut: trade.usdcAmount - trade.fee - relayFee }
    },
    async post(text, signed) {
      const settlement = await settledProof(bbs, signed)
      const { transaction, logs } = await relay({ address: bbs, abi: boardGateAbi, functionName: 'postWithAuthorization', args: [text, signed.salt, auth(signed), signed.signature, settlement] }, signed)
      const message = events(logs, bbs, boardGateAbi, 'Message').find((entry) => eventMatches(entry, 'from', signed.auth.from) && entry.text === text)
      if (!message || typeof message.id !== 'bigint') return unreadable(transaction)
      return { transaction, relayFee: receiptFee(logs, bbs, boardGateAbi, signed, 3), id: message.id }
    },
    async refundExternal(destination, signed) {
      if (!destination || (!same(destination, launchpad) && !same(destination, bbs))) throw new GateError(400, 'invalid_pay_to', 'Refunds must name the original launchpad or board recipient.')
      const settlement = await settledProof(destination, signed)
      if (settlement === zeroHash) throw new GateError(400, 'missing_settlement', 'A refund requires the transaction of the original direct USDC settlement.')
      const abi = same(destination, launchpad) ? launchpadGateAbi : boardGateAbi
      const { transaction, logs } = await relay({ address: destination, abi, functionName: 'refundExternalPayment', args: [auth(signed), signed.signature, settlement] }, signed)
      const refunded = events(logs, destination, abi, 'ExternalSettlementRefunded').find((entry) => eventMatches(entry, 'from', signed.auth.from) && eventMatches(entry, 'nonce', signed.auth.nonce) && eventMatches(entry, 'settlementTransaction', settlement) && entry.value === signed.auth.value)
      if (!refunded) return unreadable(transaction)
      return { transaction, relayFee: 0n, amount: signed.auth.value }
    },
  }
}
