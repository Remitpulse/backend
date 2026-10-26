import { describe, expect, it } from 'vitest'

import { BadRequestError } from '../src/errors'
import { fromBaseUnits, toBaseUnits } from '../src/lib/money'

describe('toBaseUnits / fromBaseUnits', () => {
  it('round-trips a decimal amount through 7-decimal base units', () => {
    expect(toBaseUnits('12.5')).toBe(125_000_000n)
    expect(fromBaseUnits(125_000_000n)).toBe('12.5000000')
  })

  it('rejects negative amounts', () => {
    expect(() => toBaseUnits('-1')).toThrow(BadRequestError)
  })

  it('rejects more than 7 decimal places', () => {
    expect(() => toBaseUnits('1.12345678')).toThrow(BadRequestError)
  })
})
