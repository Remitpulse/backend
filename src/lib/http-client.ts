import { UpstreamError } from '../errors'
import { retry } from './retry'

export type HttpRequest = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined>
  json?: unknown
  form?: Record<string, string | undefined>
  timeoutMs?: number
}

/** Thin fetch wrapper with timeouts and consistent upstream error mapping. */
export async function requestJson<T>(service: string, url: string, options: HttpRequest = {}): Promise<T> {
  const target = new URL(url)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
  let body: string | undefined
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.json)
  } else if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(options.form)) if (value !== undefined) form.set(key, value)
    body = form.toString()
  }

  let response: Response
  try {
    // Only the network-level attempt is retried (DNS/connect/timeout failures); an HTTP
    // error status below is surfaced once and never retried, since the anchor/FX call may
    // not be safely repeatable server-side.
    response = await retry(
      () =>
        fetch(target, {
          method: options.method ?? (body ? 'POST' : 'GET'),
          headers,
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        }),
      { attempts: 3, delayMs: 250 }
    )
  } catch (error) {
    throw new UpstreamError(service, `request to ${target.origin} failed`, { cause: (error as Error).message })
  }

  const text = await response.text()
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : undefined
  } catch {
    payload = text
  }

  if (!response.ok) {
    throw new UpstreamError(service, `HTTP ${response.status} from ${target.pathname}`, {
      status: response.status,
      body: payload,
    })
  }
  return payload as T
}
