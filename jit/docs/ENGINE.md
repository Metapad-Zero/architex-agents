# Architex JIT engine: milestone 1

This isolated Solidity subproject prototypes one token/ERC20-USDC pool on Arc
mainnet. It does not deploy contracts, provision capital, integrate signed
orders into the gateway, or establish production custody and creator economics.
The existing V2 contracts, launchpad, gateway and root compiler profile are
unchanged. Local fixtures mint a model launch token and use explicit test policy
parameters; those prices and balances are not market observations.

The engine keeps a wider baseline position present. On an eligible swap, its
pool-specific hook adds an inventory-capped position at immutable narrow tick
bounds before the core swap and removes it afterward. Expired, out-of-range,
below-threshold or insufficient-inventory JIT policies use baseline depth.
The fixed bounds do not recenter from a manipulable spot price. An offchain
agent is not called during swap execution. Other routers can trigger the same
pool hook; trades in other pools do not use this engine.

## Contracts and accounting

- `ArchitexJITVault` holds cash and PoolManager ERC6909 claims for the two pool
  currencies. Claims are a representation of custody, not additional assets.
  Historical deposit totals are not redeemable shares or a guarantee against
  trading loss. The prototype has no principal-withdrawal function.
- `ArchitexJITHook` authenticates PoolManager callbacks and the exact PoolKey,
  owns separate baseline and temporary positions, and enforces a bounded swap
  lifecycle. Immutable policy and pool configuration avoid arbitrary strategy
  calls. Each completed swap collects temporary-position fees, removes temporary
  principal in a separate operation, then collects baseline fees without removing
  baseline liquidity. Keeping those deltas separate avoids overflowing v4's
  signed amount limits when principal and earned fees are individually valid.
- `ArchitexJITExecutor` is the separate swap caller, settles the caller's currency
  deltas, and checks fills and limits. v4 suppresses a hook's own swap callbacks,
  so the hook cannot act as the executor for this lifecycle.

After temporary liquidity is removed, the swapper may not have settled yet.
Positive hook deltas become vault-owned ERC6909 claims; negative deltas use
existing claims and cash. Every currency delta must be zero at the end of the
PoolManager unlock. Fees, available inventory and active positions are distinct.
Only collected position fee deltas enter fee credits; unsolicited cash is not
automatically fee revenue. v4 fee-growth values can include donations, so they
must not be advertised as volume-derived revenue. The hook rejects pool donate
calls. Its immutable fee recipient is a prototype fixture choice, not an
approved production creator/protocol split.

The vault deployer has one trusted setup action: bind the hook and give it
PoolManager claim-operator rights. Interface checks establish matching vault and
manager references, not that arbitrary hook bytecode is safe. Production setup
must verify the exact deployed hook code, constructor policy and binding before
accepting deposits. Binding cannot be rotated afterward. Deposit and fee-claim
operations reject an unlocked PoolManager, and the hook rejects entry during a
vault inventory operation. The executor requires caller-owned approvals and
enforces the actual input/output, recipient, deadline, price limit and explicit
partial-fill choice; there is no signed-order gateway in this milestone.

Constructor policy checks reject per-tick or combined liquidity above the pinned
core's limits, initial baseline funding amounts above `int128.max`, and either
whole-range JIT asset amount above that signed limit. Temporary principal stays
representable even if the swap crosses the entire JIT range. Amount caps apply to
inventory committed before a swap; they do not promise that both asset balances
remain within those caps after trading.

Permanent custody and movable positions are compatible when movement stays
within the vault's own inventory and positions. They are separate from price
protection: range selection, adverse selection and persistent one-direction
flow can still cause loss or exhaust useful inventory. A public permanent-custody
promise and production capital policy remain outside this milestone.

## Compiler and dependency pin

Run commands from the repository root with `--root jit`, or change directory
into `jit`. The subproject uses Solidity **0.8.26**, Cancun, IR compilation and
200 optimizer runs. The root remains Solidity 0.8.28/Paris. This separation is
necessary because v4 uses transient storage. Arc's current official baseline is
Osaka; a pinned-block mainnet RPC probe independently exercised PUSH0, TSTORE
and TLOAD successfully. This is opcode evidence, not a complete compatibility
claim for arbitrary Cancun/Osaka contracts.

The unmodified dependency snapshot is Uniswap v4-core `v4.0.0`, revision
`e50237c43811bd9b526eff40f26772152a42daba`. Its source API uses
`IPoolManager.SwapParams` and `IPoolManager.ModifyLiquidityParams`; it does not
have the later `src/types/PoolOperation.sol` layout. The snapshot includes
original `src/` except upstream `src/test/`, and original license files.
[`PIN.json`](../lib/v4-core/PIN.json) records every vendored file's SHA256 and
SPDX identifier. Existing root `lib/forge-std` is used only for tests.

