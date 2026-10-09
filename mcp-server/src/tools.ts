import process from 'node:process'
import { decodeEventLog, formatUnits, getAbiItem } from 'viem'
import { requireAgentWallet } from './agentWallet.js'
import { gateInfo, getTransactionStatus, payGate, retryLastPayment } from './gate.js'
import { chainContext, verifiedChainContext } from './chain.js'
import { bbsAbi, erc20Abi, launchpadAbi } from '../../src/lib/abi.js'
import { marketCap, progressBps, spotPrice, type CurveState } from '../../src/lib/curve.js'
import { readLogWindows } from '../../src/lib/rpcLogs.js'

const USDC_DECIMALS = 6
const TOKEN_DECIMALS = 18

async function deployment() {
  const context = await verifiedChainContext()
  if (!context.launchpadAddress) throw new Error('The agents launchpad is not deployed yet.')
  return { ...context, launchpadAddress: context.launchpadAddress }
}

function usd(raw: bigint): string {
  return `$${Number(formatUnits(raw, USDC_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function tokens(raw: bigint): string {
  return Number(formatUnits(raw, TOKEN_DECIMALS)).toLocaleString('en-US', { maximumFractionDigits: 4 })
}

interface OnchainCurve {
  token: `0x${string}`
  creator: `0x${string}`
  pair: `0x${string}`
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint
  graduated: boolean
  metadataURI: string
}

function describe(curve: OnchainCurve) {
  const { explorerBase } = chainContext()
  const state: CurveState = { virtualUsdc: curve.virtualUsdc, virtualTokens: curve.virtualTokens, tokensSold: curve.tokensSold }
  return {
    token: curve.token,
    creator: curve.creator,
    pair: curve.pair,
    graduated: curve.graduated,
    createdAt: new Date(Number(curve.createdAt) * 1000).toISOString(),
    metadataURI: curve.metadataURI || null,
    tokensSold: { raw: curve.tokensSold.toString(), formatted: tokens(curve.tokensSold) },
    // spotPrice() returns USDC (6dp) per whole token scaled by 1e18 on top of that 6dp — 1e24 total.
    spotPriceUsdcPerToken: curve.graduated ? null : formatUnits(spotPrice(state), 24),
    marketCap: curve.graduated ? null : { raw: marketCap(state).toString(), formatted: usd(marketCap(state)) },
    progressPercent: curve.graduated ? 100 : Number(progressBps(state)) / 100,
    explorerUrl: `${explorerBase}/address/${curve.token}`,
  }
}

export async function getLaunchpadInfo() {
  const { publicClient, launchpadAddress, isTestnet } = await deployment()
  const [totalSupply, curveSupply, poolSupply, virtualUsdc0, virtualTokens0, feeBps, launchFee, tokensLength] = await Promise.all([
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'TOTAL_SUPPLY' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'CURVE_SUPPLY' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'POOL_SUPPLY' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'VIRTUAL_USDC_0' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'VIRTUAL_TOKENS_0' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'FEE_BPS' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'launchFee' }),
    publicClient.readContract({ address: launchpadAddress, abi: launchpadAbi, functionName: 'tokensLength' }),
  ])
  const openingMarketCap = marketCap({ virtualUsdc: virtualUsdc0, virtualTokens: virtualTokens0, tokensSold: 0n })
  // k = virtualUsdc * virtualTokens is invariant across trades, so the ending virtualUsdc at
  // full sell-out is exactly k / (virtualTokens0 - curveSupply), regardless of the trading path.
  const finalVirtualTokens = virtualTokens0 - curveSupply
  const finalVirtualUsdc = (virtualUsdc0 * virtualTokens0) / finalVirtualTokens
  const graduationMarketCap = marketCap({ virtualUsdc: finalVirtualUsdc, virtualTokens: finalVirtualTokens, tokensSold: curveSupply })
  return {
    network: isTestnet ? 'Arc Testnet' : 'Arc',
    launchpadAddress,
    totalLaunches: Number(tokensLength),
    tokenomics: {
      totalSupply: tokens(totalSupply),
      curveSupply: tokens(curveSupply),
      poolSupplyAtGraduation: tokens(poolSupply),
    },
    feeBps: Number(feeBps),
    feePercent: Number(feeBps) / 100,
    launchFee: { raw: launchFee.toString(), formatted: usd(launchFee) },
    approxOpeningMarketCap: usd(openingMarketCap),
    approxGraduationMarketCap: usd(graduationMarketCap),
    notes: [
      'Curve fees accrue in pendingFees and anyone can send them on with collectFees(). They never deepen the curve itself.',
      'After graduation the token trades on a normal Architex AMM pair (0.30% swap fee, stays in reserves); the LP is burned, so nobody can ever withdraw that liquidity.',
      'Contracts are not third-party audited. Launches are not reviewed before going live.',
    ],
  }
}

export async function listLaunches(start: number, count: number) {
  const { publicClient, launchpadAddress } = await deployment()
  const curves = (await publicClient.readContract({
    address: launchpadAddress,
    abi: launchpadAbi,
    functionName: 'curvesPage',
    args: [BigInt(start), BigInt(count)],
  }))
  return { start, count: curves.length, launches: curves.map(describe) }
}

export async function getLaunch(token: `0x${string}`) {
  const { publicClient, launchpadAddress, isTestnet } = await deployment()
  const curve = (await publicClient.readContract({
    address: launchpadAddress,
    abi: launchpadAbi,
    functionName: 'curves',
    args: [token],
  }))
  if (curve.createdAt === 0n) throw new Error(`No launch found for ${token} on ${isTestnet ? 'Arc Testnet' : 'Arc'}.`)
  return describe(curve)
}

export async function quoteBuy(token: `0x${string}`, usdcIn: bigint) {
  const { publicClient, launchpadAddress } = await deployment()
  const [tokensOut, fee, usdcSpent, graduates] = (await publicClient.readContract({
    address: launchpadAddress,
    abi: launchpadAbi,
    functionName: 'quoteBuy',
    args: [token, usdcIn],
  }))
  return {
    tokensOut: { raw: tokensOut.toString(), formatted: tokens(tokensOut) },
    fee: { raw: fee.toString(), formatted: usd(fee) },
    usdcSpent: { raw: usdcSpent.toString(), formatted: usd(usdcSpent) },
    graduatesCurve: graduates,
  }
}

export async function quoteSell(token: `0x${string}`, tokensIn: bigint) {
  const { publicClient, launchpadAddress } = await deployment()
  const [usdcOut, fee] = (await publicClient.readContract({
    address: launchpadAddress,
    abi: launchpadAbi,
    functionName: 'quoteSell',
    args: [token, tokensIn],
  }))
  return {
    usdcOut: { raw: usdcOut.toString(), formatted: usd(usdcOut) },
    fee: { raw: fee.toString(), formatted: usd(fee) },
  }
}

export async function getAgentWallet() {
  const { account } = requireAgentWallet()
  const { publicClient, usdcAddress, explorerBase, isTestnet } = await verifiedChainContext(process.env, { deploymentRequired: false })
  const [balance, gasBalance] = await Promise.all([publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), publicClient.getBalance({ address: account.address })])
  return {
    address: account.address,
    network: isTestnet ? 'Arc Testnet' : 'Arc',
    usdcBalance: { raw: balance.toString(), formatted: usd(balance) },
    nativeGasBalance: { raw: gasBalance.toString(), formatted: formatUnits(gasBalance, 18) },
    note: 'Legacy x402 actions sign payments while a relayer pays gas. Direct JIT tools send wallet transactions and pay gas. Arc ERC20 USDC (6 decimals) and native gas USDC (18 decimals) share the same underlying value; these balances cannot be added.',
    explorerUrl: `${explorerBase}/address/${account.address}`,
  }
}

/** What this server will be charged, and where, as the gate itself reports it. */
export async function getGate() {
  const gate = await gateInfo()
  return { network: gate.network, chainId: gate.chainId, testnet: gate.testnet, contracts: gate.contracts, fees: gate.fees, readiness: gate.readiness }
}

export async function launchToken(name: string, symbol: string, metadataURI: string, initialBuyUsdc: string, maxSlippageBps: number) {
  const { explorerBase } = await deployment()
  const answer = await payGate('/x402/launch', { name, symbol, metadataURI, initialBuyUsdc, slippageBps: maxSlippageBps })
  return { ...answer.result, txHash: answer.transaction, explorerUrl: `${explorerBase}/address/${String(answer.result.token)}` }
}

export async function buyOnCurve(token: `0x${string}`, usdcAmount: string, maxSlippageBps: number) {
  const answer = await payGate('/x402/buy', { token, usdc: usdcAmount, slippageBps: maxSlippageBps })
  return { ...answer.result, txHash: answer.transaction, explorerUrl: answer.explorer }
}

export async function sellOnCurve(token: `0x${string}`, tokenAmount: string, maxSlippageBps: number) {
  // A sale is paid in the token itself: the agent signs the same kind of authorization, on that token.
  const answer = await payGate('/x402/sell', { token, tokens: tokenAmount, slippageBps: maxSlippageBps }, token)
  return { ...answer.result, txHash: answer.transaction, explorerUrl: answer.explorer }
}

function requireBbs() {
  const { bbsAddress, isTestnet } = chainContext()
  if (!bbsAddress) throw new Error(`No BBS deployed on ${isTestnet ? 'Arc Testnet' : 'Arc'} yet.`)
  return bbsAddress
}

// Arc's public RPC refuses eth_getLogs over a large block range, so history is read backward in
// bounded windows (readLogWindows, the same helper the frontend's RPC fallback uses) rather than
// one fromBlock:0 call — that one-call approach is exactly what failed the first time this shipped.
const BBS_WINDOWS = 20

export async function getBbsMessages(count: number) {
  const { publicClient } = await verifiedChainContext()
  const bbs = requireBbs()
  const messageEvent = getAbiItem({ abi: bbsAbi, name: 'Message' })
  const total = await publicClient.readContract({ address: bbs, abi: bbsAbi, functionName: 'messageCount' })
  const head = await publicClient.getBlockNumber()
  const { logs, complete } = await readLogWindows({
    head,
    windows: BBS_WINDOWS,
    read: (fromBlock, toBlock) => publicClient.getLogs({ address: bbs, event: messageEvent, fromBlock, toBlock }),
  })
  const messages = logs
    .sort((a, b) => Number(b.blockNumber - a.blockNumber) || b.logIndex - a.logIndex)
    .slice(0, count)
    .map((log) => {
      const decoded = decodeEventLog({ abi: bbsAbi, eventName: 'Message', data: log.data, topics: log.topics })
      return { id: decoded.args.id.toString(), from: decoded.args.from, time: new Date(Number(decoded.args.time) * 1000).toISOString(), text: decoded.args.text, txHash: log.transactionHash }
    })
  return { totalMessages: Number(total), messagesReturned: messages.length, completeHistory: complete, messages }
}

export async function postToBbs(text: string) {
  const answer = await payGate('/x402/post', { text })
  return { ...answer.result, txHash: answer.transaction, explorerUrl: answer.explorer }
}

export async function checkTransaction(transaction: `0x${string}`) { return getTransactionStatus(transaction) }
export async function retryPayment() { return { ...await retryLastPayment() } }
