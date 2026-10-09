import { useQuery } from '@tanstack/react-query'
import { zeroAddress } from 'viem'
import { addressExplorerUrl } from '../../chain'
import { CodeBlock } from '../../components/CodeBlock'
import { mcpInstall } from '../../lib/gate'
import { fetchJitIndex } from '../../lib/jit'

export function DocsJIT() {
  const origin = window.location.origin
  const index = useQuery({ queryKey: ['jit', 'index', origin], queryFn: ({ signal }) => fetchJitIndex({ origin, signal }), staleTime: 15_000, refetchInterval: 30_000, retry: false })
  const clientConfig = JSON.stringify({ mcpServers: { 'architex-agents': { command: 'bun', args: ['--no-install', 'run', '/absolute/path/to/architex-agents-mcp/mcp-server/src/index.ts'], env: { ARC_NETWORK: 'mainnet', GATE_URL: origin } } } }, null, 2)
  const toolGroups = [
    ['get_jit', 'Deployment, mainnet readiness and fixed launch terms.'],
    ['list_jit_launches, get_jit_launch', 'Bounded registry summaries, then actual token, pool, policy, inventory and fee detail.'],
    ['prepare_jit_launch', 'Validate the exact capital, recipient and fixed policy, predict addresses, mine a bounded hook salt and simulate. This does not submit a transaction.'],
    ['approve_jit_funding, create_jit_launch', 'Approve a finite amount, then atomically create the token and funded pool. Both are local mainnet transactions.'],
    ['deposit_jit_inventory', 'Commit additional token or USDC inventory. Deposits have no withdrawal path.'],
    ['quote_jit_swap, swap_jit', 'Quote, then simulate the exact executor request with its price limit, full-fill input, minimum output, recipient and deadline.'],
    ['get_jit_fees, collect_jit_baseline_fees, claim_jit_fees', 'Read collected fees, collect baseline fees to vault credits, then pay credited fees in both assets to the immutable recipient. Collection and claim cost local gas.'],
    ['check_jit_transaction', 'Reconcile the original submitted hash before retrying an uncertain write.'],
  ]

  return (
    <div className="space-y-4">
      <p>JIT launches create a new fixed-supply token and its own Uniswap v4 pool on Arc mainnet, chain 5042. The creator provides real seed USDC and chooses a permanent fee recipient. Your agent signs transactions locally and pays gas. The site and discovery API are read-only.</p>
      {index.isLoading ? <p className="text-sm text-g500">Reading JIT deployment readiness…</p> : index.error ? <p className="read-error" role="alert">JIT readiness could not be confirmed. {index.error.message}{index.data ? ' Any addresses below are retained from the last successful read.' : ''}</p> : index.data && <p className="border-y border-g300 py-4 text-sm text-g700"><strong className="font-semibold text-ink">{index.data.readiness.ready ? 'Registry reads available.' : 'JIT unavailable.'}</strong> {index.data.readiness.reason}</p>}
      <p><a className="underline" href="#jit">Inspect the JIT registry</a> or read <a className="break-all underline" href={`${origin}/jit`}>{origin}/jit</a>. JIT readiness is independent of the HTTP curve launchpad and board. A configured address or successful read is not funded acceptance or a completed Firepan check.</p>

      <h3 className="pt-4 text-base font-semibold">Capital and supply</h3>
      <p>Each token has exactly 1 billion units with 18 decimals. Its entire initial supply enters the pool-specific vault. There is no free creator allocation, later mint authority, owner withdrawal or upgrade path. Trading can move tokens out of the pool; their supply is not burned when deposited.</p>
      <p>The creator supplies six-decimal USDC. Launch must fund the wide baseline and enough remaining inventory for the initial narrow position. JIT does not create capital. The full supply, seed capital and later deposits, including idle inventory, are committed principal with no redemption right. Trades and inventory losses can reduce its value.</p>

      <h3 className="pt-4 text-base font-semibold">What the hook does</h3>
      <p>The wider baseline provides persistent liquidity. When price, input thresholds and available inventory permit, the hook adds a narrower position before an eligible swap and removes it after. If the narrow position cannot be added, the swap uses the baseline. It does not guarantee an improved quote or protect principal from trading losses.</p>
      <p>Both ranges, their liquidity amounts, inventory caps and minimum swap thresholds are explicit immutable launch inputs. The ranges do not recenter. Outside the narrow range, trading uses the baseline. Version 1 requires policy expiry <code className="break-all">18446744073709551615</code>, the maximum uint64 value; this removes a finite expiry cliff without making every swap eligible.</p>
      <p>The pool fee is 0.30% and tick spacing is 60. The hook is part of the pool's immutable identity. External LP additions are rejected. Uniswap's interface may not discover or route to the pool; the agent uses this launch's verified executor.</p>

      <h3 className="pt-4 text-base font-semibold">Fees in both assets</h3>
      <p>All collected baseline and JIT LP fees go to the immutable fee recipient in the assets earned. There is no creator/protocol split, automatic token conversion or holder stream. Uncollected baseline fees first need a collection transaction. Credited fees can then be claimed to the recipient; both transactions cost local gas.</p>
      <p>The detail page separates vault cash, PoolManager claims, inventory available to the strategy, cumulative principal deposited, credited fees and fees already claimed. Collected fees are credited fees plus fees already claimed. They are not total trade volume or net profit. PoolManager claims are another form of custody for the same currencies.</p>

      <h3 className="pt-4 text-base font-semibold">Send an agent</h3>
      <ol className="list-decimal space-y-2 pl-5">
        <li>Read <code>/jit</code>. Check mainnet 5042, verified deployment, actual contracts and the permanent capital rules.</li>
        <li>Install the same MCP source bundle used by the HTTP tools. Start keyless for discovery and preparation.</li>
        <li>Choose the exact seed capital, opening price, fixed ranges and liquidity, immutable fee recipient, creator nonce and deadline. Inspect the predicted addresses and exact simulation before approving any funding.</li>
        <li>When you authorize execution, give the local process a dedicated funded account, explicit capital and gas ceilings and mainnet opt-in. The browser never signs or submits for you.</li>
        <li>Save the original transaction and request ID. Reconcile a pending or uncertain hash before replacing any submission.</li>
      </ol>
      <p><a className="underline" href={`${origin}/downloads/architex-agents-mcp.tar.gz`}>Download the MCP source bundle</a>. You need Bun on the machine running the MCP client.</p>
      <CodeBlock label="Download and install JIT MCP source" code={mcpInstall(origin)} />
      <p>Install at the extracted root with its frozen lockfile. The last command prints the server's absolute path. Replace the example path below with that value.</p>
      <CodeBlock label="Read-only JIT MCP client config" code={clientConfig} />
      <p>This config contains no signing key. <code>GATE_URL</code> locates the HTTP tools; JIT uses the shared mainnet manifest and does not depend on the HTTP relayer.</p>
      <p>For JIT writes, set <code>AGENT_PRIVATE_KEY</code> and <code>AGENT_ALLOW_MAINNET=1</code> only in the local MCP process, keep <code>ARC_NETWORK=mainnet</code>, and explicitly supply both <code>AGENT_MAX_PAYMENT_USDC</code> and <code>AGENT_MAX_GAS_USDC</code>. There is no default JIT write budget. Keep the key out of prompts, source, logs and website configuration.</p>
      <p><code>AGENT_MAX_PAYMENT_USDC</code> caps the seed, USDC swap, deposit or approval amount per request. <code>AGENT_MAX_GAS_USDC</code> separately caps the maximum native-USDC gas reservation per transaction. Neither is a total session budget. Arc's 18-decimal native gas balance and six-decimal ERC20 USDC balance represent the same underlying value, so capital and gas must fit together; do not count them as two funding pots.</p>
      <p>Token approvals and transfers use an explicit finite amount no greater than total supply. Every write needs a nonzero bytes32 <code>requestId</code>; a launch also supplies a <code>creatorNonce</code>. Retrying the same intent uses its original journaled transaction and hash. <code>AGENT_JIT_STATE_DIR</code> optionally chooses the exclusive local journal directory. Keep that state for recovery; it contains signed transaction data, not the private key.</p>
      <p>The journal retains up to 1,024 completed request IDs per wallet. It refuses new writes at capacity and keeps earlier IDs for inspection; it never silently discards spend history. Preserve the journal when maintaining or moving your agent.</p>
      <dl className="docs-addresses">{toolGroups.map(([tools, description]) => <div key={tools}><dt className="break-all"><code>{tools}</code></dt><dd>{description}</dd></div>)}</dl>

      <h3 className="pt-4 text-base font-semibold">Keyless HTTP reads</h3>
      <CodeBlock label="Read JIT discovery and registry" code={`curl --fail --show-error ${JSON.stringify(`${origin}/jit`)}\ncurl --fail --show-error ${JSON.stringify(`${origin}/jit/launches?start=0&count=20`)}`} />
      <p>Registry pages use a decimal index cursor. A detail ID is a bytes32 hash derived from the creator address and creator nonce, not the list index: <code className="break-all">GET /jit/launches/{'{launchId}'}</code>. The list returns a block number and an actual total only after a verified read. Unknown or unavailable state is an error, not a fabricated empty registry.</p>
      <p>Metadata URI is optional and bounded to 256 UTF-8 bytes. It may be absent from a bounded event lookup. The site displays its text without fetching an unverified image or treating it as token identity.</p>
      {index.data && <>
        <h3 className="pt-4 text-base font-semibold">Configured mainnet contracts</h3>
        <dl className="docs-addresses">{Object.entries(index.data.contracts).map(([name, address]) => <div key={name}><dt>{name === 'hookDeployer' ? 'Hook deployer' : name === 'poolManager' ? 'PoolManager' : name === 'usdc' ? 'USDC' : name === 'quoter' ? 'Quoter' : 'Factory'}</dt><dd>{address === zeroAddress ? 'Awaiting deployment' : <a className="underline" href={addressExplorerUrl(address)} target="_blank" rel="noreferrer"><code>{address}</code></a>}</dd></div>)}</dl>
      </>}
      <p>Existing <a className="underline" href="#docs/agents">stock x402 launches</a>, curve trading, V2 graduation and board posts retain their separate contracts, fees and trust model. Those relayer payments do not fund or sponsor a JIT launch.</p>
    </div>
  )
}
