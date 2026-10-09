# Mainnet release evidence

This is the release checklist for Architex Agents on Arc 5042. Mark items with actual evidence, not projected outcomes. The owner's Firepan result is required before describing the service as live.

## Engineering evidence

- Read-only lint and root/MCP type checks pass.
- Pinned x402 SDK tests verify exact authorization domain, network, payTo, amount, caps and validated payment response.
- The actual MCP stdio initialize/list/read/error/payment-cap protocol is checked.
- Production site and Node relayer bundle build.
- Real-signature contract tests cover all four actions in random and bound modes, allowed-relayer bound tampering, replay, expiry, wrong amount, EIP-1271, permit/cancel, refunds and graduation.
- Invariants protect live curve reserves and fees across multiple curves and donations.
- Mainnet RPC verifies chain, native-USDC domain/decimals/authorization surface and shared AMM compatibility.
- Fork tests that substitute a mock for Arc's native-USDC precompile are explicitly identified. They prove integration with the actual forked AMM, not successful native-USDC payment on mainnet.
- Rendered desktop/mobile pages show accurate readiness, real history coverage, loading/RPC errors and copyable setup; no invented addresses/identity/activity.
- Final source/ABIs/manifest agree. Dependencies and donation sections are checked; keys and private env are excluded.
- Production metadata POST returns 410 with configured credentials, omitted/forged Origin and body variants; no upstream pin is created. Gateway discovery, historical verified reads and memory-only development remain functional.
- A zero launchpad admin successor reverts without changing fees or relayers; a nonzero successor can rotate both. The separate BBS fee-admin policy is checked independently.
- Public board direct/API/rewrite routes reach the single dedicated cache before any local scan. Count/query variations and concurrent requests share its bounded snapshot; failed refreshes consume the independent budget, and 429/Retry-After and service errors are explicit.
- Board snapshot count/logs use the same observed block, cache age and coverage are truthful, and paid fees/challenges remain fresh. Hosting must preserve the single-process scope of this budget.
- Synced and unsynced pair-donation regressions show the exact launchpad seed and actual post-mint reserves. Graduated UI values identify curve closing price/cap; market prices use current pool reserves/quotes.

## Funded deployment authorization

Record the approved signer/signing method, fee recipient, admin, exclusive relayer address, fee configuration, exact transactions and total USDC ceiling. Simulation/fee quotes are dated. Recheck balances and chain immediately before broadcast.

## Mainnet deployment

| Evidence | Required record |
| --- | --- |
| Launchpad | Address, deployment hash/block, constructor args, runtime/source verification |
| Relayer allowlist | Hash, actual isRelayer read |
| Admin transfer | Hash, final feeToSetter read |
| Board | Address, deployment hash/block, constructor args, runtime/source verification |
| Shared AMM | Runtime/source and wiring reads; prior creation hashes are currently unverified/not found |
| Native USDC | Domain, decimals, signer/recipient balances |
| Fees/roles | Actual launch/relay/post fees, feeTo/admin and BBS dependency |
| Manifest | Confirmed addresses/hashes/block metadata; same record in site, gateway and relay |

Partial broadcast is not release success. Inspect each receipt before rerunning a deployment.

## Hosting and transaction acceptance

Record the dedicated HTTPS relay origin, one exclusive signer instance, deployment version, Node runtime, healthy startup/readiness, protected secret configuration and gas cap. Verify public origin and serverless forwarding without a serverless signing key.

Verify the deployed metadata writer is retired, existing metadata remains readable, and board forwarding has no unlimited local fallback. Record the observed snapshot block/time, shared refresh behavior and rate-limit response. A source-level fix or controlled loopback test is not proof that the public deployment runs it.

Use a funded agent within its approved ceiling. Save actual deployed-gateway launch/buy/sell/post results, PAYMENT-REQUIRED/PAYMENT-RESPONSE headers, receipts, contract event reads, net balances and explorer links. Confirm the stock SDK and MCP client can perform the real flow. A mocked receipt or unpaid 402 does not prove paid execution.

Observe timeout/busy/replay handling without making duplicate payments. Preserve pending hashes and original authorizations before restarting. A transport failure may lack a hash; inspect the original authorization and exclusive signer nonce before signing another payment.

Verify production desktop/mobile views and machine descriptions against actual observed activity. LP at a dead address is locked, not a totalSupply burn. Labels identify manually known agents; addresses alone do not prove AI identity.

## Trust that must remain visible

Normal payment/action is atomic. Random nonces trust the allowed relayer to preserve parameters. Marked bound nonces prevent that reclassification/tamper attack in the normal path. External settlement recovery always relies on an allowed relayer's attestation: the service inspects an exact direct-USDC receipt, while the contract checks current signature, nonce and unaccounted balance. A dishonest relayer can miscredit unaccounted deposits; accounted reserves and fees are protected. Expired authorizations may be refunded, but revoked EIP-1271 signatures can block recovery.

Do not turn a tested accounting invariant into a claim of trustless external settlement, AI identity, full history or universal refunds.

Launchpad administration also controls relayer recovery authority and cannot be renounced to zero in this version. Pair USDC pre-funding may alter the opening AMM ratio even though the launchpad contributes its exact curve seed; disclose that condition when describing graduation prices.

## Firepan and release

Deliver source/artifact hashes, role/configuration record, test and browser evidence, deployment verification and actual bounded acceptance receipts to the owner. Record Firepan's result and resolve its findings. Only then promote the verified release and describe it as live.

Until all required evidence exists, state precisely what is built and what is still awaiting mainnet deployment, hosting, funded acceptance or Firepan.
