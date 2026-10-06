import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/** Keep a readable recovery path if a component fails. This site never signs or pays. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Architex crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[512px] flex-col justify-center px-4">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">Architex Agents stopped unexpectedly</h1>
        <p className="mt-3 text-sm leading-6 text-g700">
          This page is read-only and sends no payments. Reload to read the gateway and chain again. Requests sent separately by your agent may still be pending; check their transaction receipts before retrying them.
        </p>
        <button type="button" className="primary-button mt-6 w-full" onClick={() => window.location.reload()}>
          <span>Reload Architex Agents</span>
        </button>
      </main>
    )
  }
}
