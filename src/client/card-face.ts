/**
 * The card's state face.
 *
 * Two layers of state meet here, and keeping them apart is the whole point:
 *
 * - **Host state** — the settings namespace's durably stored section, read from
 *   the shell's settings mirror. The card never caches a second copy of it.
 * - **Draft state** — what the user has typed but not saved. Edits are staged
 *   locally so a half-typed port number never reaches the host, and a save
 *   writes one revision-fenced mutation per changed field.
 *
 * This module is plain TypeScript with no React import, so the staging rules are
 * unit-testable and the rendering component stays a rendering component.
 *
 * @module dsh-webhook/client/card-face
 */

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** One route as the card edits it: the host schema's fields, all optional-but-typed. */
export interface BridgeRouteSettings {
  id: string
  path: string
  source: 'github' | 'gitlab' | 'gitee' | 'generic'
  enabled: boolean
  secretRef: string
  allowUnsigned: boolean
  session: string
  template: string
  events: string[]
  callbackUrl: string
  maxConcurrency: number
}

/** The subset of the host configuration the card edits. */
export interface BridgeSettings {
  enabled: boolean
  host: string
  port: number
  sendTool: boolean
  sendToolAllowHosts: string[]
  routes: BridgeRouteSettings[]
}

/** What the card renders from. */
export interface BridgeCardSnapshot {
  /** Namespace sync state: `loading` before the first section arrives. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the host document accepts writes. */
  writable: boolean
  /** Effective configuration as the host resolved it; undefined while loading. */
  value: BridgeSettings | undefined
  /** Staged edits layered over {@link value}; what the form renders. */
  draft: BridgeSettings | undefined
  /** Fields changed but not yet saved. */
  dirtyFields: string[]
  /** True while a save is in flight. */
  saving: boolean
  /** Failure text from the last rejected write, when there was one. */
  error: string | undefined
}

/** Editable scalar fields of the namespace section. */
export type ScalarField = 'enabled' | 'host' | 'port' | 'sendTool' | 'sendToolAllowHosts'

/** The face the card consumes. */
export interface BridgeCardFace {
  subscribe(listener: () => void): () => void
  getSnapshot(): BridgeCardSnapshot
  /** Stage a scalar edit. */
  stageScalar(field: ScalarField, value: unknown): void
  /** Stage a route insertion; the new route starts disabled and unsigned. */
  stageAddRoute(path: string): void
  /** Stage a route removal by id. */
  stageRemoveRoute(id: string): void
  /** Stage one field of one route. */
  stageRoute(id: string, patch: Partial<BridgeRouteSettings>): void
  /** Write every staged edit, then drop the drafts. */
  save(): Promise<void>
  /** Drop every staged edit. */
  discard(): void
}

/** Route fields the host schema validates as required strings. */
const ROUTE_STRING_FIELDS = ['id', 'path', 'source', 'session', 'template', 'callbackUrl', 'secretRef'] as const

/** Normalize whatever the host sent into the card's editing shape. */
export function toSettings(value: unknown): BridgeSettings {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const routes = Array.isArray(input.routes) ? input.routes : []
  return {
    enabled: input.enabled !== false,
    host: typeof input.host === 'string' ? input.host : '127.0.0.1',
    port: typeof input.port === 'number' ? input.port : 8787,
    sendTool: input.sendTool === true,
    sendToolAllowHosts: Array.isArray(input.sendToolAllowHosts)
      ? input.sendToolAllowHosts.filter((host): host is string => typeof host === 'string')
      : [],
    routes: routes.map((entry, index) => toRoute(entry, index)),
  }
}

/** Normalize one route entry, filling the fields the card renders. */
export function toRoute(entry: unknown, index: number): BridgeRouteSettings {
  const input = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
  const source = input.source
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : `route-${index + 1}`,
    path: typeof input.path === 'string' ? input.path : '',
    source: source === 'github' || source === 'gitlab' || source === 'gitee' ? source : 'generic',
    enabled: input.enabled !== false,
    secretRef: typeof input.secretRef === 'string' ? input.secretRef : '',
    allowUnsigned: input.allowUnsigned === true,
    session: typeof input.session === 'string' && input.session !== '' ? input.session : 'auto',
    template: typeof input.template === 'string' ? input.template : '',
    events: Array.isArray(input.events) ? input.events.filter((event): event is string => typeof event === 'string') : [],
    callbackUrl: typeof input.callbackUrl === 'string' ? input.callbackUrl : '',
    maxConcurrency: typeof input.maxConcurrency === 'number' ? input.maxConcurrency : 2,
  }
}

