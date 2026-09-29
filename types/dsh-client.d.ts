/**
 * Structural declarations for the harness browser packages the settings card
 * touches.
 *
 * The client half never imports these at runtime (all references are type-only
 * and erased by the build); the declarations exist so the card can be written
 * against the real slot and settings-scope contracts without depending on a
 * harness checkout.
 *
 * @module dsh-webhook/types/dsh-client
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Slot types this plugin contributes to. */
  interface SlotMap {
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }

  /** Owner share of a keyed plugin card: the section supplies nothing. */
  export interface SettingsPluginItemOwnerProps {
    children?: never
  }

  /** Registrar options accepted by `ctx.slots.register`. */
  export interface SlotRegistrationOptions {
    name: string
    id?: string
    key?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => Record<string, unknown>
  }

  /** Runtime share handed to slot content. */
  export type PropsRuntime<Name extends string> = {
    [member: string]: any
    slot?: Name
  }

  /** Locale share handed to slot content when the registration names a namespace. */
  export type PropsLocale<NS extends string> = {
    t: (key: any, params?: Record<string, unknown>) => string
    locale?: string
  }

  /** Store share handed to slot content for a controller-provided store. */
  export type PropsStore<Store> = {
    useStore?: () => Store
  }

  /** Translator bound to one namespace. */
  export type TranslateNS<NS extends string> = (key: any, params?: Record<string, unknown>) => string

  /** Slot service surface consumed here. */
  export interface SlotsService {
    register(options: SlotRegistrationOptions, content: unknown): unknown
    inject(name: string, callback: () => unknown): unknown
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Locale service surface consumed here. */
  export interface LocaleService {
    register(namespace: string, dictionaries: { zh: unknown; en: unknown }): () => void
    bind(namespace: string): (key: any, params?: Record<string, unknown>) => string
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  /** One namespace's sync snapshot. */
  export interface SettingsScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    revision: number | undefined
    writable: boolean
    mode: 'host' | 'memory'
  }

  /** Reactive owner handle over one namespace's durable section. */
  export interface SettingsScope<T> {
    getSnapshot(): SettingsScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<void>
    unset(field: string): Promise<void>
    mutate(ops: readonly unknown[], expectedRevision?: number): Promise<void>
  }

  /** Namespace-bound scope factory provided as `ctx.settingsScope`. */
  export interface SettingsScopeService {
    bind<T>(spec: { namespace: string; decode?: (section: unknown) => T | undefined }): SettingsScope<T>
  }
}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  /** Narrowed to the members this plugin's types mention. */
  export type SettingsPathOpView = unknown
}
