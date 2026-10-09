import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { createWalletClient, http, keccak256, parseTransaction, recoverTransactionAddress, stringToHex, type Address, type Hex, type PrivateKeyAccount, type Transport, type TransactionSerialized } from 'viem'
import { arc } from 'viem/chains'
import { requireAgentWallet } from './agentWallet.js'
import { parseAmount, money } from '../../server/x402/money.js'
import { createJitPublicClient, createJitReader, JIT_SUPPLY, JitError, jitAddress, jitHash, jitObject, jitUint, parseJitLaunch, sameJitAddress, verifyJitReceipt, type JitLaunchInput, type JitPrepared, type JitReader, type JitSwapInput } from '../../src/lib/jit.js'

interface Entry { requestId: Hex; fingerprint: Hex; transaction: Hex; serializedTransaction: Hex; nonce: number; prepared: JitPrepared; gasReservation: string; status: 'pending' | 'confirmed' | 'reverted'; result?: Record<string, unknown> }
interface Completed { requestId: Hex; fingerprint: Hex; transaction: Hex; operation: JitPrepared['kind']; gasReservation: string; status: 'confirmed' | 'reverted'; result: Record<string, unknown> }
interface Journal { version: 1; chainId: 5042; address: Address; active: Entry | null; resolved: Completed[] }
export const JIT_JOURNAL_CAPACITY = 1024
export interface JitBudgets { usdc: bigint; nativeGas: bigint }
/** JIT has no implicit spending defaults. ERC20 capital and native gas are the same underlying Arc value. */
export function jitBudgets(env: Record<string, string | undefined>): JitBudgets {
  if (!env.AGENT_MAX_PAYMENT_USDC?.trim() || !env.AGENT_MAX_GAS_USDC?.trim()) throw new JitError(400, 'jit_budget_required', 'Set explicit AGENT_MAX_PAYMENT_USDC and AGENT_MAX_GAS_USDC before any direct JIT submission.')
  return { usdc: parseAmount(env.AGENT_MAX_PAYMENT_USDC, 6, 'AGENT_MAX_PAYMENT_USDC'), nativeGas: parseAmount(env.AGENT_MAX_GAS_USDC, 18, 'AGENT_MAX_GAS_USDC') }
}
export function checkJitBudget(prepared: JitPrepared, limits: JitBudgets, gasCost: bigint, nativeBalance: bigint): void {
  const capital = BigInt(prepared.usdcCommitted.raw), tokens = BigInt(prepared.tokenCommitted.raw)
  if (capital < 0n || capital > limits.usdc || tokens < 0n || tokens > JIT_SUPPLY) throw new JitError(400, 'jit_budget_exceeded', 'The finite approval or input exceeds its USDC ceiling or the token supply limit.')
  if (gasCost <= 0n || gasCost > limits.nativeGas) throw new JitError(400, 'jit_gas_ceiling', 'The maximum transaction gas charge exceeds AGENT_MAX_GAS_USDC. Nothing was signed.')
  if (nativeBalance < capital * 10n ** 12n + gasCost) throw new JitError(400, 'jit_insufficient_funds', 'The same underlying Arc balance must cover both committed USDC capital and maximum gas. Nothing was signed.')
}
function rpcNotFound(error: unknown) { return error instanceof Error && /Transaction(Receipt)?NotFound|could not be found|not found/i.test(`${error.name} ${error.message}`) }
function systemCode(error: unknown): string | undefined { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined }
function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = jitObject(value, 'intent')
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}
function amountRecord(value: unknown, decimals: number) {
  const r = jitObject(value, 'journal amount'), raw = jitUint(r.raw, 256, 'journal amount', true), result = money(raw, decimals)
  if (r.formatted !== result.formatted) throw new JitError(409, 'jit_journal_invalid', 'Journal amounts disagree. Stop and reconcile the original transaction.')
  return result
}
function preparedRecord(value: unknown): JitPrepared {
  const p = jitObject(value, 'journal operation'), tx = jitObject(p.transaction, 'journal transaction'), e = jitObject(p.expected, 'journal expected')
  if (p.kind !== 'approve' && p.kind !== 'launch' && p.kind !== 'deposit' && p.kind !== 'swap' && p.kind !== 'claim' && p.kind !== 'collect') throw new JitError(409, 'jit_journal_invalid', 'Unknown journal operation.')
  if (tx.chainId !== 5042 || tx.value !== '0' || typeof tx.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,32768}$/.test(tx.data)) throw new JitError(409, 'jit_journal_invalid', 'Journal calldata is invalid.')
  const expected: JitPrepared['expected'] = {}
  for (const key of ['launchId', 'configHash', 'creatorNonce'] as const) if (e[key] !== undefined) expected[key] = jitHash(e[key], key)
  for (const key of ['currency', 'spender', 'recipient'] as const) if (e[key] !== undefined) expected[key] = jitAddress(e[key], key)
  for (const key of ['amount', 'minimumOutput'] as const) if (e[key] !== undefined) expected[key] = jitUint(e[key], 256, key, true).toString()
  if (e.zeroForOne !== undefined) { if (typeof e.zeroForOne !== 'boolean') throw new JitError(409, 'jit_journal_invalid', 'Journal swap direction is invalid.'); expected.zeroForOne = e.zeroForOne }
  return { kind: p.kind, payer: jitAddress(p.payer, 'journal payer'), transaction: { chainId: 5042, value: '0', to: jitAddress(tx.to, 'journal destination'), data: tx.data as Hex }, usdcCommitted: amountRecord(p.usdcCommitted, 6), tokenCommitted: amountRecord(p.tokenCommitted, 18), expected, simulation: { executable: false, reason: 'Original transaction is retained for reconciliation.', gasEstimate: null } }
}
async function entryRecord(value: unknown, address: Address): Promise<Entry> {
  const e = jitObject(value, 'journal entry')
  if (typeof e.serializedTransaction !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,65536}$/.test(e.serializedTransaction) || typeof e.nonce !== 'number' || !Number.isSafeInteger(e.nonce) || e.nonce < 0 || (e.status !== 'pending' && e.status !== 'confirmed' && e.status !== 'reverted')) throw new JitError(409, 'jit_journal_invalid', 'Invalid original transaction journal. Do not submit another transaction.')
  const prepared = preparedRecord(e.prepared), serializedTransaction = e.serializedTransaction as Hex, transaction = jitHash(e.transaction, 'journal transaction'), signed = parseTransaction(serializedTransaction)
  if (keccak256(serializedTransaction) !== transaction || signed.chainId !== 5042 || signed.nonce !== e.nonce || !signed.to || !sameJitAddress(signed.to, prepared.transaction.to) || signed.data !== prepared.transaction.data || (signed.value ?? 0n) !== 0n || !sameJitAddress(prepared.payer, address) || !sameJitAddress(await recoverTransactionAddress({ serializedTransaction: serializedTransaction as TransactionSerialized }), address)) throw new JitError(409, 'jit_journal_invalid', 'Retained transaction signature, calldata, hash or chain disagrees. Stop and reconcile it.')
  return { requestId: jitHash(e.requestId, 'requestId'), fingerprint: jitHash(e.fingerprint, 'fingerprint'), transaction, serializedTransaction, nonce: e.nonce, prepared, gasReservation: jitUint(e.gasReservation, 256, 'gasReservation').toString(), status: e.status, result: e.result === undefined ? undefined : jitObject(e.result, 'result') }
}
async function secureFile(path: string) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new JitError(409, 'jit_state_permissions', 'JIT state files must be owned by this user, private, regular files without symlinks.')
  return stat
}
async function loadJournal(path: string, address: Address): Promise<Journal> {
  try {
    const stat = await secureFile(path)
    if (stat.size > 4_194_304) throw new JitError(409, 'jit_journal_invalid', 'JIT journal is larger than its bounded limit.')
    const value: unknown = JSON.parse(await readFile(path, 'utf8')), j = jitObject(value, 'journal')
    if (j.version !== 1 || j.chainId !== 5042 || !sameJitAddress(jitAddress(j.address, 'journal address'), address) || !Array.isArray(j.resolved) || j.resolved.length > JIT_JOURNAL_CAPACITY) throw new JitError(409, 'jit_journal_invalid', 'JIT journal belongs to a different wallet or version.')
    const resolved = j.resolved.map((value: unknown): Completed => {
      const e = jitObject(value, 'completed operation')
      if ((e.operation !== 'approve' && e.operation !== 'launch' && e.operation !== 'deposit' && e.operation !== 'swap' && e.operation !== 'claim' && e.operation !== 'collect') || (e.status !== 'confirmed' && e.status !== 'reverted')) throw new JitError(409, 'jit_journal_invalid', 'Completed journal operation is invalid.')
      return { requestId: jitHash(e.requestId,'requestId'), fingerprint: jitHash(e.fingerprint,'fingerprint'), transaction: jitHash(e.transaction,'transaction'), gasReservation: jitUint(e.gasReservation,256,'gasReservation').toString(), operation:e.operation, status:e.status, result:jitObject(e.result,'result') }
    })
    const active = j.active === null ? null : await entryRecord(j.active, address)
    if (new Set(resolved.map((e) => e.requestId)).size !== resolved.length || (active && resolved.some((e) => e.requestId === active.requestId))) throw new JitError(409, 'jit_journal_invalid', 'Duplicate retained request IDs cannot be reconciled safely.')
    return { version: 1, chainId: 5042, address, active, resolved }

  } catch (error) {
    if (systemCode(error) === 'ENOENT') return { version: 1, chainId: 5042, address, active: null, resolved: [] }
    if (error instanceof JitError) throw error
    throw new JitError(409, 'jit_journal_invalid', 'The durable JIT journal cannot be validated. Preserve it and reconcile the original transaction.')
  }
}
async function saveJournal(path: string, journal: Journal) {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`, file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(journal)); await file.sync() } finally { await file.close() }
  await rename(temporary, path)
  const directory = await open(join(path, '..'), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function withJournal<T>(directory: string, address: Address, run: (journal: Journal, path: string) => Promise<T>): Promise<T> {
  if (!isAbsolute(directory)) throw new JitError(400, 'jit_state_directory', 'AGENT_JIT_STATE_DIR must be an absolute private local directory.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new JitError(409, 'jit_state_permissions', 'JIT state directory must be owned by this user with permissions 0700 and no symlink.')
  const path = join(directory, `5042-${address.toLowerCase()}.json`), lock = `${path}.lock`
  let file: FileHandle
  try { file = await open(lock, 'wx', 0o600) } catch (error) { if (systemCode(error) === 'EEXIST') throw new JitError(409, 'jit_lane_locked', 'Another wallet operation or a stale crash lock owns this nonce lane. Stop other processes and inspect the journal before removing a stale lock.'); throw error }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, address, chainId: 5042 })); return await run(await loadJournal(path, address), path) }
  finally { await file.close(); await unlink(lock) }
}
function answer(entry: Entry | Completed) {
  return { requestId: entry.requestId, transaction: entry.transaction, status: entry.status, operation: 'operation' in entry ? entry.operation : entry.prepared.kind, gasReservation: money(BigInt(entry.gasReservation), 18), result: entry.result ?? null, explorer: `https://explorer.arc.io/tx/${entry.transaction}`, message: entry.status === 'pending' ? 'Original signed transaction is retained. Check this hash; do not create a replacement or a fresh requestId.' : 'Original direct-wallet outcome was reconciled.' }
}

