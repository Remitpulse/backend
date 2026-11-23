export const STROOPS = 10_000_000n

export function parseXlm(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,7})?$/.test(value)) {
    throw new Error('Enter an XLM amount with up to seven decimal places.')
  }
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * STROOPS + BigInt(fraction.padEnd(7, '0'))
}

export function xlm(stroops: string | bigint, precision = 2): string {
  const value = BigInt(stroops)
  const absolute = value < 0n ? -value : value
  const fraction = (absolute % STROOPS).toString().padStart(7, '0').replace(/0+$/, '')
  const decimals = fraction.padEnd(precision, '0')
  return (value < 0n ? '−' : '') + absolute / STROOPS + (decimals ? '.' + decimals : '')
}
