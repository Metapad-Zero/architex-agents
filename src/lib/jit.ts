import { createPublicClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, formatUnits, getAbiItem, getAddress, getCreate2Address, http, isAddress, keccak256, stringToHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient, type Transport, type TransactionReceipt } from 'viem'
import { arc } from 'viem/chains'
import deployment from '../deployments/arc-mainnet-jit.json' with { type: 'json' }
import { money, parseAmount as parseMoneyAmount, type Money } from '../../server/x402/money.js'
import { jitErc20Abi, jitExecutorAbi, jitFactoryAbi, jitHookAbi, jitHookDeployerAbi, jitQuoterAbi, jitVaultAbi } from './jitAbi.js'

export const JIT_CHAIN_ID = 5042
export const JIT_USDC: Address = '0x3600000000000000000000000000000000000000'
export const JIT_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
export const JIT_QUOTER: Address = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94'
export const JIT_SUPPLY = 1_000_000_000n * 10n ** 18n
export const JIT_VALID_UNTIL = (1n << 64n) - 1n
export type JitPublicClient = PublicClient<Transport, typeof arc>
export type JitPolicy = {
  initialSqrtPriceX96: bigint; baselineLower: number; baselineUpper: number; jitLower: number; jitUpper: number;
  baselineLiquidity: bigint; jitLiquidity: bigint; maxJITAmount0: bigint; maxJITAmount1: bigint;
  minSwapAmount0: bigint; minSwapAmount1: bigint; validUntil: bigint;
}
export type JitPolicyWire = { [K in keyof JitPolicy]: JitPolicy[K] extends bigint ? string : number }
export interface JitLaunchInput {
  name: string; symbol: string; metadataURI: string; seedUsdc: string; feeRecipient: Address;
  poolFee: number; tickSpacing: number; policy: JitPolicyWire; creatorNonce: Hex; hookSaltNonce: string; deadline: string;
}
export interface JitLaunchConfig {
  name: string; symbol: string; metadataURI: string; seedUSDC: bigint; feeRecipient: Address;
  poolFee: number; tickSpacing: number; policy: JitPolicy; creatorNonce: Hex; hookSaltNonce: bigint; deadline: bigint;
}
export interface JitPrediction { launchId: Hex; configHash: Hex; token: Address; vault: Address; hook: Address; executor: Address; hookInitCodeHash: Hex }
export interface JitRecord { creator: Address; token: Address; vault: Address; hook: Address; executor: Address; poolId: Hex; configHash: Hex; seedUSDC: bigint; createdAt: bigint }
export interface JitManifest {
  version: number; chainId: number; network: string; explorerBase: string;
  factory: Address; hookDeployer: Address; poolManager: Address; usdc: Address; quoter: Address;
  runtimeHashes: { factory: Hex; hookDeployer: Hex; poolManager: Hex; quoter: Hex };
}
export interface JitIndex {
  version: 1; chainId: 5042; network: 'eip155:5042'; testnet: false; explorerBase: string;
  contracts: { factory: Address; hookDeployer: Address; poolManager: Address; usdc: Address; quoter: Address };
  readiness: { ready: boolean; deploymentVerified: boolean; reason: string };
  poolFee: 3000; tickSpacing: 60; tokenSupply: Money;
  terms: { creatorAllocation: false; principalWithdrawable: false; gasSponsored: false; feeAssets: 'both'; fixedRanges: true };
}
export interface JitInventory {
  currency: Address; decimals: 6 | 18; cash: Money; claims: Money; available: Money;
  principalDeposited: Money; feeCredits: Money; feesClaimed: Money;
}
export interface JitLaunchView {
  launchId: Hex; creator: Address; token: Address; vault: Address; hook: Address; executor: Address;
  poolId: Hex; configHash: Hex; createdAt: string; tokenName: string; symbol: string; metadataURI: string | null;
  seedUsdc: Money; tokenSupply: Money; feeRecipient: Address; currency0: Address; currency1: Address;
  policy: JitPolicyWire; currentSqrtPriceX96: string; baselineSeeded: boolean; jitInRange: boolean;
  inventory: JitInventory[]; blockNumber: string;
}
export interface JitLaunchSummary { launchId: Hex; creator: Address; token: Address; vault: Address; hook: Address; executor: Address; poolId: Hex; configHash: Hex; createdAt: string; seedUsdc: Money; blockNumber: string }
export interface JitLaunchPage { start: string; count: number; total: string; nextStart: string | null; blockNumber: string; launches: JitLaunchSummary[] }
export interface JitUnsignedTransaction { to: Address; data: Hex; value: '0'; chainId: 5042 }
export interface JitPrepared {
  kind: 'approve' | 'launch' | 'deposit' | 'swap' | 'claim' | 'collect';
  transaction: JitUnsignedTransaction; payer: Address; usdcCommitted: Money; tokenCommitted: Money;
  expected: { launchId?: Hex; configHash?: Hex; creatorNonce?: Hex; currency?: Address; spender?: Address; amount?: string; recipient?: Address; zeroForOne?: boolean; minimumOutput?: string };
  simulation: { executable: boolean; reason: string; gasEstimate: string | null };
}
export interface JitSwapInput {
  launchId: Hex; payer: Address; inputCurrency: Address; amount: string; minimumOutput: string;
  recipient: Address; sqrtPriceLimitX96: string; deadline: string;
}
export class JitError extends Error {
  constructor(readonly status: 400 | 404 | 405 | 409 | 413 | 502 | 503, readonly code: string, message: string) { super(message) }
}
export function jitObject(value: unknown, field = 'request'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JitError(400, 'invalid_request', `${field} must be an object.`)
  return value as Record<string, unknown>
}
export function jitAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new JitError(400, 'invalid_address', `${field} must be a nonzero address.`)
  return getAddress(value)
}
export function jitHash(value: unknown, field: string, allowZero = false): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || (!allowZero && value.toLowerCase() === zeroHash)) throw new JitError(400, 'invalid_hash', `${field} must be a ${allowZero ? '' : 'nonzero '}bytes32 hex value.`)
  return value.toLowerCase() as Hex
}
export function jitUint(value: unknown, bits: number, field: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new JitError(400, 'invalid_integer', `${field} must be an unsigned integer string.`)
  const parsed = BigInt(value)
  if (parsed >= 1n << BigInt(bits) || (!allowZero && parsed === 0n)) throw new JitError(400, 'invalid_integer', `${field} is outside uint${bits}.`)
  return parsed
}
function parseAmount(value: unknown, decimals: number, field: string, options: { allowZero?: boolean } = {}): bigint {
  if (typeof value !== 'string') throw new JitError(400, 'invalid_amount', `${field} must be a decimal string.`)
  try { return parseMoneyAmount(value, decimals, field, options) } catch (error) { throw new JitError(400, 'invalid_amount', error instanceof Error ? error.message : 'Invalid decimal amount.') }
}
function textField(value: unknown, max: number, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || new TextEncoder().encode(value).length > max) throw new JitError(400, 'invalid_text', `${field} must contain ${allowEmpty ? '0' : '1'} to ${max} UTF-8 bytes.`)
  return value
}
function tick(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > 887220 || value % 60 !== 0) throw new JitError(400, 'invalid_policy', `${field} must be a supported multiple of 60 ticks.`)
  return value
}
export const sameJitAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function jitPolicyWire(policy: JitPolicy): JitPolicyWire {
  return { ...policy, initialSqrtPriceX96: policy.initialSqrtPriceX96.toString(), baselineLiquidity: policy.baselineLiquidity.toString(), jitLiquidity: policy.jitLiquidity.toString(), maxJITAmount0: policy.maxJITAmount0.toString(), maxJITAmount1: policy.maxJITAmount1.toString(), minSwapAmount0: policy.minSwapAmount0.toString(), minSwapAmount1: policy.minSwapAmount1.toString(), validUntil: policy.validUntil.toString() }
}
export function parseJitLaunch(value: unknown): { config: JitLaunchConfig; input: JitLaunchInput } {
  const v = jitObject(value, 'config'), p = jitObject(v.policy, 'policy')
  const policy: JitPolicy = {
    initialSqrtPriceX96: jitUint(p.initialSqrtPriceX96, 160, 'initialSqrtPriceX96'),
    baselineLower: tick(p.baselineLower, 'baselineLower'), baselineUpper: tick(p.baselineUpper, 'baselineUpper'),
    jitLower: tick(p.jitLower, 'jitLower'), jitUpper: tick(p.jitUpper, 'jitUpper'),
    baselineLiquidity: jitUint(p.baselineLiquidity, 128, 'baselineLiquidity'), jitLiquidity: jitUint(p.jitLiquidity, 128, 'jitLiquidity'),
    maxJITAmount0: jitUint(p.maxJITAmount0, 128, 'maxJITAmount0'), maxJITAmount1: jitUint(p.maxJITAmount1, 128, 'maxJITAmount1'),
    minSwapAmount0: jitUint(p.minSwapAmount0, 128, 'minSwapAmount0', true), minSwapAmount1: jitUint(p.minSwapAmount1, 128, 'minSwapAmount1', true), validUntil: jitUint(p.validUntil, 64, 'validUntil'),
  }
  if (v.poolFee !== 3000 || v.tickSpacing !== 60 || policy.validUntil !== JIT_VALID_UNTIL || !(policy.baselineLower < policy.jitLower && policy.jitLower < policy.jitUpper && policy.jitUpper < policy.baselineUpper) || (policy.baselineLower === policy.jitLower && policy.baselineUpper === policy.jitUpper)) throw new JitError(400, 'invalid_policy', 'Version 1 requires fee 3000, spacing 60, permanent fixed ranges, and a wider enclosing baseline.')
  const config: JitLaunchConfig = {
    name: textField(v.name, 32, 'name'), symbol: textField(v.symbol, 10, 'symbol'), metadataURI: textField(v.metadataURI, 256, 'metadataURI', true),
    seedUSDC: parseAmount(v.seedUsdc, 6, 'seedUsdc'), feeRecipient: jitAddress(v.feeRecipient, 'feeRecipient'), poolFee: 3000, tickSpacing: 60, policy,
    creatorNonce: jitHash(v.creatorNonce, 'creatorNonce'), hookSaltNonce: jitUint(v.hookSaltNonce, 256, 'hookSaltNonce', true), deadline: jitUint(v.deadline, 64, 'deadline'),
  }
  const input: JitLaunchInput = { name: config.name, symbol: config.symbol, metadataURI: config.metadataURI, seedUsdc: formatUnits(config.seedUSDC, 6), feeRecipient: config.feeRecipient, poolFee: 3000, tickSpacing: 60, policy: jitPolicyWire(policy), creatorNonce: config.creatorNonce, hookSaltNonce: config.hookSaltNonce.toString(), deadline: config.deadline.toString() }
  return { config, input }
}
export function jitLaunchId(creator: Address, nonce: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, nonce]))
}
export function jitPoolId(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]))
}
export function jitHookSalt(launchId: Hex, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex('ARCHITEX_JIT_HOOK')), launchId, nonce]))
}
export function mineJitHookSalt(deployer: Address, prediction: Pick<JitPrediction, 'launchId' | 'hookInitCodeHash'>, start: bigint, attempts: number): { nonce: bigint; hook: Address } {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 200_000 || start < 0n) throw new JitError(400, 'invalid_mining_budget', 'Mining requires 1 to 200000 local attempts and a nonnegative salt.')
  for (let i = 0; i < attempts; i++) {
    const nonce = start + BigInt(i)
    if (nonce >= 1n << 256n) break
    const hook = getCreate2Address({ from: deployer, salt: jitHookSalt(prediction.launchId, nonce), bytecodeHash: prediction.hookInitCodeHash })
    if (jitHookPermissionValid(hook)) return { nonce, hook }
  }
  throw new JitError(409, 'jit_hook_salt', 'No valid permission address was found within the local mining budget. Continue from a later salt nonce.')
}
export function jitInitialCapital(config: JitLaunchConfig, token: Address) {
  const p = config.policy, price = p.initialSqrtPriceX96, perTickLimit = ((1n << 128n) - 1n) / 29576n
  if (price <= jitSqrtAtTick(p.jitLower) || price >= jitSqrtAtTick(p.jitUpper) || p.baselineLiquidity > perTickLimit || p.jitLiquidity > perTickLimit || p.baselineLiquidity + p.jitLiquidity >= 1n << 128n) throw new JitError(400, 'invalid_policy', 'Initial price or liquidity exceeds the pinned pool limits.')
  const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b
  const amounts = (lower: number, upper: number, liquidity: bigint) => ({ amount0: ceil((liquidity << 96n) * (jitSqrtAtTick(upper) - price), jitSqrtAtTick(upper) * price), amount1: ceil(liquidity * (price - jitSqrtAtTick(lower)), 1n << 96n) })
  const baseline = amounts(p.baselineLower, p.baselineUpper, p.baselineLiquidity), jit = amounts(p.jitLower, p.jitUpper, p.jitLiquidity)
  const signedLimit = (1n << 127n) - 1n, lower = jitSqrtAtTick(p.jitLower), upper = jitSqrtAtTick(p.jitUpper)
  if (baseline.amount0 > signedLimit || baseline.amount1 > signedLimit || ceil((p.jitLiquidity << 96n) * (upper - lower), upper * lower) > signedLimit || ceil(p.jitLiquidity * (upper - lower), 1n << 96n) > signedLimit) throw new JitError(400, 'invalid_policy', 'Position amounts exceed the signed core limit.')
  const tokenFirst = BigInt(token) < BigInt(JIT_USDC), capital0 = tokenFirst ? JIT_SUPPLY : config.seedUSDC, capital1 = tokenFirst ? config.seedUSDC : JIT_SUPPLY
  if (baseline.amount0 + jit.amount0 > capital0 || baseline.amount1 + jit.amount1 > capital1 || jit.amount0 > p.maxJITAmount0 || jit.amount1 > p.maxJITAmount1) throw new JitError(400, 'insufficient_initial_capital', 'Seed and supply must cover rounded baseline plus initial JIT inventory within both immutable caps.')
  const d0 = tokenFirst ? 18 : 6, d1 = tokenFirst ? 6 : 18
  return { baseline: { amount0: money(baseline.amount0, d0), amount1: money(baseline.amount1, d1) }, initialJit: { amount0: money(jit.amount0, d0), amount1: money(jit.amount1, d1) }, remainingAfterBaseline: { amount0: money(capital0 - baseline.amount0, d0), amount1: money(capital1 - baseline.amount1, d1) } }
}
export const jitHookPermissionValid = (address: Address) => (BigInt(address) & 0x3fffn) === 0x2ae0n
export function parseJitManifest(value: unknown): JitManifest {
  const v = jitObject(value, 'deployment'), hashes = jitObject(v.runtimeHashes, 'runtimeHashes')
  if (v.version !== 1 || v.chainId !== 5042 || v.network !== 'eip155:5042' || v.explorerBase !== 'https://explorer.arc.io') throw new JitError(503, 'jit_configuration', 'JIT deployment must identify Arc mainnet version 1.')
  const optionalAddress = (key: string) => typeof v[key] === 'string' && isAddress(v[key]) ? getAddress(v[key]) : jitAddress(undefined, key)
  const manifest: JitManifest = { version: 1, chainId: 5042, network: 'eip155:5042', explorerBase: v.explorerBase, factory: optionalAddress('factory'), hookDeployer: optionalAddress('hookDeployer'), poolManager: jitAddress(v.poolManager, 'poolManager'), usdc: jitAddress(v.usdc, 'usdc'), quoter: jitAddress(v.quoter, 'quoter'), runtimeHashes: { factory: jitHash(hashes.factory, 'factory runtime', true), hookDeployer: jitHash(hashes.hookDeployer, 'hook deployer runtime', true), poolManager: jitHash(hashes.poolManager, 'manager runtime'), quoter: jitHash(hashes.quoter, 'quoter runtime') } }
  if (!sameJitAddress(manifest.usdc, JIT_USDC) || !sameJitAddress(manifest.poolManager, JIT_MANAGER) || !sameJitAddress(manifest.quoter, JIT_QUOTER)) throw new JitError(503, 'jit_configuration', 'Unexpected Arc USDC, PoolManager or Quoter.')
  return manifest
}
export const jitManifest = parseJitManifest(deployment)
export function createJitPublicClient(rpcUrl: string = arc.rpcUrls.default.http[0]): JitPublicClient {
  const url = new URL(rpcUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new JitError(503, 'jit_configuration', 'JIT RPC must use HTTPS or loopback HTTP.')
  return createPublicClient({ chain: arc, transport: http(url.href, { timeout: 10_000, retryCount: 1, batch: { batchSize: 50, wait: 0 } }) })
}

export function createJitReader(options: { client?: JitPublicClient; manifest?: JitManifest } = {}) {
  const client = options.client ?? createJitPublicClient(), manifest = parseJitManifest(options.manifest ?? jitManifest)
  const unavailable = () => sameJitAddress(manifest.factory, zeroAddress) || sameJitAddress(manifest.hookDeployer, zeroAddress) || manifest.runtimeHashes.factory === zeroHash || manifest.runtimeHashes.hookDeployer === zeroHash
  async function verified() {
    if (unavailable()) throw new JitError(503, 'jit_unavailable', 'JIT factory and hook deployer are not deployed and verified.')
    if (await client.getChainId() !== JIT_CHAIN_ID) throw new JitError(503, 'jit_wrong_chain', 'JIT RPC does not serve Arc mainnet.')
    const block = await client.getBlock({ blockTag: 'latest' })
    const codeNames = ['factory', 'hookDeployer', 'poolManager', 'quoter'] as const
    await Promise.all(codeNames.map(async (key) => {
      const code = await client.getBytecode({ address: manifest[key], blockNumber: block.number })
      if (!code || code === '0x' || keccak256(code) !== manifest.runtimeHashes[key]) throw new JitError(503, 'jit_code_mismatch', `The ${key} runtime does not match the approved deployment.`)
    }))
    const [manager, quote, deployer, deployerManager, quoterManager, fee, spacing, supply, decimals, name, version] = await Promise.all([
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'poolManager', blockNumber: block.number }),
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'quote', blockNumber: block.number }),
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'hookDeployer', blockNumber: block.number }),
      client.readContract({ address: manifest.hookDeployer, abi: jitHookDeployerAbi, functionName: 'poolManager', blockNumber: block.number }),
      client.readContract({ address: manifest.quoter, abi: jitQuoterAbi, functionName: 'poolManager', blockNumber: block.number }),
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'POOL_FEE', blockNumber: block.number }),
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'TICK_SPACING', blockNumber: block.number }),
      client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'TOKEN_SUPPLY', blockNumber: block.number }),
      client.readContract({ address: JIT_USDC, abi: jitErc20Abi, functionName: 'decimals', blockNumber: block.number }),
      client.readContract({ address: JIT_USDC, abi: jitErc20Abi, functionName: 'name', blockNumber: block.number }),
      client.readContract({ address: JIT_USDC, abi: jitErc20Abi, functionName: 'version', blockNumber: block.number }),
    ])
    if (!sameJitAddress(manager, manifest.poolManager) || !sameJitAddress(quote, JIT_USDC) || !sameJitAddress(deployer, manifest.hookDeployer) || !sameJitAddress(deployerManager, manifest.poolManager) || !sameJitAddress(quoterManager, manifest.poolManager) || BigInt(fee) !== 3000n || BigInt(spacing) !== 60n || BigInt(supply) !== JIT_SUPPLY || decimals !== 6 || name !== 'USDC' || version !== '2') throw new JitError(503, 'jit_immutable_mismatch', 'JIT deployment immutables, constants or USDC identity disagree.')
    return block
  }
  async function index(): Promise<JitIndex> {
    let ready = false, reason = 'JIT factory and hook deployer are not deployed and verified.'
    try { await verified(); ready = true; reason = 'Verified direct-wallet JIT deployment. Wallet funding and gas are checked before submission.' } catch (error) { reason = error instanceof JitError ? error.message : 'JIT RPC readiness could not be verified.' }
    return { version: 1, chainId: 5042, network: 'eip155:5042', testnet: false, explorerBase: manifest.explorerBase, contracts: { factory: manifest.factory, hookDeployer: manifest.hookDeployer, poolManager: manifest.poolManager, usdc: JIT_USDC, quoter: manifest.quoter }, readiness: { ready, deploymentVerified: ready, reason }, poolFee: 3000, tickSpacing: 60, tokenSupply: money(JIT_SUPPLY, 18), terms: { creatorAllocation: false, principalWithdrawable: false, gasSponsored: false, feeAssets: 'both', fixedRanges: true } }
  }
  async function record(id: Hex, blockNumber?: bigint): Promise<JitRecord> {
    let result: JitRecord
    try { result = await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'getLaunch', args: [id], blockNumber }) } catch (error) {
      let cause: unknown = error
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('data' in cause && cause.data && typeof cause.data === 'object' && 'errorName' in cause.data && cause.data.errorName === 'UnknownLaunch') throw new JitError(404, 'jit_launch_not_found', 'No JIT launch is registered under this ID.')
        cause = 'cause' in cause ? cause.cause : undefined
      }
      throw error
    }
    if (result.createdAt === 0n || sameJitAddress(result.token, zeroAddress)) throw new JitError(404, 'jit_launch_not_found', 'No JIT launch is registered under this ID.')
    return result
  }
  async function detail(idInput: Hex, at?: bigint): Promise<JitLaunchView> {
    const id = jitHash(idInput, 'launchId'), block = at ?? (await verified()).number, r = await record(id, block)
    const [vaultHook, vaultToken, vaultQuote, vaultManager, feeRecipient, currency0, currency1] = await Promise.all((['hook', 'token', 'quote', 'poolManager', 'feeRecipient', 'currency0', 'currency1'] as const).map((functionName) => client.readContract({ address: r.vault, abi: jitVaultAbi, functionName, blockNumber: block })))
    const [hookManager, hookVault, hookPoolId, executorManager, executorHook, key, executorKey, name, symbol, decimals, supply, baselineSeeded, currentPrice] = await Promise.all([
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'poolManager', blockNumber: block }),
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'vault', blockNumber: block }),
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'poolId', blockNumber: block }),
      client.readContract({ address: r.executor, abi: jitExecutorAbi, functionName: 'poolManager', blockNumber: block }),
      client.readContract({ address: r.executor, abi: jitExecutorAbi, functionName: 'hook', blockNumber: block }),
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'getPoolKey', blockNumber: block }),
      client.readContract({ address: r.executor, abi: jitExecutorAbi, functionName: 'getPoolKey', blockNumber: block }),
      client.readContract({ address: r.token, abi: jitErc20Abi, functionName: 'name', blockNumber: block }),
      client.readContract({ address: r.token, abi: jitErc20Abi, functionName: 'symbol', blockNumber: block }),
      client.readContract({ address: r.token, abi: jitErc20Abi, functionName: 'decimals', blockNumber: block }),
      client.readContract({ address: r.token, abi: jitErc20Abi, functionName: 'totalSupply', blockNumber: block }),
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'baselineSeeded', blockNumber: block }),
      client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'currentSqrtPriceX96', blockNumber: block }),
    ])
    if (!vaultHook || !vaultToken || !vaultQuote || !vaultManager || !feeRecipient || !currency0 || !currency1 || !sameJitAddress(vaultHook, r.hook) || !sameJitAddress(vaultToken, r.token) || !sameJitAddress(vaultQuote, JIT_USDC) || !sameJitAddress(vaultManager, JIT_MANAGER) || !sameJitAddress(hookManager, JIT_MANAGER) || !sameJitAddress(hookVault, r.vault) || !sameJitAddress(executorManager, JIT_MANAGER) || !sameJitAddress(executorHook, r.hook) || !jitHookPermissionValid(r.hook) || hookPoolId !== r.poolId || jitPoolId(key) !== r.poolId || jitPoolId(executorKey) !== r.poolId || key.fee !== 3000 || key.tickSpacing !== 60 || !sameJitAddress(key.hooks, r.hook) || !sameJitAddress(key.currency0, currency0) || !sameJitAddress(key.currency1, currency1) || BigInt(currency0) >= BigInt(currency1) || ![currency0, currency1].some((c) => sameJitAddress(c, r.token)) || ![currency0, currency1].some((c) => sameJitAddress(c, JIT_USDC)) || decimals !== 18 || supply !== JIT_SUPPLY || feeRecipient === zeroAddress || !baselineSeeded) throw new JitError(503, 'jit_launch_mismatch', 'Registered JIT launch wiring, supply or pool identity disagrees.')
    const initialSqrtPriceX96 = await client.readContract({ address: r.hook, abi: jitHookAbi, functionName: 'initialSqrtPriceX96', blockNumber: block })
    const [baselineLower, baselineUpper, jitLower, jitUpper] = await Promise.all((['baselineLower', 'baselineUpper', 'jitLower', 'jitUpper'] as const).map((functionName) => client.readContract({ address: r.hook, abi: jitHookAbi, functionName, blockNumber: block })))
    const [baselineLiquidity, jitLiquidity, maxJITAmount0, maxJITAmount1, minSwapAmount0, minSwapAmount1, validUntil] = await Promise.all((['baselineLiquidity', 'jitLiquidity', 'maxJITAmount0', 'maxJITAmount1', 'minSwapAmount0', 'minSwapAmount1', 'validUntil'] as const).map((functionName) => client.readContract({ address: r.hook, abi: jitHookAbi, functionName, blockNumber: block })))
    if (initialSqrtPriceX96 === undefined || baselineLower === undefined || baselineUpper === undefined || jitLower === undefined || jitUpper === undefined || baselineLiquidity === undefined || jitLiquidity === undefined || maxJITAmount0 === undefined || maxJITAmount1 === undefined || minSwapAmount0 === undefined || minSwapAmount1 === undefined || validUntil !== JIT_VALID_UNTIL) throw new JitError(503, 'jit_policy_mismatch', 'Registered JIT policy is not version 1.')
    const policy: JitPolicy = { initialSqrtPriceX96: BigInt(initialSqrtPriceX96), baselineLower: Number(baselineLower), baselineUpper: Number(baselineUpper), jitLower: Number(jitLower), jitUpper: Number(jitUpper), baselineLiquidity: BigInt(baselineLiquidity), jitLiquidity: BigInt(jitLiquidity), maxJITAmount0: BigInt(maxJITAmount0), maxJITAmount1: BigInt(maxJITAmount1), minSwapAmount0: BigInt(minSwapAmount0), minSwapAmount1: BigInt(minSwapAmount1), validUntil }
    const inventory = await Promise.all([currency0, currency1].map(async (currency): Promise<JitInventory> => {
      const decimals_ = sameJitAddress(currency, JIT_USDC) ? 6 : 18
      const [cash, claims, available, principalDeposited, feeCredits, feesClaimed] = await Promise.all((['cashBalance', 'claimBalance', 'availableInventory', 'principalDeposited', 'feeCredits', 'feesClaimed'] as const).map((functionName) => client.readContract({ address: r.vault, abi: jitVaultAbi, functionName, args: [currency], blockNumber: block })))
      if (cash === undefined || claims === undefined || available === undefined || principalDeposited === undefined || feeCredits === undefined || feesClaimed === undefined) throw new JitError(503, 'jit_inventory', 'Incomplete inventory reads.')
      return { currency, decimals: decimals_, cash: money(cash, decimals_), claims: money(claims, decimals_), available: money(available, decimals_), principalDeposited: money(principalDeposited, decimals_), feeCredits: money(feeCredits, decimals_), feesClaimed: money(feesClaimed, decimals_) }
    }))
    // Registry omits metadata text; the durable event supplies it without trusting remote URI contents.
    const logs = await client.getLogs({ address: manifest.factory, event: getAbiItem({ abi: jitFactoryAbi, name: 'LaunchCreated' }), args: { launchId: id }, fromBlock: block > 1900n ? block - 1900n : 0n, toBlock: block })
    const metadataURI = logs.find((log) => log.args.launchId === id)?.args.metadataURI ?? null
    return { launchId: id, creator: r.creator, token: r.token, vault: r.vault, hook: r.hook, executor: r.executor, poolId: r.poolId, configHash: r.configHash, createdAt: r.createdAt.toString(), tokenName: name, symbol, metadataURI, seedUsdc: money(r.seedUSDC, 6), tokenSupply: money(supply, 18), feeRecipient, currency0, currency1, policy: jitPolicyWire(policy), currentSqrtPriceX96: currentPrice.toString(), baselineSeeded, jitInRange: jitPriceInsideRange(currentPrice, policy.jitLower, policy.jitUpper), inventory, blockNumber: block.toString() }
  }
  async function list(startInput = '0', count = 20): Promise<JitLaunchPage> {
    const start = jitUint(startInput, 256, 'start', true)
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new JitError(400, 'invalid_page', 'count must be 1 to 50.')
    const block = (await verified()).number, total = await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'launchesLength', blockNumber: block })
    const take = Number(total > start ? total - start < BigInt(count) ? total - start : BigInt(count) : 0n)
    const launches: JitLaunchSummary[] = []
    // Ten concurrent entries, at most two registry reads each; detail enrichment is a separate request.
    for (let offset = 0; offset < take; offset += 10) {
      const chunk = await Promise.all(Array.from({ length: Math.min(10, take - offset) }, async (_, inner): Promise<JitLaunchSummary> => {
        const id = await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'launchIdAt', args: [start + BigInt(offset + inner)], blockNumber: block }), r = await record(id, block)
        return { launchId: id, creator: r.creator, token: r.token, vault: r.vault, hook: r.hook, executor: r.executor, poolId: r.poolId, configHash: r.configHash, createdAt: r.createdAt.toString(), seedUsdc: money(r.seedUSDC, 6), blockNumber: block.toString() }
      }))
      launches.push(...chunk)
    }
    return { start: start.toString(), count: launches.length, total: total.toString(), nextStart: start + BigInt(take) < total ? (start + BigInt(take)).toString() : null, blockNumber: block.toString(), launches }
  }
  function prepared(kind: JitPrepared['kind'], payer: Address, to: Address, data: Hex, expected: JitPrepared['expected'], usdc = 0n, tokens = 0n): JitPrepared {
    return { kind, payer, transaction: { to, data, value: '0', chainId: 5042 }, usdcCommitted: money(usdc, 6), tokenCommitted: money(tokens, 18), expected, simulation: { executable: false, reason: 'Exact transaction simulation is required before signing.', gasEstimate: null } }
  }
  async function simulate(prep: JitPrepared, blockNumber?: bigint): Promise<JitPrepared> {
    try {
      await client.call({ account: prep.payer, to: prep.transaction.to, data: prep.transaction.data, blockNumber })
      const gas = await client.estimateGas({ account: prep.payer, to: prep.transaction.to, data: prep.transaction.data, blockNumber })
      return { ...prep, simulation: { executable: true, reason: 'Exact transaction simulated from its payer; state can change before inclusion.', gasEstimate: gas.toString() } }
    } catch { return { ...prep, simulation: { executable: false, reason: 'Exact payer simulation failed. Check funds, finite allowance, policy, deadline and minimum output.', gasEstimate: null } } }
  }
  async function prepareLaunch(creatorInput: Address, value: unknown, mineAttempts = 0) {
    const creator = jitAddress(creatorInput, 'creator'), { config, input } = parseJitLaunch(value), block = await verified()
    if (config.deadline <= block.timestamp) throw new JitError(400, 'expired_deadline', 'Launch deadline must be in the future.')
    if (await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'usedNonce', args: [creator, config.creatorNonce], blockNumber: block.number })) throw new JitError(409, 'jit_nonce_used', 'This creator nonce already created a launch. Inspect its original launch ID.')
    if (!Number.isInteger(mineAttempts) || mineAttempts < 0 || mineAttempts > 200_000) throw new JitError(400, 'invalid_mining_budget', 'mineAttempts must be 0 to 200000.')
    let prediction = await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'predictLaunch', args: [creator, config], blockNumber: block.number })
    if (prediction.launchId !== jitLaunchId(creator, config.creatorNonce)) throw new JitError(503, 'jit_prediction_mismatch', 'Factory launch identity disagrees.')
    if (!jitHookPermissionValid(prediction.hook) && mineAttempts > 0) {
      const mined = mineJitHookSalt(manifest.hookDeployer, prediction, config.hookSaltNonce + 1n, mineAttempts)
      config.hookSaltNonce = mined.nonce
      prediction = await client.readContract({ address: manifest.factory, abi: jitFactoryAbi, functionName: 'predictLaunch', args: [creator, config], blockNumber: block.number })
      if (!sameJitAddress(prediction.hook, mined.hook)) throw new JitError(503, 'jit_prediction_mismatch', 'Factory hook prediction disagrees with the mined constructor hash.')
    }
    // Mining is bounded and does not alter any other approved configuration field.
    if (!jitHookPermissionValid(prediction.hook)) throw new JitError(409, 'jit_hook_salt', 'Hook salt does not satisfy permission bits 0x2ae0. Mine a new salt against the exact deployment and configuration.')
    if ([prediction.token, prediction.vault, prediction.hook, prediction.executor, JIT_MANAGER, JIT_USDC, manifest.hookDeployer, manifest.factory].some((a) => sameJitAddress(a, config.feeRecipient))) throw new JitError(400, 'invalid_recipient', 'Fee recipient cannot be a pool, factory or manager address.')
    const capital = jitInitialCapital(config, prediction.token)
    const normalized: JitLaunchInput = { ...input, hookSaltNonce: config.hookSaltNonce.toString() }
    const result = prepared('launch', creator, manifest.factory, encodeFunctionData({ abi: jitFactoryAbi, functionName: 'launch', args: [config] }), { launchId: prediction.launchId, configHash: prediction.configHash, creatorNonce: config.creatorNonce, recipient: config.feeRecipient }, config.seedUSDC)
    const allowance = await client.readContract({ address: JIT_USDC, abi: jitErc20Abi, functionName: 'allowance', args: [creator, manifest.factory], blockNumber: block.number })
    return { ...await simulate(result), config: normalized, prediction, funding: { currency: JIT_USDC, spender: manifest.factory, required: money(config.seedUSDC, 6), allowance: money(allowance, 6), approvalRequired: allowance < config.seedUSDC, capital }, blockNumber: block.number.toString() }
  }
  async function prepareApproval(payerInput: Address, target: { kind: 'launch' | 'deposit' | 'swap'; launchId?: Hex }, currencyInput: Address, amountInput: string) {
    await verified()
    const payer = jitAddress(payerInput, 'payer'), currency = jitAddress(currencyInput, 'currency')
    let spender: Address
    if (target.kind === 'launch') { if (!sameJitAddress(currency, JIT_USDC)) throw new JitError(400, 'invalid_currency', 'Creation funding only accepts USDC.'); spender = manifest.factory }
    else {
      if (!target.launchId) throw new JitError(400, 'invalid_request', 'launchId is required.')
      const launch = await detail(target.launchId)
      if (![launch.token, JIT_USDC].some((a) => sameJitAddress(currency, a))) throw new JitError(400, 'invalid_currency', 'Only the registered token and USDC are accepted.')
      spender = target.kind === 'deposit' ? launch.vault : launch.executor
    }
    const isUsdc = sameJitAddress(currency, JIT_USDC), amount = parseAmount(amountInput, isUsdc ? 6 : 18, 'amount', { allowZero: true })
    if (amount > (isUsdc ? (1n << 128n) - 1n : JIT_SUPPLY)) throw new JitError(400, 'unbounded_approval', 'Approval exceeds the finite product limit.')
    return simulate(prepared('approve', payer, currency, encodeFunctionData({ abi: jitErc20Abi, functionName: 'approve', args: [spender, amount] }), { launchId: target.launchId, currency, spender, amount: amount.toString() }, isUsdc ? amount : 0n, isUsdc ? 0n : amount))
  }
  async function prepareDeposit(payerInput: Address, id: Hex, currencyInput: Address, amountInput: string) {
    const launch = await detail(id), payer = jitAddress(payerInput, 'payer'), currency = jitAddress(currencyInput, 'currency')
    if (![launch.token, JIT_USDC].some((a) => sameJitAddress(currency, a))) throw new JitError(400, 'invalid_currency', 'Only registered vault currencies are accepted.')
    const isUsdc = sameJitAddress(currency, JIT_USDC), amount = parseAmount(amountInput, isUsdc ? 6 : 18, 'amount')
    if (!isUsdc && amount > JIT_SUPPLY) throw new JitError(400, 'invalid_amount', 'Token amount exceeds total supply.')
    return simulate(prepared('deposit', payer, launch.vault, encodeFunctionData({ abi: jitVaultAbi, functionName: 'deposit', args: [currency, amount] }), { launchId: id, currency, amount: amount.toString() }, isUsdc ? amount : 0n, isUsdc ? 0n : amount))
  }
  async function quoteSwap(value: JitSwapInput) {
    const launch = await detail(value.launchId), payer = jitAddress(value.payer, 'payer'), recipient = jitAddress(value.recipient, 'recipient'), currency = jitAddress(value.inputCurrency, 'inputCurrency')
    if (![launch.token, JIT_USDC].some((a) => sameJitAddress(currency, a)) || [JIT_MANAGER, launch.executor, launch.vault, launch.hook].some((a) => sameJitAddress(recipient, a))) throw new JitError(400, 'invalid_swap', 'Invalid input currency or recipient.')
    const amount = parseAmount(value.amount, sameJitAddress(currency, JIT_USDC) ? 6 : 18, 'amount'), minOutput = parseAmount(value.minimumOutput, sameJitAddress(currency, JIT_USDC) ? 18 : 6, 'minimumOutput')
    if (amount >= 1n << 128n) throw new JitError(400, 'invalid_amount', 'Exact input must fit uint128.')
    const limit = jitUint(value.sqrtPriceLimitX96, 160, 'sqrtPriceLimitX96'), deadline = jitUint(value.deadline, 256, 'deadline'), block = await client.getBlock({ blockTag: 'latest' })
    if (deadline <= block.timestamp) throw new JitError(400, 'expired_deadline', 'Swap deadline must be in the future.')
    const zeroForOne = sameJitAddress(currency, launch.currency0), pool = { currency0: launch.currency0, currency1: launch.currency1, fee: 3000, tickSpacing: 60, hooks: launch.hook }
    const quoted = await client.simulateContract({ address: manifest.quoter, abi: jitQuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: pool, zeroForOne, exactAmount: amount, hookData: '0x' }], blockNumber: block.number })
    const [amountOut, quoterGasEstimate] = quoted.result
    const request = { zeroForOne, amountSpecified: -amount, sqrtPriceLimitX96: limit, maximumInput: amount, minimumOutput: minOutput, recipient, deadline, allowPartialFill: false }
    const result = prepared('swap', payer, launch.executor, encodeFunctionData({ abi: jitExecutorAbi, functionName: 'swap', args: [request] }), { launchId: value.launchId, currency, amount: amount.toString(), minimumOutput: minOutput.toString(), recipient, zeroForOne }, sameJitAddress(currency, JIT_USDC) ? amount : 0n, sameJitAddress(currency, JIT_USDC) ? 0n : amount)
    let exact: { amountIn: Money; amountOut: Money } | null = null
    const prep = await simulate(result, block.number)
    if (prep.simulation.executable) {
      const simulated = await client.simulateContract({ account: payer, address: launch.executor, abi: jitExecutorAbi, functionName: 'swap', args: [request], blockNumber: block.number })
      if (simulated.result[0] !== amount || simulated.result[1] < minOutput) throw new JitError(503, 'jit_fill_mismatch', 'Executor simulation did not satisfy full input and minimum output.')
      exact = { amountIn: money(simulated.result[0], sameJitAddress(currency, JIT_USDC) ? 6 : 18), amountOut: money(simulated.result[1], sameJitAddress(currency, JIT_USDC) ? 18 : 6) }
    }
    return { ...prep, quote: { amountOut: money(amountOut, sameJitAddress(currency, JIT_USDC) ? 18 : 6), quoterGasEstimate: quoterGasEstimate.toString(), exactExecutor: exact, blockNumber: block.number.toString(), request: value, partialFill: false } }
  }
  async function prepareClaim(payerInput: Address, id: Hex, currencyInput: Address, amountInput: string) {
    const launch = await detail(id), currency = jitAddress(currencyInput, 'currency'), payer = jitAddress(payerInput, 'payer')
    const inventory = launch.inventory.find((i) => sameJitAddress(i.currency, currency))
    if (!inventory) throw new JitError(400, 'invalid_currency', 'Only registered fee assets can be claimed.')
    const amount = parseAmount(amountInput, inventory.decimals, 'amount')
    if (amount > BigInt(inventory.feeCredits.raw)) throw new JitError(400, 'insufficient_fee_credit', 'Claim exceeds the collected fee credit. Collection and claims are separate transactions.')
    return simulate(prepared('claim', payer, launch.vault, encodeFunctionData({ abi: jitVaultAbi, functionName: 'claimFees', args: [currency, amount] }), { launchId: id, currency, amount: amount.toString(), recipient: launch.feeRecipient }))
  }
  async function prepareCollect(payer: Address, id: Hex) {
    const launch = await detail(id)
    return simulate(prepared('collect', jitAddress(payer, 'payer'), launch.hook, encodeFunctionData({ abi: jitHookAbi, functionName: 'collectBaselineFees' }), { launchId: id }))
  }
  async function transaction(hashInput: Hex) {
    const hash = jitHash(hashInput, 'transaction')
    if (await client.getChainId() !== JIT_CHAIN_ID) throw new JitError(503, 'jit_wrong_chain', 'JIT RPC serves another chain.')
    try { const receipt = await client.getTransactionReceipt({ hash }); return { transaction: hash, status: receipt.status === 'success' ? 'confirmed' : 'reverted', blockNumber: receipt.blockNumber.toString(), explorer: `${manifest.explorerBase}/tx/${hash}` } }
    catch (error) {
      if (!notFound(error)) throw new JitError(502, 'jit_rpc', 'Transaction status RPC failed; outcome remains unknown.')
      try { await client.getTransaction({ hash }); return { transaction: hash, status: 'pending', blockNumber: null, explorer: `${manifest.explorerBase}/tx/${hash}` } }
      catch (txError) { if (!notFound(txError)) throw new JitError(502, 'jit_rpc', 'Transaction lookup failed; outcome remains unknown.'); return { transaction: hash, status: 'not_found', blockNumber: null, explorer: `${manifest.explorerBase}/tx/${hash}` } }
    }
  }
  return { client, manifest, verified, index, record, detail, list, prepareLaunch, prepareApproval, prepareDeposit, quoteSwap, prepareClaim, prepareCollect, transaction }
}
export type JitReader = ReturnType<typeof createJitReader>
function notFound(error: unknown): boolean { return error instanceof Error && /Transaction(Receipt)?NotFound|could not be found|not found/i.test(`${error.name} ${error.message}`) }

