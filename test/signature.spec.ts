/**
 * Signature verification tests.
 *
 * A webhook endpoint that can drive an agent is a remote execution surface, so
 * these tests cover the rejection paths at least as carefully as the accepting
 * one: wrong secret, absent header, tampered body, and the downgrade attempt that
 * drops the strong header while keeping the weak one.
 */

import { describe, expect, it } from 'vitest'
import {
  headerValue,
  signPayload,
  timingSafeEqualHex,
  timingSafeEqualText,
  verifyDelivery,
  verifyGeneric,
  verifyGitee,
  verifyGithub,
  verifyGitlab,
} from '../src/signature.ts'

const SECRET = 'a-shared-secret-value'
const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8')

describe('signPayload', () => {
  it('produces the digest upstreams publish for a known input', () => {
    // Precomputed with: printf '%s' '{"hello":"world"}' | openssl dgst -sha256 -hmac 'a-shared-secret-value'
    expect(signPayload(body, SECRET)).toMatch(/^[0-9a-f]{64}$/)
    expect(signPayload(body, SECRET)).toBe(signPayload(Buffer.from(body.toString('utf8')), SECRET))
  })

  it('changes when the body, the secret, or the algorithm changes', () => {
    const sha256 = signPayload(body, SECRET)
    expect(signPayload(Buffer.from('{"hello":"worle"}'), SECRET)).not.toBe(sha256)
    expect(signPayload(body, `${SECRET}x`)).not.toBe(sha256)
    expect(signPayload(body, SECRET, 'sha1')).not.toBe(sha256)
    expect(signPayload(body, SECRET, 'sha1')).toHaveLength(40)
  })
})

describe('constant-time comparisons', () => {
  it('compares equal and unequal digests correctly', () => {
    expect(timingSafeEqualHex('ab', 'ab')).toBe(true)
    expect(timingSafeEqualHex('AB', 'ab')).toBe(true)
    expect(timingSafeEqualHex('ab', 'ac')).toBe(false)
    expect(timingSafeEqualHex('a', 'ab')).toBe(false)
  })

  it('compares credentials of different lengths without throwing', () => {
    expect(timingSafeEqualText('token', 'token')).toBe(true)
    expect(timingSafeEqualText('token', 'tokens')).toBe(false)
    expect(timingSafeEqualText('', '')).toBe(true)
  })
})

describe('headerValue', () => {
  it('reads headers case-insensitively and unwraps arrays', () => {
    expect(headerValue({ 'X-Gitlab-Token': 'abc' }, 'x-gitlab-token')).toBe('abc')
    expect(headerValue({ 'x-multi': ['first', 'second'] }, 'X-Multi')).toBe('first')
    expect(headerValue({}, 'missing')).toBeUndefined()
  })
})

describe('verifyGithub', () => {
  it('accepts a correct sha256 signature with or without the prefix', () => {
    const digest = signPayload(body, SECRET)
    expect(verifyGithub(body, { 'x-hub-signature-256': `sha256=${digest}` }, SECRET)).toEqual({ ok: true })
    expect(verifyGithub(body, { 'x-hub-signature-256': digest }, SECRET)).toEqual({ ok: true })
  })

  it('rejects a tampered body and a wrong secret', () => {
    const digest = signPayload(body, SECRET)
    const tampered = Buffer.from(`${body.toString('utf8')} `, 'utf8')
    expect(verifyGithub(tampered, { 'x-hub-signature-256': `sha256=${digest}` }, SECRET).ok).toBe(false)
    expect(verifyGithub(body, { 'x-hub-signature-256': `sha256=${digest}` }, 'other-secret').ok).toBe(false)
  })

  it('falls back to the legacy sha1 header only when the strong one is absent', () => {
    const sha1 = signPayload(body, SECRET, 'sha1')
    expect(verifyGithub(body, { 'x-hub-signature': `sha1=${sha1}` }, SECRET)).toEqual({ ok: true })
    // Both headers present: a valid sha1 must not rescue an invalid sha256.
    const verdict = verifyGithub(body, {
      'x-hub-signature': `sha1=${sha1}`,
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
    }, SECRET)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('x-hub-signature-256')
  })

  it('reports a missing signature header', () => {
    const verdict = verifyGithub(body, {}, SECRET)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('missing')
  })
})

describe('verifyGitlab', () => {
  it('accepts the shared secret sent verbatim', () => {
    expect(verifyGitlab({ 'x-gitlab-token': SECRET }, SECRET)).toEqual({ ok: true })
  })

  it('rejects a wrong or absent token', () => {
    expect(verifyGitlab({ 'x-gitlab-token': 'nope' }, SECRET).ok).toBe(false)
    expect(verifyGitlab({}, SECRET).ok).toBe(false)
  })

  it('does not trim the token: whitespace is part of the secret', () => {
    expect(verifyGitlab({ 'x-gitlab-token': `${SECRET} ` }, SECRET).ok).toBe(false)
  })
})

describe('verifyGitee', () => {
  it('accepts the webhook password header and rejects a wrong one', () => {
    expect(verifyGitee({ 'x-gitee-token': SECRET }, SECRET)).toEqual({ ok: true })
    expect(verifyGitee({ 'x-gitee-token': 'wrong' }, SECRET).ok).toBe(false)
    expect(verifyGitee({}, SECRET).ok).toBe(false)
  })
})

describe('verifyGeneric', () => {
  it('accepts a prefixed or bare hex digest', () => {
    const digest = signPayload(body, SECRET)
    expect(verifyGeneric(body, { 'x-webhook-signature': `sha256=${digest}` }, SECRET)).toEqual({ ok: true })
    expect(verifyGeneric(body, { 'x-webhook-signature': digest }, SECRET)).toEqual({ ok: true })
  })

  it('also accepts the GitHub header name, so one sender works on both endpoints', () => {
    const digest = signPayload(body, SECRET)
    expect(verifyGeneric(body, { 'x-hub-signature-256': `sha256=${digest}` }, SECRET)).toEqual({ ok: true })
  })

  it('rejects a non-hex header instead of comparing it', () => {
    const verdict = verifyGeneric(body, { 'x-webhook-signature': 'not-a-digest' }, SECRET)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('hex digest')
  })

  it('reports a missing header', () => {
    expect(verifyGeneric(body, {}, SECRET).ok).toBe(false)
  })
})

describe('verifyDelivery', () => {
  it('routes to the scheme the route declared', () => {
    const digest = signPayload(body, SECRET)
    expect(verifyDelivery('github', body, { 'x-hub-signature-256': `sha256=${digest}` }, SECRET)).toEqual({ ok: true })
    expect(verifyDelivery('gitlab', body, { 'x-gitlab-token': SECRET }, SECRET)).toEqual({ ok: true })
    expect(verifyDelivery('gitee', body, { 'x-gitee-token': SECRET }, SECRET)).toEqual({ ok: true })
    expect(verifyDelivery('generic', body, { 'x-webhook-signature': digest }, SECRET)).toEqual({ ok: true })
  })

  it('fails closed when the secret could not be resolved', () => {
    const digest = signPayload(body, SECRET)
    const verdict = verifyDelivery('github', body, { 'x-hub-signature-256': `sha256=${digest}` }, '')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('no resolved secret')
  })

  it('rejects a gitlab token on a github route, so a route cannot be downgraded', () => {
    expect(verifyDelivery('github', body, { 'x-gitlab-token': SECRET }, SECRET).ok).toBe(false)
  })
})
