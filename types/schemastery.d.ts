/**
 * Structural declaration for `@deepseek-ai/schemastery`, the schema library the
 * loader uses to validate a plugin's exported `Config`.
 *
 * Only the builder calls `dsh-webhook` makes are declared; the runtime value is
 * the harness-vendored schemastery, resolved by the profile at load time.
 *
 * @module dsh-webhook/types/schemastery
 */

/** Schema handle produced by the builders. */
export interface Schema<T> {
  /** The schema's value type. */
  readonly __type?: T
  default(value: T): Schema<T>
  description(text: string): Schema<T>
  required(): Schema<T>
  step(value: number): Schema<T>
  min(value: number): Schema<T>
  max(value: number): Schema<T>
  role(role: string): Schema<T>
}

/** Object schema with the mutators this plugin uses. */
export interface ObjectSchema<T> extends Schema<T> {
  [field: string]: unknown
}

/** Schema builder surface consumed by this plugin. */
export interface Schemastery {
  <T>(shape: unknown): Schema<T>
  string(): Schema<string>
  number(): Schema<number>
  boolean(): Schema<boolean>
  array<T>(inner: unknown): Schema<T[]>
  object<T>(shape: Record<string, unknown>): ObjectSchema<T>
  union(values: readonly string[]): Schema<string>
  const(value: unknown): Schema<unknown>
  dict<T>(inner: unknown): Schema<Record<string, T>>
}

declare const z: Schemastery
export default z
