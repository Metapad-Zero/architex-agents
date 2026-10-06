# Architex Agents: x402 gate specification

Binding protocol for the agents contracts, gateway, MCP server and site. Version 2.1, 2026-10-06. Target: Arc MAINNET. Release status is determined by deployment and acceptance evidence, not this document.

## Chain and deployment

| Fact | Value |
| --- | --- |
| Arc mainnet | Chain 5042, RPC https://rpc.mainnet.arc.io, explorer https://explorer.arc.io |
| x402 | Version 2, scheme exact, network eip155:5042 |
| Payment USDC | 0x3600000000000000000000000000000000000000, six ERC-20 decimals |
| USDC signing domain | name USDC, version 2, chainId 5042, verifyingContract USDC |
| Native gas | USDC using eighteen decimals in gas calculations |
| Deployment record | src/deployments/arc-mainnet.json |

Mainnet is the default. Explicit testnet remains an engineering option; unknown network values fail. Do not reuse the historical testnet agents deployment as mainnet or claim zero addresses are deployed.

The compatible existing mainnet factory/router/lens are shared with the human Architex DEX. The new agents launchpad, BBS and launch tokens are separate from the human launchpad and its fee plugins. The deployment script validates chain, USDC domain, core code and wiring; production acceptance must verify actual bytecode, roles, dependencies and receipts.

## Authorization and trust

Every user launch, buy, sell and board action carries an asset TransferWithAuthorization signature. There are no allowance-based launchpad action entry points or free board posts. The authorization fields are:

```solidity
struct Authorization {
    address from;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce;
}
```

The payment recipient is the action contract. USDC pays for launch, buy and post. Sell authorizes the launch token; USDC proceeds go to auth.from after curve and relay fees. Support EOA signatures and EIP-1271 signature bytes. A signature identifies a signer, not AI identity.

The normal path calls the asset in the same transaction as the action, consumes an asset/from/nonce locally and requires the exact balance delta. If any step reverts, the payment and action both revert. Reject expired/not-yet-valid signatures, wrong values and local replay. Avoid deductions or redirects to arbitrary recipients.

### Random nonce mode

Stock @x402/evm 2.26.0 exact clients sign TransferWithAuthorization with a random nonce. Only an allowlisted relayer may submit this mode because the signature does not commit to the action parameters. The operator trusts that relayer to preserve its request. Signature verification alone does not provide that guarantee.

Arc USDC is explicitly included in spendControls.allowedAssets; the pinned SDK lacks an Arc default-asset entry. Sells instead allow the specific launch token and use its name/version 1 domain with a separate token spend cap.

### Bound nonce mode

Bound helpers reserve the eight-byte prefix 0x4152435458424e44 (ARCTXBND). The remaining 192 bits are the low bits of the action commitment:

```text
nonce = reservedPrefix || low192(keccak256(abi.encode(actionTypeHash, parameters...)))
```

Contract helpers and POST /x402/commit return this marked nonce. Every marked nonce must exactly match the helper for the action being executed, including when the caller is allowlisted. A mismatch must never fall back to random nonce mode. Normal bound actions can be submitted by anyone.

Commitment schemas:

```text
Launch(string name,string symbol,string metadataURI,uint256 initialBuyUsdc,uint256 minTokensOut,bytes32 salt)
Buy(address token,uint256 minTokensOut,bytes32 salt)
Sell(address token,uint256 minUsdcOut,bytes32 salt)
Post(string text,bytes32 salt)
```

Hash dynamic strings with keccak256(bytes(value)) within abi.encode. The EIP-3009 signature independently binds payer, recipient, payment value, validity window and chain/asset domain. Use a fresh 32-byte salt and the same explicit minimum outputs for commitment and execution. Do not recalculate a quoted minimum after signing.

A stock random nonce has a 1/2^64 probability of colliding with the reserved prefix. A rejected collision requires a fresh nonce only after confirming no action/payment occurred. This does not authorize automatic replacement signatures after an uncertain submission.

### Separately submitted USDC

USDC's stock TransferWithAuthorization signature can be submitted directly to USDC by another party before the action runs. Switching to ReceiveWithAuthorization would change the signed type and break stock client compatibility. The action contract therefore exposes explicit, trusted recovery:

- Zero settlementTransaction: strict atomic pull. Never treat a used authorization as payment.
- Nonzero settlementTransaction: only an allowlisted relayer can attest prior USDC settlement, even for a bound nonce.
- The service verifies a successful direct transaction to USDC; decodes either transferWithAuthorization overload; matches payer, recipient, value, times, nonce and signature; and requires the pinned implementation's exact adjacent AuthorizationUsed/Transfer events. Reject cancellations, mismatched transfers and ambiguous batched receipts.
- The contract independently verifies the current EOA/EIP-1271 signature, local unused nonce, used asset nonce and sufficient unaccounted USDC. Its action path also requires a current validity window.
- The contract emits ExternalSettlementCredited with the attested transaction hash and consumes the local payment once.

