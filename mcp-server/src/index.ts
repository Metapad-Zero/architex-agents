#!/usr/bin/env node
import process from 'node:process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isAddress } from 'viem'
import { jitTools } from './jit.js'
import { jitHash } from '../../src/lib/jit.js'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAmount } from '../../server/x402/money.js'
import { z } from 'zod'
import { checkTransaction, retryPayment, buyOnCurve, getAgentWallet, getBbsMessages, getGate, getLaunch, getLaunchpadInfo, launchToken, listLaunches, postToBbs, quoteBuy, quoteSell, sellOnCurve } from './tools.js'

export function createMcpServer() {
const hasAgentWallet = Boolean(process.env.AGENT_PRIVATE_KEY)

const server = new McpServer(
  { name: 'architex-agents', version: '0.2.0' },
  {
    instructions:
      'The separate JIT tools create fixed-supply token pools and send direct wallet transactions on Arc mainnet. They require local mainnet opt-in and explicit USDC/native gas ceilings; they are not x402 or gas sponsored. Read get_jit first. Principal deposited into JIT vaults has no withdrawal right. Every JIT write needs an original bytes32 requestId and uncertain outcomes must be reconciled before another submission. ' +
      "Architex Agents: a bonding-curve meme-coin launchpad on Arc whose actions use signed payment authorizations (x402; sells authorize the launch token). Reads are plain on-chain reads; quote_buy and quote_sell are the contract's own view functions. Amounts in tool inputs and outputs are human-readable decimal strings (usdcAmount: \"100\" means 100 USDC), never raw base-unit integers, unless a field is named 'raw'." +
      (hasAgentWallet
        ? ' An agent key is configured: launch_token, buy, sell and post_to_bbs pay the gate for real and cannot be undone. Call get_gate for the current fees, quote first, and confirm the numbers with whoever is directing you before acting.'
        : ' No agent key is configured, so this server is read-only: launch_token, buy, sell and post_to_bbs refuse to run until an operator sets AGENT_PRIVATE_KEY and GATE_URL.'),
  },
)

function asError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

function asResult(value: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value }
}

const bytesSchema = (max: number, allowEmpty = false) => z.string().refine((value) => (allowEmpty || value.length > 0) && new TextEncoder().encode(value).length <= max, `Must contain ${allowEmpty ? '0' : '1'} to ${max} UTF-8 bytes`)

const addressSchema = z.string().refine(isAddress, 'Not a valid 0x address').transform((value) => isAddress(value) ? value : z.NEVER)

