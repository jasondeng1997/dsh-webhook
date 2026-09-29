/**
 * Configuration shape, defaults, and validation for the webhook bridge.
 *
 * Everything in this module is host-agnostic and free of harness imports, so
 * the routing rules can be unit-tested without a running harness. The loader's
 * schemastery schema in `src/index.ts` is a mirror of these types; this file
 * stays the single source of truth for defaults and for the cross-field checks
 * a schema cannot express (duplicate paths, unknown session ids, unreachable
 * callbacks).
 *
 * @module dsh-webhook/config
 */

/** Upstream services whose signature scheme the receiver knows natively. */
export type WebhookSource = 'github' | 'gitlab' | 'gitee' | 'generic'

/** What the bridge does with the agent's answer. */
export type ReplyMode = 'none' | 'callback'

/** Session binding strategy for a route. */
export type SessionBinding = 'auto' | 'per-session-id'

/** One inbound endpoint and everything the bridge does with its payloads. */
export interface RouteConfig {
  /** Stable identifier used in logs, delivery records, and the settings card. */
  id: string
  /** URL path the endpoint answers, e.g. `/hooks/ci`. */
  path: string
  /** Signature scheme applied to this endpoint. */
  source: WebhookSource
  /** Whether the endpoint accepts deliveries. Disabled routes answer no traffic at all. */
  enabled?: boolean
  /**
   * Name of a stored credential holding the shared secret. Resolved per request
   * through `ctx.credentials`, so rotating the secret needs no restart.
   */
  secretRef?: string
  /**
   * Inline shared secret. Supported for local experiments only: it lands in the
   * profile's patch file, which is part of the configuration tree. Prefer
   * `secretRef` for anything real.
   */
  secret?: string
  /**
   * Explicit opt-in for an endpoint that accepts unsigned deliveries. Without a
   * secret and without this flag the receiver rejects every delivery, because an
   * unauthenticated endpoint that can drive an agent is remote code execution by
   * another name.
   */
  allowUnsigned?: boolean
  /**
   * Session this route drives. `auto` (default) lazily creates one session per
   * route on first delivery and reuses it, so a route's deliveries share one
   * conversation; any other value is treated as an existing session id.
   */
  session?: string
  /** Working directory used when the route creates its own session. */
  workspace?: string
  /** Agent preset applied to sessions this route creates. */
  agentPreset?: string
  /**
   * Prompt template. `{{ path }}` placeholders resolve against the parsed
   * payload; `{{ json }}` is the whole payload; `{{ __event }}`, `{{ __source }}`,
   * `{{ __route }}`, `{{ __deliveryId }}`, and `{{ __receivedAt }}` are provided
   * by the bridge. Omitted renders a built-in summary.
   */
  template?: string
  /** Only deliver these event names (e.g. `push`, `pull_request`). Empty means all. */
  events?: string[]
  /** Where the bridge posts the agent's answer. */
  callbackUrl?: string
  /** Extra headers for the callback request. Values support the same placeholders as `template`. */
  callbackHeaders?: Record<string, string>
  /** Whether to wait for the agent's answer and post it back. */
  replyMode?: ReplyMode
  /** Per-delivery override of the bridge-wide reply timeout. */
  replyTimeoutMs?: number
  /** How many deliveries one route may process at once. */
  maxConcurrency?: number
  /** Additional instructions appended to the rendered prompt. */
  instructions?: string
}

/** Bridge-wide configuration. */
export interface Config {
  /** Master switch. When false the plugin loads but opens no socket. */
  enabled: boolean
  /** Address the receiver binds. Loopback by default: expose it deliberately. */
  host: string
  /** TCP port the receiver binds. `0` asks the operating system for an ephemeral port. */
  port: number
  /** Accepted request body size, in bytes. */
  maxBodyBytes: number
  /** How long a delivery request may take before the receiver closes it. */
  requestTimeoutMs: number
  /** Default wait for an agent answer before giving up, in milliseconds. */
  replyTimeoutMs: number
  /**
   * Deliveries a route may hold waiting behind its concurrency limit before the
   * receiver starts refusing with `503`. Queueing deeper than this does not make
   * the bridge faster; it makes the backlog invisible, and an upstream that can
   * retry is a better place to hold work.
   */
  queueLimit: number
  /** Attempts for one callback POST, including the first. */
  callbackAttempts: number
  /** Base delay for callback backoff, in milliseconds. */
  callbackBackoffMs: number
  /** Timeout for one callback POST. */
  callbackTimeoutMs: number
  /** Maximum prompt size handed to the agent, in characters. */
  maxPromptChars: number
  /** Register the outbound `webhook_send` tool for the model. */
  sendTool: boolean
  /** Allowed hosts for the outbound tool, e.g. `["hooks.example.com"]`. Empty allows any host. */
  sendToolAllowHosts: string[]
  /** Number of delivery records kept in memory for diagnostics. */
  deliveryLogSize: number
  /**
   * Token guarding `GET /deliveries`. Unset disables the endpoint entirely; the
   * delivery log then stays reachable from the settings card only.
   */
  managementToken?: string
  /** Inbound endpoints. */
  routes: RouteConfig[]
}

