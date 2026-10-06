import { tokenMonogram, tokenStamp, type Token } from '../lib/tokens'

/** A token's two-letter mark, stamped in the spot colour that belongs to that token. */
export function TokenMark({ token, className = '' }: { token: Pick<Token, 'address' | 'symbol'>; className?: string }) {
  return (
    <span className={`token-mark stamp-${tokenStamp(token)} ${className}`.trimEnd()} aria-hidden="true">
      {tokenMonogram(token)}
    </span>
  )
}
