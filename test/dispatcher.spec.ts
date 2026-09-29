/**
 * Delivery pipeline tests.
 *
 * The pipeline is the part of the bridge that decides what an inbound delivery
 * becomes, so these tests drive it against a fake session port: no harness, no
 * network, and every terminal stage asserted — including the ones that exist to
 * refuse work rather than to do it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, normalizeConfig, type Config, type RouteConfig } from '../src/config.ts'
import { Dispatcher, Limiter, defaultTemplateFor, sendAllowed, type DispatchOutcome, type PendingDelivery, type SessionPort, type SessionSnapshot } from '../src/dispatcher.ts'
import type { ParsedPayload } from '../src/payload.ts'

/** Build an effective configuration around a few routes. */
function bridgeConfig(routes: Partial<RouteConfig>[]): Config {
  const { config } = normalizeConfig({
    ...DEFAULT_CONFIG,
    callbackBackoffMs: 0,
    // A shallow queue keeps the saturation test meaningful: deeper backlog is
    // exactly what the bridge refuses to grow.
    queueLimit: 0,
    routes: routes.map((route, index) => ({ id: `r${index}`, path: `/hooks/${index}`, secretRef: 'S', ...route })),
  })
  return config
}

/** A session port that records calls and answers with scripted snapshots. */
function fakePort(overrides: Partial<SessionPort> = {}): SessionPort & { prompts: { sessionId: string; text: string; requestId: string }[] } {
  const prompts: { sessionId: string; text: string; requestId: string }[] = []
  const base: SessionPort = {
    ensureSession: async (route) => `session-for-${route.id}`,
    prompt: async (sessionId, text, requestId) => { prompts.push({ sessionId, text, requestId }) },
    snapshot: async (): Promise<SessionSnapshot> => ({ assistantTurns: 0 }),
    waitForIdle: async () => true,
  }
  return Object.assign(base, overrides, { prompts })
}

/** A parsed delivery for a route. */
function delivery(route: RouteConfig, payload: Record<string, unknown> = { action: 'opened' }): PendingDelivery {
  return {
    route,
    parsed: { payload, contentType: 'json', event: 'push' } as ParsedPayload,
    raw: JSON.stringify(payload),
    receivedAt: new Date('2026-09-29T00:00:00.000Z'),
  }
}

/** Build a dispatcher whose outcomes can be awaited one at a time. */
function harness(routes: Partial<RouteConfig>[], port: SessionPort): {
  dispatcher: Dispatcher
  next: () => Promise<DispatchOutcome>
  config: Config
} {
  const config = bridgeConfig(routes)
  const queue: DispatchOutcome[] = []
  const waiters: ((outcome: DispatchOutcome) => void)[] = []
  const dispatcher = new Dispatcher(port, { info: () => {}, warn: () => {}, error: () => {} }, config, (outcome) => {
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(outcome)
    else queue.push(outcome)
  })
  return {
    dispatcher,
    config,
    next: () => {
      const queued = queue.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise<DispatchOutcome>((resolve) => { waiters.push(resolve) })
    },
  }
}

