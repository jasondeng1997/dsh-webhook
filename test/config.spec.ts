/**
 * Configuration normalization tests.
 *
 * These pin the behaviour a deployment depends on: defaults are applied, a
 * malformed route is dropped with a reason instead of taking the boot down, and
 * every security-relevant omission is reported rather than silently accepted.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTO_SESSION,
  DEFAULT_CONFIG,
  eventAllowed,
  normalizeConfig,
  normalizePath,
  type RouteConfig,
} from '../src/config.ts'

describe('normalizeConfig', () => {
  it('applies every default to an empty configuration', () => {
    const { config } = normalizeConfig(undefined)
    expect(config.enabled).toBe(DEFAULT_CONFIG.enabled)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8787)
    expect(config.maxBodyBytes).toBe(DEFAULT_CONFIG.maxBodyBytes)
    expect(config.routes).toEqual([])
  })

  it('treats a non-object configuration as empty rather than throwing', () => {
    expect(normalizeConfig('nonsense').config.port).toBe(DEFAULT_CONFIG.port)
    expect(normalizeConfig(null).config.port).toBe(DEFAULT_CONFIG.port)
  })

  it('clamps numeric fields into their documented ranges', () => {
    const { config } = normalizeConfig({
      port: 999_999,
      maxBodyBytes: 1,
      callbackAttempts: 99,
      deliveryLogSize: -5,
    })
    expect(config.port).toBe(65_535)
    expect(config.maxBodyBytes).toBe(1_024)
    expect(config.callbackAttempts).toBe(10)
    expect(config.deliveryLogSize).toBe(0)
  })

  it('reports that no route is configured', () => {
    const { problems } = normalizeConfig({})
    expect(problems.some((problem) => problem.field === 'routes')).toBe(true)
  })

  it('drops a route without an id, path, or known source, naming the field', () => {
    const { config, problems } = normalizeConfig({
      routes: [
        { path: '/hooks/a', secretRef: 'A_SECRET' },
        { id: 'b', secretRef: 'B_SECRET' },
        { id: 'c', path: '/hooks/c', source: 'bitbucket', secretRef: 'C_SECRET' },
        { id: 'd', path: '/hooks/d', source: 'github' },
      ],
    })
    expect(config.routes.map((route) => route.id)).toEqual(['d'])
    expect(problems.map((problem) => problem.field)).toContain('routes[0].id')
    expect(problems.map((problem) => problem.field)).toContain('routes[1].path')
    expect(problems.map((problem) => problem.field)).toContain('routes[2].source')
    expect(problems.map((problem) => problem.field)).toContain('routes[3].secretRef')
  })

  it('keeps the first route and drops later duplicates of the same id or path', () => {
    const { config, problems } = normalizeConfig({
      routes: [
        { id: 'same', path: '/hooks/a', secretRef: 'S' },
        { id: 'same', path: '/hooks/b', secretRef: 'S' },
        { id: 'other', path: '/hooks/a', secretRef: 'S' },
      ],
    })
    expect(config.routes.map((route) => route.id)).toEqual(['same'])
    expect(problems.filter((problem) => problem.message.includes('duplicate'))).toHaveLength(2)
  })

  it('normalizes paths and rejects the ones a route cannot answer', () => {
    expect(normalizePath('hooks/ci/')).toBe('/hooks/ci')
    expect(normalizePath('//hooks//ci')).toBe('/hooks/ci')
    expect(normalizePath('')).toBe('/')

    const { config, problems } = normalizeConfig({
      routes: [
        { id: 'root', path: '/', secretRef: 'S' },
        { id: 'query', path: '/hooks/a?x=1', secretRef: 'S' },
        { id: 'ok', path: 'hooks/ci/', secretRef: 'S' },
      ],
    })
    expect(config.routes.map((route) => route.id)).toEqual(['ok'])
    expect(config.routes[0]?.path).toBe('/hooks/ci')
    expect(problems.filter((problem) => problem.field.endsWith('.path'))).toHaveLength(2)
  })

  it('warns when a route declares no secret and does not allow unsigned deliveries', () => {
    const { config, problems } = normalizeConfig({ routes: [{ id: 'a', path: '/hooks/a' }] })
    expect(config.routes).toHaveLength(1)
    expect(config.routes[0]?.allowUnsigned).toBe(false)
    expect(problems.some((problem) => problem.field === 'routes[0].secretRef')).toBe(true)
  })

  it('warns that an inline secret lives in the configuration tree', () => {
    const { problems } = normalizeConfig({
      routes: [{ id: 'a', path: '/hooks/a', secret: 'inline-shared-secret' }],
    })
    expect(problems.some((problem) => problem.field === 'routes[0].secret')).toBe(true)
  })

  it('prefers secretRef over an inline secret and says so', () => {
    const { config, problems } = normalizeConfig({
      routes: [{ id: 'a', path: '/hooks/a', secretRef: 'FROM_STORE', secret: 'inline' }],
    })
    expect(config.routes[0]?.secretRef).toBe('FROM_STORE')
    expect(config.routes[0]?.secret).toBeUndefined()
    expect(problems.some((problem) => problem.message.includes('secretRef wins'))).toBe(true)
  })

  it('accepts an unsigned endpoint but reports the exposure', () => {
    const { config, problems } = normalizeConfig({
      routes: [{ id: 'a', path: '/hooks/a', allowUnsigned: true }],
    })
    expect(config.routes[0]?.allowUnsigned).toBe(true)
    expect(problems.some((problem) => problem.field === 'routes[0].allowUnsigned')).toBe(true)
  })

  it('defaults the session binding to auto and accepts an explicit session id', () => {
    const { config } = normalizeConfig({
      routes: [
        { id: 'auto', path: '/hooks/a', secretRef: 'S' },
        { id: 'fixed', path: '/hooks/b', secretRef: 'S', session: 'session-42' },
      ],
    })
    expect(config.routes[0]?.session).toBe(AUTO_SESSION)
    expect(config.routes[1]?.session).toBe('session-42')
  })

  it('rejects an unparseable or unsupported callback URL', () => {
    const { config, problems } = normalizeConfig({
      routes: [
        { id: 'bad', path: '/hooks/a', secretRef: 'S', callbackUrl: 'not a url' },
        { id: 'scheme', path: '/hooks/b', secretRef: 'S', callbackUrl: 'ftp://example.com/x' },
      ],
    })
    expect(config.routes).toHaveLength(0)
    expect(problems.filter((problem) => problem.field.includes('callbackUrl'))).toHaveLength(2)
  })

  it('infers callback reply mode from a callback URL and warns when nothing will be posted', () => {
    const withUrl = normalizeConfig({
      routes: [{ id: 'a', path: '/hooks/a', secretRef: 'S', callbackUrl: 'https://example.com/reply' }],
    })
    expect(withUrl.config.routes[0]?.replyMode).toBe('callback')

    const forced = normalizeConfig({
      routes: [{ id: 'b', path: '/hooks/b', secretRef: 'S', replyMode: 'callback' }],
    })
    expect(forced.problems.some((problem) => problem.field === 'routes[0].callbackUrl')).toBe(true)
  })

  it('drops non-string header values and keeps the rest', () => {
    const { config, problems } = normalizeConfig({
      routes: [{
        id: 'a',
        path: '/hooks/a',
        secretRef: 'S',
        callbackUrl: 'https://example.com/reply',
        callbackHeaders: { 'x-ok': 'yes', 'x-bad': 5 },
      }],
    })
    expect(config.routes[0]?.callbackHeaders).toEqual({ 'x-ok': 'yes' })
    expect(problems.some((problem) => problem.field === 'routes[0].callbackHeaders.x-bad')).toBe(true)
  })

  it('reports a workspace on a route that does not create its own session', () => {
    const { problems } = normalizeConfig({
      routes: [{ id: 'a', path: '/hooks/a', secretRef: 'S', session: 'session-1', workspace: '/tmp/w' }],
    })
    expect(problems.some((problem) => problem.field === 'routes[0].workspace')).toBe(true)
  })
})

describe('eventAllowed', () => {
  const route = (events?: string[]): RouteConfig => ({
    id: 'a',
    path: '/hooks/a',
    source: 'generic',
    ...(events === undefined ? {} : { events }),
  })

  it('accepts everything when no filter is declared', () => {
    expect(eventAllowed(route(), 'push')).toBe(true)
    expect(eventAllowed(route(), undefined)).toBe(true)
    expect(eventAllowed(route([]), undefined)).toBe(true)
  })

  it('matches case-insensitively and rejects unknown events', () => {
    expect(eventAllowed(route(['push']), 'PUSH')).toBe(true)
    expect(eventAllowed(route(['push']), 'pull_request')).toBe(false)
    expect(eventAllowed(route(['push']), undefined)).toBe(false)
  })
})