/*!
Copyright 2023 Universal Navigation Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
// TickMath adapted from Uniswap v4-core e50237c (MIT), Copyright 2023 Universal Navigation Inc.
// Preserve jit/lib/v4-core/licenses/MIT_LICENSE in every source distribution.
// Integer range checks avoid floating-point price guesses.
export const jitPriceInsideRange = (price: bigint, lower: number, upper: number) => price > jitSqrtAtTick(lower) && price < jitSqrtAtTick(upper)
export function jitSqrtAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new JitError(400, 'invalid_tick', 'Tick exceeds the pinned TickMath range.')
  const constants = [0xfffcb933bd6fad37aa2d162d1a594001n,0xfff97272373d413259a46990580e213an,0xfff2e50f5f656932ef12357cf3c7fdccn,0xffe5caca7e10e4e61c3624eaa0941cd0n,0xffcb9843d60f6159c9db58835c926644n,0xff973b41fa98c081472e6896dfb254c0n,0xff2ea16466c96a3843ec78b326b52861n,0xfe5dee046a99a2a811c461f1969c3053n,0xfcbe86c7900a88aedcffc83b479aa3a4n,0xf987a7253ac413176f2b074cf7815e54n,0xf3392b0822b70005940c7a398e4b70f3n,0xe7159475a2c29b7443b29c7fa6e889d9n,0xd097f3bdfd2022b8845ad8f792aa5825n,0xa9f746462d870fdf8a65dc1f90e061e5n,0x70d869a156d2a1b890bb3df62baf32f7n,0x31be135f97d08fd981231505542fcfa6n,0x9aa508b5b7a84e1c677de54f3e99bc9n,0x5d6af8dedb81196699c329225ee604n,0x2216e584f5fa1ea926041bedfe98n,0x48a170391f7dc42444e8fa2n]
  let ratio = 1n << 128n, absolute = Math.abs(tick)
  for (let i = 0; i < constants.length; i++) if ((absolute & (1 << i)) !== 0) ratio = (ratio * constants[i]) >> 128n
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n)
}

/** A confirmed receipt must agree with the exact original operation, not just contain a familiar event. */
export function verifyJitReceipt(prepared: JitPrepared, receipt: Pick<TransactionReceipt, 'status' | 'logs'>): Record<string, unknown> {
  if (receipt.status !== 'success') throw new JitError(409, 'jit_reverted', 'The direct transaction reverted; gas was still paid.')
  if (prepared.kind === 'collect') return { kind: 'collect', launchId: prepared.expected.launchId, note: 'Exact baseline collection transaction confirmed; read current fee credits separately.' }
  for (const log of receipt.logs) {
    if (!sameJitAddress(log.address, prepared.transaction.to)) continue
    try {
      const e = prepared.expected
      if (prepared.kind === 'launch') {
        const event = decodeEventLog({ abi: jitFactoryAbi, eventName: 'LaunchCreated', data: log.data, topics: log.topics }), a = event.args
        if (a.launchId === e.launchId && a.configHash === e.configHash && sameJitAddress(a.creator, prepared.payer) && a.seedUSDC === BigInt(prepared.usdcCommitted.raw)) return { kind: 'launch', launchId:a.launchId, creator:a.creator, token:a.token,vault:a.vault,hook:a.hook,executor:a.executor,poolId:a.poolId,configHash:a.configHash,seedUsdc:money(a.seedUSDC,6),metadataURI:a.metadataURI }
      } else if (prepared.kind === 'approve') {
        const event = decodeEventLog({ abi: jitErc20Abi, eventName: 'Approval', data: log.data, topics: log.topics }), a=event.args
        if (e.spender && sameJitAddress(a.owner, prepared.payer) && sameJitAddress(a.spender, e.spender) && a.value === BigInt(e.amount ?? '-1')) return {kind:'approve',owner:a.owner,spender:a.spender,currency:e.currency,amountRaw:a.value.toString()}
      } else if (prepared.kind === 'deposit') {
        const event = decodeEventLog({ abi: jitVaultAbi, eventName: 'InventoryDeposited', data: log.data, topics: log.topics }),a=event.args
        if (e.currency && sameJitAddress(a.depositor, prepared.payer) && sameJitAddress(a.currency, e.currency) && a.amount === BigInt(e.amount ?? '-1')) return {kind:'deposit',launchId:e.launchId,depositor:a.depositor,currency:a.currency,amountRaw:a.amount.toString(),principalWithdrawable:false}
      } else if (prepared.kind === 'claim') {
        const event = decodeEventLog({ abi: jitVaultAbi, eventName: 'FeesClaimed', data: log.data, topics: log.topics }),a=event.args
        if (e.currency && e.recipient && sameJitAddress(a.currency, e.currency) && sameJitAddress(a.recipient, e.recipient) && a.amount === BigInt(e.amount ?? '-1')) return {kind:'claim',launchId:e.launchId,currency:a.currency,recipient:a.recipient,amountRaw:a.amount.toString()}
      } else if (prepared.kind === 'swap') {
        const event = decodeEventLog({ abi: jitExecutorAbi, eventName: 'SwapExecuted', data: log.data, topics: log.topics }),a=event.args
        if (e.recipient && sameJitAddress(a.payer, prepared.payer) && sameJitAddress(a.recipient, e.recipient) && a.zeroForOne === e.zeroForOne && a.amountIn === BigInt(e.amount ?? '-1') && a.amountOut >= BigInt(e.minimumOutput ?? '0')) return {kind:'swap',launchId:e.launchId,payer:a.payer,recipient:a.recipient,zeroForOne:a.zeroForOne,amountInRaw:a.amountIn.toString(),amountOutRaw:a.amountOut.toString(),partialFill:false}
      }
    } catch { /* Unrelated or malformed logs cannot prove this operation. */ }
  }
  throw new JitError(409, 'jit_receipt_mismatch', 'Confirmed transaction did not prove the exact requested JIT operation.')
}

