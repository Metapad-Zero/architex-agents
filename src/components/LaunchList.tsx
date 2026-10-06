import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { launchFacts, type LaunchRecord } from '../lib/launch'
import { relativeTime } from '../lib/recent'
import { shortAddress } from '../lib/format'
import { useLaunches } from '../hooks/useLaunches'
import { CheckIcon } from './Icons'
import { LaunchMeter, LaunchTokenMark } from './LaunchBits'
import { TableSkeleton } from './Skeleton'

interface LaunchListProps {
  onOpen: (token: Address) => void
}

export function LaunchList({ onOpen }: LaunchListProps) {
  const { launches, total, isConfigured, isLoading, error, metadataError } = useLaunches()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="pools-page">
      <div className="mb-10">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Launches</h1>
        <p className="mt-2 max-w-xl text-sm text-g500">
          Tokens launched through the HTTP gate. When a curve sells out, its reserves seed an Architex pool with the LP tokens sent to a dead address. This page reads the chain; launch and trade from your agent.
        </p>
      </div>

      <section className="ruled-section">
        <div className="section-heading-row">
          <h2>Recent launches</h2>
          <span>{total === undefined || error ? 'Count unavailable' : `${total.toLocaleString()} total`}</span>
        </div>
        {!isConfigured ? <p className="price-history-empty">Mainnet launchpad addresses are not configured in this site yet.</p> : isLoading ? (
          <TableSkeleton rows={5} />
        ) : error && launches.length === 0 ? <p className="read-error" role="alert">Launches could not be read from mainnet. This does not confirm an empty launchpad.</p> : launches.length === 0 ? (
          <div className="empty-state">
            <p>No launches yet.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="launches-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Market cap</th>
                  <th>Sold</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {launches.map((launch) => (
                  <LaunchRow key={launch.token} launch={launch} now={now} onOpen={onOpen} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && launches.length > 0 && <p className="read-error" role="alert">The latest read failed. Showing the last successful launch list.</p>}
        {metadataError && <p className="mt-3 text-xs text-g500">Token names could not be read. Use contract addresses to identify these launches.</p>}
        {total !== undefined && total > BigInt(launches.length) && <p className="mt-3 text-xs text-g500">Showing the latest {launches.length} launches. Page through older launches using GET /x402/launches.</p>}
      </section>
    </div>
  )
}

function LaunchRow({ launch, now, onOpen }: { launch: LaunchRecord; now: number; onOpen: (token: Address) => void }) {
  const facts = launchFacts(launch)
  return (
    <tr className="launch-row">
      <th scope="row">
        <button type="button" className="pool-toggle" onClick={() => onOpen(launch.token)}>
          <LaunchTokenMark token={{ address: launch.token, symbol: launch.symbol }} uri={launch.metadataURI} />
          <span className="min-w-0 text-left">
            <span className="block font-semibold">{launch.symbol}</span>
            <span className="block truncate text-xs font-normal text-g500">{launch.name} · {shortAddress(launch.token)}</span>
          </span>
        </button>
      </th>
      <td data-label="Market cap">{facts.cap}</td>
      <td data-label="Sold">
        {launch.graduated ? (
          <span className="launch-graduated"><CheckIcon className="h-4 w-4" />Graduated</span>
        ) : (
          <LaunchMeter tokensSold={launch.tokensSold} graduated={false} />
        )}
      </td>
      <td data-label="Age">{relativeTime(Number(launch.createdAt) * 1000, now)}</td>
    </tr>
  )
}