/** Identifier used when a route binds sessions lazily. */
export const AUTO_SESSION = 'auto'

/** Every configuration default in one place. */
export const DEFAULT_CONFIG: Config = {
  enabled: true,
  host: '127.0.0.1',
  port: 8787,
  maxBodyBytes: 1_048_576,
  requestTimeoutMs: 15_000,
  replyTimeoutMs: 600_000,
  queueLimit: 4,
  callbackAttempts: 3,
  callbackBackoffMs: 1_000,
  callbackTimeoutMs: 15_000,
  maxPromptChars: 100_000,
  sendTool: false,
  sendToolAllowHosts: [],
  deliveryLogSize: 200,
  routes: [],
}

/** Fallback template used when a route declares none. */
export const DEFAULT_TEMPLATE = [
  'A {{ __source }} webhook arrived on route {{ __route }}.',
  '',
  'Event: {{ __event }}',
  'Delivery: {{ __deliveryId }}',
  'Received: {{ __receivedAt }}',
  '',
  'Payload:',
  '{{ json }}',
].join('\n')

/** One problem found while validating the configuration. */
export interface ConfigProblem {
  /** Dotted path of the offending field, e.g. `routes[2].path`. */
  field: string
  /** Human-readable explanation shown in the boot log and the settings card. */
  message: string
}

/** Result of validating and normalizing a raw configuration. */
export interface NormalizedConfig {
  /** Effective configuration: defaults applied, values coerced, routes filtered to usable ones. */
  config: Config
  /** Every problem found. A non-empty list does not stop the plugin from loading. */
  problems: ConfigProblem[]
}

/** Coerce a possibly-undefined value to a string with a fallback. */
function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Coerce a possibly-undefined value to a finite number with a fallback. */
function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Coerce a possibly-undefined value to a boolean with a fallback. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Normalize one path so `/hooks/ci`, `hooks/ci/`, and `//hooks//ci` agree. */
export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (trimmed === '') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Whether a template placeholder-free path is usable as an endpoint. */
function isUsablePath(path: string): boolean {
  return path.startsWith('/') && !path.includes('?') && !path.includes('#') && path !== '/'
}

/**
 * Apply defaults, drop unusable routes, and report every problem found.
 *
 * A malformed route is dropped rather than failing the boot: a bridge that
 * refuses to start because one endpoint is misconfigured would take the working
 * endpoints down with it. Problems are surfaced in the boot log, through
 * `GET /healthz`, and in the settings card, so nothing is silently ignored.
 * @param raw - configuration as resolved by the loader, possibly partial.
 * @returns the effective configuration plus every problem found.
 */
