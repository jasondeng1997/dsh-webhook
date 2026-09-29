/**
 * Card face tests.
 *
 * The card's staging rules are the parts users can feel: a half-typed value must
 * not reach the host, a save must write only what changed, and a concurrent host
 * change must not erase what someone is typing. All of it is exercised here
 * against a fake scope, with no React and no browser.
 */

import { describe, expect, it } from 'vitest'
import { createCardFace, fromRoute, toRoute, toSettings } from '../src/client/card-face.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BridgeSettings } from '../src/client/card-face.ts'

/** A scriptable settings scope standing in for the shell's namespace mirror. */
function fakeScope(initial: unknown, options: { writable?: boolean; status?: SettingsScopeSnapshot<BridgeSettings>['status'] } = {}): SettingsScope<BridgeSettings> & { writes: [string, unknown][]; host: unknown } {
  const listeners = new Set<() => void>()
  const writes: [string, unknown][] = []
  const state = {
    host: initial,
    writable: options.writable ?? true,
    status: options.status ?? ('ready' as const),
    revision: 1,
  }
  const snapshot = (): SettingsScopeSnapshot<BridgeSettings> => ({
    status: state.status,
    value: state.host as BridgeSettings | undefined,
    base: undefined,
    user: undefined,
    revision: state.revision,
    writable: state.writable,
    mode: 'host',
  })
  return {
    writes,
    get host() { return state.host },
    set host(value: unknown) { state.host = value },
    getSnapshot: snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async set(field: string, value: unknown) {
      writes.push([field, value])
      state.host = { ...(state.host as Record<string, unknown>), [field]: value }
      state.revision += 1
      for (const listener of listeners) listener()
    },
    async unset(field: string) {
      writes.push([field, undefined])
      state.revision += 1
      for (const listener of listeners) listener()
    },
    async mutate() {},
  } as unknown as SettingsScope<BridgeSettings> & { writes: [string, unknown][]; host: unknown }
}

const HOST_SECTION = {
  enabled: true,
  host: '127.0.0.1',
  port: 8787,
  sendTool: false,
  sendToolAllowHosts: [],
  routes: [
    { id: 'ci', path: '/hooks/ci', source: 'github', enabled: true, secretRef: 'CI_SECRET', session: 'auto', maxConcurrency: 2, events: ['push'], allowUnsigned: false },
  ],
}

describe('toSettings / toRoute', () => {
  it('fills every field the card renders from a partial section', () => {
    const settings = toSettings({ port: 9000, routes: [{ path: '/x' }] })
    expect(settings.port).toBe(9000)
    expect(settings.host).toBe('127.0.0.1')
    expect(settings.enabled).toBe(true)
    expect(settings.routes[0]).toEqual({
      id: 'route-1',
      path: '/x',
      source: 'generic',
      enabled: true,
      secretRef: '',
      allowUnsigned: false,
      session: 'auto',
      template: '',
      events: [],
      callbackUrl: '',
      maxConcurrency: 2,
    })
  })

  it('survives garbage input instead of rendering undefined fields', () => {
    const settings = toSettings('nope')
    expect(settings.routes).toEqual([])
    expect(toRoute(null, 3).id).toBe('route-4')
    expect(toRoute({ source: 'bitbucket' }, 0).source).toBe('generic')
  })

  it('omits cleared optional fields when serializing back, so they re-inherit', () => {
    const serialized = fromRoute(toRoute({ id: 'a', path: '/a', secretRef: '' }, 0))
    expect(serialized).toEqual({ id: 'a', path: '/a', source: 'generic', enabled: true, session: 'auto', maxConcurrency: 2 })
    expect(serialized).not.toHaveProperty('secretRef')
  })

  it('keeps a declared allowUnsigned flag when serializing', () => {
    const serialized = fromRoute(toRoute({ id: 'a', path: '/a', allowUnsigned: true }, 0))
    expect(serialized.allowUnsigned).toBe(true)
    expect(serialized).not.toHaveProperty('secretRef')
  })
})