const jsonResponse = (status: number): Response => ({
  status,
  headers: { get: () => null },
  text: async () => '',
} as unknown as Response)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Dispatcher', () => {
  it('drops a delivery whose event the route filters out, without prompting', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{ events: ['pull_request'] }], port)
    const route = config.routes[0]!
    dispatcher.accept(delivery(route))
    const outcome = await next()
    expect(outcome.stage).toBe('filtered')
    expect(outcome.detail).toContain('push')
    expect(port.prompts).toHaveLength(0)
  })

  it('prompts the session with the rendered prompt and stops there without a callback', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{ template: 'repo={{ repository.full_name }}' }], port)
    const route = config.routes[0]!
    dispatcher.accept(delivery(route, { repository: { full_name: 'owner/repo' } }))
    const outcome = await next()
    expect(outcome.stage).toBe('prompted')
    expect(port.prompts).toHaveLength(1)
    expect(port.prompts[0]!.text).toBe('repo=owner/repo')
    expect(port.prompts[0]!.sessionId).toBe('session-for-r0')
    expect(port.prompts[0]!.requestId).toBe(`webhook:${outcome.deliveryId}`)
  })

  it('uses the built-in template when the route declares none', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{}], port)
    const route = config.routes[0]!
    dispatcher.accept(delivery(route))
    await next()
    const text = port.prompts[0]!.text
    expect(text).toContain('generic webhook arrived')
    expect(text).toContain('Event: push')
    expect(text).toContain('"action": "opened"')
    expect(defaultTemplateFor(route)).toContain('{{ json }}')
  })

  it('appends the route instructions after the rendered prompt', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{ template: 'body', instructions: 'Answer in one line.' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    await next()
    expect(port.prompts[0]!.text).toBe('body\n\nAnswer in one line.')
  })

  it('reports unresolved template paths so a role name typo is visible', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{ template: '{{ repository.nope }} {{ also.missing }}' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.missing).toEqual(['repository.nope', 'also.missing'])
  })

  it('posts the agent answer to the callback and reports success', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return jsonResponse(200)
    }))
    const port = fakePort({
      snapshot: async () => ({ assistantTurns: 0 }),
      waitForIdle: async () => true,
    })
    let calls = 0
    const scripted: SessionPort = {
      ...port,
      snapshot: async () => {
        calls += 1
        return calls === 1 ? { assistantTurns: 1, lastAssistant: 'earlier answer' } : { assistantTurns: 2, lastAssistant: 'the new answer' }
      },
    }
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], scripted)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('answered')
    expect(outcome.answer).toBe('the new answer')
    expect(outcome.callbackOk).toBe(true)
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(body.answer).toBe('the new answer')
    expect(body.route).toBe('r0')
    expect(body.sessionId).toBe('session-for-r0')
    expect(body.deliveryId).toBe(outcome.deliveryId)
  })

  it('reports a timeout when the session goes idle without a new turn', async () => {
    const port = fakePort({ snapshot: async () => ({ assistantTurns: 1, lastAssistant: 'stale' }) })
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('timeout')
    expect(outcome.detail).toContain('without producing a new assistant turn')
    expect(outcome.answer).toBeUndefined()
  })

  it('reports a timeout when the session never settles', async () => {
    const port = fakePort({
      snapshot: async () => ({ assistantTurns: 0 }),
      waitForIdle: async () => false,
    })
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('timeout')
    expect(outcome.detail).toContain('no answer within')
  })

  it('fails the delivery when the route cannot resolve a session', async () => {
    const port = fakePort({ ensureSession: async () => { throw new Error('session/not-found') } })
    const { dispatcher, config, next } = harness([{ session: 'session-gone' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('failed')
    expect(outcome.detail).toContain('session/not-found')
  })

  it('fails the delivery when the prompt is rejected, and does not wait for a reply', async () => {
    const port = fakePort({ prompt: async () => { throw new Error('agent busy') } })
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('failed')
    expect(outcome.detail).toContain('agent busy')
  })

  it('reports a callback rejection as callback-failed while keeping the answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)))
    let calls = 0
    const port = fakePort({
      snapshot: async () => {
        calls += 1
        return calls === 1 ? { assistantTurns: 0 } : { assistantTurns: 1, lastAssistant: 'answer' }
      },
    })
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('callback-failed')
    expect(outcome.answer).toBe('answer')
    expect(outcome.callbackOk).toBe(false)
  })

  it('treats an unreadable session as having no visible turns instead of failing', async () => {
    const port = fakePort({ snapshot: async () => { throw new Error('session gone') } })
    const { dispatcher, config, next } = harness([{ callbackUrl: 'https://example.com/reply' }], port)
    dispatcher.accept(delivery(config.routes[0]!))
    const outcome = await next()
    expect(outcome.stage).toBe('timeout')
  })

  it('refuses a delivery when the route is saturated, so the upstream can retry', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const port = fakePort({
      ensureSession: async (route) => {
        await gate
        return `session-${route.id}`
      },
    })
    const { dispatcher, config } = harness([{ maxConcurrency: 1 }], port)
    const route = config.routes[0]!
    const first = dispatcher.accept(delivery(route))
    const second = dispatcher.accept(delivery(route))
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(dispatcher.counters.rejected).toBe(1)
    release?.()
  })

  it('counts accepted deliveries and reports them through the registry', async () => {
    const port = fakePort()
    const { dispatcher, config, next } = harness([{}], port)
    dispatcher.accept(delivery(config.routes[0]!))
    await next()
    expect(dispatcher.counters.accepted).toBe(1)
    expect(dispatcher.counters.completed).toBe(1)
    expect(dispatcher.counters.failed).toBe(0)
  })
})

describe('Limiter', () => {
  it('tracks capacity, queueing, and promotion without losing slots', () => {
    const limiter = new Limiter(1)
    expect(limiter.hasCapacity('a', 1)).toBe(true)
    expect(limiter.tryReserve('a', 1)).toBe(true)
    expect(limiter.hasCapacity('a', 1)).toBe(false)
    // The waiting queue accepts one, then refuses.
    expect(limiter.tryReserve('a', 1)).toBe(true)
    expect(limiter.tryReserve('a', 1)).toBe(false)
    // Releasing promotes the queued slot instead of freeing capacity.
    limiter.release('a')
    expect(limiter.hasCapacity('a', 1)).toBe(false)
    limiter.release('a')
    expect(limiter.hasCapacity('a', 1)).toBe(true)
  })

  it('keeps routes independent', () => {
    const limiter = new Limiter(1)
    expect(limiter.tryReserve('a', 1)).toBe(true)
    expect(limiter.hasCapacity('b', 1)).toBe(true)
  })
})

describe('sendAllowed', () => {
  it('applies the deployment allowlist to the outbound tool', () => {
    const { config } = normalizeConfig({ ...DEFAULT_CONFIG, sendToolAllowHosts: ['hooks.example.com'] })
    expect(sendAllowed('https://hooks.example.com/x', config)).toBe(true)
    expect(sendAllowed('https://elsewhere.example/x', config)).toBe(false)
  })
})
