import { describe, expect, test } from 'bun:test'
import { enforceGasBudget, gasBudget, publicAccount } from './jit-prepare'

describe('JIT unsigned deployment safeguards', () => {
  test('treats gas USDC as eighteen decimals, including sub-micro-USDC', () => {
    expect(gasBudget('0.000000000000000001')).toBe(1n)
    expect(gasBudget('0.02')).toBe(20_000_000_000_000_000n)
  })
  test('rejects zero, signs, exponent notation and excessive precision', () => {
    for (const value of ['0', '0.0', '-1', '+1', '1e2', '0.0000000000000000001', '1.']) expect(() => gasBudget(value)).toThrow()
  })
  test('budgets maximum fees rather than the current base fee', () => {
    expect(enforceGasBudget(1_000_000n, 20_000_000_000n, gasBudget('0.02'), gasBudget('1'))).toBe(gasBudget('0.02'))
    expect(() => enforceGasBudget(1_000_000n, 20_000_000_001n, gasBudget('0.02'), gasBudget('1'))).toThrow('ceiling')
  })
  test('requires sufficient underlying native USDC and positive gas inputs', () => {
    expect(() => enforceGasBudget(1_000_000n, 20_000_000_000n, gasBudget('1'), gasBudget('0.01'))).toThrow('lacks')
    expect(() => enforceGasBudget(0n, 1n, 1n, 1n)).toThrow('positive')
  })
  test('requires an actual public account without accepting key-shaped input', () => {
    expect(publicAccount('0x0000000000000000000000000000000000000001')).toBe('0x0000000000000000000000000000000000000001')
    expect(() => publicAccount('0x' + '0'.repeat(40))).toThrow('nonzero')
    expect(() => publicAccount('0x' + '1'.repeat(64))).toThrow('deployer')
  })
})
