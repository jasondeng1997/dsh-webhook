/**
 * Template and payload tests.
 *
 * The template renderer exists to be boring: no evaluation, no helpers, no way
 * for a payload to reach anything but the output string. These tests pin that
 * property along with the substitution and truncation behaviour users see.
 */

import { describe, expect, it } from 'vitest'
import { placeholdersOf, renderHeaders, renderTemplate, resolvePath, type DeliveryFacts } from '../src/template.ts'
import { parsePayload } from '../src/payload.ts'

const facts: DeliveryFacts = {
  route: 'ci',
  source: 'github',
  event: 'push',
  deliveryId: 'delivery-1',
  receivedAt: '2026-09-29T00:00:00.000Z',
}

describe('resolvePath', () => {
  const data = {
    action: 'opened',
    repository: { full_name: 'owner/repo', owner: { login: 'owner' } },
    commits: [{ id: 'aaa' }, { id: 'bbb' }],
    'odd key': { 'with.dot': 1 },
    count: 0,
    flag: false,
  }

  it('resolves nested fields, array indexes, and quoted segments', () => {
    expect(resolvePath(data, 'action')).toBe('opened')
    expect(resolvePath(data, 'repository.full_name')).toBe('owner/repo')
    expect(resolvePath(data, 'repository.owner.login')).toBe('owner')
    expect(resolvePath(data, 'commits[1].id')).toBe('bbb')
    expect(resolvePath(data, 'commits[0].id')).toBe('aaa')
    expect(resolvePath(data, '["odd key"]["with.dot"]')).toBe(1)
  })

  it('keeps falsy values that are not missing', () => {
    expect(resolvePath(data, 'count')).toBe(0)
    expect(resolvePath(data, 'flag')).toBe(false)
  })

  it('returns undefined instead of throwing for anything unresolved', () => {
    expect(resolvePath(data, 'missing')).toBeUndefined()
    expect(resolvePath(data, 'repository.missing.deep')).toBeUndefined()
    expect(resolvePath(data, 'commits[9].id')).toBeUndefined()
    expect(resolvePath(data, 'action.deep')).toBeUndefined()
    expect(resolvePath(data, 'action..x')).toBeUndefined()
    expect(resolvePath(undefined, 'a')).toBeUndefined()
    expect(resolvePath(data, '')).toBeUndefined()
  })
})

describe('renderTemplate', () => {
  const payload = { action: 'opened', repository: { full_name: 'owner/repo' }, flag: false, count: 0 }

  it('substitutes payload paths and tolerates spacing inside the braces', () => {
    const result = renderTemplate('{{action}} by {{ repository.full_name }}', payload, facts, 1_000)
    expect(result.text).toBe('opened by owner/repo')
    expect(result.missing).toEqual([])
  })

  it('exposes the delivery facts under their reserved names', () => {
    const result = renderTemplate(
      '{{ __route }}/{{ __source }}/{{ __event }}/{{ __deliveryId }}/{{ __receivedAt }}',
      payload,
      facts,
      1_000,
    )
    expect(result.text).toBe('ci/github/push/delivery-1/2026-09-29T00:00:00.000Z')
  })

  it('renders an absent event as an empty string rather than the word undefined', () => {
    const { text } = renderTemplate('event=[{{ __event }}]', payload, { ...facts, event: undefined }, 1_000)
    expect(text).toBe('event=[]')
  })

  it('renders {{ json }} as pretty-printed payload text', () => {
    const { text } = renderTemplate('{{ json }}', payload, facts, 1_000)
    expect(JSON.parse(text)).toEqual(payload)
    expect(text).toContain('\n')
  })

  it('collects unresolved paths once, in first-seen order', () => {
    const { text, missing } = renderTemplate('{{ a }} {{ b }} {{ a }}', payload, facts, 1_000)
    expect(text).toBe('  ')
    expect(missing).toEqual(['a', 'b'])
  })

  it('does not execute anything a payload puts in a template', () => {
    // A payload value that looks like a placeholder is output verbatim and never
    // resolved a second time, so a payload cannot make the renderer recurse.
    const nested = { a: '{{ b }}', b: 'SECRET' }
    expect(renderTemplate('{{ a }}', nested, facts, 1_000).text).toBe('{{ b }}')
  })

  it('truncates long output and says so', () => {
    const roomy = renderTemplate('{{ json }}', payload, facts, 80)
    expect(roomy.truncated).toBe(true)
    expect(roomy.text.length).toBeLessThanOrEqual(80)
    expect(roomy.text).toContain('[truncated')

    // A limit smaller than the notice itself leaves room for neither: the text
    // is cut to size and the flag is the only signal.
    const tight = renderTemplate('{{ json }}', payload, facts, 40)
    expect(tight.truncated).toBe(true)
    expect(tight.text.length).toBeLessThanOrEqual(40)
  })

  it('treats a negative limit as no limit', () => {
    const { text, truncated } = renderTemplate('{{ json }}', payload, facts, -1)
    expect(truncated).toBe(false)
    expect(text).toContain('owner/repo')
  })
})

