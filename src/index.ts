/**
 * dsh-webhook — bridge inbound HTTP webhooks into DeepSeek Harness sessions.
 *
 * The plugin does four things, in this order:
 *
 * 1. Opens one HTTP listener on `host:port` and matches POSTs to configured
 *    routes (`src/receiver.ts`).
 * 2. Verifies the delivery's signature against a secret resolved per request
 *    (`src/signature.ts`), so rotating a secret needs no restart.
 * 3. Renders a prompt from the payload (`src/template.ts`) and submits it to a
 *    harness session through `ctx.sessionController` (`src/dispatcher.ts`).
 * 4. Optionally waits for the agent's answer and posts it back to the route's
 *    callback URL, and optionally registers a `webhook_send` tool so the model
 *    can call outbound webhooks itself.
 *
 * The harness coupling is confined to this file: everything else is plain Node
 * and is covered by the unit tests. That split is what lets the routing rules be
 * verified without booting a harness, and it is why this file reads as an
 * adapter rather than as the implementation.
 *
 * @module dsh-webhook
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Schema } from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AUTO_SESSION, DEFAULT_CONFIG, normalizeConfig, type Config as BridgeConfig, type ConfigProblem, type RouteConfig } from './config.ts'
import { DeliveryLog } from './delivery-log.ts'
import { Dispatcher, type SessionPort, type SessionSnapshot } from './dispatcher.ts'
import { hostAllowed, postWithRetry } from './outbound.ts'
import { createReceiver } from './receiver.ts'
import { parsePayload } from './payload.ts'
import { verifyDelivery } from './signature.ts'
import { SETTINGS_NAMESPACE, VERSION } from './version.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'dsh-webhook'

/**
 * Hard dependencies.
 *
 * `sessionController` drives agent turns and `sessions`/`agents` observe them;
 * without all three the bridge has nothing to do, so the fiber stays pending
 * rather than half-loading. `settings`, `credentials`, and `tools` are optional
 * seams reached through `ctx.get`, because a minimal profile may compose none of
 * them and the bridge still works with configuration-file secrets and no tool.
 */
export const inject = ['sessionController', 'sessions', 'agents']

/** Route schema as the loader validates it. */
const routeSchema = z.object({
  id: z.string().required().description('Stable identifier used in logs and delivery records.'),
  path: z.string().required().description('URL path this endpoint answers, e.g. /hooks/ci.'),
  source: z.union(['github', 'gitlab', 'gitee', 'generic']).default('generic').description('Signature scheme for this endpoint.'),
  enabled: z.boolean().default(true).description('Whether the endpoint accepts deliveries.'),
  secretRef: z.string().description('Credential reference (an environment-variable name) holding the shared secret.'),
  secret: z.string().description('Inline shared secret; local experiments only. Prefer secretRef.'),
  allowUnsigned: z.boolean().default(false).description('Accept deliveries with no signature. Anyone who can reach the port can drive the session.'),
  session: z.string().default(AUTO_SESSION).description('"auto" creates one session per route; any other value is an existing session id.'),
  workspace: z.string().description('Working directory for the session this route creates.'),
  agentPreset: z.string().description('Agent preset applied to sessions this route creates.'),
  template: z.string().description('Prompt template using {{ path }} placeholders.'),
  instructions: z.string().description('Extra instructions appended after the rendered prompt.'),
  events: z.array(z.string()).description('Only deliver these event names; empty means all.'),
  callbackUrl: z.string().description('Where to post the agent answer.'),
  callbackHeaders: z.object({}).description('Extra callback headers; values support {{ }} placeholders.'),
  replyMode: z.union(['none', 'callback']).description('Whether to wait for the answer and post it back.'),
  replyTimeoutMs: z.number().step(1).min(1_000).description('Per-delivery wait for the agent answer.'),
  maxConcurrency: z.number().step(1).min(1).max(32).default(2).description('Deliveries this route may process at once.'),
})

