/**
 * Receiver tests.
 *
 * The receiver is the bridge's only network-facing surface, so these tests drive
 * real HTTP against a bound ephemeral port rather than a mocked request object:
 * what matters is what a sender on the wire experiences — status codes, headers,
 * and whether an agent was ever asked to do anything.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { signPayload, verifyDelivery } from '../src/signature.ts'
import { DeliveryLog } from '../src/delivery-log.ts'
import { normalizeConfig, type Config, type RouteConfig } from '../src/config.ts'
import { createReceiver, type Receiver } from '../src/receiver.ts'
import type { ParsedPayload } from '../src/payload.ts'

const SECRET = 'shared-secret'

/** Everything one test harness observed. */
interface Harness {
  receiver: Receiver
  base: string
  accepted: { routeId: string; parsed: ParsedPayload }[]
  stop: () => Promise<void>
}

const running: { receiver: Receiver; stop: () => Promise<void> }[] = []
const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

/** Build a receiver over a normalized configuration and track it for teardown. */
async function bootReceiver(
  raw: Record<string, unknown>,
  accept: (route: RouteConfig, parsed: ParsedPayload) => { deliveryId: string; accepted: boolean; reason?: string },
  resolveSecret: (route: RouteConfig) => Promise<string | undefined>,
): Promise<Receiver> {
  const { config, problems } = normalizeConfig({ host: '127.0.0.1', port: 0, ...raw })
  const receiver = createReceiver({
    config,
    problems,
    version: '0.0.0-test',
    log: silentLog,
    deliveries: new DeliveryLog(20),
    resolveSecret,
    verify: (route, body, headers, secret) => {
      const verdict = verifyDelivery(route.source, body, headers, secret)
      return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
    },
    accept,
  })
  await receiver.start()
  running.push({ receiver, stop: async () => { await receiver.stop() } })
  return receiver
}

/** Boot a receiver over routes whose secret resolves to {@link SECRET}. */
async function boot(routes: Partial<RouteConfig>[], overrides: Record<string, unknown> = {}): Promise<Harness> {
  const accepted: Harness['accepted'] = []
  const receiver = await bootReceiver(
    {
      managementToken: 'mgmt-token',
      ...overrides,
      routes: routes.map((route, index) => ({ id: `r${index}`, path: `/hooks/${index}`, secretRef: 'TEST_SECRET', ...route })),
    },
    (route, parsed) => {
      accepted.push({ routeId: route.id, parsed })
      return { deliveryId: `d-${accepted.length}`, accepted: true }
    },
    async (route) => (route.secretRef === undefined ? route.secret : SECRET),
  )
  const port = receiver.address()!.port
  return {
    receiver,
    base: `http://127.0.0.1:${port}`,
    accepted,
    stop: async () => { await receiver.stop() },
  }
}

