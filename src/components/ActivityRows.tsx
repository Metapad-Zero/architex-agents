import { useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import { addressExplorerUrl, txExplorerUrl } from '../chain'
import type { ActivityEntry } from '../hooks/useLaunchpadActivity'
import { agentLabel } from '../lib/agents'
import { formatAmount, shortAddress } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { relativeTime } from '../lib/recent'
import { ExternalLinkIcon } from './Icons'
import { TokenMark } from './TokenMark'

function summarize(entry: ActivityEntry, symbol: string) {
  if (entry.kind === 'launch') return { verb: 'Launched', detail: symbol, className: '' }
  const usdc = entry.kind === 'buy' ? entry.usdcAmount : entry.usdcAmount - entry.fee
  return {
    verb: entry.kind === 'buy' ? 'Bought' : 'Sold',
    detail: `${formatAmount(entry.tokenAmount, 18)} ${symbol} · ${formatAmount(usdc, 6)} USDC`,
    className: entry.kind === 'buy' ? 'trade-buy' : 'trade-sell',
  }
}

export function ActivityRows({ entries, launches, onOpenLaunch }: { entries: ActivityEntry[]; launches: LaunchRecord[]; onOpenLaunch: (token: Address) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const symbols = useMemo(() => {
    const map = new Map(launches.map((launch) => [launch.token.toLowerCase(), launch.symbol]))
    for (const entry of entries) if (entry.kind === 'launch') map.set(entry.token.toLowerCase(), entry.symbol)
    return map
  }, [entries, launches])

  return (
    <ol className="ledger-list">
      {entries.map((entry) => {
        const symbol = symbols.get(entry.token.toLowerCase()) ?? shortAddress(entry.token)
        const { verb, detail, className } = summarize(entry, symbol)
        const label = agentLabel(entry.actor)
        return (
          <li key={`${entry.txHash}:${entry.logIndex}`} className="ledger-row">
            <div className="min-w-0 flex-1">
              <button type="button" className="activity-token" onClick={() => onOpenLaunch(entry.token)}>
                <TokenMark token={{ address: entry.token, symbol }} />
                <span className="min-w-0 truncate"><span className={className}>{verb}</span> {detail}</span>
              </button>
              <div className="activity-byline">
                <a className="underline" href={addressExplorerUrl(entry.actor)} target="_blank" rel="noreferrer">{shortAddress(entry.actor)}</a>
                {label && <span className="actor-label">Known agent</span>}
                <span>{entry.time > 0 ? relativeTime(entry.time * 1000, now) : `Block ${entry.block.toLocaleString()}`}</span>
              </div>
            </div>
            <a className="inline-flex shrink-0 items-center gap-1 font-semibold underline" href={txExplorerUrl(entry.txHash)} target="_blank" rel="noreferrer" aria-label={`View ${verb.toLowerCase()} transaction`}>
              View <ExternalLinkIcon className="h-4 w-4" />
            </a>
          </li>
        )
      })}
    </ol>
  )
}
