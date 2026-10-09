/** ABI for the separate direct-wallet JIT product. Keep the tuple order aligned with jit/src. */
export const jitPolicyComponents = [
  { name: 'initialSqrtPriceX96', type: 'uint160' },
  { name: 'baselineLower', type: 'int24' }, { name: 'baselineUpper', type: 'int24' },
  { name: 'jitLower', type: 'int24' }, { name: 'jitUpper', type: 'int24' },
  { name: 'baselineLiquidity', type: 'uint128' }, { name: 'jitLiquidity', type: 'uint128' },
  { name: 'maxJITAmount0', type: 'uint128' }, { name: 'maxJITAmount1', type: 'uint128' },
  { name: 'minSwapAmount0', type: 'uint128' }, { name: 'minSwapAmount1', type: 'uint128' },
  { name: 'validUntil', type: 'uint64' },
] as const
export const jitConfigComponents = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'metadataURI', type: 'string' },
  { name: 'seedUSDC', type: 'uint256' }, { name: 'feeRecipient', type: 'address' },
  { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
  { name: 'policy', type: 'tuple', components: jitPolicyComponents },
  { name: 'creatorNonce', type: 'bytes32' }, { name: 'hookSaltNonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
] as const
const recordComponents = [
  { name: 'creator', type: 'address' }, { name: 'token', type: 'address' }, { name: 'vault', type: 'address' },
  { name: 'hook', type: 'address' }, { name: 'executor', type: 'address' }, { name: 'poolId', type: 'bytes32' },
  { name: 'configHash', type: 'bytes32' }, { name: 'seedUSDC', type: 'uint256' }, { name: 'createdAt', type: 'uint64' },
] as const
const poolKey = [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] as const
export const jitSwapComponents = [
  { name: 'zeroForOne', type: 'bool' }, { name: 'amountSpecified', type: 'int256' },
  { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'maximumInput', type: 'uint256' },
  { name: 'minimumOutput', type: 'uint256' }, { name: 'recipient', type: 'address' },
  { name: 'deadline', type: 'uint256' }, { name: 'allowPartialFill', type: 'bool' },
] as const
export const jitFactoryAbi = [
  ...(['InvalidConfiguration', 'InvalidLaunch', 'DeadlineExpired', 'NonceAlreadyUsed', 'InvalidHookAddress', 'InsufficientInitialCapital', 'TransferMismatch', 'DeploymentMismatch', 'Reentrancy', 'UnknownLaunch'] as const).map((name) => ({ type: 'error', name, inputs: [] }) as const),
  { type: 'function', name: 'launch', stateMutability: 'nonpayable', inputs: [{ name: 'config', type: 'tuple', components: jitConfigComponents }], outputs: [{ name: 'record', type: 'tuple', components: recordComponents }] },
  { type: 'function', name: 'predictLaunch', stateMutability: 'view', inputs: [{ name: 'creator', type: 'address' }, { name: 'config', type: 'tuple', components: jitConfigComponents }], outputs: [{ name: 'prediction', type: 'tuple', components: [
    { name: 'launchId', type: 'bytes32' }, { name: 'configHash', type: 'bytes32' },
    { name: 'token', type: 'address' }, { name: 'vault', type: 'address' }, { name: 'hook', type: 'address' }, { name: 'executor', type: 'address' }, { name: 'hookInitCodeHash', type: 'bytes32' },
  ] }] },
  { type: 'function', name: 'configHash', stateMutability: 'pure', inputs: [{ name: 'config', type: 'tuple', components: jitConfigComponents }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'getLaunch', stateMutability: 'view', inputs: [{ name: 'launchId', type: 'bytes32' }], outputs: [{ type: 'tuple', components: recordComponents }] },
  { type: 'function', name: 'launchIdOfToken', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'usedNonce', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'launchesLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'launchIdAt', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  ...(['poolManager', 'quote', 'hookDeployer'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }) as const),
  ...(['POOL_FEE', 'TICK_SPACING', 'TOKEN_SUPPLY'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: name === 'POOL_FEE' ? 'uint24' : name === 'TICK_SPACING' ? 'int24' : 'uint256' }] }) as const),
  { type: 'function', name: 'hookSalt', stateMutability: 'pure', inputs: [{ type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  ...(['tokenSalt', 'vaultSalt', 'executorSalt'] as const).map((name) => ({ type: 'function', name, stateMutability: 'pure', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] }) as const),
  { type: 'event', name: 'LaunchCreated', inputs: [
    { name: 'launchId', type: 'bytes32', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'token', type: 'address', indexed: true },
    { name: 'vault', type: 'address', indexed: false }, { name: 'hook', type: 'address', indexed: false }, { name: 'executor', type: 'address', indexed: false },
    { name: 'poolId', type: 'bytes32', indexed: false }, { name: 'configHash', type: 'bytes32', indexed: false }, { name: 'seedUSDC', type: 'uint256', indexed: false }, { name: 'metadataURI', type: 'string', indexed: false },
  ] },
] as const
export const jitHookDeployerAbi = [{ type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const
export const jitHookAbi = [
  ...jitPolicyComponents.map(({ name, type }) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type }] }) as const),
  ...(['poolManager', 'vault'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }) as const),
  { type: 'function', name: 'poolId', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'baselineSeeded', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'currentSqrtPriceX96', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }] },
  { type: 'function', name: 'getPoolKey', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: poolKey }] },
  { type: 'function', name: 'collectBaselineFees', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const
export const jitVaultAbi = [
  ...(['poolManager', 'token', 'quote', 'currency0', 'currency1', 'feeRecipient', 'hook'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }) as const),
  ...(['principalDeposited', 'feeCredits', 'feesClaimed', 'cashBalance', 'claimBalance', 'availableInventory'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }) as const),
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimFees', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'event', name: 'InventoryDeposited', inputs: [{ name: 'depositor', type: 'address', indexed: true }, { name: 'currency', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'FeesClaimed', inputs: [{ name: 'currency', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
] as const
export const jitExecutorAbi = [
  ...(['poolManager', 'hook'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }) as const),
  { type: 'function', name: 'getPoolKey', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: poolKey }] },
  { type: 'function', name: 'swap', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: jitSwapComponents }], outputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOut', type: 'uint256' }] },
  { type: 'event', name: 'SwapExecuted', inputs: [{ name: 'payer', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'zeroForOne', type: 'bool', indexed: false }, { name: 'amountIn', type: 'uint256', indexed: false }, { name: 'amountOut', type: 'uint256', indexed: false }] },
] as const
export const jitErc20Abi = [
  ...(['name', 'symbol', 'version'] as const).map((name) => ({ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }) as const),
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Approval', inputs: [{ name: 'owner', type: 'address', indexed: true }, { name: 'spender', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
] as const
export const jitQuoterAbi = [
  { type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: [
    { name: 'poolKey', type: 'tuple', components: poolKey }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' },
  ] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] },
] as const
