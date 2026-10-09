# Direct JIT launches on Arc mainnet

The first direct-launch product creates a new fixed-supply token and its own
JIT engine. Existing agents curve/V2 launches and the human DEX are separate.
Source publication, a website release candidate and successful fork simulations
do not constitute an operational mainnet deployment. The authoritative JIT
deployment record is `src/deployments/arc-mainnet-jit.json`; zero factory or hook
deployer addresses mean unavailable. Do not create a second authoritative record.

## Immutable launch terms

- Supply is exactly 1 billion tokens, with 18 decimals. Entire supply enters the
  bound engine, with no free creator allocation or later mint/burn authority.
- Creator supplies real six-decimal USDC at
  `0x3600000000000000000000000000000000000000`. Both baseline and initial JIT
  liquidity must fit this capital and the issued token inventory.
- Deposits, idle inventory and positions confer no withdrawal/redemption right.
  They remain exposed to trades and losses. Locked custody does not burn supply.
- All collected LP fees in both assets go to the explicitly chosen immutable
  recipient. Fee recipient cannot be rotated. Anyone may deliver accrued credits
  using `claimFees`, but cannot redirect them or take principal.
- Pool fee is 3000 (0.30%) and tick spacing is 60. Any PoolManager protocol fee
  affects actual LP earnings. Do not advertise every swap fee as creator revenue.
- JIT expiry is maximum `uint64`. Baseline and temporary ranges, liquidity,
  minimum swap sizes and inventory budgets remain fixed. Out-of-range or depleted
  inventory falls back to baseline; there is no automatic recentering.
- Agents sign locally and pay gas. This lane adds no gas sponsor, x402 payment
  adapter, creator/protocol split, holder stream or automatic quote conversion.

The creator is the direct factory caller and the exact capital payer. The
factory pulls a finite USDC allowance, creates known token/vault/hook/executor
code, binds and funds the vault, seeds baseline and registers the result in one
transaction. Failure reverts capital movement, deployments and nonce use. The
factory retains no portion of the launch capital and has no recovery/sweep API.
Unsolicited transfers to the factory are not used as someone else's seed.

## Deterministic preparation

`LaunchConfig` field order is:

```text
name string
symbol string
metadataURI string
seedUSDC uint256
feeRecipient address
poolFee uint24
tickSpacing int24
policy ArchitexJITHook.Policy
creatorNonce bytes32
hookSaltNonce uint256
deadline uint64
```

Policy uses the existing engine tuple order, ending in `validUntil uint64`.
Name is 1–32 UTF-8 bytes, symbol 1–10 bytes, optional metadata URI 0–256 bytes.
Opening price must use sorted currency units (token 18 decimals, USDC 6).
Fixture valuations are synthetic and are not production defaults.

```text
launchId = keccak256(abi.encode(creator, creatorNonce))
configHash = keccak256(abi.encode(config))
tokenSalt = keccak256(abi.encode(keccak256("ARCHITEX_JIT_TOKEN"), launchId))
vaultSalt = keccak256(abi.encode(keccak256("ARCHITEX_JIT_VAULT"), launchId))
executorSalt = keccak256(abi.encode(keccak256("ARCHITEX_JIT_EXECUTOR"), launchId))
hookSalt = keccak256(abi.encode(keccak256("ARCHITEX_JIT_HOOK"), launchId, hookSaltNonce))
```

Use one `predictLaunch(creator, config)` result for token/vault predictions and
hook initialization hash. Mine the hook CREATE2 address locally using the actual
hook deployer address, until its low 14 bits equal `0x2ae0`. The production
factory performs no search. Changing constructor inputs or compiled code can
invalidate the salt; regenerate the complete preparation and approval payload.
Changing only the mined nonce leaves token and vault addresses unchanged.

Supply is initially minted to the factory, avoiding a circular token/vault
constructor address dependency. The factory must construct the vault itself:
the vault binder is its constructor caller. A generic CREATE2 factory cannot
bind this vault. The typed hook deployer has no vault authority or arbitrary-code
entrypoint. Its manager is constructor-set storage with no setter, allowing an
exact runtime hash check in the factory constructor. Verify that runtime and
manager independently when preparing a deployment.

## Build and unsigned deployment preparation

Use the pinned Solidity 0.8.26/Cancun/viaIR/optimizer-200/no-metadata-hash JIT
profile. Reuse the existing OpenZeppelin 5.1 dependency. No core implementation
or unlicensed upstream helper belongs in product contracts.

```sh
forge build --root jit
forge test --root jit --match-contract ArchitexJITFactoryTest
bun run scripts/jit-prepare.ts inspect
```

`inspect` checks the complete artifact source closure and production module
runtime/initcode limits. The older state-override simulation harness is not
deployable product code and can make a global `forge build --sizes` exit nonzero;
use the production artifact inspection for release sizing.