export function normalizeConfig(raw: unknown): NormalizedConfig {
  const problems: ConfigProblem[] = []
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const maxBodyBytes = num(
    input.maxBodyBytes,
    DEFAULT_CONFIG.maxBodyBytes,
    1_024,
    64 * 1_048_576,
  )
  const config: Config = {
    enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
    host: str(input.host, DEFAULT_CONFIG.host),
    // Port 0 is meaningful: it asks the OS for an ephemeral port, which is what a
    // test or a container wants when it does not care where the bridge lands.
    port: num(input.port, DEFAULT_CONFIG.port, 0, 65_535),
    maxBodyBytes,
    requestTimeoutMs: num(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1_000, 120_000),
    replyTimeoutMs: num(input.replyTimeoutMs, DEFAULT_CONFIG.replyTimeoutMs, 1_000, 3_600_000),
    queueLimit: num(input.queueLimit, DEFAULT_CONFIG.queueLimit, 0, 1_000),
    callbackAttempts: num(input.callbackAttempts, DEFAULT_CONFIG.callbackAttempts, 1, 10),
    callbackBackoffMs: num(input.callbackBackoffMs, DEFAULT_CONFIG.callbackBackoffMs, 0, 60_000),
    callbackTimeoutMs: num(input.callbackTimeoutMs, DEFAULT_CONFIG.callbackTimeoutMs, 1_000, 120_000),
    maxPromptChars: num(input.maxPromptChars, DEFAULT_CONFIG.maxPromptChars, 1_024, 2_000_000),
    sendTool: bool(input.sendTool, DEFAULT_CONFIG.sendTool),
    sendToolAllowHosts: Array.isArray(input.sendToolAllowHosts)
      ? input.sendToolAllowHosts.filter((host): host is string => typeof host === 'string' && host !== '')
      : [],
    deliveryLogSize: num(input.deliveryLogSize, DEFAULT_CONFIG.deliveryLogSize, 0, 10_000),
    routes: [],
  }
  if (typeof input.managementToken === 'string' && input.managementToken !== '') {
    config.managementToken = input.managementToken
  }

  const rawRoutes = Array.isArray(input.routes) ? input.routes : []
  if (input.routes !== undefined && !Array.isArray(input.routes)) {
    problems.push({ field: 'routes', message: 'routes must be a list; no endpoint was configured' })
  }

  const seenIds = new Set<string>()
  const seenPaths = new Set<string>()
  rawRoutes.forEach((entry, index) => {
    const route = normalizeRoute(entry, index, problems, config)
    if (route === undefined) return
    if (seenIds.has(route.id)) {
      problems.push({
        field: `routes[${index}].id`,
        message: `duplicate route id "${route.id}"; this route was dropped`,
      })
      return
    }
    if (seenPaths.has(route.path)) {
      problems.push({
        field: `routes[${index}].path`,
        message: `duplicate path "${route.path}"; this route was dropped`,
      })
      return
    }
    seenIds.add(route.id)
    seenPaths.add(route.path)
    config.routes.push(route)
  })

  if (config.routes.length === 0) {
    problems.push({
      field: 'routes',
      message: 'no usable route configured; the receiver will answer health checks only',
    })
  }

  return { config, problems }
}

