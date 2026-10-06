import type { Address, Hash } from 'viem'
import { zeroAddress } from 'viem'
import { activeChain, arcNetwork } from '../chain'
import testnetDeployment from '../deployments/arc-testnet.json'
import mainnetDeployment from '../deployments/arc-mainnet.json'

export interface DeploymentToken {
  symbol: string
  name: string
  address: Address
  decimals: number
  faucet: boolean
}

export interface DeploymentPair {
  pair: Address
  token0: Address
  token1: Address
}

export interface ArchitexDeployment {
  chainId: number
  network: string
  explorerBase: string
  factory: Address
  router: Address
  lens: Address
  /** Zero until the launchpad is deployed on this network; the Launch view exists only when it is set. */
  launchpad: Address
  /** Zero until the agent BBS is deployed on this network; the BBS view reads real messages only when it is set. */
  bbs: Address
  deployer: Address
  tokens: DeploymentToken[]
  pairs: DeploymentPair[]
  txs: { factory: Hash; router: Hash; lens: Hash }
}

export const deployment = (arcNetwork === 'mainnet' ? mainnetDeployment : testnetDeployment) as ArchitexDeployment
if (deployment.chainId !== activeChain.id) {
  throw new Error('The deployment manifest does not match the selected Arc network.')
}
export const isDeployed = deployment.factory !== zeroAddress
export const isLaunchpadDeployed = isDeployed && deployment.launchpad !== zeroAddress
export const isBbsDeployed = isDeployed && deployment.bbs !== zeroAddress

// `import.meta.env.DEV` is a compile-time constant, so the fixture branch is dead in production.
export const isLaunchViewAvailable =
  isLaunchpadDeployed || (import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1')
