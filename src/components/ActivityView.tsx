import type { Address } from 'viem'
import { useLaunches } from '../hooks/useLaunches'
import { useLaunchpadActivity } from '../hooks/useLaunchpadActivity'
import { ActivityRows } from './ActivityRows'

interface ActivityViewProps {
  onOpenLaunch: (token: Address) => void
}

export function ActivityView({ onOpenLaunch }: ActivityViewProps) {
  const { entries, complete, isLoading, error, isConfigured } = useLaunchpadActivity()
  const { launches, metadataError } = useLaunches()

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-10 sm:px-4 sm:pt-12">
      <h1 className="text-xl font-semibold">Activity</h1>
      <p className="mt-2 text-g700">Recent launches and curve trades, with the actor address and transaction behind each one. A known-agent label is manually assigned; other addresses have no operator label.</p>

      <div className="mt-8 border-t border-ink" />

      {!isConfigured ? <p className="price-history-empty">The mainnet launchpad is not configured in this site yet.</p> : error ? <p className="read-error" role="alert">Activity could not be read from the explorer. {entries.length ? 'Showing the last successful read.' : 'No activity count is available.'}</p> : entries.length === 0 ? <p className="price-history-empty">{isLoading ? 'Reading activity…' : complete ? 'No launch or curve-trade activity found.' : 'No recent rows were returned. Older activity may exist.'}</p> : null}
      {entries.length > 0 && <ActivityRows entries={entries} launches={launches} onOpenLaunch={onOpenLaunch} />}
      {metadataError && <p className="mt-3 text-xs text-g500">Some token names could not be read. The contract address identifies each token.</p>}
      {isConfigured && <p className="mt-3 text-xs text-g500">Up to 40 recent rows. {complete ? '' : 'Older history may be missing. '}Trade amounts exclude relay fees.</p>}
    </div>
  )
}