/** Bridge schema exported for the loader and for the settings document. */
export const Config: Schema<BridgeConfig> = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('Load the plugin and open the listener.'),
  host: z.string().default(DEFAULT_CONFIG.host).description('Address to bind. Loopback by default.'),
  port: z.number().step(1).min(1).max(65_535).default(DEFAULT_CONFIG.port).description('TCP port to bind.'),
  maxBodyBytes: z.number().step(1).min(1_024).default(DEFAULT_CONFIG.maxBodyBytes).description('Accepted request body size in bytes.'),
  requestTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_CONFIG.requestTimeoutMs).description('Request read deadline.'),
  replyTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_CONFIG.replyTimeoutMs).description('Default wait for an agent answer.'),
  queueLimit: z.number().step(1).min(0).max(1_000).default(DEFAULT_CONFIG.queueLimit).description('Deliveries a route may hold waiting before 503 is returned.'),
  callbackAttempts: z.number().step(1).min(1).max(10).default(DEFAULT_CONFIG.callbackAttempts).description('Callback POST attempts, including the first.'),
  callbackBackoffMs: z.number().step(1).min(0).default(DEFAULT_CONFIG.callbackBackoffMs).description('Base callback backoff in milliseconds.'),
  callbackTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_CONFIG.callbackTimeoutMs).description('Timeout for one callback POST.'),
  maxPromptChars: z.number().step(1).min(1_024).default(DEFAULT_CONFIG.maxPromptChars).description('Maximum prompt size handed to the agent.'),
  sendTool: z.boolean().default(DEFAULT_CONFIG.sendTool).description('Register the outbound webhook_send tool.'),
  sendToolAllowHosts: z.array(z.string()).description('Hosts the outbound tool may call; empty allows any host.'),
  deliveryLogSize: z.number().step(1).min(0).default(DEFAULT_CONFIG.deliveryLogSize).description('Delivery records retained in memory.'),
  managementToken: z.string().role('secret').description('Token guarding GET /deliveries. Unset disables the endpoint.'),
  routes: z.array(routeSchema).description('Inbound endpoints.'),
})

/** Extract readable text from one derived assistant message. */
function assistantText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** Count assistant turns and read the latest assistant text out of a session. */
function snapshotOf(session: unknown): SessionSnapshot {
  const derive = (session as { deriveMessages?: () => unknown } | undefined)?.deriveMessages
  if (typeof derive !== 'function') return { assistantTurns: 0 }
  const messages = derive.call(session)
  if (!Array.isArray(messages)) return { assistantTurns: 0 }
  let assistantTurns = 0
  let lastAssistant: string | undefined
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    if ((message as { role?: unknown }).role !== 'assistant') continue
    assistantTurns += 1
    const text = assistantText(message)
    if (text !== undefined) lastAssistant = text
  }
  return lastAssistant === undefined ? { assistantTurns } : { assistantTurns, lastAssistant }
}

