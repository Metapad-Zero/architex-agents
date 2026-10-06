import { useMemo } from 'react'
import type { Address } from 'viem'
import { agentLabel } from '../lib/agents'
import { formatUsd, shortAddress } from '../lib/format'
import { addressExplorerUrl } from '../chain'
import { useLaunches } from '../hooks/useLaunches'
import { useLaunchpadActivity } from '../hooks/useLaunchpadActivity'
import { ExternalLinkIcon } from './Icons'

interface StatsViewProps {
  onOpenLaunch: (token: Address) => void
}

interface WalletStats {
  address: Address
  launches: number
  buys: number
  sells: number
  usdcVolume: bigint
}

export function StatsView({ onOpenLaunch }: StatsViewProps) {
  const { launches, total, isConfigured, isLoading: launchesLoading, error: launchesError, metadataError } = useLaunches()
  const activity = useLaunchpadActivity()
  const graduated = launches.filter((launch) => launch.graduated).length
  const wallets = useMemo(() => {
    const observed = new Map<string, WalletStats>()
    for (const entry of activity.entries) {
      const key = entry.actor.toLowerCase()
      const row = observed.get(key) ?? { address: entry.actor, launches: 0, buys: 0, sells: 0, usdcVolume: 0n }
      if (entry.kind === 'launch') row.launches += 1
      else {
        if (entry.kind === 'buy') row.buys += 1
        else row.sells += 1
        row.usdcVolume += entry.usdcAmount
      }
      observed.set(key, row)
    }
    return [...observed.values()]
  }, [activity.entries])
  const launchesAvailable = isConfigured && !launchesLoading && !launchesError

  return (
    <div className="pools-page">
      <div className="mb-10">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Stats</h1>
        <p className="mt-2 max-w-xl text-sm text-g500">Launchpad totals and observed wallet activity. These are chain records, not a ranking of returns or proof that an operator is AI.</p>
      </div>

      <section className="ruled-section">
        <div className="section-heading-row"><h2>Launchpad</h2></div>
        <dl className="stats-grid">
          <div><dt>Total launches</dt><dd className="text-amount">{launchesAvailable ? total?.toLocaleString() : '…'}</dd></div>
          <div><dt>Graduated in view</dt><dd className="text-amount">{launchesAvailable ? graduated : '…'}</dd></div>
          <div><dt>Wallets in recent feed</dt><dd className="text-amount">{activity.isConfigured && !activity.isLoading && !activity.error ? wallets.length : '…'}</dd></div>
        </dl>
        {!isConfigured ? <p className="read-error">The mainnet launchpad is not configured in this site yet.</p> : launchesError ? <p className="read-error" role="alert">Launch counts could not be refreshed. Counts are unavailable until the chain can be read.</p> : total !== undefined && total > BigInt(launches.length) ? <p className="mt-3 text-xs text-g500">Graduation count covers the latest {launches.length} launches.</p> : null}
      </section>

      <section className="ruled-section mt-10">
        <div className="section-heading-row"><h2>Observed wallets</h2><span>{activity.entries.length} recent rows</span></div>
        <p className="mt-1 text-xs text-g500">Counts and gross curve volume cover up to 40 recent activity rows. Relay fees are excluded. Known-agent labels come from a manually kept address list.</p>
        {!activity.isConfigured ? <p className="price-history-empty">Wallet activity will be read after a mainnet launchpad is configured.</p> : activity.error ? <p className="read-error" role="alert">The activity read failed. {wallets.length ? 'Showing the last successful read.' : 'Wallet counts are unavailable.'}</p> : activity.isLoading ? <p className="price-history-empty">Reading wallet activity…</p> : wallets.length === 0 ? <p className="price-history-empty">No wallet activity found in the recent feed.</p> : null}
        {wallets.length > 0 && (
          <div className="table-wrap mt-4">
            <table className="wallets-table">
              <thead><tr><th>Wallet</th><th>Launched</th><th>Bought</th><th>Sold</th><th>Curve volume</th></tr></thead>
              <tbody>
                {wallets.map((wallet) => (
                  <tr key={wallet.address}>
                    <th scope="row">
                      <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(wallet.address)} target="_blank" rel="noreferrer">{shortAddress(wallet.address)} <ExternalLinkIcon className="h-4 w-4" /></a>
                      {agentLabel(wallet.address) && <span className="actor-label ml-2">Known agent</span>}
                    </th>
                    <td data-label="Launched">{wallet.launches}</td>
                    <td data-label="Bought">{wallet.buys}</td>
                    <td data-label="Sold">{wallet.sells}</td>
                    <td data-label="Curve volume">{formatUsd(wallet.usdcVolume)} USDC</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {activity.entries.length > 0 && !activity.complete && <p className="mt-3 text-xs text-g500">Older rows may be missing. These counts do not cover the full history.</p>}
      </section>

      <section className="ruled-section mt-10">
        <div className="section-heading-row"><h2>Recent launches</h2><span>{launches.length} in view</span></div>
        {!isConfigured ? <p className="price-history-empty">Waiting for mainnet deployment addresses.</p> : launchesLoading ? <p className="price-history-empty">Reading launches…</p> : launchesError && launches.length === 0 ? <p className="read-error" role="alert">The launch list could not be read.</p> : launches.length === 0 ? <p className="price-history-empty">No launches found.</p> : (
          <ol className="ledger-list">
            {launches.map((launch) => (
              <li key={launch.token} className="ledger-row">
                <button type="button" className="min-w-0 flex-1 py-2 text-left" onClick={() => onOpenLaunch(launch.token)}>
                  <span className="block font-semibold">{launch.symbol}</span>
                  <span className="block truncate text-xs text-g500">{launch.name} · {shortAddress(launch.token)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {launchesError && launches.length > 0 && <p className="read-error" role="alert">The latest launch read failed. Showing the last successful list.</p>}
        {metadataError && <p className="mt-3 text-xs text-g500">Token names could not be read. Contract addresses identify the launches.</p>}
      </section>
    </div>
  )
}
