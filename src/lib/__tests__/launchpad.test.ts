import { describe, expect, test } from 'bun:test'
import { explainRevert } from '../errors'
import { formatCurveSold, soldLabel, utf8ByteLength } from '../launch'

describe('launchpad copy and validation', () => {
  test('explains launchpad custom errors in a sentence', () => {
    expect(explainRevert('SlippageExceeded')).toBe('The price moved past your slippage limit. Try again or raise slippage in settings.')
    expect(explainRevert('CurveGraduated')).toBe('This curve has graduated.')
    expect(explainRevert('InvalidName')).toBe('Name must be 1 to 32 bytes.')
    expect(explainRevert('UnknownToken')).toBe('That token is not on the launchpad.')
  })

  test('counts UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('DOGE')).toBe(4)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('😀')).toBe(4)
  })

  test('formats sold as millions of the 800M curve', () => {
    expect(soldLabel(0n)).toBe('0 / 800M')
    expect(formatCurveSold(412_000_000n * 10n ** 18n)).toBe('412M')
  })
})
