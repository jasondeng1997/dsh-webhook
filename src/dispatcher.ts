/**
 * Delivery pipeline: one HTTP delivery in, one agent turn out, one optional
 * callback back.
 *
 * The pipeline is deliberately split from the harness by {@link SessionPort}.
 * Everything worth testing — event filtering, template rendering, ordering,
 * concurrency limits, callback retry classification — lives here and runs
 * against a fake port, so the parts that can be reasoned about locally are
 * covered locally, and the harness-facing adapter in `src/index.ts` stays thin.
 *
 * Ordering matters and is deliberate: a delivery is acknowledged by the receiver
 * before this pipeline runs at all, because upstreams time out in seconds and an
 * agent turn takes minutes. The pipeline's job is to make the slow part
 * observable rather than to make the fast part wait for it.
 *
 * @module dsh-webhook/dispatcher
 */

import { randomUUID } from 'node:crypto'
import type { Config, RouteConfig } from './config.ts'
import { eventAllowed } from './config.ts'
import type { DeliveryStage } from './delivery-log.ts'
import { renderHeaders, renderTemplate, type DeliveryFacts } from './template.ts'
import { hostAllowed, postWithRetry } from './outbound.ts'
import type { ParsedPayload } from './payload.ts'

/** Snapshot of the session a delivery is about to drive. */
export interface SessionSnapshot {
  /** Number of assistant turns completed so far. */
  assistantTurns: number
  /** Text of the most recent assistant turn, if any. */
  lastAssistant?: string
}

/** The harness-facing capabilities the pipeline needs. */
export interface SessionPort {
  /**
   * Resolve the session a route drives, creating it when the route owns one.
   * @param route - the route accepting the delivery.
   * @returns the session id to prompt.
   */
  ensureSession(route: RouteConfig): Promise<string>
  /**
   * Submit one user message to a session.
   * @param sessionId - target session.
   * @param text - rendered prompt.
   * @param requestId - idempotency key for this submission.
   */
  prompt(sessionId: string, text: string, requestId: string): Promise<void>
  /**
   * Read the session's current assistant state.
   * @param sessionId - target session.
   * @returns assistant turn count and the latest assistant text.
   */
  snapshot(sessionId: string): Promise<SessionSnapshot>
  /**
   * Wait until the session stops generating, or the deadline passes.
   * @param sessionId - target session.
   * @param timeoutMs - how long to wait.
   * @param signal - cancels the wait.
   * @returns true when the session reached idle, false on timeout.
   */
  waitForIdle(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean>
}

/** Everything one delivery produced. */
export interface DispatchOutcome {
  /** Stable id for the delivery. */
  deliveryId: string
  /** Terminal stage. */
  stage: DeliveryStage
  /** Session the delivery drove, when it got that far. */
  sessionId?: string
  /** The agent's answer, when one was captured. */
  answer?: string
  /** Bridge-authored explanation for a non-happy stage. */
  detail?: string
  /** Placeholder paths the template could not resolve. */
  missing?: string[]
  /** Whether the callback POST succeeded, when one was attempted. */
  callbackOk?: boolean
  /** Milliseconds between receipt and the terminal stage. */
  durationMs?: number
}

/** One accepted delivery waiting for a pipeline slot. */
export interface PendingDelivery {
  /** Route that accepted it. */
  route: RouteConfig
  /** Parsed body. */
  parsed: ParsedPayload
  /** Raw body, kept for templates that want the original text. */
  raw: string
  /** Receipt timestamp. */
  receivedAt: Date
}

/** Minimal logger surface the pipeline writes to. */
export interface DispatchLogger {
  info: (...args: readonly unknown[]) => void
  warn: (...args: readonly unknown[]) => void
  error: (...args: readonly unknown[]) => void
  debug?: (...args: readonly unknown[]) => void
}

/** Per-key concurrency limiter with a bounded waiting queue. */
export class Limiter {
  private readonly active = new Map<string, number>()
  private readonly waiting = new Map<string, number>()