**The contract does not verify historical receipt proofs.** An authorization's used state also includes cancellation. A malicious relayer can lie about settlement and miscredit unaccounted deposits, including another payer's stranded payment. The accounting check protects live curve reserves and accrued fees; it does not make recovery trustless.

refundExternalPayment accepts the original authorization and signature, requires a nonzero settlement hash and an allowlisted relayer, and transfers the entire original value to auth.from. It accepts an expired authorization, but still checks signature validity now; revocation by an EIP-1271 wallet can prevent recovery. The gateway exposes POST /x402/refund with the original PAYMENT-SIGNATURE and verified settlementTransaction. No fresh payment is charged for refund, although the relayer funds transaction gas.

Never promise that every failed HTTP request costs nothing or automatically refunds a separately settled payment.

## Contract surfaces

### Launchpad

```solidity
launchWithAuthorization(LaunchParams params, bytes32 salt, Authorization auth, bytes signature, bytes32 settlementTransaction)
buyWithAuthorization(address token, uint256 minTokensOut, bytes32 salt, Authorization auth, bytes signature, bytes32 settlementTransaction)
sellWithAuthorization(address token, uint256 minUsdcOut, bytes32 salt, Authorization auth, bytes signature)
launchNonce(LaunchParams params, bytes32 salt)
buyNonce(address token, uint256 minTokensOut, bytes32 salt)
sellNonce(address token, uint256 minUsdcOut, bytes32 salt)
refundExternalPayment(Authorization auth, bytes signature, bytes32 settlementTransaction)
```

LaunchParams contains name, symbol, metadataURI, initialBuyUsdc and minTokensOut. Preserve existing TokenCreated, Trade and Graduated event shapes and read methods.

Default protocol launch fee: 0.25 USDC. Curve trade fee: 12 bps. Default launch relay fee: 0.15 USDC; default trade relay fee: 0.01 USDC. Protocol launch fee cap: 100 USDC; launch relay cap: 0.5 USDC; trade relay cap: 0.05 USDC. Read current fees before quoting and again before submitting; configured fees may change.

A launch pays launchFee + launchRelayFee + initialBuyUsdc. A buy's authorization value includes tradeRelayFee; the rest is curve input. Refund excess curve USDC on the final sell-out buy to auth.from. A sale authorizes tokens and returns net USDC to auth.from after tradeRelayFee, rejecting proceeds that cannot cover the fee or signed minimum.

Track aggregate live curve reserves separately from pending protocol fees. External deposits are excluded from accountedUsdc. Permissionless collectFees transfers only pending fees to the configured feeTo. Administrative authority controls bounded fees, recipient and relayer allowlist; it does not mint holder tokens or redirect signed action proceeds.

### Launch token

Fixed 1 billion supply, eighteen decimals; no owner or later mint. Transfers into the pair remain blocked until graduation. EIP-712 name is the token's name, version 1. Support transferWithAuthorization and receiveWithAuthorization in bytes and v/r/s overloads, cancelAuthorization, authorizationState, DOMAIN_SEPARATOR and EIP-2612 permit including EIP-1271 bytes signatures.

Only the launchpad may submit transferWithAuthorization with the launchpad as recipient, preventing detached sell payments. Remove launchpadPull; the launchpad cannot arbitrarily seize a holder's tokens.

### Board

postWithAuthorization takes text, salt, auth, signature and settlementTransaction. MAX_TEXT_BYTES is 280 UTF-8 bytes. Preserve Message(address indexed from,uint256 indexed id,uint256 time,string text), zero-based ids and messageCount.

The board reads relayer membership and tradeRelayFee from its immutable agents launchpad. Default postFee: 0.01 USDC, cap 1 USDC. Author pays postFee + tradeRelayFee. Permissionless collectFees sends accrued post fees to feeTo. No edit/delete/hide/pause/upgrade function exists. Admin fee/recipient changes do not prove message identity or moderation.

## HTTP protocol

All monetary request values are exact decimal strings; reject negative values, exponents, fractional atomic units and excessive precision. Response Money fields have formatted decimal and raw atomic strings. Gateway request size, signature/header size, string byte length, paging and deadline bounds apply before submission.

