import { formatUnits, parseUnits } from 'viem'
import { GateError } from './errors.js'

export const USDC_DECIMALS = 6
export const TOKEN_DECIMALS = 18

/** Every money value on the wire: a decimal string for reading, atomic units for arithmetic. */
export interface Money {
  formatted: string
  raw: string
}

export function money(raw: bigint, decimals: number): Money {
  return { formatted: formatUnits(raw, decimals), raw: raw.toString() }
}

/** A human decimal ("5", "0.25") to atomic units. Signs, exponents and excess precision are refused, not rounded. */
export function parseAmount(value: unknown, decimals: number, field: string, options: { allowZero?: boolean } = {}): bigint {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  if (!/^\d{1,30}(\.\d+)?$/.test(text)) {
    throw new GateError(400, 'invalid_amount', `${field} must be a decimal number, for example "5" or "0.25".`)
  }
  if ((text.split('.')[1] ?? '').length > decimals) {
    throw new GateError(400, 'invalid_amount', `${field} has more than ${decimals} decimal places.`)
  }
  const raw = parseUnits(text, decimals)
  if (raw === 0n && !options.allowZero) throw new GateError(400, 'invalid_amount', `${field} must be greater than zero.`)
  return raw
}