  /** @param maxQueue - waiting deliveries tolerated per key before new ones are refused. */
  constructor(private readonly maxQueue: number) {}

  /**
   * Whether a key can accept another delivery without queueing.
   * @param key - route id.
   * @param limit - the key's concurrency limit.
   * @returns true when a slot is free.
   */
  hasCapacity(key: string, limit: number): boolean {
    return (this.active.get(key) ?? 0) < limit
  }

  /**
   * Reserve a queue slot, so the receiver can refuse early instead of buffering
   * an unbounded backlog behind a slow session.
   * @param key - route id.
   * @param limit - the key's concurrency limit.
   * @returns true when the delivery was accepted for later processing.
   */
  tryReserve(key: string, limit: number): boolean {
    if (this.hasCapacity(key, limit)) {
      this.active.set(key, (this.active.get(key) ?? 0) + 1)
      return true
    }
    const queued = this.waiting.get(key) ?? 0
    if (queued >= this.maxQueue) return false
    this.waiting.set(key, queued + 1)
    return true
  }

  /** Release a reservation, promoting a queued delivery when one is waiting. */
  release(key: string): void {
    const active = (this.active.get(key) ?? 1) - 1
    if (active > 0) {
      this.active.set(key, active)
      return
    }
    this.active.delete(key)
    const queued = this.waiting.get(key) ?? 0
    if (queued === 0) return
    if (queued === 1) this.waiting.delete(key)
    else this.waiting.set(key, queued - 1)
    this.active.set(key, 1)
  }
}

/** Live counters the health endpoint reports. */
export interface DispatchCounters {
  accepted: number
  rejected: number
  completed: number
  failed: number
}

/**
 * The delivery pipeline.
 *
 * One instance serves every route. It holds no per-delivery state outside the
 * limiter, so a slow session on one route cannot block another route's
 * deliveries: the limiter's key is the route id.
 */
export class Dispatcher {
  /** Public counters, read by the health endpoint. */
  readonly counters: DispatchCounters = { accepted: 0, rejected: 0, completed: 0, failed: 0 }

  private readonly limiter: Limiter

  /**
   * @param port - the harness-facing capabilities.
   * @param log - where pipeline decisions are reported.
   * @param config - effective bridge configuration.
   * @param onRecord - notified with each outcome so the delivery log can update.
   */
  constructor(
    private readonly port: SessionPort,
    private readonly log: DispatchLogger,
    private readonly config: Config,
    private readonly onRecord: (outcome: DispatchOutcome, facts: DeliveryFacts) => void = () => {},
  ) {
    this.limiter = new Limiter(Math.max(0, Math.trunc(config.queueLimit)))
  }

  /**
   * Accept a delivery for processing, or refuse it when the route is saturated.
   *
   * Refusing is a feature: the upstream still holds the event and will retry, so
   * a bridge that answers `503` instead of growing an unbounded backlog of agent
   * turns loses nothing and stays honest about what it can do.
   * @param pending - the delivery.
   * @returns the delivery id, whether it was accepted, and why not.
   */
  accept(pending: PendingDelivery): { deliveryId: string; accepted: boolean; reason?: string } {
    const deliveryId = randomUUID()
    const limit = pending.route.maxConcurrency ?? 2
    if (!this.limiter.tryReserve(pending.route.id, limit)) {
      this.counters.rejected += 1
      const reason = `route "${pending.route.id}" is at capacity (${limit} running, ${this.config.queueLimit} queued); retry later`
      this.log.warn('dsh-webhook: refused delivery %s — %s', deliveryId, reason)
      return { deliveryId, accepted: false, reason }
    }
    this.counters.accepted += 1
    void this.process(deliveryId, pending).finally(() => { this.limiter.release(pending.route.id) })
    return { deliveryId, accepted: true }
  }