Licenses are preserved per file:

- Production imports are restricted to MIT interfaces, types, Hooks, TickMath,
  SqrtPriceMath and their MIT dependency closure. No core implementation is
  copied or relicensed into Architex MIT product source.
- `PoolManager.sol` and parts of the original core are BUSL-1.1. They remain
  separately licensed dependency source for local model fixtures and bytecode
  reconstruction. This project interacts with the existing deployed manager;
  it does not propose deploying a copied core under an MIT label.
- `StateLibrary.sol` and `TransientStateLibrary.sol` have MIT SPDX headers but
  import BUSL files. They are excluded from production imports. The hook's
  small state decoder reads the independently checked pool mapping at slot 6;
  that version assumption is supported by the runtime match below.
- Original core fixture compilation requires Solmate `Owned.sol`, pinned to
  `4b47a19038b798b4a33d9749d25e570443520647`. It is AGPL-3.0-only, and its original
  license is retained. It is not imported into product contracts.
- Upstream swap/liquidity test helpers and its `LiquidityAmounts` test utility
  are UNLICENSED and are neither copied nor imported. Architex fixtures and
  sizing logic are independently implemented.

See the pinned upstream [BUSL license](https://github.com/Uniswap/v4-core/blob/e50237c43811bd9b526eff40f26772152a42daba/licenses/BUSL_LICENSE)
and [MIT license](https://github.com/Uniswap/v4-core/blob/e50237c43811bd9b526eff40f26772152a42daba/licenses/MIT_LICENSE).
This inventory describes the included notices; it does not invent a production
license grant or remove the original dependencies' terms.

## Mainnet version verification

At Arc block **25019963**, hash
`0x43695925c3971843bdffd6149353ac880d42e6003b785d55d8fdc01b52926d38`, the listed
PoolManager at `0x8366a39CC670B4001A1121B8F6A443A643e40951` has 24,009 runtime
bytes and keccak256
`0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626`.

Compiling the original pinned core with its published Solidity 0.8.26, Cancun,
IR, **44,444,444 optimizer runs** and `bytecode_hash = "none"` reproduces every
runtime byte. The sole constructor immutable is `NoDelegateCall.original`:
the compiler reports a 32-byte replacement at byte offset 13606. Filling that
location with the left-padded deployed PoolManager address yields the identical
hash above, including compiler metadata. Engine optimizer settings remain 200;
the high run count is only for this independent core reconstruction.

To repeat the reconstruction without changing engine settings, create a
temporary Foundry project with these settings and an absolute `src` path to
`jit/lib/v4-core/src`, plus the `solmate/` remapping to its pinned subdependency.
Run `forge build --root <temporary-project> --no-cache`. Read
`out/PoolManager.sol/PoolManager.json`, fill only the positions in
`deployedBytecode.immutableReferences` with the deployed address, and compare
the resulting bytes against `cast rpc eth_getCode <manager> 0x17dc63b` using the
mainnet RPC. The structured evidence records the actual settings, immutable
locations and both hashes.

The explorer source API returned HTTP 403 and Sourcify's full-match metadata
endpoint returned HTTP 404 during this check. The byte-for-byte reconstruction
is independent evidence. It proves that this pinned source/settings produce
the observed runtime, not that a unique Git revision or constructor transaction
has been identified, nor that the new engine is audited.

## Verification commands and evidence categories

```sh
forge build --root jit
forge test --root jit --no-match-path 'test/fork/*'
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io \
  forge test --root jit --match-path 'test/fork/*'

# Use the checksum-verified Arc Foundry forge binary for this command.
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io ARC_NATIVE_FORK=true \
  /path/to/arc-foundry/forge test --root jit --network arc \
  --match-path 'test/fork/*' -vv
```

The configured fuzz seed is deterministic. Fuzzing runs 128 examples; invariant
testing runs 128 sequences with depth 64. Network checks are read-only or local
simulations; no command in this milestone broadcasts transactions.
The test itself selects block 25019963. Without `ARC_MAINNET_RPC`, fork tests
explicitly skip; without `ARC_NATIVE_FORK=true`, the positive native-USDC test
explicitly skips. A suite with skipped tests is not full native-USDC evidence.

Use three distinct labels when recording results:

1. **Local model tests:** original licensed core deployed locally and freely
   minted test assets. These establish engine behavior under the test model.
2. **Arc mainnet fork:** actual deployed PoolManager code/state at the pinned
   block. Ordinary Ethereum Foundry does not implement Arc's native-USDC
   precompiles; tests using a USDC model do not establish real USDC settlement.
   Arc Foundry supplies `forge test --network arc`. The checked official
   release is `v0.8.0-2`, build `d497beea7096ff2a8e583c8b307941f24a61b06b`;
   its Apple Silicon archive SHA256 is
   `90e3eefbf7dd80652fd283a7562e9263301a48797bc2224cc21a3964e2d5db87`.
   It was extracted to a temporary directory, without a global installation.
   The native test gives its simulation harness an artificial native balance
   and first checks that real USDC `balanceOf` exposes the corresponding
   six-decimal balance. It leaves the USDC and PoolManager code intact, runs
   both swap directions and fee claims, and verifies no temporary position or
   unsettled deltas remain. The launch token is still a freely minted model.
3. **Mainnet RPC simulation:** stateless `eth_call` with synthetic code/balance
   overrides against Arc's actual execution runtime. No transaction is sent
   and all simulated changes are discarded. This can exercise the real ERC20
   USDC/precompiles, but synthetic funding and the model launch token remain
   explicit. It is not funded acceptance.

USDC ERC20 `0x3600000000000000000000000000000000000000` reports **6 decimals**;
native gas balances use **18 decimals**. These are two interfaces to the same
balance, not separate assets. Never pool the native and ERC20 views against
each other or double count them. Engine pool operations use the ERC20 interface
and `msg.value = 0`. Gas costs expressed in native units require a different
conversion from six-decimal pool quantities.

The independent stateless checks in
[`arc-fork-verification.json`](../artifacts/arc-fork-verification.json) include
the opcode probe and an actual ERC20 USDC transfer returning true after a
synthetic native-balance override. Full engine tests, lifecycle measurements
and their limitations are also recorded there. The completed verification is:

| Check | Result |
| --- | --- |
| Local engine regressions, including both signed-limit fee/principal cases | 45 passed, zero failed; 128 fuzz examples |
| Conservation, fee backing and resting lifecycle invariants | Five properties passed; 128 runs and 8,192 calls per property, zero reverts |
| Ordinary Forge Arc fork | Five passed; native positive test explicitly skipped |
| Checksum-verified Arc Forge native fork | Six passed, zero failed or skipped |
| Separate read-only source review | No concrete remaining finding; fixes and trusted setup limit recorded |
| Existing root contracts, JavaScript and MCP tests | 158, 211 and 10 passed respectively |
| Existing mainnet fork with configured factory/router/lens | Five passed, zero skipped |
| Existing lint, types, site/MCP packaging and relayer build | Passed |

On the Arc native fork, 1,000 real-interface USDC bought
1,000.117170523647399695 model launch tokens, and the reverse 1,000-token trade
returned 993.894017 USDC. Both temporary positions closed, the baseline remained,
and all currency deltas settled. Fee payouts reduced the vault's cash-plus-claims
by exactly the credited fees while preserving available inventory. These are
synthetic fixture fills, not market observations. The two harness execution
measurements were 705,465 and 566,177 gas; the full test, including deployments
and hook-address mining, consumed 7,308,697 gas.

Passing any of these categories does not satisfy mainnet deployment, funded
acceptance or the owner's Firepan release gate. Source review is separate from
runtime testing and does not constitute an external audit.

The local equal-capital comparison starts with identical baseline liquidity and
cash inventory, then enables JIT in one run and expires it in the other. It
measures identical exact-input trades in both directions and reports each
asset's remaining cash and claims. The disabled run keeps the narrow-range
inventory idle; this is not a comparison against an optimized static position
using all capital. Measured execution gas includes the test/helper call path,
excludes transaction intrinsic gas, and is not a paid mainnet gas receipt. Fills
under these synthetic policy parameters do not establish market performance or
profitability.

The 5,000-token example returned 4,955.358351 model USDC with JIT and
4,731.651327 with JIT expired, using 654,810 versus 360,516 harness execution gas.
The 5,000-model-USDC example returned 4,991.094976658144218218 versus
4,765.001287335211034757 model tokens, using 655,743 versus 356,065 gas. The
structured artifact records raw units and the comparison's limitations.

Milestone 1 is complete. Production capital/custody terms, creator fee splits,
signed gateway/MCP swaps and launch integration remain the separately scoped
next milestone. No new JIT deployment addresses or acceptance transactions
exist, and existing V2 launches continue using their current graduation path.

Primary references: [v4 deployment list](https://developers.uniswap.org/docs/protocols/v4/deployments),
[pinned core](https://github.com/Uniswap/v4-core/tree/e50237c43811bd9b526eff40f26772152a42daba),
[Arc connection details](https://docs.arc.io/arc/references/connect-to-arc),
[Arc EVM differences](https://docs.arc.io/arc/references/evm-differences), and
[official Arc Foundry setup](https://docs.arc.io/arc/tutorials/install-arc-foundry).