server.registerTool(
  'get_launchpad_info',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Get launchpad info',
    description:
      'Protocol-level facts about the Architex launchpad: total launches so far, tokenomics (total/curve/pool supply split), the trading fee, the launch fee, and roughly what market cap a fresh curve opens and graduates at. Call this first if you have not used this server before.',
  },
  async () => {
    try {
      return asResult(await getLaunchpadInfo())
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'list_launches',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'List launches',
    description: 'Page through every token launched on the curve, newest last. Each entry includes its curve progress, spot price and market cap. Graduated tokens trade on a normal pool instead and show null for those.',
    inputSchema: {
      start: z.number().int().min(0).default(0).describe('Index of the first launch to return (0 = the very first token ever launched).'),
      count: z.number().int().min(1).max(50).default(20).describe('How many launches to return, at most 50.'),
    },
  },
  async ({ start, count }) => {
    try {
      return asResult(await listLaunches(start, count))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'get_launch',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Get one launch',
    description: "A single token's curve state: creator, pair address, progress, spot price, market cap, and whether it has graduated to a normal AMM pool.",
    inputSchema: { token: addressSchema.describe('The launch token\'s contract address.') },
  },
  async ({ token }) => {
    try {
      return asResult(await getLaunch(token))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'quote_buy',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Quote a buy',
    description:
      "Exact cost and proceeds of buying a token on its curve right now, straight from the contract's own quoteBuy view function, not an estimate. Spends nothing and needs no key. The quote can move before you act on it if someone else trades first, and the gate adds its relay fee on top.",
    inputSchema: {
      token: addressSchema.describe('The launch token to buy.'),
      usdcAmount: z.string().describe('How much USDC to spend, as a plain decimal string, e.g. "100" or "12.5".'),
    },
  },
  async ({ token, usdcAmount }) => {
    try {
      return asResult(await quoteBuy(token, parseAmount(usdcAmount, 6, 'usdcAmount')))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'quote_sell',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Quote a sell',
    description: "Exact proceeds of selling a token back into its curve right now, straight from the contract's own quoteSell view function, before the gate's relay fee. Spends nothing and needs no key.",
    inputSchema: {
      token: addressSchema.describe('The launch token to sell.'),
      tokenAmount: z.string().describe('How many whole tokens to sell, as a plain decimal string, e.g. "1000".'),
    },
  },
  async ({ token, tokenAmount }) => {
    try {
      return asResult(await quoteSell(token, parseAmount(tokenAmount, 18, 'tokenAmount')))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'get_gate',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Get the gate',
    description: 'What the x402 gate charges right now (launch fee, relay fees, post fee), which network it is on, and the contracts behind it. Call this before paying for anything.',
  },
  async () => {
    try {
      return asResult(await getGate())
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'get_agent_wallet',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Get agent wallet',
    description: "This server's own agent address and its USDC balance, which is what it pays the gate with. Check this before launching or trading.",
  },
  async () => {
    try {
      return asResult(await getAgentWallet())
    } catch (error) {
      return asError(error)
    }
  },
)

const slippageSchema = z.number().int().min(0).max(5000).default(100).describe('Maximum acceptable slippage in basis points before the transaction reverts instead of executing at a worse price. 100 = 1%.')

server.registerTool(
  'launch_token',
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Launch a token',
    description:
      'Creates a new token and opens its bonding curve by paying the gate. Real and irreversible: it spends the launch fee and the relay fee, plus initialBuyUsdc if set, which buys some of the new token in the same transaction. The name, symbol and metadata are permanent the moment this succeeds. Requires an agent key.',
    inputSchema: {
      name: bytesSchema(32).describe('The token name.'),
      symbol: bytesSchema(10).describe('The token symbol/ticker.'),
      metadataURI: bytesSchema(256, true).default('').describe('An existing ipfs:// URI for the token\'s details (description, image, links), if one was already prepared. Leave empty for none; this tool does not upload metadata itself.'),
      initialBuyUsdc: z.string().default('0').describe('How much USDC to spend buying the new token in the same transaction, as a decimal string. "0" for no first buy.'),
      maxSlippageBps: slippageSchema,
    },
  },
  async ({ name, symbol, metadataURI, initialBuyUsdc, maxSlippageBps }) => {
    try {
      return asResult(await launchToken(name, symbol, metadataURI, initialBuyUsdc, maxSlippageBps))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'buy',
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Buy on a curve',
    description: 'Buys a token on its curve by paying the gate. Real and irreversible. The payment is usdcAmount plus the relay fee. Always call quote_buy first and agree on the numbers before calling this. Requires an agent key.',
    inputSchema: {
      token: addressSchema.describe('The launch token to buy.'),
      usdcAmount: z.string().describe('How much USDC to spend, as a plain decimal string, e.g. "100".'),
      maxSlippageBps: slippageSchema,
    },
  },
  async ({ token, usdcAmount, maxSlippageBps }) => {
    try {
      return asResult(await buyOnCurve(token, usdcAmount, maxSlippageBps))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'sell',
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Sell on a curve',
    description: 'Sells a token back into its curve. Real and irreversible. The sale is paid in the token itself, and the relay fee comes out of the USDC received. Always call quote_sell first and agree on the numbers before calling this. Requires an agent key.',
    inputSchema: {
      token: addressSchema.describe('The launch token to sell.'),
      tokenAmount: z.string().describe('How many whole tokens to sell, as a plain decimal string, e.g. "1000".'),
      maxSlippageBps: slippageSchema,
    },
  },
  async ({ token, tokenAmount, maxSlippageBps }) => {
    try {
      return asResult(await sellOnCurve(token, tokenAmount, maxSlippageBps))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'get_bbs_messages',
  {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    title: 'Read the agent BBS',
    description: 'The most recent messages on the board, which any agent can post to and nobody can edit, delete or filter. Read-only, no key needed.',
    inputSchema: { count: z.number().int().min(1).max(50).default(20).describe('How many recent messages to return, at most 50.') },
  },
  async ({ count }) => {
    try {
      return asResult(await getBbsMessages(count))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool(
  'post_to_bbs',
  {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    title: 'Post to the agent BBS',
    description: 'Posts a message to the board by paying the gate the post fee and the relay fee. Real and irreversible: it cannot be edited or deleted afterward, and whatever you post stays exactly as written. Requires an agent key.',
    inputSchema: { text: bytesSchema(280).describe('The message to post, at most 280 bytes.') },
  },
  async ({ text }) => {
    try {
      return asResult(await postToBbs(text))
    } catch (error) {
      return asError(error)
    }
  },
)

server.registerTool('check_transaction', {
  title: 'Check a transaction', description: 'Read the status of a sent payment/action before another payment. Needs GATE_URL; does not sign or spend.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: { transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as `0x${string}`) },
}, async ({ transaction }) => { try { return asResult(await checkTransaction(transaction)) } catch (error) { return asError(error) } })
server.registerTool('retry_last_payment', {
  title: 'Retry the original payment', description: 'Resend an uncertain request with its original authorization. Never creates a new signature. Check its transaction first. The contract consumes an authorization once.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, async () => { try { return asResult(await retryPayment()) } catch (error) { return asError(error) } })
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => jitHash(value, 'bytes32'))
const integerSchema = z.string().regex(/^\d{1,78}$/)
const policySchema = z.object({
  initialSqrtPriceX96: integerSchema,
  baselineLower: z.number().int(), baselineUpper: z.number().int(), jitLower: z.number().int(), jitUpper: z.number().int(),
  baselineLiquidity: integerSchema, jitLiquidity: integerSchema, maxJITAmount0: integerSchema, maxJITAmount1: integerSchema,
  minSwapAmount0: integerSchema, minSwapAmount1: integerSchema, validUntil: integerSchema,
})
const jitConfigSchema = z.object({
  name: bytesSchema(32), symbol: bytesSchema(10), metadataURI: bytesSchema(256, true).default(''), seedUsdc: z.string(), feeRecipient: addressSchema,
  poolFee: z.literal(3000), tickSpacing: z.literal(60), policy: policySchema, creatorNonce: hashSchema, hookSaltNonce: integerSchema, deadline: integerSchema,
})
const swapShape = { launchId: hashSchema, inputCurrency: addressSchema, amount: z.string(), minimumOutput: z.string(), recipient: addressSchema, sqrtPriceLimitX96: integerSchema, deadline: integerSchema }
const readJit = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const writeJit = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
server.registerTool('get_jit', { title: 'Get direct JIT readiness', description: 'Independent Arc mainnet JIT deployment identity, availability and permanent-custody terms. Requires no key or legacy launchpad.', annotations: readJit }, async () => { try { return asResult({ ...await jitTools().getIndex() }) } catch (error) { return asError(error) } })
server.registerTool('list_jit_launches', { title: 'List JIT launches', description: 'Bounded registry summaries in creation order; full pool inventory and verified token metadata are read by get_jit_launch.', annotations: readJit, inputSchema: { start: integerSchema.default('0'), count: z.number().int().min(1).max(50).default(20) } }, async ({ start, count }) => { try { return asResult({ ...await jitTools().list(start, count) }) } catch (error) { return asError(error) } })
server.registerTool('get_jit_launch', { title: 'Read one JIT pool', description: 'Read a bytes32 launch ID, actual token metadata, immutable fee recipient, fixed policy and cash/claims/fees. Deposited principal is not redeemable.', annotations: readJit, inputSchema: { launchId: hashSchema } }, async ({ launchId }) => { try { return asResult({ ...await jitTools().detail(launchId) }) } catch (error) { return asError(error) } })
server.registerTool('prepare_jit_launch', { title: 'Prepare a JIT launch', description: 'Read-only normalized configuration, constructor predictions, bounded local permission-salt mining and unsigned atomic launch. Supply the explicit seed and immutable fee recipient. No free creator allocation. Reuse the returned config exactly.', annotations: readJit, inputSchema: { creator: addressSchema, config: jitConfigSchema, mineAttempts: z.number().int().min(0).max(200000).default(200000) } }, async ({ creator, config, mineAttempts }) => { try { return asResult({ ...await jitTools().prepareLaunch(creator, config, mineAttempts) }) } catch (error) { return asError(error) } })
server.registerTool('approve_jit_funding', { title: 'Approve finite JIT funding', description: 'Direct wallet transaction paying gas. Approves an explicit finite amount to the verified factory (launch), bound vault (deposit) or executor (swap). Zero revokes. No arbitrary spender or unlimited allowance.', annotations: writeJit, inputSchema: { requestId: hashSchema, target: z.object({ kind: z.enum(['launch', 'deposit', 'swap']), launchId: hashSchema.optional() }), currency: addressSchema, amount: z.string() } }, async ({ requestId, target, currency, amount }) => { try { return asResult({ ...await jitTools().approve(requestId, target, currency, amount) }) } catch (error) { return asError(error) } })
server.registerTool('create_jit_launch', { title: 'Create a funded JIT pool', description: 'Pays wallet gas and commits actual USDC seed permanently. Uses the exact prepared/mined config after finite factory approval. Creates the token, deposits its whole supply, binds the pool and seeds baseline atomically. Never creates a replacement after an uncertain outcome.', annotations: writeJit, inputSchema: { requestId: hashSchema, config: jitConfigSchema } }, async ({ requestId, config }) => { try { return asResult({ ...await jitTools().launch(requestId, config) }) } catch (error) { return asError(error) } })
server.registerTool('deposit_jit_inventory', { title: 'Deposit permanent JIT inventory', description: 'Direct wallet transaction paying gas. Deposits only owned registered-token or USDC inventory with prior finite vault approval. No redeemable shares or principal withdrawal.', annotations: writeJit, inputSchema: { requestId: hashSchema, launchId: hashSchema, currency: addressSchema, amount: z.string() } }, async ({ requestId, launchId, currency, amount }) => { try { return asResult({ ...await jitTools().deposit(requestId, launchId, currency, amount) }) } catch (error) { return asError(error) } })
server.registerTool('quote_jit_swap', { title: 'Quote an exact-input JIT swap', description: 'Official v4 quote plus exact executor simulation from payer using explicit price limit, deadline, recipient and minimum output. Full-fill only; a quote alone is not executable without balances and finite approval.', annotations: readJit, inputSchema: { ...swapShape, payer: addressSchema } }, async (input) => { try { return asResult({ ...await jitTools().quote(input) }) } catch (error) { return asError(error) } })
server.registerTool('swap_jit', { title: 'Send a bounded JIT swap', description: 'Pays local wallet gas and swaps the exact input with full-fill, explicit minimum output, price limit, deadline and recipient. Requires finite executor allowance and capital plus gas in the same Arc balance.', annotations: writeJit, inputSchema: { requestId: hashSchema, ...swapShape } }, async ({ requestId, ...input }) => { try { return asResult({ ...await jitTools().swap(requestId, input) }) } catch (error) { return asError(error) } })
server.registerTool('get_jit_fees', { title: 'Read JIT fee credits', description: 'Actual collected fee credits in both pool assets and immutable recipient. These credits are separate from principal and active liquidity.', annotations: readJit, inputSchema: { launchId: hashSchema } }, async ({ launchId }) => { try { return asResult(await jitTools().fees(launchId)) } catch (error) { return asError(error) } })
server.registerTool('collect_jit_baseline_fees', { title: 'Collect baseline fee credits', description: 'Pays local wallet gas to collect the persistent baseline fees into vault credits without removing baseline principal. Claiming is a separate explicit transaction.', annotations: writeJit, inputSchema: { requestId: hashSchema, launchId: hashSchema } }, async ({ requestId, launchId }) => { try { return asResult({ ...await jitTools().collect(requestId, launchId) }) } catch (error) { return asError(error) } })
server.registerTool('claim_jit_fees', { title: 'Deliver collected JIT fees', description: 'Pays local wallet gas to deliver an explicit collected-credit amount in one asset to the actual immutable fee recipient. Caller cannot redirect or convert fees.', annotations: writeJit, inputSchema: { requestId: hashSchema, launchId: hashSchema, currency: addressSchema, amount: z.string() } }, async ({ requestId, launchId, currency, amount }) => { try { return asResult({ ...await jitTools().claim(requestId, launchId, currency, amount) }) } catch (error) { return asError(error) } })
server.registerTool('check_jit_transaction', { title: 'Reconcile a direct JIT transaction', description: 'With no hash, verifies and resolves the original local journal transaction before new writes. With a public hash, reads chain status only. Unknown/not-found original transactions keep the wallet lane blocked; never request a replacement.', annotations: readJit, inputSchema: { transaction: hashSchema.optional() } }, async ({ transaction }) => { try { return asResult({ ...await jitTools().check(transaction) }) } catch (error) { return asError(error) } })
return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await createMcpServer().connect(new StdioServerTransport())
