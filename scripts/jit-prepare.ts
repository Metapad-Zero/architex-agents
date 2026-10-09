import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, encodeDeployData, formatUnits, getAddress, getContractAddress, http, isAddress, keccak256, parseAbi, parseUnits, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { arc } from 'viem/chains'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const JIT_MANAGER: Address = '0x8366a39CC670B4001A1121B8F6A443A643e40951'
export const JIT_USDC: Address = '0x3600000000000000000000000000000000000000'
const MANAGER_HASH = '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626'
const MAX_RUNTIME_BYTES = 24_576
const MAX_INITCODE_BYTES = 49_152
const MANAGER_ABI = parseAbi(['function poolManager() view returns (address)'])
const USDC_ABI = parseAbi(['function decimals() view returns (uint8)'])
const NAMES = ['ArchitexJITToken', 'ArchitexJITHookDeployer', 'ArchitexJITFactory', 'ArchitexJITVault', 'ArchitexJITHook', 'ArchitexJITExecutor'] as const
type ContractName = typeof NAMES[number]

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}

function bytecode(value: unknown, label: string): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error(`${label} has empty, malformed or unlinked bytecode. Run forge build --root jit.`)
  return value as Hex
}

export function publicAccount(value: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error('A nonzero public deployer address is required.')
  return getAddress(value)
}

export function gasBudget(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) throw new Error('The gas ceiling must be a plain positive USDC decimal with at most 18 fractional digits.')
  const amount = parseUnits(value, 18)
  if (amount === 0n) throw new Error('The gas ceiling must be positive.')
  return amount
}

export function enforceGasBudget(gas: bigint, maxFeePerGas: bigint, ceiling: bigint, balance: bigint): bigint {
  if (gas <= 0n || maxFeePerGas <= 0n || ceiling <= 0n) throw new Error('Gas, maximum fee and gas ceiling must be positive.')
  const worstCase = gas * maxFeePerGas
  if (worstCase > ceiling) throw new Error('The prepared transaction exceeds the explicit native-USDC gas ceiling.')
  if (worstCase > balance) throw new Error('The public deployer lacks native USDC to cover the maximum prepared gas cost.')
  return worstCase
}

export function checkedArtifact(name: ContractName, root = REPO) {
  const file = resolve(root, 'jit/out', `${name}.sol`, `${name}.json`)
  const artifact = object(JSON.parse(readFileSync(file, 'utf8')) as unknown, `${name} artifact`)
  if (!Array.isArray(artifact.abi)) throw new Error(`${name} ABI is missing.`)
  const creation = bytecode(object(artifact.bytecode, 'creation code').object, name)
  const deployed = object(artifact.deployedBytecode, 'runtime code')
  const runtime = bytecode(deployed.object, name)
  const metadata = object(typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) as unknown : artifact.metadata, 'compiler metadata')
  const settings = object(metadata.settings, 'compiler settings')
  const optimizer = object(settings.optimizer, 'optimizer settings')
  const compiler = object(metadata.compiler, 'compiler')
  if (typeof compiler.version !== 'string' || !compiler.version.startsWith('0.8.26+') || settings.evmVersion !== 'cancun' || settings.viaIR !== true || optimizer.enabled !== true || optimizer.runs !== 200 || object(settings.metadata, 'metadata settings').bytecodeHash !== 'none') throw new Error(`${name} was not compiled with the reviewed JIT profile.`)
  const sources = object(metadata.sources, 'compiler sources')
  // Check the complete compiled dependency closure, including embedded creation code.
  for (const [source, details] of Object.entries(sources)) {
    const expected = object(details, 'source metadata').keccak256
    const path = resolve(root, 'jit', source)
    const actual = keccak256(new Uint8Array(readFileSync(path)))
    if (expected !== actual) throw new Error(`${name} artifact is stale for ${source}. Rebuild before preparing transactions.`)
  }
  const runtimeBytes = (runtime.length - 2) / 2
  const creationBytes = (creation.length - 2) / 2
  if (runtimeBytes > MAX_RUNTIME_BYTES || creationBytes > MAX_INITCODE_BYTES) throw new Error(`${name} exceeds the standard deployment size limit.`)
  return { name, abi: artifact.abi as Abi, creation, runtime, runtimeBytes, creationBytes, creationHash: keccak256(creation), unresolvedRuntimeHash: keccak256(runtime), immutableReferences: deployed.immutableReferences ?? {} }
}