describe('placeholdersOf', () => {
  it('lists unique placeholder names in order', () => {
    expect(placeholdersOf('{{ a }}{{b}}{{ a }}')).toEqual(['a', 'b'])
    expect(placeholdersOf('no placeholders')).toEqual([])
  })
})

describe('renderHeaders', () => {
  it('renders values and drops dangerous or malformed ones', () => {
    const headers = renderHeaders({
      'x-route': '{{ __route }}',
      'X-Bad Name': 'space in the name',
      'x-injected': 'a\r\nX-Evil: 1',
      host: 'example.com',
      'content-length': '10',
      'x-missing': '{{ nope }}',
    }, { ok: true }, facts, 1_000)
    expect(headers).toEqual({ 'x-route': 'ci', 'x-missing': '' })
  })

  it('returns an empty map when the route declares no headers', () => {
    expect(renderHeaders(undefined, {}, facts, 1_000)).toEqual({})
  })
})

describe('parsePayload', () => {
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8')

  it('parses a JSON body and takes the event from the upstream header', () => {
    const parsed = parsePayload(json({ action: 'opened' }), { 'content-type': 'application/json', 'x-github-event': 'pull_request' }, 'github')
    expect(parsed.contentType).toBe('json')
    expect(parsed.payload).toEqual({ action: 'opened' })
    expect(parsed.event).toBe('pull_request')
  })

  it('falls back to well-known event fields when no header names one', () => {
    expect(parsePayload(json({ object_kind: 'push' }), {}, 'gitlab').event).toBe('push')
    expect(parsePayload(json({ event_type: 'note' }), {}, 'generic').event).toBe('note')
    expect(parsePayload(json({ action: 'closed' }), {}, 'generic').event).toBe('closed')
  })

  it('parses a JSON body that announces no content type', () => {
    const parsed = parsePayload(json({ a: 1 }), {}, 'generic')
    expect(parsed.contentType).toBe('json')
    expect(parsed.payload).toEqual({ a: 1 })
  })

  it('keeps a JSON array reachable under value and raw', () => {
    const parsed = parsePayload(Buffer.from('[1,2]'), { 'content-type': 'application/json' }, 'generic')
    expect(parsed.payload).toEqual({ value: [1, 2], raw: '[1,2]' })
  })

  it('falls back to text when a JSON body cannot be parsed', () => {
    const parsed = parsePayload(Buffer.from('{"broken":'), { 'content-type': 'application/json' }, 'generic')
    expect(parsed.contentType).toBe('text')
    expect(parsed.payload).toEqual({ raw: '{"broken":' })
  })

  it('parses form-encoded bodies, including repeated keys', () => {
    const parsed = parsePayload(
      Buffer.from('a=1&b=hello+world&b=second&empty='),
      { 'content-type': 'application/x-www-form-urlencoded' },
      'gitlab',
    )
    expect(parsed.contentType).toBe('form')
    expect(parsed.payload).toEqual({ a: '1', b: ['hello world', 'second'], empty: '' })
  })

  it('keeps an unknown body as raw text and still reports the header event', () => {
    const parsed = parsePayload(Buffer.from('plain text body'), { 'x-webhook-event': 'ping' }, 'generic')
    expect(parsed.contentType).toBe('text')
    expect(parsed.payload).toEqual({ raw: 'plain text body' })
    expect(parsed.event).toBe('ping')
  })

  it('reads an empty body without failing', () => {
    const parsed = parsePayload(Buffer.alloc(0), {}, 'generic')
    expect(parsed.contentType).toBe('text')
    expect(parsed.payload).toEqual({ raw: '' })
    expect(parsed.event).toBeUndefined()
  })
})
