import { parseAbi } from 'viem'

/**
 * The launchpad and board as the gate uses them (docs/agents/X402-GATE-SPEC.md, section 2).
 * Only what the gate calls or decodes; the site's own read ABIs stay in src/lib/abi.ts.
 */
const authorization = 'struct Authorization { address from; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }'

// Reverts from the assets being paid surface through the launchpad's call, so they are listed
// here too: without them a refused payment would read as an anonymous failure.
const paymentErrors = [
  'error RecoveryRelayerRequired()',
  'error BoundNonceMismatch()',
  'error SettlementAttestationRequired()',
  'error SettlementNotConsumed()',
  'error InsufficientUnaccountedBalance(uint256 available, uint256 required)',
  'error PaymentAmountMismatch(uint256 received, uint256 required)',
  'error PaymentValueMismatch(uint256 expected, uint256 actual)',
  'error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce)',
  'error AuthorizationExpired(uint256 validBefore)',
  'error AuthorizationNotYetValid(uint256 validAfter)',
  'error InvalidSignature()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error CallerMustBePayee()',
] as const

export const launchpadGateAbi = parseAbi([
  authorization,
  'struct LaunchParams { string name; string symbol; string metadataURI; uint256 initialBuyUsdc; uint256 minTokensOut; }',
  'struct Curve { address token; address creator; address pair; uint128 virtualUsdc; uint128 virtualTokens; uint128 tokensSold; uint64 createdAt; bool graduated; string metadataURI; }',
  'function launchWithAuthorization(LaunchParams p, bytes32 salt, Authorization auth, bytes signature, bytes32 settlementTransaction) returns (address token, uint256 tokensOut)',
  'function buyWithAuthorization(address token, uint256 minTokensOut, bytes32 salt, Authorization auth, bytes signature, bytes32 settlementTransaction) returns (uint256 tokensOut, uint256 usdcSpent)',
  'function sellWithAuthorization(address token, uint256 minUsdcOut, bytes32 salt, Authorization auth, bytes signature) returns (uint256 usdcOut)',
  'function launchNonce(LaunchParams p, bytes32 salt) pure returns (bytes32)',
  'function buyNonce(address token, uint256 minTokensOut, bytes32 salt) pure returns (bytes32)',
  'function sellNonce(address token, uint256 minUsdcOut, bytes32 salt) pure returns (bytes32)',
  'function launchFee() view returns (uint256)',
  'function launchRelayFee() view returns (uint256)',
  'function tradeRelayFee() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
  'function isRelayer(address relayer) view returns (bool)',
  'function usdc() view returns (address)',
  'function factory() view returns (address)',
  'function refundExternalPayment(Authorization auth, bytes signature, bytes32 settlementTransaction) returns (uint256 amount)',
  'function paymentConsumed(address asset, address from, bytes32 nonce) view returns (bool)',
  'function curves(address token) view returns (Curve)',
  'function tokensLength() view returns (uint256)',
  'function curvesPage(uint256 start, uint256 count) view returns (Curve[])',
  'function quoteBuy(address token, uint256 usdcIn) view returns (uint256 tokensOut, uint256 fee, uint256 usdcSpent, bool graduates)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 usdcOut, uint256 fee)',
  'event TokenCreated(address indexed token, address indexed creator, address indexed pair, string name, string symbol, string metadataURI)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 fee, uint256 virtualUsdc, uint256 virtualTokens)',
  'event Relayed(address indexed relayer, address indexed from, bytes32 indexed nonce, uint8 action, bool bound, uint256 relayFee)',
  'event ExternalSettlementCredited(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value)',
  'event ExternalSettlementRefunded(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value)',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error Forbidden()',
  'error UnknownToken()',
  'error CurveGraduated()',
  'error SlippageExceeded()',
  'error ExceedsSold()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error InvalidMetadata()',
  ...paymentErrors,
])

export const boardGateAbi = parseAbi([
  authorization,
  'function postWithAuthorization(string text, bytes32 salt, Authorization auth, bytes signature, bytes32 settlementTransaction) returns (uint256 id)',
  'function postNonce(string text, bytes32 salt) pure returns (bytes32)',
  'function postFee() view returns (uint256)',
  'function tradeRelayFee() view returns (uint256)',
  'function isRelayer(address relayer) view returns (bool)',
  'function usdc() view returns (address)',
  'function launchpad() view returns (address)',
  'function refundExternalPayment(Authorization auth, bytes signature, bytes32 settlementTransaction) returns (uint256 amount)',
  'function paymentConsumed(address asset, address from, bytes32 nonce) view returns (bool)',
  'function messageCount() view returns (uint256)',
  'event Message(address indexed from, uint256 indexed id, uint256 time, string text)',
  'event Relayed(address indexed relayer, address indexed from, bytes32 indexed nonce, uint8 action, bool bound, uint256 relayFee)',
  'event ExternalSettlementCredited(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value)',
  'event ExternalSettlementRefunded(address indexed from, bytes32 indexed nonce, bytes32 indexed settlementTransaction, uint256 value)',
  'error Forbidden()',
  'error TextTooLong(uint256 length, uint256 max)',
  ...paymentErrors,
])

export const launchTokenGateAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'])

export const usdcAuthorizationAbi = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
