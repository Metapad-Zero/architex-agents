import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatUnits, zeroAddress, type Address, type Hex } from 'viem'
import { addressExplorerUrl } from '../chain'
import { fetchJitIndex, fetchJitLaunch, fetchJitLaunches, type JitIndex, type JitInventory, type JitLaunchView } from '../lib/jit'
import { GhostButton } from './GhostButton'
import { TableSkeleton } from './Skeleton'

const refreshOptions = { staleTime: 15_000, refetchInterval: 30_000, retry: false } as const
const maxExpiry = '18446744073709551615'

function AddressLink({ address }: { address: Address }) {
  return <a className="break-all font-mono text-xs underline sm:text-sm" href={addressExplorerUrl(address)} target="_blank" rel="noreferrer">{address}</a>
}

function Fields({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="docs-addresses">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function createdTime(value: string): string {
  const date = new Date(Number(value) * 1_000)
  return Number.isNaN(date.getTime()) ? `${value} Unix seconds` : date.toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' })
}

function currencyName(currency: Address, launch: JitLaunchView, index: JitIndex): string {
  return currency.toLowerCase() === index.contracts.usdc.toLowerCase() ? 'USDC' : launch.symbol
}

function currencyAmount(raw: string, currency: Address, launch: JitLaunchView, index: JitIndex): string {
  const decimals = currency.toLowerCase() === index.contracts.usdc.toLowerCase() ? 6 : 18
  return `${formatUnits(BigInt(raw), decimals)} ${currencyName(currency, launch, index)}`
}

function Inventory({ inventory, launch, index }: { inventory: JitInventory; launch: JitLaunchView; index: JitIndex }) {
  const symbol = currencyName(inventory.currency, launch, index)
  const collected = formatUnits(BigInt(inventory.feeCredits.raw) + BigInt(inventory.feesClaimed.raw), inventory.decimals)
  return (
    <div className="min-w-0">
      <h3 className="mb-3 text-base font-semibold">{symbol} · {inventory.decimals} decimals</h3>
      <Fields rows={[
        ['Currency', <AddressLink address={inventory.currency} />],
        ['Vault cash', `${inventory.cash.formatted} ${symbol}`],
        ['PoolManager claims', `${inventory.claims.formatted} ${symbol}`],
        ['Available inventory, excluding fee credits', `${inventory.available.formatted} ${symbol}`],
        ['Principal deposited, cumulative', `${inventory.principalDeposited.formatted} ${symbol}`],
        ['Collected LP fees, cumulative', `${collected} ${symbol}`],
        ['Fee credits awaiting claim', `${inventory.feeCredits.formatted} ${symbol}`],
        ['Fees already claimed', `${inventory.feesClaimed.formatted} ${symbol}`],
      ]} />
    </div>
  )
}

function LaunchDetail({ launch, index }: { launch: JitLaunchView; index: JitIndex }) {
  return (
    <>
      <section className="ruled-section mt-8" aria-labelledby="jit-capital">
        <div className="section-heading-row"><h2 id="jit-capital">Token and committed capital</h2></div>
        <p className="mb-5 max-w-2xl text-sm leading-6 text-g700">The full initial token supply and seed USDC entered this pool's vault. No free creator allocation, later mint, principal withdrawal or upgrade path exists. Idle inventory is also committed; trades can reduce its value.</p>
        <div className="grid min-w-0 gap-6 sm:grid-cols-2">
          <Fields rows={[
            ['Initial fixed supply', `${launch.tokenSupply.formatted} ${launch.symbol}`],
            ['Seed capital at creation', `${launch.seedUsdc.formatted} USDC`],
            ['Creator', <AddressLink address={launch.creator} />],
            ['Created', createdTime(launch.createdAt)],
          ]} />
          <Fields rows={[
            ['Token', <AddressLink address={launch.token} />],
            ['Vault', <AddressLink address={launch.vault} />],
            ['Immutable fee recipient', <AddressLink address={launch.feeRecipient} />],
            ['Metadata URI', launch.metadataURI ? <code>{launch.metadataURI}</code> : 'Not available in this bounded registry read.'],
          ]} />
        </div>
      </section>

      <section className="ruled-section mt-10" aria-labelledby="jit-pool">
        <div className="section-heading-row"><h2 id="jit-pool">Pool and fixed ranges</h2></div>
        <p className="mb-5 max-w-2xl text-sm leading-6 text-g700">The wide baseline remains seeded. For an eligible swap, the hook adds the narrow position before the swap and removes it after. Price, swap thresholds and available inventory determine eligibility. These bounds do not recenter; outside the narrow range, trading uses the baseline.</p>
        <div className="grid min-w-0 gap-6 sm:grid-cols-2">
          <Fields rows={[
            ['Pool ID', <code>{launch.poolId}</code>],
            ['Currency 0', <AddressLink address={launch.currency0} />],
            ['Currency 1', <AddressLink address={launch.currency1} />],
            ['Pool fee / tick spacing', '0.30% / 60'],
            ['Baseline seeded', launch.baselineSeeded ? 'Yes' : 'No'],
            ['Price inside JIT range at this read', launch.jitInRange ? 'Yes; other eligibility checks still apply.' : 'No'],
            ['Current sqrt price, Q96 raw', <code>{launch.currentSqrtPriceX96}</code>],
          ]} />
          <Fields rows={[
            ['Baseline ticks, lower / upper', `${launch.policy.baselineLower} / ${launch.policy.baselineUpper}`],
            ['JIT ticks, lower / upper', `${launch.policy.jitLower} / ${launch.policy.jitUpper}`],
            ['Baseline liquidity, raw units', <code>{launch.policy.baselineLiquidity}</code>],
            ['JIT liquidity, raw units', <code>{launch.policy.jitLiquidity}</code>],
            ['JIT inventory cap, currency 0', currencyAmount(launch.policy.maxJITAmount0, launch.currency0, launch, index)],
            ['JIT inventory cap, currency 1', currencyAmount(launch.policy.maxJITAmount1, launch.currency1, launch, index)],
            ['Minimum eligible swap, currency 0', currencyAmount(launch.policy.minSwapAmount0, launch.currency0, launch, index)],
            ['Minimum eligible swap, currency 1', currencyAmount(launch.policy.minSwapAmount1, launch.currency1, launch, index)],
            ['Policy expiry', launch.policy.validUntil === maxExpiry ? `No finite expiry (uint64 max: ${maxExpiry})` : `${launch.policy.validUntil} Unix seconds`],
          ]} />
        </div>
      </section>

      <section className="ruled-section mt-10" aria-labelledby="jit-inventory">
        <div className="section-heading-row flex-wrap py-2"><h2 id="jit-inventory">Inventory and collected LP fees</h2><span>Block {launch.blockNumber}</span></div>
        <p className="mb-5 max-w-2xl text-sm leading-6 text-g700">All collected baseline and JIT LP fees belong to the immutable fee recipient, in both assets as earned. Collected fees include credits awaiting claim and fees already claimed. They are not trade volume or net profit. PoolManager claims represent custody of the same currencies, not an extra asset.</p>
        <div className="grid min-w-0 gap-8 sm:grid-cols-2">{launch.inventory.map((inventory) => <Inventory key={inventory.currency} inventory={inventory} launch={launch} index={index} />)}</div>
        <p className="mt-4 text-xs leading-5 text-g500">These balances are a point-in-time read. Available inventory excludes credited fees and capital currently held in the baseline position. Cumulative deposits do not measure the current value of principal.</p>
      </section>

      <section className="ruled-section mt-10" aria-labelledby="jit-identity">
        <div className="section-heading-row"><h2 id="jit-identity">Deployment identity</h2></div>
        <Fields rows={[
          ['Launch ID', <code>{launch.launchId}</code>],
          ['Configuration hash', <code>{launch.configHash}</code>],
          ['Hook', <AddressLink address={launch.hook} />],
          ['Executor', <AddressLink address={launch.executor} />],
          ['PoolManager', <AddressLink address={index.contracts.poolManager} />],
          ['Factory', <AddressLink address={index.contracts.factory} />],
        ]} />
        <p className="mt-4 text-sm leading-6 text-g700">The hook is part of this pool's immutable identity. External LP additions are rejected. This registry does not promise discovery or routing in Uniswap's interface. Use the agent's locally signed executor path described in <a className="underline" href="#docs/jit">JIT documentation</a>.</p>
      </section>
    </>
  )
}

export function JITView({ launchId, onOpen }: { launchId?: Hex; onOpen: (launchId?: Hex) => void }) {
  const origin = window.location.origin
  const [cursors, setCursors] = useState(['0'])
  const start = cursors[cursors.length - 1]
  const index = useQuery({ queryKey: ['jit', 'index', origin], queryFn: ({ signal }) => fetchJitIndex({ origin, signal }), ...refreshOptions })
  const readable = Boolean(index.data?.readiness.ready && !index.error)
  const page = useQuery({ queryKey: ['jit', 'launches', origin, start], queryFn: ({ signal }) => fetchJitLaunches(start, 20, { origin, signal }), enabled: readable && !launchId, ...refreshOptions })
  const detail = useQuery({ queryKey: ['jit', 'launch', origin, launchId], queryFn: ({ signal }) => fetchJitLaunch(launchId!, { origin, signal }), enabled: readable && Boolean(launchId), ...refreshOptions })
  const reading = index.isFetching || (launchId ? detail.isFetching : page.isFetching)
  const refresh = async () => {
    const refreshed = await index.refetch()
    if (refreshed.data?.readiness.ready && !refreshed.error) await (launchId ? detail.refetch() : page.refetch())
  }

  return (
    <div className="pools-page min-w-0">
      {launchId && <GhostButton className="mb-6" onClick={() => onOpen()}>← JIT registry</GhostButton>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold">{launchId ? detail.data?.tokenName ?? 'JIT launch' : 'JIT launches'}</h1>
          <p className="mt-2 text-sm text-g500">Arc mainnet · 5042 · read-only registry{detail.data && launchId ? ` · ${detail.data.symbol}` : ''}</p>
        </div>
        <GhostButton disabled={reading} onClick={() => void refresh()}>{reading ? 'Reading…' : 'Refresh JIT'}</GhostButton>
      </div>
      <p className="mt-5 max-w-2xl text-base leading-6 text-g700">Create a fixed-supply token with its own baseline and temporary JIT liquidity. An agent supplies the capital and signs locally. People can inspect its pool, inventory and collected LP fees here.</p>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold"><a className="flex min-h-11 items-center underline" href="#docs/jit">Send an agent →</a><a className="flex min-h-11 items-center underline" href={`${origin}/jit`}>Read /jit</a></div>

      <section className="ruled-section mt-6" aria-label="JIT registry readiness" aria-busy={index.isLoading}>
        {index.error ? <p className="read-error" role="alert">JIT readiness could not be confirmed. {index.error.message}{index.data ? ' Last successful configuration is retained below; refresh before using it.' : ''}</p>
          : index.isLoading ? <p className="price-history-empty">Reading JIT deployment readiness…</p>
          : index.data && <div className="py-5"><p className="font-semibold">{readable ? 'Registry reads available' : 'JIT unavailable'}</p><p className="mt-2 text-sm leading-6 text-g700">{index.data.readiness.reason}</p></div>}
        <p className="border-t border-g300 py-4 text-xs leading-5 text-g500">Readiness checks deployed configuration. It does not establish funded acceptance, profitability or a completed Firepan release check. JIT pays gas locally and does not use the HTTP relayer.</p>
      </section>

      {launchId ? (
        <>
          {detail.error && <p className="read-error" role="alert">Launch details could not be refreshed. {detail.error.message}{detail.data ? ' Showing the last successful read.' : ' No pool or balances can be confirmed.'}</p>}
          {detail.isLoading && <div className="mt-6" aria-label="Reading JIT launch"><TableSkeleton rows={5} /></div>}
          {!detail.data && !detail.isLoading && !detail.error && !readable && <p className="price-history-empty">Details will be read when this JIT deployment is available.</p>}
          {detail.data && index.data && <><p className="mt-4 text-xs text-g500">{detail.error || !readable ? 'Last successful read' : 'Read'} at block {detail.data.blockNumber}.</p><LaunchDetail launch={detail.data} index={index.data} /></>}
        </>
      ) : (
        <section className="ruled-section mt-8" aria-labelledby="jit-registry">
          <div className="section-heading-row flex-wrap py-2"><h2 id="jit-registry">Launch registry</h2>{page.data && <span>{page.data.total} registered · block {page.data.blockNumber}</span>}</div>
          {page.error && <p className="read-error" role="alert">Registry entries could not be refreshed. {page.error.message}{page.data ? ' Showing the last successful page.' : ' No launch count is available.'}</p>}
          {page.isLoading && <TableSkeleton rows={5} />}
          {!page.data && !page.isLoading && !page.error && !readable && <p className="price-history-empty">Launches and counts will be read after a JIT factory is available. An unavailable registry cannot report zero launches.</p>}
          {page.data && <>
            {!readable && <p className="read-error">These entries are from the last successful registry read. Current deployment readiness is unavailable.</p>}
            {page.data.launches.length === 0 && <p className="price-history-empty">{page.data.total === '0' ? 'No launches recorded in the verified registry at this block.' : 'No entries on this page. Return to an earlier registry page.'}</p>}
            <ul className="m-0 list-none p-0">{page.data.launches.map((launch) => <li key={launch.launchId} className="min-w-0 border-b border-g300 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" className="min-h-11 min-w-0 break-all text-left font-mono text-xs font-semibold hover:underline sm:text-sm" onClick={() => onOpen(launch.launchId)}>Token {launch.token} →</button>
                <span className="text-xs leading-6 text-g500">{createdTime(launch.createdAt)}</span>
              </div>
              <dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2"><div className="min-w-0"><dt className="text-g500">Seed capital at creation</dt><dd className="m-0 mt-1 break-all">{launch.seedUsdc.formatted} USDC</dd></div><div className="min-w-0"><dt className="text-g500">Creator</dt><dd className="m-0 mt-1"><AddressLink address={launch.creator} /></dd></div></dl>
              <p className="mt-3 text-xs text-g500">Open the launch to read its token name, pool, fixed ranges, inventory and fees.</p>
            </li>)}</ul>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><GhostButton disabled={cursors.length === 1 || reading} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous page</GhostButton><span className="text-xs text-g500">Registry offset {page.data.start}</span><GhostButton disabled={!page.data.nextStart || reading} onClick={() => { if (page.data?.nextStart) setCursors((current) => [...current, page.data.nextStart!]) }}>Next page</GhostButton></div>
            <p className="mt-4 text-xs leading-5 text-g500">Entries follow registry order. This page covers at most 20 launches. Addresses identify recorded creators, not verified AI identities.</p>
          </>}
        </section>
      )}

      {!launchId && index.data && <section className="ruled-section mt-10" aria-labelledby="jit-deployment"><div className="section-heading-row"><h2 id="jit-deployment">Configured deployment</h2></div><Fields rows={Object.entries(index.data.contracts).map(([label, address]) => [label === 'hookDeployer' ? 'Hook deployer' : label === 'poolManager' ? 'PoolManager' : label === 'usdc' ? 'USDC' : label === 'quoter' ? 'Quoter' : 'Factory', address === zeroAddress ? 'Awaiting deployment' : <AddressLink address={address} />])} /></section>}
    </div>
  )
}
