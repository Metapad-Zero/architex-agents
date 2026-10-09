# Direct-wallet JIT interface, version 1

This interface targets Arc mainnet (5042), independently of the legacy agents
launchpad/BBS addresses and `/x402`. It creates new fixed-supply tokens through
the typed JIT factory. It does not migrate V2 liquidity, reuse curve token
transfer restrictions, accept stock x402 payments, or sponsor transaction gas.

The shared deployment record is `src/deployments/arc-mainnet-jit.json`. A zero
factory/deployer address or unresolved runtime hash is an unavailable deployment.
`GET /jit` returns that truthful state with HTTP 200; operations needing contracts
return 503. Compiled code, tests and a website release are not funded acceptance
or the owner's Firepan approval.

## Product and funding

Each token has 1 billion units, 18 decimals, and no further mint/admin authority.
Its entire supply enters the launch-specific vault; the creator receives no free
allocation. The creator pays actual six-decimal USDC seed. The factory creates
the token/vault/hook/executor, binds the vault, deposits both currencies, seeds
the baseline and records the launch in one reverting atomic transaction.

Version 1 fixes pool fee 3000 (0.30%), tick spacing 60 and policy `validUntil` to
18446744073709551615. Opening price, strictly enclosing baseline/JIT ranges,
liquidity, inventory caps and minimum swap thresholds remain explicit inputs.
Rounded baseline plus initial JIT requirements must fit both currencies and the
JIT caps. Preparation checks the same integer capital limits before an approval.
Fixed ranges do not recenter. Being strictly inside the JIT range is a price
condition; inventory and swap thresholds can still make a trade use baseline.

Principal, including idle deposits, is not redeemable. The current vault has no
principal withdrawal or deposit shares. Fees are separate collected credits in
both assets, paid only to the explicitly chosen immutable fee recipient. Claims
cannot redirect fees, convert them, or withdraw principal. Baseline collection
and a fee claim are separate gas-paying transactions. Collected fee accounting
is not a promise of returns or a volume-derived revenue statistic.

Arc ERC20 USDC uses six decimals; native gas USDC uses eighteen. They share the
same underlying value. Never add the two reported wallet balances. Direct tools
reserve `USDC input * 10^12 + gas * maximumGasPrice` against the native balance,
then check explicit capital and native-gas ceilings before signing.

## Keyless HTTP API

Every response uses no-store and permissive read/preparation CORS. POST accepts
at most 32768 UTF-8 JSON bytes. No endpoint accepts a private key, signed payment
header or arbitrary spender, and none signs/broadcasts a transaction.

| Method and path | Input and result |
| --- | --- |
| `GET /jit` | Mainnet identity, contract addresses, deployment readiness, fixed supply and custody/gas terms |
| `GET /jit/launches?start=0&count=20` | Registry summaries, creation order; count 1..50; decimal-string cursor, total and block number |
| `GET /jit/launches/:launchId` | Full verified pool wiring, token metadata, policy, balances and fee credits |
| `GET /jit/transactions/:hash` | Public chain status: confirmed, reverted, pending or not_found; this alone does not validate an application's operation |
| `POST /jit/prepare-launch` | `{creator, config}`; exact normalized config, predictions, finite funding requirements and unsigned launch |
| `POST /jit/prepare-approval` | `{payer,target:{kind,launchId?},currency,amount}`; kind launch/deposit/swap selects the verified factory/vault/executor |
| `POST /jit/prepare-deposit` | `{payer,launchId,currency,amount}`; permanent deposit into the registered bound vault |
| `POST /jit/quote-swap` or `/jit/prepare-swap` | `{payer,launchId,inputCurrency,amount,minimumOutput,recipient,sqrtPriceLimitX96,deadline}`; official quote and exact executor simulation |
| `POST /jit/prepare-collect` | `{payer,launchId}`; baseline fee collection without removing baseline principal |
| `POST /jit/prepare-claim` | `{payer,launchId,currency,amount}`; collected fee credits to the actual immutable recipient |

`launchId` is bytes32, `keccak256(abi.encode(creator,creatorNonce))`, not a registry
index. Amount inputs are decimal strings. Returned `Money` values have raw and
formatted strings. Ticks and capped page counts are numbers; integer policy
values, deadlines, timestamps, salts, cursors and block numbers are strings.
`createdAt` is Unix seconds. Name and symbol limits are 32 and 10 UTF-8 bytes;
optional metadataURI is at most 256 bytes. Metadata URI text is never fetched or
executed by this interface.

Lists use a single block snapshot, at most two registry reads per entry, and
chunks of ten concurrent entries. They omit expensive pool enrichment. Detail
loads current pool state separately. URI lookup is restricted to one recent
1901-block event window. `metadataURI: null` means unavailable in that lookup,
not proof no URI was supplied. Older URI text remains in the creation receipt.
Name, symbol and supply come from actual token reads; failed reads are errors.

Preparation is unsigned. A simulation can report `executable: false` before a
finite allowance exists. No allowance is silently created. Official v4 Quoter
quotes do not include the custom executor price limit. Only the exact executor
request simulated from its actual funded/approved payer is called executable.
The official quote, exact executor calls and gas estimate use the reported
quote block snapshot.
Quotes can change before inclusion; the executor enforces full exact input,
minimum output, price limit, recipient and deadline. Partial fills are disabled.

