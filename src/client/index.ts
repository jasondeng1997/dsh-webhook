/**
 * dsh-webhook — browser half.
 *
 * The client contributes exactly one thing: a settings card in the Plugins
 * section, keyed by this plugin's settings namespace. Keying on the namespace is
 * the contract that lets a plugin distributed outside the harness repository own
 * a card: the host registers the namespace, the browser registers a card under
 * the same key, and the settings shell pairs them without knowing what either
 * means.
 *
 * Everything the card needs from the host arrives through `settingsScope`, so the
 * client half declares no RPC surface of its own. Reads come from the settings
 * mirror the shell already maintains; writes are revision-fenced namespace
 * mutations. A card is therefore cheap to add and impossible to desynchronize:
 * there is no second copy of the configuration to keep aligned.
 *
 * @module dsh-webhook/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeService } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createCardFace, type BridgeSettings } from './card-face.ts'
import { en, NS, zh } from './locales.ts'
import { WebhookCard } from './WebhookCard.tsx'

/** Services the card's wiring needs. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the card.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-webhook: dictionaries')

  const scopes = ctx.settingsScope as SettingsScopeService
  const scope: SettingsScope<BridgeSettings> = scopes.bind<BridgeSettings>({ namespace: NS })
  const face = createCardFace(scope)

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: () => ({ bridge: face }),
  }, WebhookCard))
}

export { WebhookCard }
export type { BridgeCardFace, BridgeSettings } from './card-face.ts'