export type JitFetchOptions = { origin?: string; signal?: AbortSignal }
function wireMoney(value: unknown, decimals: number): Money {
  const v = jitObject(value, 'amount'), result = money(jitUint(v.raw, 256, 'amount.raw', true), decimals)
  if (v.formatted !== result.formatted) throw new JitError(502, 'jit_response_mismatch', 'Formatted and atomic amounts disagree.')
  return result
}
export function parseJitIndex(value: unknown): JitIndex {
  const v = jitObject(value), c = jitObject(v.contracts, 'contracts'), r = jitObject(v.readiness, 'readiness'), terms = jitObject(v.terms, 'terms')
  const factory = typeof c.factory === 'string' && isAddress(c.factory) ? getAddress(c.factory) : jitAddress(undefined, 'factory'), hookDeployer = typeof c.hookDeployer === 'string' && isAddress(c.hookDeployer) ? getAddress(c.hookDeployer) : jitAddress(undefined, 'hookDeployer')
  if (v.version !== 1 || v.chainId !== 5042 || v.network !== 'eip155:5042' || v.testnet !== false || v.explorerBase !== 'https://explorer.arc.io' || v.poolFee !== 3000 || v.tickSpacing !== 60 || !sameJitAddress(jitAddress(c.usdc, 'USDC'), JIT_USDC) || !sameJitAddress(jitAddress(c.poolManager, 'PoolManager'), JIT_MANAGER) || !sameJitAddress(jitAddress(c.quoter, 'Quoter'), JIT_QUOTER) || typeof r.ready !== 'boolean' || typeof r.deploymentVerified !== 'boolean' || r.ready !== r.deploymentVerified || typeof r.reason !== 'string' || (r.ready && (factory === zeroAddress || hookDeployer === zeroAddress)) || terms.creatorAllocation !== false || terms.principalWithdrawable !== false || terms.gasSponsored !== false || terms.feeAssets !== 'both' || terms.fixedRanges !== true) throw new JitError(502, 'jit_response_mismatch', 'JIT response network, deployment readiness or custody terms disagree.')
  const tokenSupply = wireMoney(v.tokenSupply, 18)
  if (BigInt(tokenSupply.raw) !== JIT_SUPPLY) throw new JitError(502, 'jit_response_mismatch', 'JIT supply differs from the fixed product supply.')
  return { version: 1, chainId: 5042, network: 'eip155:5042', testnet: false, explorerBase: 'https://explorer.arc.io', contracts: { factory, hookDeployer, usdc: JIT_USDC, poolManager: JIT_MANAGER, quoter: JIT_QUOTER }, readiness: { ready: r.ready, deploymentVerified: r.deploymentVerified, reason: r.reason }, poolFee: 3000, tickSpacing: 60, tokenSupply, terms: { creatorAllocation: false, principalWithdrawable: false, gasSponsored: false, feeAssets: 'both', fixedRanges: true } }
}
function wireSummary(value: unknown): JitLaunchSummary {
  const v = jitObject(value, 'launch')
  return { launchId: jitHash(v.launchId, 'launchId'), creator: jitAddress(v.creator, 'creator'), token: jitAddress(v.token, 'token'), vault: jitAddress(v.vault, 'vault'), hook: jitAddress(v.hook, 'hook'), executor: jitAddress(v.executor, 'executor'), poolId: jitHash(v.poolId, 'poolId'), configHash: jitHash(v.configHash, 'configHash'), createdAt: jitUint(v.createdAt, 64, 'createdAt').toString(), seedUsdc: wireMoney(v.seedUsdc, 6), blockNumber: jitUint(v.blockNumber, 256, 'blockNumber', true).toString() }
}
export function parseJitLaunchPage(value: unknown): JitLaunchPage {
  const v = jitObject(value, 'page'), start = jitUint(v.start, 256, 'start', true), total = jitUint(v.total, 256, 'total', true), blockNumber = jitUint(v.blockNumber, 256, 'blockNumber', true).toString()
  if (!Array.isArray(v.launches) || typeof v.count !== 'number' || !Number.isInteger(v.count) || v.count < 0 || v.count > 50 || v.count !== v.launches.length) throw new JitError(502, 'jit_response_mismatch', 'JIT page exceeds its bounded registry count.')
  const launches = v.launches.map(wireSummary), expectedNext = start + BigInt(launches.length) < total ? (start + BigInt(launches.length)).toString() : null
  if (v.nextStart !== expectedNext || (launches.length > 0 && start + BigInt(launches.length) > total) || launches.some((l) => l.blockNumber !== blockNumber) || new Set(launches.map((l) => l.launchId)).size !== launches.length) throw new JitError(502, 'jit_response_mismatch', 'JIT registry page snapshot or cursor disagrees.')
  return { start: start.toString(), count: launches.length, total: total.toString(), nextStart: expectedNext, blockNumber, launches }
}
export function parseJitLaunchView(value: unknown): JitLaunchView {
  const v = jitObject(value, 'launch'), base = wireSummary(v), p = jitObject(v.policy, 'policy')
  const policy: JitPolicyWire = { initialSqrtPriceX96: jitUint(p.initialSqrtPriceX96, 160, 'initialSqrtPriceX96').toString(), baselineLower: tick(p.baselineLower, 'baselineLower'), baselineUpper: tick(p.baselineUpper, 'baselineUpper'), jitLower: tick(p.jitLower, 'jitLower'), jitUpper: tick(p.jitUpper, 'jitUpper'), baselineLiquidity: jitUint(p.baselineLiquidity, 128, 'baselineLiquidity').toString(), jitLiquidity: jitUint(p.jitLiquidity, 128, 'jitLiquidity').toString(), maxJITAmount0: jitUint(p.maxJITAmount0, 128, 'maxJITAmount0').toString(), maxJITAmount1: jitUint(p.maxJITAmount1, 128, 'maxJITAmount1').toString(), minSwapAmount0: jitUint(p.minSwapAmount0, 128, 'minSwapAmount0', true).toString(), minSwapAmount1: jitUint(p.minSwapAmount1, 128, 'minSwapAmount1', true).toString(), validUntil: jitUint(p.validUntil, 64, 'validUntil').toString() }
  const currency0 = jitAddress(v.currency0, 'currency0'), currency1 = jitAddress(v.currency1, 'currency1'), currentSqrtPriceX96 = jitUint(v.currentSqrtPriceX96, 160, 'currentSqrtPriceX96', true).toString()
  if (!Array.isArray(v.inventory) || v.inventory.length !== 2 || typeof v.baselineSeeded !== 'boolean' || typeof v.jitInRange !== 'boolean' || BigInt(currency0) >= BigInt(currency1) || ![currency0,currency1].some((c) => sameJitAddress(c, base.token)) || ![currency0,currency1].some((c) => sameJitAddress(c,JIT_USDC)) || !jitHookPermissionValid(base.hook) || jitPoolId({currency0,currency1,fee:3000,tickSpacing:60,hooks:base.hook}) !== base.poolId || policy.validUntil !== JIT_VALID_UNTIL.toString() || v.jitInRange !== jitPriceInsideRange(BigInt(currentSqrtPriceX96),policy.jitLower,policy.jitUpper) || !(policy.baselineLower < policy.jitLower && policy.jitLower < policy.jitUpper && policy.jitUpper < policy.baselineUpper)) throw new JitError(502, 'jit_response_mismatch', 'JIT detail pool identity or policy disagrees.')
  const inventory = v.inventory.map((item: unknown): JitInventory => {
    const i = jitObject(item, 'inventory'), currency = jitAddress(i.currency, 'currency'), decimals = sameJitAddress(currency,JIT_USDC) ? 6 : 18
    if (![currency0,currency1].some((c) => sameJitAddress(c,currency)) || i.decimals !== decimals) throw new JitError(502, 'jit_response_mismatch', 'Inventory currency or decimal units disagree.')
    return { currency, decimals, cash: wireMoney(i.cash,decimals), claims: wireMoney(i.claims,decimals), available: wireMoney(i.available,decimals), principalDeposited: wireMoney(i.principalDeposited,decimals), feeCredits: wireMoney(i.feeCredits,decimals), feesClaimed: wireMoney(i.feesClaimed,decimals) }
  })
  const tokenSupply = wireMoney(v.tokenSupply,18)
  if (new Set(inventory.map((i) => i.currency.toLowerCase())).size !== 2 || BigInt(tokenSupply.raw) !== JIT_SUPPLY) throw new JitError(502, 'jit_response_mismatch', 'Inventory assets or token supply disagree.')
  return { ...base, tokenName: textField(v.tokenName,32,'tokenName'), symbol: textField(v.symbol,10,'symbol'), metadataURI: v.metadataURI === null ? null : textField(v.metadataURI,256,'metadataURI',true), tokenSupply, feeRecipient: jitAddress(v.feeRecipient,'feeRecipient'), currency0,currency1,policy,currentSqrtPriceX96,baselineSeeded:v.baselineSeeded,jitInRange:v.jitInRange,inventory }
}
async function fetchJit<T>(path: string, options: JitFetchOptions, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(`${options.origin?.replace(/\/$/, '') ?? ''}${path}`, { signal: options.signal, headers: { Accept: 'application/json' } })
  const result: unknown = await response.json()
  if (!response.ok) { const r = jitObject(result); throw new JitError(response.status === 503 ? 503 : 502, typeof r.error === 'string' ? r.error : 'jit_rpc', typeof r.message === 'string' ? r.message : 'JIT request failed.') }
  return parse(result)
}
export const fetchJitIndex = (options: JitFetchOptions = {}) => fetchJit('/jit', options, parseJitIndex)
export const fetchJitLaunches = (start = '0', count = 20, options: JitFetchOptions = {}) => fetchJit(`/jit/launches?start=${encodeURIComponent(start)}&count=${count}`, options, parseJitLaunchPage)
export const fetchJitLaunch = (id: Hex, options: JitFetchOptions = {}) => fetchJit(`/jit/launches/${jitHash(id, 'launchId')}`, options, parseJitLaunchView)