/** Normalize one route entry, reporting why an unusable entry was dropped. */
function normalizeRoute(
  entry: unknown,
  index: number,
  problems: ConfigProblem[],
  config: Config,
): RouteConfig | undefined {
  const field = (name: string): string => `routes[${index}].${name}`
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    problems.push({ field: `routes[${index}]`, message: 'route must be an object' })
    return undefined
  }
  const input = entry as Record<string, unknown>
  const rawId = typeof input.id === 'string' ? input.id.trim() : ''
  const rawPath = typeof input.path === 'string' ? input.path : ''
  if (rawId === '') {
    problems.push({ field: field('id'), message: 'route id is required' })
    return undefined
  }
  if (rawPath === '') {
    problems.push({ field: field('path'), message: 'route path is required' })
    return undefined
  }
  const path = normalizePath(rawPath)
  if (!isUsablePath(path)) {
    problems.push({
      field: field('path'),
      message: `path "${rawPath}" must start with "/" and carry no query or fragment`,
    })
    return undefined
  }
  const source = input.source
  if (source !== undefined && source !== 'github' && source !== 'gitlab' && source !== 'gitee' && source !== 'generic') {
    problems.push({
      field: field('source'),
      message: `unknown source "${String(source)}"; expected github, gitlab, gitee, or generic`,
    })
    return undefined
  }
  const secretRef = typeof input.secretRef === 'string' && input.secretRef !== '' ? input.secretRef : undefined
  const secret = typeof input.secret === 'string' && input.secret !== '' ? input.secret : undefined
  const allowUnsigned = bool(input.allowUnsigned, false)
  const resolvedSource: WebhookSource = source ?? 'generic'
  if (secretRef === undefined && secret === undefined && !allowUnsigned) {
    problems.push({
      field: field('secretRef'),
      message:
        'no secret configured: this endpoint stays closed until it declares secretRef, secret, '
        + 'or allowUnsigned: true',
    })
  }
  if (secretRef !== undefined && secret !== undefined) {
    problems.push({
      field: field('secret'),
      message: 'both secretRef and secret are set; secretRef wins and the inline secret is ignored',
    })
  }
  if (secret !== undefined) {
    problems.push({
      field: field('secret'),
      message:
        'inline secret is stored in the profile configuration tree; move it to a credential '
        + 'reference (secretRef) before sharing this profile',
    })
  }
  if (resolvedSource === 'generic' && secretRef === undefined && secret === undefined && allowUnsigned) {
    problems.push({
      field: field('allowUnsigned'),
      message: 'unsigned endpoint: anyone who can reach this port can drive the bound session',
    })
  }

  const callbackUrl = typeof input.callbackUrl === 'string' && input.callbackUrl !== ''
    ? input.callbackUrl
    : undefined
  const replyMode = input.replyMode === 'callback' ? 'callback' : input.replyMode === 'none' ? 'none' : undefined
  const effectiveReply = replyMode ?? (callbackUrl === undefined ? 'none' : 'callback')
  if (effectiveReply === 'callback' && callbackUrl === undefined) {
    problems.push({
      field: field('callbackUrl'),
      message: 'replyMode is "callback" but no callbackUrl is set; the answer will only reach the session log',
    })
  }
  if (callbackUrl !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = new URL(callbackUrl)
    } catch {
      problems.push({ field: field('callbackUrl'), message: `"${callbackUrl}" is not a valid URL` })
      return undefined
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      problems.push({
        field: field('callbackUrl'),
        message: `callback protocol "${parsed.protocol}" is unsupported`,
      })
      return undefined
    }
  }

  const events = Array.isArray(input.events)
    ? input.events.filter((event): event is string => typeof event === 'string' && event !== '')
    : []
  const callbackHeaders: Record<string, string> = {}
  if (typeof input.callbackHeaders === 'object' && input.callbackHeaders !== null && !Array.isArray(input.callbackHeaders)) {
    for (const [name, value] of Object.entries(input.callbackHeaders as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        problems.push({
          field: `${field('callbackHeaders')}.${name}`,
          message: 'header value must be a string',
        })
        continue
      }
      callbackHeaders[name] = value
    }
  }

  const session = typeof input.session === 'string' && input.session.trim() !== ''
    ? input.session.trim()
    : AUTO_SESSION
  if (session !== AUTO_SESSION && input.workspace !== undefined) {
    problems.push({
      field: field('workspace'),
      message: 'workspace only applies to a route that creates its own session; it is ignored here',
    })
  }

  const route: RouteConfig = {
    id: rawId,
    path,
    source: resolvedSource,
    enabled: bool(input.enabled, true),
    session,
    replyMode: effectiveReply,
    maxConcurrency: num(input.maxConcurrency, 2, 1, 32),
    allowUnsigned,
  }
  if (secretRef !== undefined) route.secretRef = secretRef
  else if (secret !== undefined) route.secret = secret
  if (session !== AUTO_SESSION) {
    problems.push({
      field: field('session'),
      message: `route drives existing session "${session}"; a missing or closed session is reported per delivery`,
    })
  }
  if (typeof input.workspace === 'string' && input.workspace !== '') route.workspace = input.workspace
  if (typeof input.agentPreset === 'string' && input.agentPreset !== '') route.agentPreset = input.agentPreset
  if (typeof input.template === 'string' && input.template !== '') route.template = input.template
  if (typeof input.instructions === 'string' && input.instructions !== '') route.instructions = input.instructions
  if (callbackUrl !== undefined) route.callbackUrl = callbackUrl
  if (Object.keys(callbackHeaders).length > 0) route.callbackHeaders = callbackHeaders
  if (events.length > 0) route.events = events
  if (typeof input.replyTimeoutMs === 'number') {
    route.replyTimeoutMs = num(input.replyTimeoutMs, config.replyTimeoutMs, 1_000, 3_600_000)
  }
  return route
}

/** Whether a delivery's event name passes the route's filter. */
export function eventAllowed(route: RouteConfig, event: string | undefined): boolean {
  if (route.events === undefined || route.events.length === 0) return true
  if (event === undefined) return false
  return route.events.some((allowed) => allowed.toLowerCase() === event.toLowerCase())
}
