import type { Address, Hex } from 'viem'

/** Fees as the contracts report them, in atomic USDC. */
export interface Fees {
  launchFee: bigint
  launchRelayFee: bigint
  tradeRelayFee: bigint
  postFee: bigint
  postRelayFee: bigint
  tradeFeeBps: bigint
}

export interface Curve {
  token: Address
  creator: Address
  pair: Address
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint
  graduated: boolean
  metadataURI: string
}

export interface BoardMessage {
  id: bigint
  from: Address
  time: bigint
  text: string
  transaction: Hex
}

/** An EIP-3009 authorization; `to` is always the contract that runs the action. */
export interface Authorization {
  from: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: Hex
}

export interface Signed {
  auth: Authorization
  signature: Hex
  /** Zero unless the caller committed to the parameters (bound mode). */
  salt: Hex
  /** An independently verified prior direct USDC transfer, credited by a trusted relayer. */
  settlementTransaction?: Hex
}

export interface Readiness {
  chainVerified: boolean
  contractsVerified: boolean
  relay: {
    configured: boolean
    ready: boolean
    mode: 'single-process' | 'forwarded' | 'read-only'
    address: Address | null
    reason: string | null
  }
}

export interface TransactionStatus {
  transaction: Hex
  status: 'pending' | 'confirmed' | 'reverted' | 'not_found'
  blockNumber?: string
  action?: string
  payer?: Address
  result?: Record<string, unknown>
}

export interface LaunchParams {
  name: string
  symbol: string
  metadataURI: string
  initialBuyUsdc: bigint
  minTokensOut: bigint
}

export interface Relayed {
  transaction: Hex
  relayFee: bigint
}

/** Stable request intent, parsed before reading mutable fees or curve state. */
export type RecoveryRequest =
  | { action: 'launch'; name: string; symbol: string; metadataURI: string; initialBuyUsdc: bigint; minTokensOut?: bigint }
  | { action: 'buy'; token: Address; usdcIn: bigint; minTokensOut?: bigint }
  | { action: 'sell'; token: Address; tokensIn: bigint; minUsdcOut?: bigint }
  | { action: 'post'; text: string }
  | { action: 'refund'; payTo: Address }

export interface RecoveredAction {
  transaction: Hex
  bound: boolean
  result: Record<string, unknown>
}

/**
 * Everything the gate needs from the chain. The gate itself holds no chain code, so it can be
 * exercised in tests against a stand-in, and the one real implementation (viemPort) stays small.
 */
export interface ChainPort {
  readonly chainId: number
  readonly testnet: boolean
  readonly explorer: string
  readonly usdc: Address
  readonly launchpad: Address
  readonly bbs: Address
  /** False without a relayer key: the gate can quote and challenge, but cannot act. */
  readonly canRelay: boolean

  readiness(): Promise<Readiness>
  transaction(hash: Hex): Promise<TransactionStatus>
  /** Read-only recovery of the original executed result; never sends a second transaction. */
  recover(request: RecoveryRequest, signed: Signed): Promise<RecoveredAction | undefined>
  /** Used/cancelled state is a retry refusal signal, never proof that a payment was received. */
  authorizationUsed(asset: Address, auth: Authorization): Promise<boolean>
  /** Synchronous last check before returning fresh terms for a previously validated signature. */
  pendingTransaction(): Hex | undefined
  fees(options?: { fresh?: boolean }): Promise<Fees>
  curve(token: Address): Promise<Curve | undefined>
  curves(start: number, count: number): Promise<{ total: number; curves: Curve[] }>
  tokenName(token: Address): Promise<{ name: string; symbol: string }>
  quoteBuy(token: Address, usdcIn: bigint): Promise<{ tokensOut: bigint; fee: bigint; usdcSpent: bigint; graduates: boolean }>
  quoteSell(token: Address, tokensIn: bigint): Promise<{ usdcOut: bigint; fee: bigint }>
  messages(count: number): Promise<{
    total: number
    complete: boolean
    messages: BoardMessage[]
    /** A bounded cached read, independent of payment/fee freshness. */
    snapshot?: { blockNumber: bigint; fetchedAt: number; ageMs: number; ttlMs: number }
  }>

  /** The nonce that binds an authorization to these exact parameters, as the contract computes it. */
  launchNonce(params: LaunchParams, salt: Hex): Promise<Hex>
  buyNonce(token: Address, minTokensOut: bigint, salt: Hex): Promise<Hex>
  sellNonce(token: Address, minUsdcOut: bigint, salt: Hex): Promise<Hex>
  postNonce(text: string, salt: Hex): Promise<Hex>

  /** Each of these simulates first and throws GateError without sending anything that would revert. */
  launch(params: LaunchParams, signed: Signed): Promise<Relayed & { token: Address; tokensOut: bigint }>
  buy(token: Address, minTokensOut: bigint, signed: Signed): Promise<Relayed & { tokensOut: bigint; usdcSpent: bigint }>
  sell(token: Address, minUsdcOut: bigint, signed: Signed): Promise<Relayed & { usdcOut: bigint }>
  post(text: string, signed: Signed): Promise<Relayed & { id: bigint }>
  refundExternal(recipient: Address, signed: Signed): Promise<Relayed & { amount: bigint }>
}