The deployment helper is deployed first, then the factory with that confirmed
helper address. The factory constructor checks helper runtime and manager, so a
prediction of an undeployed helper cannot pass a factory gas estimate.

```sh
bun run scripts/jit-prepare.ts deployment --deployer PUBLIC_ADDRESS --gas-ceiling-usdc DECIMAL
bun run scripts/jit-prepare.ts deployment --deployer PUBLIC_ADDRESS --gas-ceiling-usdc REMAINING_DECIMAL --hook-deployer CONFIRMED_ADDRESS
```

These commands prepare unsigned data only and never load a signing key. Obtain
explicit public signer/signing-method and aggregate budget approval before
submission. `jit/script/DeployJIT.s.sol` targets only chain 5042 and the verified
manager runtime. Standard Forge script execution is a dry run; `--broadcast`
requires the approved externally supplied signing account and authorization for
the aggregate spend. Do not put private keys in shell arguments, source, chat,
logs or serverless configuration. No broadcasting is part of source verification.

Arc native gas has 18 decimals and ERC20 USDC has 6, over the same underlying
value. Seed capital, approval/creation/trade gas and any trade input share the
wallet's budget. Reserve the maximum approved gas cost before committing seed;
reconcile both unit scales without double counting. A deployment gas ceiling
does not authorize seed capital or acceptance trades. After helper confirmation,
rerun factory preparation with the remaining approved ceiling and fresh nonce.

Record actual transaction hashes, receipts, deployed runtime hashes and constructor
terms. Factory runtime has address-dependent immutables: resolve compiler
immutable references before comparing it with on-chain code. Do not record
unresolved artifact hashes as deployed runtime identities. Verify factory
manager/USDC/deployer, exact helper code, token supply, vault binding and fee
recipient, hook pool key/permission bits/policy, and executor wiring.

## Verification and funded acceptance

Local factory regressions exercise actual pinned PoolManager code with an
explicit six-decimal USDC model. Ordinary Forge Arc fork execution may also use
a distinct USDC model. Native-positive tests require the official verified Arc
Forge runtime; they never overwrite native USDC or deployed PoolManager code.

```sh
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io forge test --root jit --match-contract ArchitexJITFactoryArcForkTest
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io ARC_NATIVE_FORK=true /path/to/verified/arc-forge test --root jit --network arc --match-contract ArchitexJITFactoryArcForkTest
```

The package command `jit:test:mainnet-fork` also requires a verified Arc Forge:
set `ARC_FORGE=/path/to/verified/arc-forge`; stock Forge rejects `--network arc`.

All fork funds are synthetic. Before describing this release as live, record:

1. Approved signer, fee recipient and combined deployment/seed/trade USDC ceiling.
2. Confirmed typed helper and factory deployments with verified runtime identity.
3. A real factory launch whose event and registry match prepared addresses and
   whose baseline plus remaining JIT inventory match the funded terms.
4. Bounded buy and sell receipts with completed JIT cycles, no resting temporary
   position, and no unresolved PoolManager deltas.
5. Fee claim receipts proving recipient credits and preserved non-fee inventory,
   plus reconciled native USDC, ERC20 balances, PM claims and token total supply.
6. API/MCP readiness and durable uncertain-transaction recovery. Persist original
   signed bytes/hash before submitting; do not replace a lost-response payment or
   launch automatically. Reconcile receipt, account nonce and creator nonce first.
7. The owner's Firepan release gate.

The standard Uniswap frontend is not guaranteed to discover or route this hook.
Architex executor/MCP usability must be established independently. Source and
fork checks establish execution evidence, not external audit or funded acceptance.

## Source verification recorded 2026-10-09

The current source passes 26 deterministic factory regressions using the actual
pinned local PoolManager with a labeled USDC model. Four additional official
Arc Forge tests pass with no skips at block 25019963 using untouched deployed
PoolManager and native USDC, and the production fixed-supply token created by
the factory. They cover predicted deployment and capital, both swap directions
and fee claims, underfunding rollback, and official Quoter parity without
persisting price, cycle, inventory or fee changes. Fork balances are synthetic;
there are no funded acceptance transactions in this record.

The artifact source-closure inspection passes for all six product contracts:

| Contract | Runtime bytes | Creation bytes before constructor arguments |
| --- | ---: | ---: |
| ArchitexJITToken | 1,552 | 2,618 |
| ArchitexJITHookDeployer | 18,043 | 18,200 |
| ArchitexJITFactory | 23,768 | 42,510 |
| ArchitexJITVault | 5,776 | 6,537 |
| ArchitexJITHook | 12,148 | 16,846 |
| ArchitexJITExecutor | 3,577 | 4,311 |

Factory runtime has 808 bytes of headroom below the standard limit; future
changes require another size check. Factory deployment adds 96 constructor
bytes (42,606 total initcode), and hook-deployer deployment adds 32 (18,232
total). The three reviewed core source files remain unchanged.
