import { useEffect, useRef, useState } from 'react'
import { GhostButton } from './GhostButton'

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setState('copied')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 2_000)
    } catch {
      setState('failed')
    }
  }

  return (
    <div className="code-sheet">
      <div className="code-heading">
        <span>{label}</span>
        <GhostButton onClick={() => void copy()} aria-label={`Copy ${label}`}>{state === 'copied' ? 'Copied' : 'Copy'}</GhostButton>
      </div>
      <pre tabIndex={0} aria-label={label}><code>{code}</code></pre>
      <span className="sr-only" role="status">{state === 'copied' ? `${label} copied.` : ''}</span>
      {state === 'failed' && <p className="mt-2 text-sm text-loss" role="alert">Clipboard access failed. Select and copy the code above.</p>}
    </div>
  )
}