/** Sleep, honoring an abort signal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Install the bridge.
 * @param ctx - the plugin's context.
 * @param rawConfig - configuration resolved by the loader.
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const { config, problems } = normalizeConfig(rawConfig ?? {})
  const log = ctx.logger('dsh-webhook')

  for (const problem of problems) {
    log.warn('dsh-webhook: %s — %s', problem.field, problem.message)
  }

  if (!config.enabled) {
    log.info('dsh-webhook: disabled by configuration; no listener was opened')
    return
  }

  const deliveries = new DeliveryLog(config.deliveryLogSize)

  /** Route ids whose session has been created, so `auto` is created once. */
  const autoSessions = new Map<string, Promise<string>>()

  /** Resolve a route's secret through the credential store, falling back to the process environment. */
  const resolveSecret = async (route: RouteConfig): Promise<string | undefined> => {
    if (route.secretRef === undefined) return route.secret
    const credentials = ctx.get('credentials') as
      | { resolve: (ref: unknown) => Promise<{ value: string } | undefined> }
      | undefined
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(route.secretRef)
        if (hit !== undefined && hit.value !== '') return hit.value
      } catch (error) {
        log.warn('dsh-webhook: cannot resolve credential %s: %o', route.secretRef, error)
      }
    }
    const ambient = process.env[route.secretRef]
    if (ambient !== undefined && ambient !== '') return ambient
    return undefined
  }

  const port: SessionPort = {
    async ensureSession(route: RouteConfig): Promise<string> {
      if (route.session !== undefined && route.session !== AUTO_SESSION) return route.session
      const existing = autoSessions.get(route.id)
      if (existing !== undefined) return existing
      const creation = (async (): Promise<string> => {
        const created = await ctx.sessionController.create({
          ...(route.workspace === undefined ? {} : { cwd: route.workspace }),
          ...(route.agentPreset === undefined ? {} : { agentPreset: route.agentPreset }),
        }) as { sessionId: string }
        log.info('dsh-webhook: route "%s" created session %s', route.id, created.sessionId)
        return created.sessionId
      })()
      autoSessions.set(route.id, creation)
      try {
        return await creation
      } catch (error) {
        autoSessions.delete(route.id)
        throw error
      }
    },

    async prompt(sessionId: string, text: string, requestId: string): Promise<void> {
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    },

    async snapshot(sessionId: string): Promise<SessionSnapshot> {
      return snapshotOf(ctx.sessions.get(sessionId))
    },

    async waitForIdle(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      const deadline = Date.now() + timeoutMs
      const agent = ctx.agents.get(sessionId) as
        | { status?: string; whenIdle?: () => Promise<void> }
        | undefined
      if (agent === undefined || typeof agent.whenIdle !== 'function') {
        log.warn('dsh-webhook: session %s has no live agent to observe; skipping the reply wait', sessionId)
        return false
      }
      // The turn may not have started when this runs, and `whenIdle()` on an idle
      // agent resolves immediately — which would report a stale answer as this
      // delivery's. Give the run a hair of time to start before waiting on it.
      const startGrace = Math.min(5_000, Math.max(0, deadline - Date.now()))
      const startedAt = Date.now()
      while (Date.now() - startedAt < startGrace) {
        if (agent.status === 'running') break
        await sleep(50, signal)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let idleReached = false
      await Promise.race([
        agent.whenIdle().then(() => { idleReached = true }),
        sleep(remaining, signal),
      ])
      return idleReached && signal?.aborted !== true
    },
  }

  const dispatcher = new Dispatcher(port, log, config, (outcome, facts) => {
    deliveries.update(outcome.deliveryId, {
      stage: outcome.stage,
      ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      ...(outcome.missing === undefined ? {} : { missing: outcome.missing }),
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    })
    if (outcome.stage === 'answered') {
      log.info('dsh-webhook: delivery %s answered in %dms', outcome.deliveryId, outcome.durationMs ?? 0)
    } else if (outcome.stage !== 'prompted' && outcome.stage !== 'filtered') {
      log.warn(
        'dsh-webhook: delivery %s ended as %s: %s',
        outcome.deliveryId,
        outcome.stage,
        outcome.detail ?? '(no detail)',
      )
    }
    void facts
  })

  const receiver = createReceiver({
    config,
    log,
    deliveries,
    version: VERSION,
    problems,
    resolveSecret,
    verify: (route, body, headers, secret) => {
      const verdict = verifyDelivery(route.source, body, headers, secret)
      return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
    },
    accept: (route, parsed, raw, receivedAt) => {
      const result = dispatcher.accept({ route, parsed, raw, receivedAt })
      if (result.accepted) {
        deliveries.add({
          id: result.deliveryId,
          route: route.id,
          source: route.source,
          ...(parsed.event === undefined ? {} : { event: parsed.event }),
          receivedAt: receivedAt.toISOString(),
          stage: 'queued',
        })
      } else {
        deliveries.add({
          id: result.deliveryId,
          route: route.id,
          source: route.source,
          ...(parsed.event === undefined ? {} : { event: parsed.event }),
          receivedAt: receivedAt.toISOString(),
          stage: 'rejected',
          detail: 'route is saturated; the delivery was refused so the upstream can retry',
        })
      }
      return { deliveryId: result.deliveryId, accepted: result.accepted, ...(result.reason === undefined ? {} : { reason: result.reason }) }
    },
  })

  ctx.effect(() => {
    let stopped = false
    void receiver.start().then(() => {
      const address = receiver.address()
      log.info(
        'dsh-webhook %s listening on http://%s:%d with %d route(s)',
        VERSION,
        address?.host ?? config.host,
        address?.port ?? config.port,
        config.routes.filter((route) => route.enabled !== false).length,
      )
    }).catch((error: unknown) => {
      log.error('dsh-webhook: cannot bind %s:%d — %o', config.host, config.port, error)
    })
    return () => {
      if (stopped) return
      stopped = true
      void receiver.stop()
    }
  }, 'dsh-webhook: listener')

  registerSettingsSection(ctx, config, problems)
  if (config.sendTool) registerSendTool(ctx, config)
}