export function inspectBuild() {
  return {
    chainId: arc.id,
    poolManager: JIT_MANAGER,
    quote: JIT_USDC,
    contracts: NAMES.map((name) => {
      const artifact = checkedArtifact(name)
      return { name, runtimeBytes: artifact.runtimeBytes, creationBytes: artifact.creationBytes, creationHash: artifact.creationHash, unresolvedRuntimeHash: artifact.unresolvedRuntimeHash, immutableReferences: artifact.immutableReferences }
    }),
    note: 'Compiled identities; runtime immutables must be resolved against actual deployment. No transactions are signed or sent.',
  }
}

export async function prepareDeployment(inputs: { deployer: string; gasCeilingUsdc: string; rpcUrl?: string; hookDeployer?: string }) {
  const deployer = publicAccount(inputs.deployer)
  const ceiling = gasBudget(inputs.gasCeilingUsdc)
  const rpcUrl = new URL(inputs.rpcUrl ?? 'https://rpc.mainnet.arc.io')
  if (rpcUrl.protocol !== 'https:' && !(rpcUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(rpcUrl.hostname))) throw new Error('Use an HTTPS mainnet RPC or HTTP loopback fork.')
  const client = createPublicClient({ chain: arc, transport: http(rpcUrl.href, { timeout: 15_000, retryCount: 0 }) })
  const [chainId, managerCode, decimals, latestNonce, pendingNonce, balance, fees, block] = await Promise.all([
    client.getChainId(), client.getCode({ address: JIT_MANAGER }), client.readContract({ address: JIT_USDC, abi: USDC_ABI, functionName: 'decimals' }),
    client.getTransactionCount({ address: deployer, blockTag: 'latest' }), client.getTransactionCount({ address: deployer, blockTag: 'pending' }),
    client.getBalance({ address: deployer }), client.estimateFeesPerGas(), client.getBlock(),
  ])
  if (chainId !== 5042 || decimals !== 6 || !managerCode || keccak256(managerCode) !== MANAGER_HASH) throw new Error('The RPC chain, USDC or PoolManager does not match the verified Arc mainnet deployment.')
  if (latestNonce !== pendingNonce) throw new Error('The deployer has an unresolved transaction; reconcile its nonce before preparing another deployment.')
  const helper = checkedArtifact('ArchitexJITHookDeployer')
  const factory = checkedArtifact('ArchitexJITFactory')
  const maxFeePerGas = fees.maxFeePerGas
  if (!maxFeePerGas || maxFeePerGas <= 0n) throw new Error('The RPC did not return a valid maximum fee per gas.')
  let hookDeployer: Address
  const steps: Record<string, unknown>[] = []
  if (inputs.hookDeployer) {
    hookDeployer = publicAccount(inputs.hookDeployer)
    const [code, manager] = await Promise.all([
      client.getCode({ address: hookDeployer }), client.readContract({ address: hookDeployer, abi: MANAGER_ABI, functionName: 'poolManager' }),
    ])
    if (!code || code !== helper.runtime || manager.toLowerCase() !== JIT_MANAGER.toLowerCase()) throw new Error('The supplied hook deployer is not the exact reviewed code bound to Arc PoolManager.')
  } else {
    hookDeployer = getContractAddress({ from: deployer, nonce: BigInt(latestNonce) })
    const data = encodeDeployData({ abi: helper.abi, bytecode: helper.creation, args: [JIT_MANAGER] })
    if ((data.length - 2) / 2 > MAX_INITCODE_BYTES) throw new Error('Hook-deployer constructor data exceeds the initcode limit.')
    const estimate = await client.estimateGas({ account: deployer, data })
    const gas = (estimate * 120n + 99n) / 100n
    if (gas > block.gasLimit) throw new Error('The hook-deployer gas limit exceeds the Arc block limit.')
    const maxCost = enforceGasBudget(gas, maxFeePerGas, ceiling, balance)
    steps.push({ contract: helper.name, chainId, from: deployer, nonce: latestNonce, predictedAddress: hookDeployer, data, gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), maxGasUsdc: formatUnits(maxCost, 18), simulation: 'passed eth_estimateGas, no broadcast' })
  }
  const factoryNonce = latestNonce + (inputs.hookDeployer ? 0 : 1)
  const data = encodeDeployData({ abi: factory.abi, bytecode: factory.creation, args: [JIT_MANAGER, JIT_USDC, hookDeployer] })
  if ((data.length - 2) / 2 > MAX_INITCODE_BYTES) throw new Error('Factory constructor data exceeds the initcode limit.')
  const predictedFactory = getContractAddress({ from: deployer, nonce: BigInt(factoryNonce) })
  if (inputs.hookDeployer) {
    const estimate = await client.estimateGas({ account: deployer, data })
    const gas = (estimate * 120n + 99n) / 100n
    if (gas > block.gasLimit) throw new Error('The factory gas limit exceeds the Arc block limit.')
    const maxCost = enforceGasBudget(gas, maxFeePerGas, ceiling, balance)
    steps.push({ contract: factory.name, chainId, from: deployer, nonce: factoryNonce, predictedAddress: predictedFactory, data, gas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), maxGasUsdc: formatUnits(maxCost, 18), simulation: 'passed eth_estimateGas, no broadcast' })
  } else {
    // Its constructor verifies the helper runtime. An undeployed prediction cannot satisfy that check.
    steps.push({ contract: factory.name, chainId, from: deployer, nonce: factoryNonce, predictedAddress: predictedFactory, data, gas: null, simulation: 'Requires the confirmed hook-deployer receipt, then rerun deployment with --hook-deployer and the remaining gas ceiling.' })
  }
  return { chainId, checkedAtBlock: block.number?.toString(), blockHash: block.hash, publicDeployer: deployer, gasCeilingUsdc: inputs.gasCeilingUsdc, nativeBalanceUsdc: formatUnits(balance, 18), signed: false, broadcast: false, steps, acceptance: 'Seed capital, fee recipient and acceptance-trade ceilings are separate explicit inputs. Prepare the launch with prepare_jit_launch after factory verification.' }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!key?.startsWith('--') || !value || flags.has(key)) throw new Error('Flags must be unique --name value pairs.')
    if (!['--deployer', '--gas-ceiling-usdc', '--rpc-url', '--hook-deployer', '--output'].includes(key)) throw new Error(`Unknown flag ${key}.`)
    flags.set(key, value)
  }
  let result: unknown
  if (command === 'inspect') result = inspectBuild()
  else if (command === 'deployment') {
    const deployer = flags.get('--deployer'), gasCeilingUsdc = flags.get('--gas-ceiling-usdc')
    if (!deployer || !gasCeilingUsdc) throw new Error('deployment requires --deployer PUBLIC_ADDRESS --gas-ceiling-usdc DECIMAL. This tool never loads a signing key.')
    result = await prepareDeployment({ deployer, gasCeilingUsdc, rpcUrl: flags.get('--rpc-url'), hookDeployer: flags.get('--hook-deployer') })
  } else throw new Error('Usage: bun run scripts/jit-prepare.ts inspect | deployment --deployer PUBLIC_ADDRESS --gas-ceiling-usdc DECIMAL [--hook-deployer ADDRESS] [--rpc-url HTTPS_URL] [--output PATH]')
  const json = JSON.stringify(result, null, 2) + '\n'
  const output = flags.get('--output')
  if (output) writeFileSync(resolve(output), json, { mode: 0o600, flag: 'wx' })
  else process.stdout.write(json)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'JIT preparation failed.'); process.exitCode = 1 })
}
