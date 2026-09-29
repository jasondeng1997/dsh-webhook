/**
 * Published type surface for the browser half of dsh-webhook.
 *
 * Ships as `lib/types/client/index.d.ts`. The browser half contributes one
 * settings card; its props arrive from the slot system, so this file documents
 * the couple of shapes a host would need in order to reason about it.
 *
 * @module dsh-webhook/client
 */

/** One route as the card edits it. */
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

/** Services the card's wiring needs. */
export declare const inject: readonly string[]
/**
 * Register the card in the Plugins settings section.
 * @param ctx - the client root context.
 */
export declare function apply(ctx: unknown): void
