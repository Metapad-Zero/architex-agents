/** Real mainnet acceptance runner. Its environment must be populated only after signer and total spend approval. */
import { erc20Abi, formatUnits, isAddress, type Address } from 'viem'
import { createGateClient, gateOrigin } from '../mcp-server/src/gate.js'
import { chainContext } from '../mcp-server/src/chain.js'
import { requireAgentWallet } from '../mcp-server/src/agentWallet.js'
import { parseAmount } from '../server/x402/money.js'

if (process.env.E2E_MAINNET_APPROVED !== '1' || process.env.ARC_NETWORK !== 'mainnet' || process.env.AGENT_ALLOW_MAINNET !== '1') throw new Error('This mainnet runner requires E2E_MAINNET_APPROVED=1, ARC_NETWORK=mainnet and AGENT_ALLOW_MAINNET=1 after explicit signer/spend approval.')
if (!process.env.E2E_MAX_SPEND_USDC) throw new Error('E2E_MAX_SPEND_USDC must be the approved total USDC ceiling.')
if (!process.env.AGENT_MAX_PAYMENT_USDC) throw new Error('AGENT_MAX_PAYMENT_USDC must be an explicit per-payment ceiling.')
const budget = parseAmount(process.env.E2E_MAX_SPEND_USDC, 6, 'E2E_MAX_SPEND_USDC')
const client = createGateClient()
const index = await client.info(true)
if (index.chainId !== 5042 || index.testnet || index.network !== 'eip155:5042') throw new Error('This runner targets Arc mainnet, chain 5042.')
const readiness = index.readiness as { relay?: { ready?: boolean } } | undefined
if (readiness?.relay?.ready !== true) throw new Error('The mainnet relayer does not report ready.')
const fee = (name: string) => {
  const value = index.fees[name]
  if (!value || typeof value !== 'object' || !/^\d+$/.test(value.raw)) throw new Error(`The gate fee ${name} is malformed.`)
  return BigInt(value.raw)
}
const launchCost = fee('launchFee') + fee('launchRelayFee') + 500_000n
const buyCost = 1_000_000n + fee('tradeRelayFee')
const postCost = fee('postFee') + fee('postRelayFee')
const planned = launchCost + buyCost + 50_000n + postCost
if (planned > budget) throw new Error('The full launch/buy/sell/post sequence exceeds the approved total USDC ceiling.')
const { account } = requireAgentWallet()
const { publicClient, usdcAddress } = chainContext()
if (await publicClient.getChainId() !== 5042) throw new Error('ARC_RPC_URL does not serve Arc mainnet.')
const holds = (asset: Address) => publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
const started = await holds(usdcAddress)
if (started < planned) throw new Error('The authorized agent account does not have enough USDC for this sequence.')
console.info('Mainnet acceptance sequence', { network: index.network, agent: account.address, launchpad: index.contracts.launchpad, bbs: index.contracts.bbs, approvedCeilingUsdc: formatUnits(budget, 6), plannedGrossUsdc: formatUnits(planned, 6) })

let reserved = 0n
const originalCap = process.env.AGENT_MAX_PAYMENT_USDC
async function action(path: string, body: Record<string, unknown>, sellingToken?: Address) {
  const current = await client.info(true)
  const currentFee = (name: string) => BigInt((current.fees[name] as { raw: string }).raw)
  const cost = sellingToken ? 50_000n : path === '/x402/launch' ? currentFee('launchFee') + currentFee('launchRelayFee') + 500_000n : path === '/x402/buy' ? 1_000_000n + currentFee('tradeRelayFee') : currentFee('postFee') + currentFee('postRelayFee')
  if (reserved + cost > budget || (!sellingToken && cost > parseAmount(originalCap, 6, 'AGENT_MAX_PAYMENT_USDC'))) throw new Error('This next signature would exceed the approved total or per-payment ceiling.')
  reserved += cost
  // The SDK cap also constrains a fee change between these reads and signing; no retrospective budget check is relied on.
  process.env.AGENT_MAX_PAYMENT_USDC = formatUnits(cost, 6)
  let answer
  try { answer = await client.pay(path, body, sellingToken) } finally { process.env.AGENT_MAX_PAYMENT_USDC = originalCap }
  const receipt = await publicClient.getTransactionReceipt({ hash: answer.transaction })
  if (receipt.status !== 'success') throw new Error('The public mainnet RPC did not confirm this action. Stop before another payment.')
  console.info(path, { transaction: answer.transaction, result: answer.result })
  return answer
}
const origin = gateOrigin()
const read = async (path: string): Promise<Record<string, unknown>> => {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!response.ok) throw new Error(`Read ${path} failed with ${response.status}.`)
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('The gate returned malformed read data.')
  return value as Record<string, unknown>
}
const stamp = Date.now().toString(36).slice(-5).toUpperCase()
const launched = await action('/x402/launch', { name: `Mainnet check ${stamp}`, symbol: `MC${stamp}`, initialBuyUsdc: '0.5' })
const token = launched.result.token
if (typeof token !== 'string' || !isAddress(token) || launched.payer.toLowerCase() !== account.address.toLowerCase()) throw new Error('The launch result did not credit the authorized agent.')
const curve = await read(`/x402/launch/${token}`)
if (typeof curve.creator !== 'string' || curve.creator.toLowerCase() !== account.address.toLowerCase()) throw new Error('The curve creator does not match the agent.')
await action('/x402/buy', { token, usdc: '1' })
const held = await holds(token)
if (held === 0n) throw new Error('The agent received no launch tokens.')
await action('/x402/sell', { token, tokens: formatUnits(held, 18) }, token)
if (await holds(token) !== 0n) throw new Error('The agent still holds tokens after the sale.')
const posted = await action('/x402/post', { text: `Mainnet acceptance check ${stamp}: launched, bought, sold and posted through x402.` })
const board = await read('/x402/bbs?count=5')
if (!Array.isArray(board.messages)) throw new Error('The board returned malformed history.')
const messages: unknown[] = board.messages
const message = messages.find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'id' in entry && entry.id === posted.result.id)
if (typeof message?.from !== 'string' || message.from.toLowerCase() !== account.address.toLowerCase()) throw new Error('The board did not credit the agent.')
const spent = started - await holds(usdcAddress)
if (spent > budget) throw new Error('Observed balance change exceeded the approved ceiling. Stop and inspect the receipts.')
console.info('Mainnet sequence confirmed; Firepan release review is still required.', { netSpentUsdc: formatUnits(spent, 6) })