/** Register the settings namespace the browser card edits. */
function registerSettingsSection(
  ctx: Context,
  config: BridgeConfig,
  problems: readonly ConfigProblem[],
): void {
  const settings = ctx.get('settings') as
    | { register: (ns: string, schema: unknown, options: { base: unknown }) => unknown }
    | undefined
  if (settings === undefined || typeof settings.register !== 'function') {
    return
  }
  try {
    settings.register(SETTINGS_NAMESPACE, Config, { base: config })
  } catch (error) {
    ctx.logger('dsh-webhook').warn('dsh-webhook: cannot register the settings section: %o', error)
    return
  }
  if (problems.length > 0) {
    ctx.logger('dsh-webhook').info(
      'dsh-webhook: %d configuration problem(s) are visible in the IM settings card and in the boot log',
      problems.length,
    )
  }
}

/**
 * Register the outbound tool.
 *
 * The tool is off by default and host-restricted when on: it turns model output
 * into an outbound HTTP request, so enabling it is a deliberate act and an
 * allowlist is the intended posture.
 */
function registerSendTool(ctx: Context, config: BridgeConfig): void {
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | undefined
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger('dsh-webhook').warn('dsh-webhook: sendTool is enabled but no tool registry is composed')
    return
  }
  tools.register(defineTool({
    name: 'webhook_send',
    description: [
      'POST a JSON payload to a webhook URL.',
      'Use it to notify an external system when a task finishes or when a human decision is needed.',
      'The URL must be absolute; the deployment may restrict which hosts are reachable.',
    ].join(' '),
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to POST to.' },
      payload: { type: 'string', required: true, description: 'JSON text to send as the request body.' },
      headers: {
        type: 'object',
        description: 'Optional extra headers.',
        additionalProperties: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'integer' },
          attempts: { type: 'integer', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args: unknown, value: { ok: boolean; status?: number; attempts: number; detail?: string }) => [{
        type: 'text',
        text: value.ok
          ? `Webhook delivered (HTTP ${value.status ?? 200}) after ${value.attempts} attempt(s).`
          : `Webhook not delivered after ${value.attempts} attempt(s): ${value.detail ?? 'unknown failure'}`,
      }],
    },
    async execute(args: { url: string; payload: string; headers?: Record<string, string> }, exec: { signal?: AbortSignal }) {
      if (!hostAllowed(args.url, config.sendToolAllowHosts)) {
        return { ok: false, attempts: 0, detail: 'host is not in sendToolAllowHosts' }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(args.payload)
      } catch {
        return { ok: false, attempts: 0, detail: 'payload is not valid JSON' }
      }
      const result = await postWithRetry({
        url: args.url,
        body: JSON.stringify(parsed),
        headers: args.headers,
        attempts: config.callbackAttempts,
        backoffMs: config.callbackBackoffMs,
        timeoutMs: config.callbackTimeoutMs,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
      return {
        ok: result.ok,
        attempts: result.attempts,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      }
    },
  }))
}

export type { BridgeConfig as ConfigType, RouteConfig }
export { parsePayload, verifyDelivery, normalizeConfig, DeliveryLog, Dispatcher, createReceiver }
