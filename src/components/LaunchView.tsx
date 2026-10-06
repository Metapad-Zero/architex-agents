import type { Address } from 'viem'
import { LaunchDetail } from './LaunchDetail'
import { LaunchList } from './LaunchList'

if (import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1') {
  await import('../lib/launchFixtures')
}

interface LaunchViewProps {
  token?: Address
  onOpen: (token?: Address) => void
}

export function LaunchView({ token, onOpen }: LaunchViewProps) {
  if (token) return <LaunchDetail token={token} onBack={() => onOpen()} />
  return <LaunchList onOpen={(next) => onOpen(next)} />
}
