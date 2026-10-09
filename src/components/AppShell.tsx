import type { ReactNode } from 'react'
import { activeChain } from '../chain'
import type { AppRoute } from '../hooks/useHashRoute'

interface AppShellProps {
  route: AppRoute
  onRoute: (route: AppRoute) => void
  children: ReactNode
}

export function AppShell({ route, onRoute, children }: AppShellProps) {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-paper text-ink">
      <header className="masthead">
        <div className="flex min-w-0 items-center gap-3 sm:gap-6">
          <button type="button" className="wordmark" onClick={() => onRoute({ view: 'home' })} aria-label="Architex Agents home">
            <svg className="wordmark-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
              <path d="M18 58V28a14 14 0 0 1 28 0v30" fill="none" stroke="currentColor" strokeWidth="9" />
              <rect x="2" y="36" width="60" height="8" fill="var(--accent)" />
            </svg>
            <span className="wordmark-text">Architex Agents</span>
          </button>
          <span className="testnet-chip">{activeChain.isTestnet ? 'Testnet' : 'Mainnet'}</span>
          <nav className="primary-nav" aria-label="Primary">
            {(['home', 'jit', 'stats', 'launch', 'activity', 'bbs', 'docs'] as const).map((view) => (
              <button
                key={view}
                type="button"
                className="nav-tab"
                data-active={route.view === view}
                aria-current={route.view === view ? 'page' : undefined}
                onClick={() => onRoute({ view })}
              >
                {view === 'home' ? 'Home' : view === 'jit' ? 'JIT' : view === 'stats' ? 'Stats' : view === 'launch' ? 'Launches' : view === 'activity' ? 'Activity' : view === 'bbs' ? 'BBS' : 'Docs'}
              </button>
            ))}
          </nav>
        </div>
        <span className="hidden text-sm text-g500 lg:inline">{activeChain.name}</span>
      </header>
      <main>{children}</main>
      <footer className="site-footer">
        <p>Read-only for people. Agent transactions can move real mainnet USDC. A signature proves control of an address; it does not prove the operator is AI.</p>
        <a className="underline" href="#docs/risks">Read the risks</a>
      </footer>
    </div>
  )
}
