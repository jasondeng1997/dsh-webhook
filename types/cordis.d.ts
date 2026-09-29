/**
 * Minimal structural declarations for the DeepSeek Harness host packages this
 * plugin touches.
 *
 * A plugin distributed outside the harness repository cannot install the
 * published `@deepseek-ai/dsh-*` type packages without pinning a host build, so
 * this file declares the surfaces `dsh-webhook` actually uses. `tsconfig.json`
 * maps the host specifiers here; the build marks them external, and at runtime
 * the profile's own installation resolves them. Keeping the shim in the
 * repository is what lets `npm run check` type-check on a machine with no
 * harness installed.
 *
 * @module dsh-webhook/types
 */

/** Cordis context: only the members this plugin reads. */
export interface Context {
  /** Named logger factory. */
  logger: {
    (name?: string): Logger
    error: LogMethod
    warn: LogMethod
    info: LogMethod
    debug: LogMethod
  }
  /** Read a composed service without declaring an injection. */
  get(name: string): unknown
  /** Run `callback` once the named services exist; the callback's registrations belong to its scope. */
  inject(deps: string | readonly string[], callback: (ctx: Context) => void): unknown
  /** Register a listener that is removed when the owning plugin unloads. */
  on(name: string, listener: (...args: any[]) => any, options?: unknown): () => void
  /** Register an arbitrary reversible effect owned by the current fiber. */
  effect(callback: () => void | (() => void), label?: string): unknown
  /** The plugin's own configuration as resolved by the loader. */
  readonly config?: unknown
  [member: string]: any
}

/** Logger method accepting printf-style placeholders. */
export interface LogMethod {
  (...args: readonly unknown[]): void
}

/** One named logger. */
export interface Logger {
  error: LogMethod
  warn: LogMethod
  info: LogMethod
  debug: LogMethod
}

/** Cordis plugin function shape. */
export interface Plugin {
  name?: string
  inject?: readonly string[]
  apply: (ctx: Context, config?: any) => void
}

/** A composed service object, typed loosely on purpose. */
export type Service = any
