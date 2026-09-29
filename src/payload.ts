/**
 * Payload parsing and event extraction.
 *
 * Upstreams disagree about almost everything: GitHub sends JSON with the event
 * in a header, GitLab sometimes sends form-encoded bodies, and a hand-rolled
 * sender may post anything at all. The bridge normalizes all of it into
 * `{ payload, event, contentType }` and never throws on a malformed body — a
 * delivery that cannot be parsed is still a delivery worth answering, and the
 * raw text stays available to the template as `{{ raw }}`.
 *
 * @module dsh-webhook/payload
 */

import { headerValue } from './signature.ts'
import type { WebhookSource } from './config.ts'

/** Parsed delivery body. */
export interface ParsedPayload {
  /** Parsed structure: an object when the body is JSON or form-encoded, otherwise `{ raw }`. */
  payload: Record<string, unknown>
  /** How the body was interpreted. */
  contentType: 'json' | 'form' | 'text'
  /** Event name reported by the upstream, when it reports one. */
  event?: string
}

/** Header names each upstream uses to name the event. */
const EVENT_HEADERS: Record<WebhookSource, readonly string[]> = {
  github: ['x-github-event', 'x-github-hook-installation-target-type'],
  gitlab: ['x-gitlab-event', 'x-gitlab-event-uuid'],
  gitee: ['x-gitee-event', 'x-gitee-hook-name'],
  generic: ['x-webhook-event', 'x-event-type', 'x-gitee-event'],
}

/** Event fields carried inside the payload when no header names one. */
const EVENT_FIELDS = ['event', 'event_type', 'event_name', 'type', 'object_kind', 'action'] as const

/** Media types that indicate a JSON body. */
function looksJson(contentType: string | undefined, body: string): boolean {
  if (contentType !== undefined && /\bjson\b/i.test(contentType)) return true
  const head = body.trimStart()[0]
  return head === '{' || head === '['
}

/** Media types that indicate a form-encoded body. */
function looksForm(contentType: string | undefined): boolean {
  return contentType !== undefined && /application\/x-www-form-urlencoded/i.test(contentType)
}

/** Pull the event name out of a parsed payload's well-known fields. */
function eventFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  for (const field of EVENT_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' && value !== '') return value
    // GitLab nests the object kind and action separately; prefer the finer one.
    if (typeof value === 'object' && value !== null) {
      const nested = (value as Record<string, unknown>).type
      if (typeof nested === 'string' && nested !== '') return nested
    }
  }
  return undefined
}

/** Read a form-encoded body into a flat record. */
function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const pair of body.split('&')) {
    if (pair === '') continue
    const separator = pair.indexOf('=')
    const rawKey = separator === -1 ? pair : pair.slice(0, separator)
    const rawValue = separator === -1 ? '' : pair.slice(separator + 1)
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    if (key === '') continue
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

/**
 * Parse one delivery body.
 * @param body - raw body bytes.
 * @param headers - case-insensitive header bag.
 * @param source - the route's declared upstream, used to pick the event header.
 * @returns the parsed payload, its interpretation, and the event name when known.
 */
export function parsePayload(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  source: WebhookSource,
): ParsedPayload {
  const text = body.toString('utf8')
  const contentType = headerValue(headers, 'content-type')

  const headerEvent = EVENT_HEADERS[source]
    .map((name) => headerValue(headers, name))
    .find((value): value is string => value !== undefined && value !== '')

  if (looksJson(contentType, text)) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const payload = parsed as Record<string, unknown>
        const payloadEvent = eventFromPayload(payload)
        const event = headerEvent ?? payloadEvent
        return event === undefined ? { payload, contentType: 'json' } : { payload, contentType: 'json', event }
      }
      // A JSON array or scalar has no field to look up: keep it reachable under `value`.
      const payload: Record<string, unknown> = { value: parsed, raw: text }
      const event = headerEvent
      return event === undefined ? { payload, contentType: 'json' } : { payload, contentType: 'json', event }
    } catch {
      // Fall through to the text branch: a body that announces JSON but cannot
      // be parsed still deserves a readable prompt rather than a failed delivery.
    }
  }

  if (looksForm(contentType)) {
    const payload = parseForm(text)
    const event = headerEvent ?? eventFromPayload(payload)
    return event === undefined ? { payload, contentType: 'form' } : { payload, contentType: 'form', event }
  }

  const payload: Record<string, unknown> = { raw: text }
  const event = headerEvent
  return event === undefined ? { payload, contentType: 'text' } : { payload, contentType: 'text', event }
}