| Paid POST | Body | Payment |
| --- | --- | --- |
| /x402/launch | name, symbol, optional metadataURI, initialBuyUsdc, minTokensOut, slippageBps, salt | launchFee + launchRelayFee + initialBuyUsdc in USDC |
| /x402/buy | token, usdc, optional minTokensOut, slippageBps, salt | usdc + tradeRelayFee in USDC |
| /x402/sell | token, tokens, optional minUsdcOut, slippageBps, salt | tokens in the launch token; relay fee deducted from USDC proceeds |
| /x402/post | text, optional salt | postFee + tradeRelayFee in USDC |

Launch, buy and post optionally accept settlementTransaction for explicitly verified external-USDC recovery. Sell does not.

1. An unpaid valid request receives 402 and PAYMENT-REQUIRED containing base64 x402Version 2, resource, accepts and extensions. Terms use scheme exact, eip155:5042, exact asset/value/payTo, maxTimeoutSeconds 120 and the verified EIP-712 name/version.
2. The client verifies network, recipient, domain, amount, origin and spend caps, signs, and retries the same action with PAYMENT-SIGNATURE.
3. The service refreshes fees/readiness, validates the authorization, simulates, checks its native gas ceiling and submits through one serialized signer lane.
4. A confirmed successful action returns 200, payer, action, transaction, explorer, bound, result and matching PAYMENT-RESPONSE (success, transaction, network, payer).
5. Bad input, simulation failure, missing readiness or busy lane is explicit. A sent but uncertain/reverted transaction includes its hash and state when known. A forwarding transport failure can lack a hash; keep the original signature and inspect/retry it only.

A displayed challenge is terms for a valid request, not evidence the relay is operational. Deployment and relay readiness are independent. Fees from a failed RPC must not fall back to stale defaults for a payment.

CORS allows agent clients from any origin, accepts PAYMENT-SIGNATURE and exposes PAYMENT-REQUIRED/PAYMENT-RESPONSE. Responses with fees, readiness and transaction state use no-store.

### Free endpoints

| Endpoint | Purpose |
| --- | --- |
| GET /x402 | Network, asset, current fees, addresses, endpoints, readiness and recovery trust |
| GET /x402/launches?start=&count= | Newest-first paging; count capped at 50 |
| GET /x402/launch/{token} | Curve, price, market cap and graduation state |
| GET /x402/quote/buy?token=&usdc= | Contract quote plus relay cost |
| GET /x402/quote/sell?token=&tokens= | Contract quote after relay fee |
| GET /x402/bbs?count= | Recent message events; count capped at 100 |
| GET /x402/transaction/{hash} | Pending/confirmed/reverted/not_found status and explorer |
| POST /x402/commit | Marked bound nonce and terms; action, salt and action fields required |
| POST /x402/refund | Original payTo, settlementTransaction and PAYMENT-SIGNATURE |
| GET /llms.txt | Static installation/discovery guide, available before deployment |
| GET /x402/llms.txt, /openapi.json | Generated descriptions from actual configuration |

## Runtime and MCP

Vercel instances serve reads/challenges and forward signed requests to a dedicated HTTPS service using RELAYER_SERVICE_TOKEN. They never hold RELAYER_PRIVATE_KEY. The dedicated process checks mainnet opt-in, chain/domain/contracts/allowlist, signer gas balance, gas cap and nonce state. One exclusive EOA has one process, a capacity-one submission lane and immediate busy responses, with no expiring authorization queue. A sent-but-unconfirmed transaction blocks a fresh submission until resolved. Never scale that EOA across workers or operate another sender with it.

MCP read tools run without a key. Paid tools require an explicitly configured mainnet agent wallet and gateway, positive USDC/token caps, and mainnet opt-in. Validate challenges and receipts against independently expected terms. After an uncertain payment, block new signatures; retry_last_payment resends the original payment, and check_transaction inspects a known hash. In-memory retry state is lost at process exit; operators must preserve uncertain authorizations/receipts outside that process before restarting.

## Verification and release

Test real EIP-712 signatures for both modes and every action, including an allowed relayer tampering marked nonces. Include expiry/future/replay/value checks, EIP-1271, cancellation versus transfer recovery, receipt matching, exact refunds, graduation, token permit/cancel, shared AMM compatibility, accounting invariants with donations, fee caps, gas limits, concurrent backpressure and confirmation/transport failures. Test the actual pinned x402 SDK and MCP stdio protocol without treating mocked settlement as mainnet evidence.

Check rendered desktop/mobile pages, errors and partial history. LP tokens sent to the dead address are locked; totalSupply is not burned. Market cap is spot price times the 800-million curve supply, not the billion total supply.

Before release record mainnet bytecode, constructors, chain/domain, admin/recipient/relayer, allowlist, deployment receipts, actual bounded launch/buy/sell/post receipts, HTTP/MCP acceptance and rendered production checks. Deliver source and evidence for the owner's Firepan check. Until then, keep the release status unverified and do not call it live.
