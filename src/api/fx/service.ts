import { env } from '../../config/env'
import { UpstreamError } from '../../errors'
import { requestJson } from '../../lib/http-client'
import { Big } from '../../lib/money'
import { getCorridor } from '../corridors/service'
import { getAnchorToml } from '../../interfaces/anchors/toml'

let httpCache: { at: number; base: string; rates: Record<string, number> } | undefined
let sep38Cache: { at: number; base: string; rates: Record<string, number> } | undefined

/**
 * Fetches per-currency reference rates from an anchor's SEP-38 quote server (`GET /price`).
 *
 * SEP-38 quotes are per-corridor (sell/buy asset pair) rather than per-base-currency, so we
 * resolve the corridor for `base` and ask the anchor for the price of selling 1 unit of the
 * corridor's fiat currency for its on-chain asset. The returned `price` is the number of
 * sell-asset units per 1 buy-asset unit, which we invert to get "units of fiat per 1 base".
 */
async function fetchSep38Rates(base: string): Promise<Record<string, number>> {
  const corridor = await getCorridor(base)
  const toml = await getAnchorToml(corridor.anchorDomain)
  if (!toml.quoteServer) {
    throw new UpstreamError('fx', `Anchor ${corridor.anchorDomain} does not advertise a SEP-38 quote server (ANCHOR_QUOTE_SERVER)`)
  }

  const sellAsset = `iso4217:${corridor.fiatCurrency.toUpperCase()}`
  const buyAsset = corridor.assetCode
  const payload = await requestJson<{ price: string }>('fx', `${toml.quoteServer.replace(/\/$/, '')}/price`, {
    query: { sell_asset: sellAsset, buy_asset: buyAsset, sell_amount: '1' },
    timeoutMs: env.ANCHOR_REQUEST_TIMEOUT_MS,
  })

  const price = new Big(payload.price)
  if (price.lte(0)) throw new UpstreamError('fx', `Anchor ${corridor.anchorDomain} returned a non-positive SEP-38 price`)

  // `price` is buy-asset units per 1 sell-asset unit; invert to get fiat units per 1 base unit.
  const fiatPerBase = new Big(1).div(price)
  return { [corridor.fiatCurrency.toUpperCase()]: fiatPerBase.toNumber() }
}

/** Units of each fiat currency per 1 unit of `base`, e.g. { USD: 1, EUR: 0.92, ARS: 1050 }. */
export async function getReferenceRates(base = 'USD'): Promise<Record<string, number>> {
  if (env.FX_PROVIDER === 'http') {
    if (httpCache && httpCache.base === base && Date.now() - httpCache.at < env.FX_CACHE_TTL_SECONDS * 1000) {
      return httpCache.rates
    }
    if (!env.FX_REFERENCE_URL) throw new UpstreamError('fx', 'FX_PROVIDER=http but FX_REFERENCE_URL is not configured')
    const payload = await requestJson<{ rates: Record<string, number> }>('fx', env.FX_REFERENCE_URL, {
      query: { base },
      timeoutMs: env.ANCHOR_REQUEST_TIMEOUT_MS,
    })
    httpCache = { at: Date.now(), base, rates: payload.rates }
    return payload.rates
  }

  if (env.FX_PROVIDER === 'sep38') {
    if (sep38Cache && sep38Cache.base === base && Date.now() - sep38Cache.at < env.FX_CACHE_TTL_SECONDS * 1000) {
      return sep38Cache.rates
    }
    try {
      const rates = await fetchSep38Rates(base)
      sep38Cache = { at: Date.now(), base, rates }
      return rates
    } catch (err) {
      // Documented fallback: if the anchor's SEP-38 quote server is unreachable, misconfigured,
      // or returns an invalid price, we log the reason and fall back to the static rate table.
      // This is the only path on which 'sep38' uses static rates.
      console.warn(`[fx] SEP-38 quote fetch failed for base ${base}, falling back to static rates: ${(err as Error).message}`)
    }
  }

  // 'static' provider (and the explicit SEP-38 failure fallback above).
  const rates = env.FX_STATIC_RATES
  const baseRate = rates[base.toUpperCase()]
  if (!baseRate) throw new UpstreamError('fx', `No static rate configured for base currency ${base}`)
  return Object.fromEntries(Object.entries(rates).map(([currency, unitsPerUsd]) => [currency, unitsPerUsd / baseRate]))
}

export type FxQuote = {
  corridorCode: string
  kind: 'deposit' | 'withdrawal'
  amountIn: string
  fiatCurrency: string
  referenceRate: string
  platformFee: string
  amountOut: string
  provider: string
}

/**
 * Quotes a RemitPulse transfer through a corridor. Corridor assets (USDC, EURC, ARST, BRLA) are
 * assumed to track their fiat currency ~1:1, so `referenceRate` here is informational (USD
 * equivalent) while the platform fee (fixedFee + markupBps) is what actually moves the amount.
 */
export async function quoteCorridor(code: string, amount: string, kind: 'deposit' | 'withdrawal'): Promise<FxQuote> {
  const corridor = await getCorridor(code)
  const amountIn = new Big(amount)
  if (amountIn.lt(corridor.minAmount.toString())) throw new UpstreamError('fx', `Amount below corridor minimum (${corridor.minAmount})`)
  if (corridor.maxAmount && amountIn.gt(corridor.maxAmount.toString())) {
    throw new UpstreamError('fx', `Amount above corridor maximum (${corridor.maxAmount})`)
  }

  const rates = await getReferenceRates('USD')
  const referenceRate = new Big(rates[corridor.fiatCurrency.toUpperCase()] ?? 1)

  const platformFee = amountIn.times(corridor.markupBps.toString()).div(10_000).plus(corridor.fixedFee.toString())
  const amountOut = amountIn.minus(platformFee)
  if (amountOut.lte(0)) throw new UpstreamError('fx', 'Amount is too small to cover the platform fee')

  return {
    corridorCode: corridor.code,
    kind,
    amountIn: amountIn.toFixed(7),
    fiatCurrency: corridor.fiatCurrency,
    referenceRate: referenceRate.toFixed(12),
    platformFee: platformFee.toFixed(7),
    amountOut: amountOut.toFixed(7),
    provider: env.FX_PROVIDER,
  }
}
