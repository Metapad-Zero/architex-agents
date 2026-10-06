import { useMemo, useSyncExternalStore } from 'react'
import { isAddress, zeroAddress, type Address } from 'viem'
import { useReadContract } from 'wagmi'
import { lensAbi, launchpadAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed } from '../lib/deployment'
import { asLaunchCurve, type LaunchRecord } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { rememberToken, type Token, type TokenMetaResult } from '../lib/tokens'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

/** Read-only token state. No wallet connection, allowance or holder balance is needed. */
export function useLaunch(token: Address | undefined) {
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const valid = Boolean(token && isAddress(token))
  const curveQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'curves',
    args: [token!],
    query: { enabled: !fixtureOn && isLaunchpadDeployed && valid, refetchInterval: 4_000 },
  })
  const metaQuery = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'tokenMeta',
    args: [[token!]],
    query: { enabled: !fixtureOn && isDeployed && valid && Boolean(curveQuery.data), staleTime: Number.POSITIVE_INFINITY },
  })
  const launch = useMemo<LaunchRecord | undefined>(() => {
    if (!token) return undefined
    if (fixtureOn) {
      void fixtureVersion
      return api?.get(token)
    }
    if (!curveQuery.data) return undefined
    const curve = asLaunchCurve(curveQuery.data)
    // curves(unknown) returns a zero tuple, not a failed call.
    if (curve.token === zeroAddress || curve.token.toLowerCase() !== token.toLowerCase()) return undefined
    const meta = ((metaQuery.data ?? []) as readonly TokenMetaResult[])[0]
    const record = { ...curve, name: meta?.name || 'Launch token', symbol: meta?.symbol || 'TOKEN' }
    rememberToken({ address: record.token, name: record.name, symbol: record.symbol, decimals: 18, faucet: false, isLaunch: true })
    return record
  }, [api, curveQuery.data, fixtureVersion, metaQuery.data, token])
  const launchToken = useMemo<Token | undefined>(() => launch ? { address: launch.token, name: launch.name, symbol: launch.symbol, decimals: 18, faucet: false, isLaunch: true } : undefined, [launch])

  return {
    launch,
    token: launchToken,
    isConfigured: fixtureOn || isLaunchpadDeployed,
    isLoading: !fixtureOn && isLaunchpadDeployed && valid && curveQuery.isLoading,
    unknown: Boolean(valid && !launch && (fixtureOn || (!curveQuery.isError && curveQuery.data !== undefined))),
    error: fixtureOn ? null : curveQuery.error,
    metadataError: fixtureOn ? null : metaQuery.error,
    refetch: () => Promise.all([curveQuery.refetch(), metaQuery.refetch()]),
  }
}
