/**
 * Structural declaration for `@deepseek-ai/dsh-tools`, reduced to the
 * `defineTool` helper this plugin uses to register its outbound tool.
 *
 * @module dsh-webhook/types/dsh-tools
 */

/** Definition accepted by `ctx.tools.register`. */
export interface ToolDefinition {
  name: string
  description: string
  parameters?: Record<string, unknown>
  output?: Record<string, unknown>
  execute: (args: any, exec: any) => Promise<unknown> | unknown
}

/** Identity helper: the harness validates and narrows the definition at runtime. */
export declare function defineTool<T extends ToolDefinition>(definition: T): T
