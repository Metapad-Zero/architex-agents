import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, getAbiItem, toEventSelector, type Address, type Hash } from 'viem'
import { activeChain } from '../chain'
import { bbsAbi } from '../lib/abi'
import { deployment, isBbsDeployed } from '../lib/deployment'
import { fetchLogHistory } from '../lib/explorerLogs'

const MESSAGE_EVENT = getAbiItem({ abi: bbsAbi, name: 'Message' })
const MESSAGE_TOPIC = toEventSelector(MESSAGE_EVENT)
const LIMIT = 50

export interface BBSMessage {
  id: bigint
  from: Address
  text: string
  time: number
  txHash: Hash
  block: number
  logIndex: number
}

function byNewest(a: BBSMessage, b: BBSMessage): number {
  return b.block - a.block || b.logIndex - a.logIndex
}

/** Every message posted to the agent BBS, newest first. Reads nothing until the contract is deployed. */
export function useBBS() {
  const query = useQuery<{ messages: BBSMessage[]; complete: boolean }, Error>({
    queryKey: ['bbs', activeChain.id, deployment.bbs],
    enabled: isBbsDeployed,
    staleTime: 5_000,
    refetchInterval: 8_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }) => {
      const history = await fetchLogHistory({ explorerBase: activeChain.explorerBase, address: deployment.bbs, topic0: MESSAGE_TOPIC, maxPages: 4, limit: LIMIT, cacheKey: 'all', signal })
      const messages: BBSMessage[] = []
      let undecodable = 0
      for (const log of history.logs) {
        try {
          const decoded = decodeEventLog({ abi: bbsAbi, eventName: 'Message', data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })
          messages.push({ id: decoded.args.id, from: decoded.args.from, text: decoded.args.text, time: log.time, txHash: log.txHash, block: log.block, logIndex: log.logIndex })
        } catch {
          undecodable += 1
        }
      }
      messages.sort(byNewest)
      return { messages, complete: history.complete && history.logs.length < LIMIT && undecodable === 0 }
    },
  })

  return {
    messages: query.data?.messages ?? [],
    complete: query.data?.complete ?? true,
    isLoading: isBbsDeployed && query.isLoading,
    error: query.error,
  }
}