  /** Run one delivery to its terminal stage, never throwing. */
  private async process(deliveryId: string, pending: PendingDelivery): Promise<void> {
    const { route, parsed, raw, receivedAt } = pending
    const facts: DeliveryFacts = {
      route: route.id,
      source: route.source,
      deliveryId,
      receivedAt: receivedAt.toISOString(),
      ...(parsed.event === undefined ? {} : { event: parsed.event }),
    }
    const started = Date.now()
    let outcome: DispatchOutcome = { deliveryId, stage: 'failed' }
    try {
      outcome = await this.run(deliveryId, pending, facts)
    } catch (error) {
      outcome = {
        deliveryId,
        stage: 'failed',
        detail: `pipeline error: ${error instanceof Error ? error.message : String(error)}`,
      }
      this.log.error('dsh-webhook: delivery %s failed: %o', deliveryId, error)
    }
    if (outcome.stage === 'failed' || outcome.stage === 'callback-failed' || outcome.stage === 'timeout') {
      this.counters.failed += 1
    } else {
      this.counters.completed += 1
    }
    this.onRecord({ ...outcome, durationMs: Date.now() - started }, facts)
  }

  /** The pipeline itself, shared by every route. */
  private async run(
    deliveryId: string,
    pending: PendingDelivery,
    facts: DeliveryFacts,
  ): Promise<DispatchOutcome> {
    const { route, parsed } = pending

    if (!eventAllowed(route, parsed.event)) {
      const detail = `event "${parsed.event ?? '(none)'}" is not in this route's filter`
      this.log.debug?.('dsh-webhook: delivery %s filtered: %s', deliveryId, detail)
      return { deliveryId, stage: 'filtered', detail }
    }

    const template = route.template ?? undefined
    const rendered = template === undefined
      ? renderTemplate(defaultTemplateFor(route), parsed.payload, facts, this.config.maxPromptChars)
      : renderTemplate(template, parsed.payload, facts, this.config.maxPromptChars)
    const promptText = route.instructions === undefined
      ? rendered.text
      : `${rendered.text}\n\n${route.instructions}`
    if (rendered.truncated) {
      this.log.warn(
        'dsh-webhook: delivery %s prompt was truncated to %d characters',
        deliveryId,
        this.config.maxPromptChars,
      )
    }
    if (rendered.missing.length > 0) {
      this.log.debug?.(
        'dsh-webhook: delivery %s resolved no value for: %s',
        deliveryId,
        rendered.missing.join(', '),
      )
    }

    let sessionId: string
    try {
      sessionId = await this.port.ensureSession(route)
    } catch (error) {
      return {
        deliveryId,
        stage: 'failed',
        detail: `cannot resolve a session for this route: ${error instanceof Error ? error.message : String(error)}`,
        missing: rendered.missing,
      }
    }

    const before = await this.safeSnapshot(sessionId)
    try {
      await this.port.prompt(sessionId, promptText, `webhook:${deliveryId}`)
    } catch (error) {
      return {
        deliveryId,
        sessionId,
        stage: 'failed',
        detail: `prompt rejected: ${error instanceof Error ? error.message : String(error)}`,
        missing: rendered.missing,
      }
    }
    this.log.info('dsh-webhook: delivery %s prompted session %s', deliveryId, sessionId)

    const replyMode = route.replyMode ?? (route.callbackUrl === undefined ? 'none' : 'callback')
    if (replyMode !== 'callback') {
      return { deliveryId, sessionId, stage: 'prompted', missing: rendered.missing }
    }

    const timeoutMs = route.replyTimeoutMs ?? this.config.replyTimeoutMs
    const idle = await this.port.waitForIdle(sessionId, timeoutMs)
    const after = await this.safeSnapshot(sessionId)
    const answer = after.lastAssistant
    // A captured answer must be *this* delivery's: the session must have gained a
    // turn after the prompt, otherwise the text belongs to an earlier delivery.
    const answered = idle && after.assistantTurns > before.assistantTurns && answer !== undefined
    if (!answered || answer === undefined) {
      const detail = idle
        ? 'the session stopped without producing a new assistant turn'
        : `no answer within ${timeoutMs}ms`
      return { deliveryId, sessionId, stage: 'timeout', detail, missing: rendered.missing }
    }

    if (route.callbackUrl === undefined) {
      return {
        deliveryId,
        sessionId,
        stage: 'prompted',
        answer,
        detail: 'no callbackUrl configured; the answer exists only in the session log',
        missing: rendered.missing,
      }
    }

    const callback = await this.postCallback(route, pending, facts, sessionId, answer)
    return {
      deliveryId,
      sessionId,
      stage: callback.ok ? 'answered' : 'callback-failed',
      answer,
      callbackOk: callback.ok,
      ...(callback.detail === undefined ? {} : { detail: callback.detail }),
      ...(rendered.missing.length === 0 ? {} : { missing: rendered.missing }),
    }
  }