/** Serialize one route back to the shape the host schema validates. */
export function fromRoute(route: BridgeRouteSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: route.id,
    path: route.path,
    source: route.source,
    enabled: route.enabled,
    session: route.session,
    maxConcurrency: route.maxConcurrency,
  }
  if (route.allowUnsigned) out.allowUnsigned = true
  // Empty strings are omitted rather than written: a cleared optional field
  // should re-inherit the composition layer, not override it with "".
  if (route.secretRef !== '') out.secretRef = route.secretRef
  if (route.template !== '') out.template = route.template
  if (route.events.length > 0) out.events = route.events
  if (route.callbackUrl !== '') out.callbackUrl = route.callbackUrl
  return out
}

/** Stable identity for a staged route draft. */
let draftCounter = 0
/** Mint an id for a route the user is adding. */
function nextRouteId(): string {
  draftCounter += 1
  return `route-${Date.now().toString(36)}-${draftCounter}`
}

/**
 * Build the card face over one namespace scope.
 * @param scope - the namespace-bound settings scope from `ctx.settingsScope`.
 * @returns the face the card renders and writes through.
 */
export function createCardFace(scope: SettingsScope<BridgeSettings>): BridgeCardFace {
  const listeners = new Set<() => void>()
  /** The host section as last read from the namespace mirror. */
  let fresh: BridgeSettings | undefined
  /** Scalar fields the user changed but has not saved. */
  const stagedScalars = new Map<ScalarField, unknown>()
  /** Route list the user changed, when they changed it. */
  let stagedRoutes: BridgeRouteSettings[] | undefined
  let saving = false
  let error: string | undefined
  let revision: number | undefined
  /** Bumped by every staged edit, so a rebuild can tell drafts apart. */
  let stagedVersion = 0
  /** Bumped whenever the host section is re-read, so a rebuild can tell values apart. */
  let hostVersion = 0
  let cache: BridgeCardSnapshot | undefined
  let cacheKey = ''
  let lastPublished: BridgeCardSnapshot | undefined

  const refreshHost = (): void => {
    const snapshot = scope.getSnapshot()
    fresh = snapshot.value === undefined ? undefined : toSettings(snapshot.value)
    revision = snapshot.revision
    hostVersion += 1
  }

  /**
   * Compose what the form shows: the host section with the staged edits on top.
   *
   * Keeping the two layers separate is what makes a concurrent host change
   * harmless — a write from another browser replaces the host layer and leaves
   * the staged edits exactly as the user left them.
   */
  const composeDraft = (): BridgeSettings | undefined => {
    if (fresh === undefined) return undefined
    const scalars = Object.fromEntries(stagedScalars) as Partial<BridgeSettings>
    return {
      ...fresh,
      ...scalars,
      ...(stagedRoutes === undefined ? {} : { routes: stagedRoutes }),
    }
  }

  const dirtyFields = (): string[] => {
    const fields: string[] = [...stagedScalars.keys()]
    if (stagedRoutes !== undefined) fields.push('routes')
    return fields.sort()
  }

  const buildSnapshot = (): BridgeCardSnapshot => {
    const snapshot = scope.getSnapshot()
    // A newer revision — or the arrival of a first section — refreshes the host layer.
    if (revision !== snapshot.revision || (fresh === undefined && snapshot.value !== undefined)) {
      refreshHost()
    }
    const dirty = dirtyFields()
    const key = [
      snapshot.status,
      String(snapshot.writable),
      String(snapshot.revision),
      String(hostVersion),
      String(stagedVersion),
      String(saving),
      error ?? '',
      dirty.join(','),
    ].join('|')
    if (cache !== undefined && cacheKey === key) return cache
    cache = {
      status: snapshot.status,
      writable: snapshot.writable,
      value: fresh,
      draft: composeDraft(),
      dirtyFields: dirty,
      saving,
      error,
    }
    cacheKey = key
    return cache
  }

  /** Rebuild and notify subscribers when anything they render actually changed. */
  const publish = (): void => {
    const next = buildSnapshot()
    if (next === lastPublished) return
    lastPublished = next
    for (const listener of listeners) listener()
  }

  const unsubscribeScope = scope.subscribe(() => { publish() })

  /** Apply one staged change over the routes the form currently shows. */
  const currentRoutes = (): BridgeRouteSettings[] => stagedRoutes ?? fresh?.routes ?? []

  const stageRoutes = (next: BridgeRouteSettings[]): void => {
    stagedRoutes = next
    stagedVersion += 1
    publish()
  }

  publish()

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) unsubscribeScope()
      }
    },

    getSnapshot(): BridgeCardSnapshot {
      return buildSnapshot()
    },

    stageScalar(field: ScalarField, value: unknown): void {
      if (fresh === undefined) return
      switch (field) {
        case 'enabled':
          stagedScalars.set('enabled', value === true)
          break
        case 'host':
          stagedScalars.set('host', String(value))
          break
        case 'port':
          if (typeof value === 'number' && Number.isFinite(value)) stagedScalars.set('port', value)
          break
        case 'sendTool':
          stagedScalars.set('sendTool', value === true)
          break
        case 'sendToolAllowHosts':
          stagedScalars.set(
            'sendToolAllowHosts',
            Array.isArray(value)
              ? value.filter((host): host is string => typeof host === 'string' && host.trim() !== '')
              : [],
          )
          break
      }
      stagedVersion += 1
      publish()
    },

    stageAddRoute(path: string): void {
      const trimmed = path.trim()
      stageRoutes([...currentRoutes(), {
        id: nextRouteId(),
        path: trimmed === '' ? '/' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`,
        source: 'generic',
        enabled: false,
        secretRef: '',
        allowUnsigned: false,
        session: 'auto',
        template: '',
        events: [],
        callbackUrl: '',
        maxConcurrency: 2,
      }])
    },

    stageRemoveRoute(id: string): void {
      stageRoutes(currentRoutes().filter((route) => route.id !== id))
    },

    stageRoute(id: string, patch: Partial<BridgeRouteSettings>): void {
      stageRoutes(currentRoutes().map((route) => (route.id === id ? { ...route, ...patch } : route)))
    },

    async save(): Promise<void> {
      if (fresh === undefined || scope.getSnapshot().writable !== true) return
      const fields = dirtyFields()
      if (fields.length === 0) return
      const draft = composeDraft()
      /* v8 ignore next -- `fresh` was checked above, so the composition exists. */
      if (draft === undefined) return
      saving = true
      error = undefined
      publish()
      try {
        if (stagedScalars.has('enabled')) await scope.set('enabled', draft.enabled)
        if (stagedScalars.has('host')) await scope.set('host', draft.host)
        if (stagedScalars.has('port')) await scope.set('port', draft.port)
        if (stagedScalars.has('sendTool')) await scope.set('sendTool', draft.sendTool)
        if (stagedScalars.has('sendToolAllowHosts')) {
          await scope.set('sendToolAllowHosts', draft.sendToolAllowHosts)
        }
        if (stagedRoutes !== undefined) {
          await scope.set('routes', draft.routes.map(fromRoute))
        }
        // The host answers with a fresh revision, so the staged layer is now
        // redundant: dropping it lets the form follow the stored value.
        stagedScalars.clear()
        stagedRoutes = undefined
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      } finally {
        saving = false
        stagedVersion += 1
        publish()
      }
    },

    discard(): void {
      stagedScalars.clear()
      stagedRoutes = undefined
      error = undefined
      stagedVersion += 1
      publish()
    },
  }
}

/** Route fields the card writes back unchanged, exported for its validation hints. */
export const ROUTE_FIELDS_WRITTEN = ROUTE_STRING_FIELDS