export function createJitTools(options: { env?: Record<string, string | undefined>; reader?: JitReader; wallet?: () => { account: PrivateKeyAccount }; walletTransport?: Transport } = {}) {
  const env = options.env ?? process.env
  let cachedReader: JitReader | undefined
  const reader = () => options.reader ?? (cachedReader ??= createJitReader({ client: createJitPublicClient(env.ARC_RPC_URL) }))
  function wallet() {
    if ((env.ARC_NETWORK?.trim() || 'mainnet') !== 'mainnet' || env.AGENT_ALLOW_MAINNET !== '1') throw new JitError(400, 'jit_mainnet_opt_in', 'Direct JIT wallet tools require ARC_NETWORK=mainnet and AGENT_ALLOW_MAINNET=1.')
    return (options.wallet ?? (() => requireAgentWallet(env)))()
  }
  const directory = () => env.AGENT_JIT_STATE_DIR || join(homedir(), '.local', 'state', 'architex-agents')
  async function reconcile(journal: Journal, path: string): Promise<Entry | null> {
    const entry = journal.active
    if (!entry) return null
    if (await reader().client.getChainId() !== 5042) throw new JitError(503, 'jit_wrong_chain', 'Original transaction reconciliation requires Arc mainnet. Lane remains blocked.')
    let receipt
    try { receipt = await reader().client.getTransactionReceipt({ hash: entry.transaction }) } catch (error) { if (rpcNotFound(error)) return entry; throw new JitError(502, 'jit_status_unknown', 'RPC status is unknown. The original signed transaction remains retained; no fresh submission is permitted.') }
    const tx = await reader().client.getTransaction({ hash: entry.transaction })
    if (receipt.transactionHash !== entry.transaction || tx.hash !== entry.transaction || !tx.to || !sameJitAddress(tx.to, entry.prepared.transaction.to) || !sameJitAddress(tx.from, journal.address) || tx.input !== entry.prepared.transaction.data || tx.nonce !== entry.nonce || tx.chainId !== 5042 || tx.value !== 0n) throw new JitError(409, 'jit_receipt_mismatch', 'Transaction receipt disagrees with the exact original wallet operation. Lane remains blocked.')
    if (receipt.status === 'success') { entry.result = verifyJitReceipt(entry.prepared, receipt); entry.status = 'confirmed' }
    else { entry.status = 'reverted'; entry.result = { reverted: true, actionCompleted: false, gasPaid: true } }
    entry.result = { ...entry.result, gasCharged: money(receipt.gasUsed * receipt.effectiveGasPrice, 18) }
    journal.active = null; journal.resolved.push({ requestId:entry.requestId,fingerprint:entry.fingerprint,transaction:entry.transaction,operation:entry.prepared.kind,gasReservation:entry.gasReservation,status:entry.status,result:entry.result ?? {} })
    await saveJournal(path, journal)
    return entry
  }
  async function submit(requestIdInput: Hex, intent: unknown, build: (payer: Address) => Promise<JitPrepared>) {
    const requestId = jitHash(requestIdInput, 'requestId'), fingerprint = keccak256(stringToHex(stableJson(intent))), { account } = wallet()
    return withJournal(directory(), account.address, async (journal, path) => {
      const active = journal.active
      if (active) {
        const original = await reconcile(journal, path)
        if (original && original.requestId === requestId) {
          if (original.fingerprint !== fingerprint) throw new JitError(409, 'jit_request_mismatch', `requestId belongs to a different original operation; inspect ${original.transaction}.`)
          return answer(original)
        }
        if (journal.active) return { ...answer(journal.active), blockedRequestId: requestId, message: 'Another original wallet transaction is unresolved. No new operation was prepared or signed.' }
      }
      const prior = journal.resolved.find((e) => e.requestId === requestId)
      if (prior) { if (prior.fingerprint !== fingerprint) throw new JitError(409, 'jit_request_mismatch', `requestId belongs to a different confirmed operation; inspect ${prior.transaction}.`); return answer(prior) }
      if (journal.resolved.length >= JIT_JOURNAL_CAPACITY) throw new JitError(409, 'jit_journal_capacity', 'Durable request-ID retention is full. Preserve this journal; no new spending is allowed through this wallet lane. Original requests can still be inspected.')
      const limits = jitBudgets(env), port = reader()
      await port.verified()
      const [pendingNonce, latestNonce] = await Promise.all([port.client.getTransactionCount({ address: account.address, blockTag: 'pending' }), port.client.getTransactionCount({ address: account.address, blockTag: 'latest' })])
      if (pendingNonce !== latestNonce) throw new JitError(409, 'jit_nonce_busy', 'The wallet has a pending transaction outside this journal. Reconcile it before submitting through this exclusive lane.')
      const prepared = await build(account.address)
      if (!sameJitAddress(prepared.payer, account.address) || prepared.transaction.chainId !== 5042 || prepared.transaction.value !== '0') throw new JitError(400, 'jit_payer_mismatch', 'Prepared transaction does not belong to the local wallet.')
      // Limits are checked before provider preparation and again against the actual gas reservation.
      if (BigInt(prepared.usdcCommitted.raw) > limits.usdc || BigInt(prepared.tokenCommitted.raw) > JIT_SUPPLY) throw new JitError(400, 'jit_budget_exceeded', 'The finite funding amount exceeds its explicit ceiling. Nothing was signed.')
      if (!prepared.simulation.executable) throw new JitError(400, 'jit_not_executable', prepared.simulation.reason)
      const walletClient = createWalletClient({ chain: arc, account, transport: options.walletTransport ?? http(env.ARC_RPC_URL || arc.rpcUrls.default.http[0]) })
      // Real viem prepares and signs; tests may provide a local transport without broadcasting.
      const request = await walletClient.prepareTransactionRequest({ to: prepared.transaction.to, data: prepared.transaction.data, value: 0n, nonce: latestNonce })
      const maxFee = request.maxFeePerGas ?? request.gasPrice
      if (!request.gas || maxFee === undefined) throw new JitError(503, 'jit_gas_unknown', 'RPC did not provide a usable maximum gas charge.')
      const gasCost = request.gas * maxFee
      const nativeBalance = await port.client.getBalance({ address: account.address })
      checkJitBudget(prepared, limits, gasCost, nativeBalance)
      // A late nonce change blocks signing even if the preparation was valid earlier.
      const [lastPending, lastLatest] = await Promise.all([port.client.getTransactionCount({ address: account.address, blockTag: 'pending' }), port.client.getTransactionCount({ address: account.address, blockTag: 'latest' })])
      if (lastPending !== latestNonce || lastLatest !== latestNonce) throw new JitError(409, 'jit_nonce_busy', 'Wallet nonce changed during preparation. No transaction was signed.')
      const serializedTransaction = await walletClient.signTransaction(request), transaction = keccak256(serializedTransaction)
      const entry: Entry = { requestId, fingerprint, transaction, serializedTransaction, nonce: latestNonce, prepared, gasReservation: gasCost.toString(), status: 'pending' }
      journal.active = entry
      await saveJournal(path, journal) // fsync original signed bytes + hash BEFORE any broadcast.
      try { const accepted = await port.client.sendRawTransaction({ serializedTransaction }); if (accepted !== transaction) return { ...answer(entry), message: 'RPC returned a different hash; preserve the original and reconcile independently.' } }
      catch { return { ...answer(entry), message: 'Broadcast outcome is unknown. The original signed transaction and hash are durably retained. No replacement was signed.' } }
      try { await port.client.waitForTransactionReceipt({ hash: transaction, timeout: 15_000, pollingInterval: 500 }) } catch { return answer(entry) }
      return answer((await reconcile(journal, path)) ?? entry)
    })
  }
  return {
    getIndex: () => reader().index(), list: (start = '0', count = 20) => reader().list(start, count), detail: (id: Hex) => reader().detail(id),
    prepareLaunch: (creator: Address, config: JitLaunchInput, mineAttempts = 200_000) => reader().prepareLaunch(creator, config, mineAttempts),
    approve: (requestId: Hex, target: { kind: 'launch' | 'deposit' | 'swap'; launchId?: Hex }, currency: Address, amount: string) => submit(requestId, { kind: 'approve', target, currency, amount }, (payer) => reader().prepareApproval(payer, target, currency, amount)),
    launch: (requestId: Hex, configInput: JitLaunchInput) => { const { input } = parseJitLaunch(configInput); return submit(requestId, { kind: 'launch', config: input }, (payer) => reader().prepareLaunch(payer, input, 0)) },
    deposit: (requestId: Hex, id: Hex, currency: Address, amount: string) => submit(requestId, { kind: 'deposit', launchId: id, currency, amount }, (payer) => reader().prepareDeposit(payer, id, currency, amount)),
    quote: (input: JitSwapInput) => reader().quoteSwap(input),
    swap: (requestId: Hex, input: Omit<JitSwapInput, 'payer'>) => submit(requestId, { kind: 'swap', ...input }, (payer) => reader().quoteSwap({ ...input, payer })),
    fees: async (id: Hex) => { const launch = await reader().detail(id); return { launchId: id, feeRecipient: launch.feeRecipient, inventory: launch.inventory, note: 'Collected fee credits can be claimed in both assets; collection is a separate gas-paying transaction.' } },
    collect: (requestId: Hex, id: Hex) => submit(requestId, { kind: 'collect', launchId: id }, (payer) => reader().prepareCollect(payer, id)),
    claim: (requestId: Hex, id: Hex, currency: Address, amount: string) => submit(requestId, { kind: 'claim', launchId: id, currency, amount }, (payer) => reader().prepareClaim(payer, id, currency, amount)),
    check: async (hash?: Hex) => {
      if (hash) return reader().transaction(hash)
      const { account } = wallet()
      return withJournal(directory(), account.address, async (journal, path) => {
        const original = await reconcile(journal, path)
        return original ? answer(original) : { status: 'idle', last: journal.resolved.length ? answer(journal.resolved[journal.resolved.length - 1]) : null, message: 'No unresolved journal transaction. A pending account nonce is still checked before any submission.' }
      })
    },
  }
}
export type JitTools = ReturnType<typeof createJitTools>
let tools: JitTools | undefined
export const jitTools = () => (tools ??= createJitTools())