  /** Snapshot a session, treating a read failure as "no visible turns yet". */
  private async safeSnapshot(sessionId: string): Promise<SessionSnapshot> {
    try {
      return await this.port.snapshot(sessionId)
    } catch (error) {
      this.log.warn('dsh-webhook: cannot read session %s: %o', sessionId, error)
      return { assistantTurns: 0 }
    }
  }

  /** Post the agent's answer back to the route's callback URL. */
  private async postCallback(
    route: RouteConfig,
    pending: PendingDelivery,
    facts: DeliveryFacts,
    sessionId: string,
    answer: string,
  ): Promise<{ ok: boolean; detail?: string }> {
    const url = route.callbackUrl
    /* v8 ignore next -- callers check for a URL before calling. */
    if (url === undefined) return { ok: false, detail: 'no callbackUrl configured' }
    const headers = renderHeaders(route.callbackHeaders, pending.parsed.payload, facts, 4_096)
    const body = JSON.stringify({
      deliveryId: facts.deliveryId,
      route: route.id,
      source: route.source,
      event: facts.event ?? null,
      sessionId,
      receivedAt: facts.receivedAt,
      answeredAt: new Date().toISOString(),
      answer,
    })
    const result = await postWithRetry({
      url,
      body,
      headers,
      attempts: this.config.callbackAttempts,
      backoffMs: this.config.callbackBackoffMs,
      timeoutMs: this.config.callbackTimeoutMs,
    })
    if (result.ok) {
      this.log.info('dsh-webhook: delivery %s callback answered %d', facts.deliveryId, result.status ?? 0)
      return { ok: true }
    }
    this.log.warn(
      'dsh-webhook: delivery %s callback failed after %d attempt(s): %s',
      facts.deliveryId,
      result.attempts,
      result.detail ?? 'unknown',
    )
    return { ok: false, ...(result.detail === undefined ? {} : { detail: result.detail }) }
  }
}

/**
 * Built-in prompt for a route that declares no template.
 *
 * It names the delivery facts the agent cannot infer and then hands over the
 * payload verbatim, because guessing which fields matter is the model's job, not
 * the bridge's.
 * @param route - the route being rendered.
 * @returns the default template text.
 */
export function defaultTemplateFor(route: RouteConfig): string {
  return [
    `A ${route.source} webhook arrived on route "${route.id}".`,
    '',
    'Event: {{ __event }}',
    'Delivery: {{ __deliveryId }}',
    'Received: {{ __receivedAt }}',
    '',
    'Payload:',
    '{{ json }}',
  ].join('\n')
}

/**
 * Whether the outbound send tool may call a URL under the deployment's allowlist.
 * @param url - candidate URL.
 * @param config - effective bridge configuration.
 * @returns true when the call is allowed.
 */
export function sendAllowed(url: string, config: Config): boolean {
  return hostAllowed(url, config.sendToolAllowHosts)
}
