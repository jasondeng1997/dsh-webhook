/**
 * Outbound HTTP delivery with bounded retries.
 *
 * Used by two features with the same failure modes: posting an agent's answer
 * back to a route's callback URL, and the `webhook_send` tool the model can
 * call. Both need the same rules, so both go through here.
 *
 * The retry policy is the part worth stating explicitly: a delivery is retried
 * only when retrying could plausibly succeed — a connection failure, a timeout,
 * a `408`, a `429`, or a `5xx`. A `4xx` is a decision by the receiver, and
 * repeating it would multiply a rejected request into a small flood. `Retry-After`
 * is honored when present, including the HTTP-date form, capped by the caller's
 * own ceiling.
 *
 * @module dsh-webhook/outbound
 */

/** One outbound delivery attempt set. */
export interface OutboundRequest {
  /** Absolute URL to post to. */
  url: string
  /** Request body, already serialized. */
  body: string
  /** Content type; defaults to `application/json; charset=utf-8`. */
  contentType?: string
  /** Extra headers, already rendered and validated. */
  headers?: Readonly<Record<string, string>>
  /** Total attempts including the first; clamped to 1..10. */
  attempts: number
  /** Base backoff in milliseconds, doubled per attempt; clamped to 0..60000. */
  backoffMs: number
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number
  /** Cancels the whole attempt set. */
  signal?: AbortSignal
  /** Sleep implementation, injectable so tests do not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Ceiling for a `Retry-After` hint, in milliseconds. */
  maxRetryAfterMs?: number
}

/** Outcome of an outbound delivery. */
export interface OutboundResult {
  /** True only when a response arrived with a 2xx status. */
  ok: boolean
  /** Response status, when a response arrived at all. */
  status?: number
  /** Attempts actually made. */
  attempts: number
  /** Bridge-authored explanation for a failure. */
  detail?: string
  /** First 512 characters of a non-2xx response body, for diagnostics. */
  responseExcerpt?: string
}

/** Whether an optional signal has been aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Default sleep honoring the abort signal. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether a status is worth retrying. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/** Parse a `Retry-After` header into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined
  }
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/** Clamp a numeric option into range, tolerating non-finite input. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Read `Retry-After` off a Headers object without throwing on exotic shapes. */
function retryAfterOf(response: Response): number | undefined {
  try {
    return parseRetryAfter(response.headers.get('retry-after'))
  } catch {
    return undefined
  }
}

/** Read a bounded excerpt of a response body, never throwing. */
async function excerptOf(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    return text === '' ? undefined : text.slice(0, 512)
  } catch {
    return undefined
  }
}

/**
 * Post a payload, retrying according to {@link retryableStatus}.
 * @param request - delivery parameters.
 * @returns the outcome; `ok` is true only for a 2xx response.
 */
export async function postWithRetry(request: OutboundRequest): Promise<OutboundResult> {
  const attempts = clamp(request.attempts, 1, 10, 1)
  const backoffMs = clamp(request.backoffMs, 0, 60_000, 1_000)
  const timeoutMs = clamp(request.timeoutMs, 200, 300_000, 15_000)
  const sleep = request.sleep ?? defaultSleep
  const maxRetryAfter = request.maxRetryAfterMs ?? 60_000

  let lastDetail: string | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isAborted(request.signal)) {
      return { ok: false, attempts: attempt - 1, detail: 'aborted before attempt' }
    }
    const controller = new AbortController()
    const onOuterAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response | undefined
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: {
          'content-type': request.contentType ?? 'application/json; charset=utf-8',
          ...request.headers,
        },
        body: request.body,
        signal: controller.signal,
      })
    } catch (error) {
      lastDetail = isAborted(request.signal)
        ? 'aborted'
        : error instanceof Error && error.name === 'AbortError'
          ? `no response within ${timeoutMs}ms`
          : `transport failure: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onOuterAbort)
    }

    if (response !== undefined) {
      if (response.status >= 200 && response.status <= 299) {
        return { ok: true, status: response.status, attempts: attempt }
      }
      const excerpt = await excerptOf(response)
      if (!retryableStatus(response.status)) {
        return {
          ok: false,
          status: response.status,
          attempts: attempt,
          detail: `receiver rejected the request with ${response.status}`,
          ...(excerpt === undefined ? {} : { responseExcerpt: excerpt }),
        }
      }
      lastDetail = `receiver answered ${response.status}`
      const hint = retryAfterOf(response)
      if (attempt < attempts) {
        const wait = hint === undefined ? backoffMs * 2 ** (attempt - 1) : Math.min(hint, maxRetryAfter)
        await sleep(wait, request.signal)
        continue
      }
      return {
        ok: false,
        status: response.status,
        attempts: attempt,
        detail: lastDetail,
        ...(excerpt === undefined ? {} : { responseExcerpt: excerpt }),
      }
    }

    if (isAborted(request.signal)) {
      return { ok: false, attempts: attempt, detail: 'aborted' }
    }
    if (attempt < attempts) {
      await sleep(backoffMs * 2 ** (attempt - 1), request.signal)
      continue
    }
    return { ok: false, attempts: attempt, ...(lastDetail === undefined ? {} : { detail: lastDetail }) }
  }

  /* v8 ignore next 2 -- the loop returns on every path; guarded for type completeness. */
  return { ok: false, attempts, ...(lastDetail === undefined ? {} : { detail: lastDetail }) }
}

/**
 * Whether an outbound URL may be called under an allowlist of hosts.
 *
 * The model can only reach the `webhook_send` tool when the deployment enables
 * it, and an allowlist narrows that further. An empty allowlist means "any
 * host", which is why the tool ships disabled by default.
 * @param url - candidate URL.
 * @param allowHosts - permitted hostnames; empty allows everything.
 * @returns true when the URL may be called.
 */
export function hostAllowed(url: string, allowHosts: readonly string[]): boolean {
  if (allowHosts.length === 0) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const host = parsed.host.toLowerCase()
  return allowHosts.some((allowed) => {
    const candidate = allowed.trim().toLowerCase()
    if (candidate === '') return false
    if (candidate === host) return true
    // A leading dot means "this domain and its subdomains", so `.example.com`
    // covers both `example.com` and `hooks.example.com`.
    if (!candidate.startsWith('.')) return false
    return host === candidate.slice(1) || host.endsWith(candidate)
  })
}
