/**
 * Published type surface for the host half of dsh-webhook.
 *
 * This declaration file is authored by hand and shipped as `lib/types/index.d.ts`.
 * It deliberately does not re-export from `src/`: the published package carries
 * only `lib/`, and a generated rollup would have to resolve the harness type
 * packages, which this plugin intentionally does not depend on. Types that users
 * need in order to write configuration are restated here; `src/config.ts` remains
 * the source of truth for their behaviour, and a unit test asserts the defaults
 * documented here match the ones the code applies.
 *
 * @module dsh-webhook
 */

/** Upstream services whose signature scheme the receiver knows natively. */
export type WebhookSource = 'github' | 'gitlab' | 'gitee' | 'generic'

/** What the bridge does with the agent's answer. */
export type ReplyMode = 'none' | 'callback'

/** One inbound endpoint and everything the bridge does with its payloads. */
export interface RouteConfig {
  /** Stable identifier used in logs, delivery records, and the settings card. */
  id: string
  /** URL path the endpoint answers, e.g. `/hooks/ci`. */
  path: string
  /** Signature scheme applied to this endpoint. Defaults to `generic`. */
  source?: WebhookSource
  /** Whether the endpoint accepts deliveries. Defaults to `true`. */
  enabled?: boolean
  /** Name of a stored credential holding the shared secret. */
  secretRef?: string
  /** Inline shared secret; local experiments only, since it lands in the patch file. */
  secret?: string
  /** Opt in to unsigned deliveries. Without a secret and without this flag, every delivery is rejected. */
  allowUnsigned?: boolean
  /** `auto` lazily creates and reuses one session per route; otherwise an existing session id. */
  session?: string
  /** Working directory for the session this route creates. */
  workspace?: string
  /** Agent preset applied to sessions this route creates. */
  agentPreset?: string
  /** Prompt template using `{{ path }}` placeholders. */
  template?: string
  /** Extra instructions appended after the rendered prompt. */
  instructions?: string
  /** Only deliver these event names; empty means all. */
  events?: string[]
  /** Where the bridge posts the agent's answer. */
  callbackUrl?: string
  /** Extra callback headers; values support the same placeholders as `template`. */
  callbackHeaders?: Record<string, string>
  /** Whether to wait for the answer and post it back. Defaults to `callback` when `callbackUrl` is set. */
  replyMode?: ReplyMode
  /** Per-delivery override of the bridge-wide reply timeout. */
  replyTimeoutMs?: number
  /** Deliveries this route may process at once. Defaults to `2`. */
  maxConcurrency?: number
}

/** Bridge-wide configuration; every field has a schema default. */
export interface Config {
  /** Master switch. When false the plugin loads but opens no socket. Defaults to `true`. */
  enabled: boolean
  /** Address the receiver binds. Defaults to `127.0.0.1`. */
  host: string
  /** TCP port the receiver binds. Defaults to `8787`; `0` asks for an ephemeral port. */
  port: number
  /** Accepted request body size in bytes. Defaults to `1048576`. */
  maxBodyBytes: number
  /** Request read deadline in milliseconds. Defaults to `15000`. */
  requestTimeoutMs: number
  /** Default wait for an agent answer in milliseconds. Defaults to `600000`. */
  replyTimeoutMs: number
  /** Deliveries a route may hold waiting before `503` is returned. Defaults to `4`. */
  queueLimit: number
  /** Callback POST attempts including the first. Defaults to `3`. */
  callbackAttempts: number
  /** Base callback backoff in milliseconds. Defaults to `1000`. */
  callbackBackoffMs: number
  /** Timeout for one callback POST in milliseconds. Defaults to `15000`. */
  callbackTimeoutMs: number
  /** Maximum prompt size handed to the agent, in characters. Defaults to `100000`. */
  maxPromptChars: number
  /** Register the outbound `webhook_send` tool. Defaults to `false`. */
  sendTool: boolean
  /** Hosts the outbound tool may call; empty allows any host. */
  sendToolAllowHosts: string[]
  /** Delivery records retained in memory. Defaults to `200`. */
  deliveryLogSize: number
  /** Token guarding `GET /deliveries`. Unset disables the endpoint. */
  managementToken?: string
  /** Inbound endpoints. */
  routes: RouteConfig[]
}

/** Cordis plugin name. */
export declare const name: 'dsh-webhook'
/** Services this plugin requires before it activates. */
export declare const inject: readonly string[]
/** Configuration schema the loader validates. */
export declare const Config: unknown
/**
 * Install the bridge.
 * @param ctx - the plugin's context.
 * @param config - configuration resolved by the loader and normalized by the schema.
 */
export declare function apply(ctx: unknown, config: unknown): void