/** POST a chunked body so the sender never declares a content length. */
function postChunked(port: number, path: string, chunks: Buffer[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
    }, (response) => {
      response.resume()
      response.on('end', () => { resolve(response.statusCode ?? 0) })
    })
    request.on('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

afterEach(async () => {
  while (running.length > 0) {
    const harness = running.pop()
    if (harness !== undefined) await harness.stop()
  }
})

describe('createReceiver', () => {
  it('answers a health probe without leaking route or session detail', async () => {
    const harness = await boot([{ source: 'github' }])
    const response = await fetch(`${harness.base}/healthz`)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.version).toBe('0.0.0-test')
    expect(body.routes).toBe(1)
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('accepts a correctly signed delivery and acknowledges with the delivery id', async () => {
    const harness = await boot([{ source: 'github' }])
    const body = JSON.stringify({ action: 'opened' })
    const response = await fetch(`${harness.base}/hooks/0`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': `sha256=${signPayload(body, SECRET)}`,
      },
      body,
    })
    expect(response.status).toBe(202)
    const payload = await response.json() as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.deliveryId).toBe('d-1')
    expect(harness.accepted).toHaveLength(1)
    expect(harness.accepted[0]?.parsed.event).toBe('pull_request')
    expect(harness.accepted[0]?.parsed.payload).toEqual({ action: 'opened' })
  })

  it('rejects a delivery whose signature does not match', async () => {
    const harness = await boot([{ source: 'github' }])
    const response = await fetch(`${harness.base}/hooks/0`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
      body: '{"a":1}',
    })
    expect(response.status).toBe(401)
    expect(harness.accepted).toHaveLength(0)
  })

  it('rejects a delivery with no signature at all rather than trusting it', async () => {
    const harness = await boot([{ source: 'github' }])
    const response = await fetch(`${harness.base}/hooks/0`, { method: 'POST', body: '{"a":1}' })
    expect(response.status).toBe(401)
    expect(harness.accepted).toHaveLength(0)
  })

  it('closes an endpoint whose secret does not resolve instead of running it unauthenticated', async () => {
    const accepted: unknown[] = []
    const receiver = await bootReceiver(
      { routes: [{ id: 'r', path: '/hooks/r', source: 'github', secretRef: 'MISSING' }] },
      () => {
        accepted.push(1)
        return { deliveryId: 'x', accepted: true }
      },
      async () => undefined,
    )
    const response = await fetch(`http://127.0.0.1:${receiver.address()!.port}/hooks/r`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
    expect(accepted).toHaveLength(0)
  })

  it('accepts an unsigned delivery only when the route opted in', async () => {
    const harness = await boot([{ source: 'generic', allowUnsigned: true, secretRef: undefined }])
    const response = await fetch(`${harness.base}/hooks/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    })
    expect(response.status).toBe(202)
    expect(harness.accepted).toHaveLength(1)
  })

  it('rejects an oversized body that declares its length', async () => {
    const harness = await boot([{ source: 'github' }], { maxBodyBytes: 1_024 })
    const body = 'x'.repeat(4_096)
    const response = await fetch(`${harness.base}/hooks/0`, {
      method: 'POST',
      headers: { 'content-length': String(body.length), 'x-hub-signature-256': 'sha256=deadbeef' },
      body,
    })
    expect(response.status).toBe(413)
    expect(harness.accepted).toHaveLength(0)
  })

  it('rejects an oversized streamed body when the sender declares no length', async () => {
    const receiver = await bootReceiver(
      { maxBodyBytes: 1_024, routes: [{ id: 'r', path: '/hooks/r', source: 'github', secretRef: 'S' }] },
      () => ({ deliveryId: 'x', accepted: true }),
      async () => SECRET,
    )
    const chunk = Buffer.alloc(600, 0x78)
    const status = await postChunked(receiver.address()!.port, '/hooks/r', [chunk, chunk])
    expect(status).toBe(413)
  })

  it('refuses a delivery the pipeline cannot accept, so the upstream retries', async () => {
    const receiver = await bootReceiver(
      { routes: [{ id: 'r', path: '/hooks/r', source: 'generic', allowUnsigned: true, secretRef: undefined }] },
      () => ({ deliveryId: 'x', accepted: false, reason: 'this route is saturated; retry later' }),
      async () => undefined,
    )
    const response = await fetch(`http://127.0.0.1:${receiver.address()!.port}/hooks/r`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(503)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toContain('saturated')
  })

  it('answers 404 on an unconfigured path and 405 on a non-POST method', async () => {
    const harness = await boot([{ source: 'github' }])
    expect((await fetch(`${harness.base}/hooks/elsewhere`, { method: 'POST', body: '{}' })).status).toBe(404)
    const wrongMethod = await fetch(`${harness.base}/hooks/0`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
  })

  it('serves nothing at a disabled route path', async () => {
    const harness = await boot([{ source: 'github', enabled: false }])
    const response = await fetch(`${harness.base}/hooks/0`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('guards the delivery log with the management token', async () => {
    const harness = await boot([{ source: 'github' }])
    expect((await fetch(`${harness.base}/deliveries`)).status).toBe(401)
    expect((await fetch(`${harness.base}/deliveries?token=mgmt-token`)).status).toBe(200)
    const withHeader = await fetch(`${harness.base}/deliveries`, { headers: { 'x-webhook-token': 'mgmt-token' } })
    expect(withHeader.status).toBe(200)
    const body = await withHeader.json() as Record<string, unknown>
    expect(body.summary).toEqual({ total: 0, byStage: {} })
  })

  it('hides the delivery log entirely when no management token is configured', async () => {
    const receiver = await bootReceiver(
      { routes: [{ id: 'r', path: '/hooks/r', source: 'github', secretRef: 'S' }] },
      () => ({ deliveryId: 'x', accepted: true }),
      async () => SECRET,
    )
    const response = await fetch(`http://127.0.0.1:${receiver.address()!.port}/deliveries?token=anything`)
    expect(response.status).toBe(404)
  })

  it('stops accepting connections and is safe to stop twice', async () => {
    const harness = await boot([{ source: 'github' }])
    const base = harness.base
    await harness.stop()
    await harness.stop()
    await expect(fetch(`${base}/healthz`)).rejects.toBeTruthy()
  })

  it('keeps a form-encoded delivery usable', async () => {
    const harness = await boot([{ source: 'gitlab' }])
    const response = await fetch(`${harness.base}/hooks/0`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-gitlab-token': SECRET },
      body: 'object_kind=push&ref=main',
    })
    expect(response.status).toBe(202)
    expect(harness.accepted[0]?.parsed.payload).toEqual({ object_kind: 'push', ref: 'main' })
  })
})

describe('channel conflict', () => {
  it('reports a bind failure instead of silently running without a listener', async () => {
    const first = await bootReceiver(
      { port: 0, routes: [{ id: 'r', path: '/hooks/r', source: 'generic', secretRef: 'S' }] },
      () => ({ deliveryId: 'x', accepted: true }),
      async () => SECRET,
    )
    const port = first.address()!.port
    const { config } = normalizeConfig({ host: '127.0.0.1', port, routes: [] })
    const second = createReceiver({
      config,
      problems: [],
      version: 'test',
      log: silentLog,
      deliveries: new DeliveryLog(5),
      resolveSecret: async () => undefined,
      verify: () => ({ ok: true }),
      accept: () => ({ deliveryId: 'x', accepted: true }),
    })
    await expect(second.start()).rejects.toBeTruthy()
    expect(second.address()).toBeUndefined()
  })
})
