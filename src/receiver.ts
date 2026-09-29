/**
 * The inbound HTTP receiver.
 *
 * Design constraints, in the order they shaped the code:
 *
 * 1. **Acknowledge fast.** Upstreams abandon a webhook after roughly ten
 *    seconds; an agent turn takes minutes. The receiver reads the body, verifies
 *    it, hands it to the pipeline, and answers `202` — it never awaits the agent.
 * 2. **Verify before parse.** The signature check runs on raw bytes, before JSON
 *    parsing, so a malformed body from an unauthenticated caller is rejected
 *    without being interpreted at all.
 * 3. **Bound everything.** Body size, request duration, header count, and the
 *    pipeline queue all have ceilings, because the port may be reachable from a
 *    network the deployment does not control.
 * 4. **Answer unauthenticated probes minimally.** `GET /healthz` reports
 *    liveness and nothing else: no route list, no session ids, no delivery
 *    counts. The token-guarded `GET /deliveries` is where diagnostics live.
 *
 * @module dsh-webhook/receiver
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { headerValue } from './signature.ts'
import type { Config, RouteConfig } from './config.ts'
import { parsePayload } from './payload.ts'
import type { DeliveryRecord, DeliveryLog } from './delivery-log.ts'

/** What the receiver needs from the rest of the plugin. */
export interface ReceiverOptions {
  /** Effective configuration. */
  config: Config
  /** Resolves a route's shared secret; `undefined` means the route is closed. */
  resolveSecret: (route: RouteConfig) => Promise<string | undefined>
  /** Verifies a signed body against a route's scheme. */
  verify: (route: RouteConfig, body: Buffer, headers: Record<string, string | string[] | undefined>, secret: string) => { ok: boolean; reason?: string }
  /** Accepts a verified delivery for processing. */
  accept: (route: RouteConfig, parsed: ReturnType<typeof parsePayload>, raw: string, receivedAt: Date) => { deliveryId: string; accepted: boolean; reason?: string }
  /** Diagnostic log for this plugin. */
  log: { info: (...args: readonly unknown[]) => void; warn: (...args: readonly unknown[]) => void; error: (...args: readonly unknown[]) => void; debug?: (...args: readonly unknown[]) => void }
  /** Delivery records for the management endpoint. */
  deliveries: DeliveryLog
  /** Plugin version reported by the health endpoint. */
  version: string
  /** Configuration problems surfaced through the health endpoint. */
  problems: readonly { field: string; message: string }[]
  /** Test seam: replaces the listener factory. */
  listener?: (handler: (request: IncomingMessage, response: ServerResponse) => void) => Server
}

/** A running receiver. */
export interface Receiver {
  /** Bind and start accepting connections. */
  start(): Promise<void>
  /** Stop accepting connections and wait for in-flight responses to finish. */
  stop(): Promise<void>
  /** The bound address, once started. */
  address(): { host: string; port: number } | undefined
  /** The underlying server, for tests and diagnostics. */
  server: Server
}

/** Where the receiver actually ended up after binding. */
interface BoundAddress {
  host: string
  port: number
}

/** Constant-time-ish comparison for the management token, kept out of the hot path docs. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false
  if (provided.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= provided.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return mismatch === 0
}

/** Write a JSON response. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * Read a request body up to a byte ceiling.
 *
 * An oversized body is drained rather than cut off: destroying the socket would
 * deny the sender the `413` that explains the refusal, and a webhook sender that
 * sees a connection reset cannot tell a size limit from an outage. Memory stays
 * bounded either way, because nothing past the ceiling is retained.
 * @param request - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the body, or a rejection reason when it exceeds the ceiling.
 */
async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: string; status: number }> {
  const declared = headerValue(request.headers, 'content-length')
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    // The sender already told us the answer; no need to read a byte of it.
    return { ok: false, reason: `body exceeds ${limit} bytes`, status: 413 }
  }
  const chunks: Buffer[] = []
  let total = 0
  let overflowed = false
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      total += buffer.byteLength
      if (total > limit) {
        overflowed = true
        continue
      }
      chunks.push(buffer)
    }
  } catch (error) {
    return {
      ok: false,
      reason: `cannot read request body: ${error instanceof Error ? error.message : String(error)}`,
      status: 400,
    }
  }
  if (overflowed) return { ok: false, reason: `body exceeds ${limit} bytes`, status: 413 }
  return { ok: true, body: Buffer.concat(chunks) }
}

/**
 * Build the receiver.
 * @param options - configuration, collaborators, and test seams.
 * @returns a receiver that binds on `start()`.
 */
