/**
 * Outbound delivery tests.
 *
 * Retry classification is the behaviour worth pinning: repeating a request the
 * receiver has already rejected multiplies one rejected call into a small flood,
 * so a `4xx` must never be retried, while a transport failure, a `429`, and a
 * `5xx` must be.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostAllowed, parseRetryAfter, postWithRetry, retryableStatus } from '../src/outbound.ts'

/** A response stub with the members `postWithRetry` touches. */
function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response
}

/** No-op sleep, so a retry test never waits. */
const noSleep = async (): Promise<void> => {}

const base = {
  url: 'https://example.com/hook',
  body: '{"a":1}',
  attempts: 3,
  backoffMs: 1,
  timeoutMs: 1_000,
  sleep: noSleep,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('retryableStatus', () => {
  it('retries timeouts, rate limits, and server faults only', () => {
    expect(retryableStatus(408)).toBe(true)
    expect(retryableStatus(429)).toBe(true)
    expect(retryableStatus(500)).toBe(true)
    expect(retryableStatus(503)).toBe(true)
    expect(retryableStatus(599)).toBe(true)
    expect(retryableStatus(400)).toBe(false)
    expect(retryableStatus(401)).toBe(false)
    expect(retryableStatus(404)).toBe(false)
    expect(retryableStatus(200)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  it('parses the seconds form and the HTTP-date form', () => {
    expect(parseRetryAfter('2')).toBe(2_000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('not a date')).toBeUndefined()
    const now = Date.parse('2026-09-29T00:00:00.000Z')
    expect(parseRetryAfter('Tue, 29 Sep 2026 00:00:07 GMT', now)).toBe(7_000)
    expect(parseRetryAfter('Tue, 29 Sep 2026 00:00:00 GMT', now + 5_000)).toBe(0)
  })
})

describe('postWithRetry', () => {
  it('returns success on the first 2xx', async () => {
    const fetchMock = vi.fn(async () => response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result).toEqual({ ok: true, status: 200, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a 500 and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(500, 'boom'))
      .mockResolvedValueOnce(response(202))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
  })

  it('does not retry a 4xx and keeps a response excerpt for diagnostics', async () => {
    const fetchMock = vi.fn(async () => response(422, 'field missing'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.attempts).toBe(1)
    expect(result.responseExcerpt).toBe('field missing')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops after the configured attempts and reports the last status', async () => {
    const fetchMock = vi.fn(async () => response(503))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(3)
    expect(result.detail).toContain('503')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries a transport failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
  })

  it('reports a timeout as a failure without an infinite wait', async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry(base)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('no response within')
  })

  it('honors a Retry-After hint, capped by the caller ceiling', async () => {
    const waits: number[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, '', { 'retry-after': '600' }))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry({
      ...base,
      maxRetryAfterMs: 5_000,
      sleep: async (ms) => { waits.push(ms) },
    })
    expect(result.ok).toBe(true)
    expect(waits).toEqual([5_000])
  })

  it('backs off exponentially without a hint', async () => {
    const waits: number[] = []
    const fetchMock = vi.fn(async () => response(500))
    vi.stubGlobal('fetch', fetchMock)
    await postWithRetry({ ...base, backoffMs: 100, sleep: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([100, 200])
  })

  it('refuses to start when the signal is already aborted', async () => {
    const fetchMock = vi.fn(async () => response(200))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const result = await postWithRetry({ ...base, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('aborted before attempt')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops retrying once the signal aborts mid-flight', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      controller.abort()
      return response(500)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await postWithRetry({ ...base, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('hostAllowed', () => {
  it('allows everything when the allowlist is empty', () => {
    expect(hostAllowed('https://anywhere.example/x', [])).toBe(true)
  })

  it('matches exact hosts and dotted subdomain patterns', () => {
    expect(hostAllowed('https://hooks.example.com/x', ['hooks.example.com'])).toBe(true)
    expect(hostAllowed('https://hooks.example.com/x', ['example.com'])).toBe(false)
    expect(hostAllowed('https://hooks.example.com/x', ['.example.com'])).toBe(true)
    expect(hostAllowed('https://example.com/x', ['.example.com'])).toBe(true)
    expect(hostAllowed('https://notexample.com/x', ['.example.com'])).toBe(false)
  })

  it('honors a non-default port and rejects unusable input', () => {
    expect(hostAllowed('https://example.com:8443/x', ['example.com:8443'])).toBe(true)
    expect(hostAllowed('https://example.com:8443/x', ['example.com'])).toBe(false)
    expect(hostAllowed('not a url', ['example.com'])).toBe(false)
    expect(hostAllowed('https://example.com/x', ['  '])).toBe(false)
  })
})
