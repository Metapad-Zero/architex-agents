import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, parseAbiItem, toEventSelector, type Address, type Hash } from 'viem'
import { activeChain } from '../chain'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { fetchLogHistory } from '../lib/explorerLogs'

const TOKEN_CREATED_EVENT = parseAbiItem(
  'event TokenCreated(address indexed token, address indexed creator, address indexed pair, string name, string symbol, string metadataURI)',
)
const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 fee, uint256 virtualUsdc, uint256 virtualTokens)',
)
const TOKEN_CREATED_TOPIC = toEventSelector(TOKEN_CREATED_EVENT)
const TRADE_TOPIC = toEventSelector(TRADE_EVENT)

export type ActivityEntry =
  | { kind: 'launch'; token: Address; actor: Address; name: string; symbol: string; time: number; txHash: Hash; block: number; logIndex: number }
  | { kind: 'buy' | 'sell'; token: Address; actor: Address; usdcAmount: bigint; tokenAmount: bigint; fee: bigint; time: number; txHash: Hash; block: number; logIndex: number }

const LIMIT = 40

function byNewest(a: ActivityEntry, b: ActivityEntry): number {
  return b.block - a.block || b.logIndex - a.logIndex
}

/** Bounded recent launches and trades across the launchpad, newest first. */
export function useLaunchpadActivity() {
  const query = useQuery<{ entries: ActivityEntry[]; complete: boolean }, Error>({
    queryKey: ['launchpadActivity', activeChain.id, deployment.launchpad],
    enabled: isLaunchpadDeployed,
    staleTime: 6_000,
    refetchInterval: 10_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const [launches, trades] = await Promise.all([
        fetchLogHistory({ explorerBase: activeChain.explorerBase, address: deployment.launchpad, topic0: TOKEN_CREATED_TOPIC, maxPages: 3, limit: LIMIT, cacheKey: 'all', signal }),
        fetchLogHistory({ explorerBase: activeChain.explorerBase, address: deployment.launchpad, topic0: TRADE_TOPIC, maxPages: 6, limit: LIMIT, cacheKey: 'all', signal }),
      ])

      const entries: ActivityEntry[] = []
      let undecodable = 0
      for (const log of launches.logs) {
        try {
          const decoded = decodeEventLog({ abi: [TOKEN_CREATED_EVENT], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
          entries.push({ kind: 'launch', token: decoded.args.token, actor: decoded.args.creator, name: decoded.args.name, symbol: decoded.args.symbol, time: log.time, txHash: log.txHash, block: log.block, logIndex: log.logIndex })
        } catch {
          undecodable += 1
        }
      }
      for (const log of trades.logs) {
        try {
          const decoded = decodeEventLog({ abi: [TRADE_EVENT], data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
          entries.push({
            kind: decoded.args.isBuy ? 'buy' : 'sell',
            token: decoded.args.token,
            actor: decoded.args.trader,
            usdcAmount: decoded.args.usdcAmount,
            tokenAmount: decoded.args.tokenAmount,
            fee: decoded.args.fee,
            time: log.time,
            txHash: log.txHash,
            block: log.block,
            logIndex: log.logIndex,
          })
        } catch {
          undecodable += 1
        }
      }
      entries.sort(byNewest)
      return { entries: entries.slice(0, LIMIT), complete: launches.complete && trades.complete && launches.logs.length < LIMIT && trades.logs.length < LIMIT && entries.length <= LIMIT && undecodable === 0 }
    },
  })

  return {
    entries: query.data?.entries ?? [],
    isConfigured: isLaunchpadDeployed,
    complete: query.data?.complete ?? true,
    isLoading: isLaunchpadDeployed && query.isLoading,
    error: query.error,
  }
}