export function createReceiver(options: ReceiverOptions): Receiver {
  const { config, log } = options
  let bound: BoundAddress | undefined

  const routesByPath = new Map<string, RouteConfig>()
  for (const route of config.routes) {
    if (route.enabled === false) continue
    routesByPath.set(route.path, route)
  }

  const handleDelivery = async (
    route: RouteConfig,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const read = await readBody(request, config.maxBodyBytes)
    if (!read.ok) {
      log.warn('dsh-webhook: refused a delivery on "%s": %s', route.id, read.reason)
      sendJson(response, read.status, { ok: false, error: read.reason })
      return
    }
    const headers = request.headers

    const secret = await options.resolveSecret(route)
    if (secret === undefined || secret === '') {
      if (route.allowUnsigned !== true) {
        log.warn(
          'dsh-webhook: route "%s" has no resolvable secret and does not allow unsigned deliveries',
          route.id,
        )
        sendJson(response, 401, {
          ok: false,
          error: `no secret is configured for this endpoint; set secretRef (or allowUnsigned: true to accept unsigned deliveries)`,
        })
        return
      }
    } else {
      const verdict = options.verify(route, read.body, headers, secret)
      if (!verdict.ok) {
        log.warn('dsh-webhook: rejected a delivery on "%s": %s', route.id, verdict.reason ?? 'signature mismatch')
        sendJson(response, 401, { ok: false, error: verdict.reason ?? 'signature mismatch' })
        return
      }
    }

    const parsed = parsePayload(read.body, headers, route.source)
    const receivedAt = new Date()
    const accepted = options.accept(route, parsed, read.body.toString('utf8'), receivedAt)
    if (!accepted.accepted) {
      sendJson(response, 503, {
        ok: false,
        error: accepted.reason ?? 'this route is saturated; retry later',
        deliveryId: accepted.deliveryId,
      })
      return
    }
    sendJson(response, 202, { ok: true, deliveryId: accepted.deliveryId })
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async (): Promise<void> => {
      try {
        const method = request.method ?? 'GET'
        const url = new URL(request.url ?? '/', 'http://localhost')
        const path = url.pathname

        if (method === 'GET' && path === '/healthz') {
          const live = config.routes.filter((route) => route.enabled !== false).length
          sendJson(response, 200, {
            ok: true,
            version: options.version,
            routes: live,
            problems: options.problems.length,
          })
          return
        }

        if (method === 'GET' && path === '/deliveries') {
          if (config.managementToken === undefined) {
            sendJson(response, 404, { ok: false, error: 'not found' })
            return
          }
          const provided = headerValue(request.headers, 'x-webhook-token')
            ?? url.searchParams.get('token')
            ?? undefined
          if (!tokenMatches(provided, config.managementToken)) {
            sendJson(response, 401, { ok: false, error: 'invalid management token' })
            return
          }
          const limitParam = url.searchParams.get('limit')
          const limit = limitParam === null ? 50 : Number(limitParam)
          const records: DeliveryRecord[] = options.deliveries.recent(Number.isFinite(limit) ? limit : 50)
          sendJson(response, 200, {
            ok: true,
            summary: options.deliveries.summary(),
            deliveries: records,
          })
          return
        }

        const route = routesByPath.get(path)
        if (route === undefined) {
          sendJson(response, 404, { ok: false, error: 'no route is configured at this path' })
          return
        }
        if (method !== 'POST') {
          response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: 'deliveries must use POST' }))
          return
        }
        await handleDelivery(route, request, response)
      } catch (error) {
        log.error('dsh-webhook: request handling failed: %o', error)
        if (!response.headersSent) {
          sendJson(response, 500, {
            ok: false,
            error: error instanceof Error ? error.message : 'internal error',
          })
        } else {
          response.end()
        }
      }
    })()
  }

  const server = options.listener === undefined ? createServer(handler) : options.listener(handler)
  // Header and body pacing belong to the deployment's own proxy for real traffic;
  // these ceilings only stop a slow or oversized client from holding a slot forever.
  server.headersTimeout = Math.max(1_000, config.requestTimeoutMs)
  server.requestTimeout = Math.max(1_000, config.requestTimeoutMs)
  server.keepAliveTimeout = 5_000

  return {
    server,
    async start(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
      const address = server.address()
      if (typeof address === 'object' && address !== null) {
        bound = { host: config.host, port: address.port }
      }
    },
    async stop(): Promise<void> {
      if (!server.listening) return
      await new Promise<void>((resolve) => server.close(() => { resolve() }))
    },
    address(): BoundAddress | undefined {
      return bound
    },
  }
}
