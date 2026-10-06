import { useQuery } from '@tanstack/react-query'
import { activeChain } from '../chain'
import { deployment } from '../lib/deployment'
import { challengeAgreement, readGateChallenge, readGateIndex } from '../lib/gate'

const expected = { chainId: activeChain.id, asset: activeChain.usdc, launchpad: deployment.launchpad, bbs: deployment.bbs }

export function useGateIndex() {
  const origin = window.location.origin
  return useQuery({
    queryKey: ['gate-index', activeChain.id, origin],
    queryFn: ({ signal }) => readGateIndex(origin, expected, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
}

export function useGate() {
  const origin = window.location.origin
  const index = useGateIndex()
  const challenge = useQuery({
    queryKey: ['gate-challenge', activeChain.id, origin],
    queryFn: ({ signal }) => readGateChallenge(origin, expected, signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
  return {
    index: index.data,
    challenge: challenge.data,
    indexError: index.error,
    challengeError: challenge.error,
    termsError: index.data && challenge.data ? challengeAgreement(index.data, challenge.data) : undefined,
    indexLoading: index.isLoading,
    challengeLoading: challenge.isLoading,
    isFetching: index.isFetching || challenge.isFetching,
    refetch: () => Promise.all([index.refetch(), challenge.refetch()]),
  }
}
