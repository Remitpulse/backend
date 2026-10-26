import Big from 'big.js'

import { STELLAR } from '../config/stellar'
import { BadRequestError } from '../errors'

Big.DP = 20
Big.RM = Big.roundDown

const SCALE = new Big(10).pow(STELLAR.decimals)

/** Converts a decimal token amount ("12.5") into i128 base units ("125000000"). */
export function toBaseUnits(amount: string | number | Big): bigint {
  const value = new Big(amount)
  if (value.lt(0)) throw new BadRequestError('amount must be non-negative', undefined, 'INVALID_AMOUNT')
  const scaled = value.times(SCALE)
  if (!scaled.eq(scaled.round(0, Big.roundDown))) {
    throw new BadRequestError(`amount supports at most ${STELLAR.decimals} decimal places`, undefined, 'INVALID_AMOUNT')
  }
  return BigInt(scaled.toFixed(0))
}

/** Converts i128 base units back into a fixed 7-decimal string. */
export function fromBaseUnits(units: bigint | string): string {
  return new Big(units.toString()).div(SCALE).toFixed(STELLAR.decimals)
}

/** Rounds a decimal to 7 places (Stellar precision), rounding down so we never over-promise. */
export function toStellarPrecision(value: Big): string {
  return value.round(STELLAR.decimals, Big.roundDown).toFixed(STELLAR.decimals)
}

export const DecimalString = /^\d+(\.\d{1,7})?$/

export { Big }
