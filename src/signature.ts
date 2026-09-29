/**
 * Signature verification for inbound deliveries.
 *
 * Each supported service signs the raw request body with a shared secret, and
 * the receiver compares that signature in constant time before the payload is
 * allowed anywhere near an agent. Two rules hold everywhere in this module:
 *
 * 1. The comparison is constant-time for equal-length inputs, and a length
 *    mismatch short-circuits only after the expected digest length is known —
 *    digest length is not a secret.
 * 2. A failure returns a reason, never a partially-trusted payload, so callers
 *    cannot accidentally proceed on an unverified body.
 *
 * @module dsh-webhook/signature
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebhookSource } from './config.ts'

/** Outcome of verifying one delivery. */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string }

/** Compare two hex digests without leaking their contents through timing. */
export function timingSafeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase(), 'utf8')
  const b = Buffer.from(right.toLowerCase(), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Compare two arbitrary credentials in constant time. */
export function timingSafeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Compute the hex HMAC of a payload.
 * @param body - raw request body, exactly as received.
 * @param secret - shared secret.
 * @param algorithm - digest to use; `sha256` unless a legacy upstream needs otherwise.
 * @returns lowercase hex digest.
 */
export function signPayload(
  body: Buffer | string,
  secret: string,
  algorithm: 'sha256' | 'sha1' = 'sha256',
): string {
  return createHmac(algorithm, secret).update(body).digest('hex')
}

/** Read one header value from a case-insensitive header bag. */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct[0]
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value[0]
  }
  return undefined
}

/** Strip the `sha256=` prefix upstreams use, when present. */
function bareDigest(value: string, algorithm: 'sha256' | 'sha1'): string {
  const prefix = `${algorithm}=`
  const trimmed = value.trim()
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

/**
 * Verify a GitHub delivery.
 *
 * GitHub sends `x-hub-signature-256` for current apps and `x-hub-signature`
 * (SHA-1) for older ones. SHA-256 is preferred; the SHA-1 header is accepted
 * only when the stronger header is absent, so an attacker cannot downgrade a
 * delivery that carried the strong signature.
 * @param body - raw request body.
 * @param headers - case-insensitive header bag.
 * @param secret - webhook secret configured on the GitHub side.
 * @returns verification outcome.
 */
export function verifyGithub(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  const sha256 = headerValue(headers, 'x-hub-signature-256')
  if (sha256 !== undefined) {
    const expected = signPayload(body, secret, 'sha256')
    const provided = bareDigest(sha256, 'sha256')
    return timingSafeEqualHex(provided, expected)
      ? { ok: true }
      : { ok: false, reason: 'x-hub-signature-256 does not match the body' }
  }
  const sha1 = headerValue(headers, 'x-hub-signature')
  if (sha1 !== undefined) {
    const expected = signPayload(body, secret, 'sha1')
    const provided = bareDigest(sha1, 'sha1')
    return timingSafeEqualHex(provided, expected)
      ? { ok: true }
      : { ok: false, reason: 'x-hub-signature (legacy SHA-1) does not match the body' }
  }
  return { ok: false, reason: 'missing x-hub-signature-256 and x-hub-signature headers' }
}

/**
 * Verify a GitLab delivery, which sends the shared secret verbatim in
 * `x-gitlab-token`. The comparison is constant-time and the token never reaches
 * a log line: this module returns a reason string only.
 * @param headers - case-insensitive header bag.
 * @param secret - secret token configured on the GitLab side.
 * @returns verification outcome.
 */
export function verifyGitlab(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  const token = headerValue(headers, 'x-gitlab-token')
  if (token === undefined) return { ok: false, reason: 'missing x-gitlab-token header' }
  return timingSafeEqualText(token, secret)
    ? { ok: true }
    : { ok: false, reason: 'x-gitlab-token does not match the configured secret' }
}

/**
 * Verify a Gitee delivery. Gitee's webhook password travels in
 * `X-Gitee-Token`, and its signature (when enabled) arrives as
 * `X-Gitee-Timestamp` plus a base64 HMAC in `X-Gitee-Token` for signed mode.
 * Only the token form is supported here, which is what the Gitee UI calls the
 * "webhook password".
 * @param headers - case-insensitive header bag.
 * @param secret - webhook password configured on the Gitee side.
 * @returns verification outcome.
 */
export function verifyGitee(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  const token = headerValue(headers, 'x-gitee-token')
  if (token === undefined) return { ok: false, reason: 'missing x-gitee-token header' }
  return timingSafeEqualText(token, secret)
    ? { ok: true }
    : { ok: false, reason: 'x-gitee-token does not match the configured secret' }
}

/**
 * Verify a generic delivery. Accepts either
 * `x-webhook-signature: sha256=<hex>` or a bare hex SHA-256 of the raw body in
 * the same header, so any sender that can compute an HMAC can use the endpoint.
 * @param body - raw request body.
 * @param headers - case-insensitive header bag.
 * @param secret - shared secret.
 * @returns verification outcome.
 */
export function verifyGeneric(
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  const header = headerValue(headers, 'x-webhook-signature')
    ?? headerValue(headers, 'x-hub-signature-256')
  if (header === undefined) {
    return { ok: false, reason: 'missing x-webhook-signature header' }
  }
  const provided = bareDigest(header, 'sha256')
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return { ok: false, reason: 'x-webhook-signature is not a hex digest' }
  }
  const expected = signPayload(body, secret, 'sha256')
  return timingSafeEqualHex(provided, expected)
    ? { ok: true }
    : { ok: false, reason: 'x-webhook-signature does not match the body' }
}

/**
 * Verify one delivery against the scheme its route declared.
 * @param source - the route's declared upstream.
 * @param body - raw request body.
 * @param headers - case-insensitive header bag.
 * @param secret - resolved shared secret.
 * @returns verification outcome.
 */
export function verifyDelivery(
  source: WebhookSource,
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifyResult {
  if (secret === '') return { ok: false, reason: 'route has no resolved secret' }
  switch (source) {
    case 'github':
      return verifyGithub(body, headers, secret)
    case 'gitlab':
      return verifyGitlab(headers, secret)
    case 'gitee':
      return verifyGitee(headers, secret)
    case 'generic':
      return verifyGeneric(body, headers, secret)
  }
}