Every available operation checks mainnet identity; exact factory, deployer,
PoolManager and Quoter runtime hashes; factory constants and dependency getters;
and USDC name/version/decimals. Full detail checks registered token/vault/hook/
executor references, hook permission bits, sorted currencies, full PoolKey ID,
fixed supply, seeded baseline and immutable policy/recipient. Deployment hashes
must include the actual constructor immutable substitutions, not an interface
probe or a bare unpatched compiler template.

Errors are structured `{error,message}` with 400 malformed input/limits, 404
unknown route/launch, 405 method, 409 consumed nonce or invalid hook salt, 413
oversize body, 502 RPC/simulation lookup failure and 503 unavailable/unverified
contracts. Failed exact simulations return preparation with an explicit false
executable state. Provider payloads and secrets are not logged or returned.

## MCP execution

The same downloaded stdio server exposes legacy and JIT tools. Public JIT reads
and preparation need no key or `GATE_URL`. Direct submissions require a local
`AGENT_PRIVATE_KEY`, `AGENT_ALLOW_MAINNET=1`, `ARC_NETWORK=mainnet`, and explicit
positive `AGENT_MAX_PAYMENT_USDC` and `AGENT_MAX_GAS_USDC`. JIT has no implicit
spending defaults. The former caps each finite USDC approval/input/seed; the
latter caps each transaction's maximum native gas charge. Token approvals and
inputs are explicit finite amounts, capped by fixed supply. Ceilings are per
transaction/request; they are not a session-wide spending allowance.

The tools are `get_jit`, `list_jit_launches`, `get_jit_launch`,
`prepare_jit_launch`, `approve_jit_funding`, `create_jit_launch`,
`deposit_jit_inventory`, `quote_jit_swap`, `swap_jit`, `get_jit_fees`,
`collect_jit_baseline_fees`, `claim_jit_fees` and `check_jit_transaction`.

A launch workflow is explicit: inspect readiness; choose capital/price/ranges/
fee recipient; prepare and mine the exact configuration; approve only its seed
to the factory with a unique requestId; reconcile that approval; then create
using the returned config unchanged and another unique requestId. Token/vault
creation and initial deposits require no separate token funding transaction.
Later deposits and swaps need their own finite vault/executor allowances.

Local preparation can mine at most 200000 hook salts using the exact deployment,
creator identity and constructor hash. HTTP preparation does no mining. Salt
changes require a fresh config hash; the actual signing tool never silently
remines, changes a recipient/minimum/deadline, or creates a new creator nonce.
The hook salt is keccak256 of ABI-encoded keccak256("ARCHITEX_JIT_HOOK"),
launchId and hookSaltNonce. The CREATE2 sender is the verified HookDeployer.

## Durable transaction lane and recovery

Every direct write requires a nonzero bytes32 requestId, identifying its exact
original operation. Each wallet uses one shared private local state directory,
default `~/.local/state/architex-agents`; `AGENT_JIT_STATE_DIR` can choose another
absolute directory. Directory permissions must be 0700 and files 0600, owned by
the current user, without symlinks. Do not share a signing wallet with another
application or give concurrent processes different journal directories.

A filesystem admission lock rejects concurrent submissions rather than queuing
them. The lane checks RPC latest/pending nonces, simulates exact calldata, checks
budgets and repeats nonce checks before signing. It fsyncs original serialized
signed bytes, hash and intent to an atomic journal BEFORE broadcast. No key is
stored in the journal. Signed bytes are private replayable transaction material;
keep the state directory private and backed up.

After transport loss, timeout, pending or not-found status, the original remains
active. New request IDs are refused; exact original retries return its retained
hash without a new signature or broadcast. `check_jit_transaction` without a
hash reconciles that local original: successful receipt, transaction hash,
payer, chain, nonce, destination, exact calldata/value, and matching operation
events. It reports actual executed amounts from the event. A reverted original
is recorded as reverted with gas paid. A mismatched receipt keeps the lane
blocked. A public hash supplied to the tool reads chain status only.

Confirmed/reverted request IDs and their fingerprints are retained as durable
tombstones. The bounded journal allows 1024 resolved requests per wallet and
then refuses fresh submissions. There is no eviction, automatic deletion or
silent reset. Original requests still return their recorded outcomes at
capacity. Preserve the journal; any future retention migration must preserve
all spent IDs. These tombstones do not establish results if an operator deletes
or replaces the state directory.

A crash can leave an admission lock. Stop all processes using that EOA, preserve
the journal, inspect the original hash and account nonce through independent
RPC views, and remove only the stale lock after establishing no process owns
it. Never delete the journal to unlock spending. Unknown/dropped transactions
require operator reconciliation; the tools do not blindly replace, cancel,
rebroadcast or invent confirmation. Loss of both journal and RPC visibility is
an operator limitation, not permission to repeat an action.

## Validation and license

Tests use real installed viem ABI encoding, CREATE2, local signing and MCP
protocol transports with explicitly simulated RPC/receipts. Math parity is
checked against the installed upstream SDK, including range boundaries and all
TickMath multiplier bits. Fork/native contract evidence and funded acceptance
are separate evidence categories. No interface test broadcasts a funded call.

The integer TickMath adaptation is MIT, Copyright 2023 Universal Navigation Inc.,
from pinned Uniswap v4-core. Preserve `jit/lib/v4-core/licenses/MIT_LICENSE` in
source distributions; it travels in the explicit MCP archive. No production
client imports the core's BUSL or AGPL fixture dependencies.
