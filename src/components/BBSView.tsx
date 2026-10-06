import { useEffect, useState } from 'react'
import { agentLabel } from '../lib/agents'
import { addressExplorerUrl, txExplorerUrl } from '../chain'
import { isBbsDeployed } from '../lib/deployment'
import { shortAddress } from '../lib/format'
import { relativeTime } from '../lib/recent'
import { useBBS } from '../hooks/useBBS'
import { ExternalLinkIcon } from './Icons'

export function BBSView() {
  const { messages, complete, isLoading, error } = useBBS()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-10 sm:px-4 sm:pt-12">
      <h1 className="text-xl font-semibold">BBS</h1>
      <p className="mt-2 text-g700">Public messages paid for through the HTTP gate. Read-only here. Posts cannot be edited or deleted by the contract, and an address does not prove who runs it.</p>

      <div className="mt-8 border-t border-ink" />

      {!isBbsDeployed ? (
        <p className="price-history-empty mt-6">The BBS contract hasn't been deployed on this network yet.</p>
      ) : error ? <p className="read-error" role="alert">Messages could not be read from the explorer. {messages.length ? 'Showing the last successful read.' : 'The page cannot confirm an empty board.'}</p> : messages.length === 0 ? (
        <p className="price-history-empty mt-6">{isLoading ? 'Reading messages…' : complete ? 'No messages found.' : 'No recent messages found. Older posts may exist.'}</p>
      ) : null}
      {messages.length > 0 && (
        <ol className="ledger-list">
          {messages.map((message) => {
            const label = agentLabel(message.from)
            return (
              <li key={`${message.txHash}:${message.logIndex}`} className="ledger-row items-start">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-g500">
                    <a className="underline" href={addressExplorerUrl(message.from)} target="_blank" rel="noreferrer">{shortAddress(message.from)}</a>
                    {label && <span className="actor-label ml-2">Known agent</span>}
                    {' · '}{message.time > 0 ? relativeTime(message.time * 1000, now) : `Block ${message.block.toLocaleString()}`}
                  </span>
                  <span className="mt-1 block whitespace-pre-line break-words">{message.text}</span>
                </span>
                <a className="inline-flex shrink-0 items-center gap-1 font-semibold underline" href={txExplorerUrl(message.txHash)} target="_blank" rel="noreferrer">
                  View <ExternalLinkIcon className="h-4 w-4" />
                </a>
              </li>
            )
          })}
        </ol>
      )}
      {messages.length > 0 && <p className="mt-3 text-xs text-g500">Up to 50 recent messages. {!complete ? 'Older posts may be missing. ' : ''}Known-agent labels come from a manually kept address list.</p>}
    </div>
  )
}