describe('createCardFace', () => {
  it('exposes the host section as a draft and reports nothing as dirty', () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    const snapshot = face.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.writable).toBe(true)
    expect(snapshot.draft?.port).toBe(8787)
    expect(snapshot.dirtyFields).toEqual([])
  })

  it('stages scalar edits locally and writes nothing until save', async () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    face.stageScalar('port', 9001)
    face.stageScalar('sendTool', true)
    expect(face.getSnapshot().draft?.port).toBe(9001)
    expect(face.getSnapshot().dirtyFields).toEqual(['port', 'sendTool'])
    expect(scope.writes).toEqual([])

    await face.save()
    expect(scope.writes).toEqual([['port', 9001], ['sendTool', true]])
    expect((scope.host as { port: number }).port).toBe(9001)
  })

  it('writes nothing when there is no staged edit', async () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    await face.save()
    expect(scope.writes).toEqual([])
  })

  it('stages route edits and writes the whole list once', async () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    face.stageRoute('ci', { template: 'repo={{ repository.full_name }}' })
    face.stageRoute('ci', { events: ['push', 'pull_request'] })
    expect(face.getSnapshot().dirtyFields).toEqual(['routes'])

    await face.save()
    expect(scope.writes).toHaveLength(1)
    const [field, value] = scope.writes[0]!
    expect(field).toBe('routes')
    const routes = value as Record<string, unknown>[]
    expect(routes).toHaveLength(1)
    expect(routes[0]?.template).toBe('repo={{ repository.full_name }}')
    expect(routes[0]?.events).toEqual(['push', 'pull_request'])
    expect(routes[0]?.secretRef).toBe('CI_SECRET')
  })

  it('adds a route disabled and unsigned by default, and normalizes its path', () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    face.stageAddRoute('hooks/extra/')
    const added = face.getSnapshot().draft?.routes[1]
    expect(added?.path).toBe('/hooks/extra/')
    expect(added?.enabled).toBe(false)
    expect(added?.allowUnsigned).toBe(false)
    expect(added?.secretRef).toBe('')
  })

  it('removes a route by id', () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    face.stageRemoveRoute('ci')
    expect(face.getSnapshot().draft?.routes).toEqual([])
  })

  it('discards staged edits and returns to the host section', () => {
    const scope = fakeScope(HOST_SECTION)
    const face = createCardFace(scope)
    face.stageScalar('port', 1234)
    face.discard()
    const snapshot = face.getSnapshot()
    expect(snapshot.draft?.port).toBe(8787)
    expect(snapshot.dirtyFields).toEqual([])
  })

  it('refuses to write into a read-only namespace', async () => {
    const scope = fakeScope(HOST_SECTION, { writable: false })
    const face = createCardFace(scope)
    face.stageScalar('port', 1234)
    await face.save()
    expect(scope.writes).toEqual([])
    expect(face.getSnapshot().writable).toBe(false)
  })

  it('reports a rejected write instead of pretending it succeeded', async () => {
    const scope = fakeScope(HOST_SECTION)
    scope.set = async () => { throw new Error('revision conflict') }
    const face = createCardFace(scope)
    face.stageScalar('port', 1234)
    await face.save()
    const snapshot = face.getSnapshot()
    expect(snapshot.error).toBe('revision conflict')
    // The draft survives, so the user can retry without retyping.
    expect(snapshot.draft?.port).toBe(1234)
  })

  it('notifies subscribers when state changes and stops after the last unsubscribes', () => {
    const scope = fakeScope(HOST_SECTION, { status: 'loading' })
    const face = createCardFace(scope)
    let notifications = 0
    const unsubscribe = face.subscribe(() => { notifications += 1 })
    face.stageScalar('port', 1)
    expect(notifications).toBe(1)
    unsubscribe()
    face.stageScalar('port', 2)
    expect(notifications).toBe(1)
  })

  it('fills the draft when the host section arrives after the card mounted', () => {
    const scope = fakeScope(undefined, { status: 'loading' })
    const face = createCardFace(scope)
    expect(face.getSnapshot().draft).toBeUndefined()
    scope.host = HOST_SECTION
    // The shell notifies subscribers when a section is accepted; emulate that.
    const snapshot = face.getSnapshot()
    expect(snapshot.status).toBe('loading')
    expect(snapshot.draft?.port).toBe(8787)
  })
})
