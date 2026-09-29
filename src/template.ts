/**
 * Template rendering for prompts and callback headers.
 *
 * The renderer is deliberately not a template engine. It resolves
 * `{{ dotted.path }}` lookups against the parsed payload and substitutes the
 * built-in delivery facts the bridge provides. There is no evaluation, no
 * helper functions, no partials, and no way for a payload to reach anything
 * except the output string — a payload arriving from the internet is
 * attacker-controlled by definition, and a template language that can execute
 * would hand that attacker a foothold inside the harness process.
 *
 * @module dsh-webhook/template
 */

/** Outcome of rendering one template. */
export interface RenderResult {
  /** Rendered text, already truncated to the configured limit. */
  text: string
  /** Placeholder paths that resolved to nothing, in first-seen order. */
  missing: string[]
  /** Whether the configured character limit truncated the result. */
  truncated: boolean
}

/** Built-in values available to every template. */
export interface DeliveryFacts {
  /** Route id that received the delivery. */
  route: string
  /** Upstream service name. */
  source: string
  /** Event name extracted from the delivery, when the upstream reports one. */
  event?: string
  /** Unique id minted for this delivery. */
  deliveryId: string
  /** ISO-8601 timestamp of receipt. */
  receivedAt: string
}

/** One `{{ ... }}` occurrence found in a template. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g

/** Built-in placeholder names, with the `__` prefix that keeps them out of payload space. */
const BUILT_INS = new Set(['__route', '__source', '__event', '__deliveryId', '__receivedAt', 'json'])

/** Path segments: `.name` or `[0]` or `["quoted name"]`. */
const PATH_SEGMENTS = /\.([A-Za-z0-9_$]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g

/**
 * Resolve a dotted path against arbitrary JSON-shaped data.
 *
 * Supports `a.b`, `a[0].b`, and `a["odd key"]`. Nothing else is meaningful, and
 * a path that does not resolve returns `undefined` instead of throwing, so one
 * unfamiliar payload shape degrades to an empty substitution rather than a
 * failed delivery.
 * @param data - parsed payload.
 * @param path - template path, without braces.
 * @returns the resolved value, or `undefined`.
 */
export function resolvePath(data: unknown, path: string): unknown {
  const trimmed = path.trim()
  if (trimmed === '') return undefined
  const head = trimmed.match(/^([A-Za-z0-9_$]+)/)?.[1]
  let current: unknown = data
  let consumed = 0
  if (head !== undefined) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[head]
    consumed = head.length
  }
  PATH_SEGMENTS.lastIndex = consumed
  let match: RegExpExecArray | null
  while ((match = PATH_SEGMENTS.exec(trimmed)) !== null) {
    if (match.index !== consumed) return undefined
    const key = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (key === undefined) return undefined
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
    consumed = match.index + match[0].length
  }
  return consumed === trimmed.length ? current : undefined
}

/** Render one resolved value as prompt text. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value, undefined, 2) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * Render a template against a parsed payload and the delivery facts.
 * @param template - template text containing `{{ }}` placeholders.
 * @param payload - parsed delivery payload.
 * @param facts - built-in delivery facts.
 * @param maxChars - output limit; a negative or non-finite value means no limit.
 * @returns the rendered text plus substitution diagnostics.
 */
export function renderTemplate(
  template: string,
  payload: unknown,
  facts: DeliveryFacts,
  maxChars: number,
): RenderResult {
  const missing: string[] = []
  const seen = new Set<string>()
  const text = template.replace(PLACEHOLDER, (_whole, rawPath: string) => {
    const path = rawPath.trim()
    if (path === '') return ''
    if (path === 'json') {
      const json = stringify(payload)
      return json === '' ? '{}' : json
    }
    if (BUILT_INS.has(path)) {
      const builtIn = path === '__route'
        ? facts.route
        : path === '__source'
          ? facts.source
          : path === '__event'
            ? facts.event
            : path === '__deliveryId'
              ? facts.deliveryId
              : facts.receivedAt
      return builtIn ?? ''
    }
    const value = resolvePath(payload, path)
    if (value === undefined || value === null) {
      if (!seen.has(path)) {
        seen.add(path)
        missing.push(path)
      }
      return ''
    }
    return stringify(value)
  })

  const limit = Number.isFinite(maxChars) && maxChars >= 0 ? Math.trunc(maxChars) : Number.POSITIVE_INFINITY
  if (text.length <= limit) return { text, missing, truncated: false }
  const notice = `\n\n[truncated: payload rendering exceeded ${limit} characters]`
  // A limit smaller than the notice itself leaves no room for both; the caller
  // still learns about the truncation from the returned flag.
  if (limit <= notice.length) return { text: text.slice(0, limit), missing, truncated: true }
  return { text: text.slice(0, limit - notice.length) + notice, missing, truncated: true }
}

/**
 * Render a header value map, dropping any header whose name or rendered value is
 * unusable so a malformed template cannot smuggle a CRLF into the request.
 * @param headers - header templates.
 * @param payload - parsed delivery payload.
 * @param facts - built-in delivery facts.
 * @param maxChars - per-value character limit.
 * @returns header names to values, safe to hand to `fetch`.
 */
export function renderHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  payload: unknown,
  facts: DeliveryFacts,
  maxChars: number,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined) return out
  for (const [name, template] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (/^(?:host|content-length|transfer-encoding)$/i.test(name)) continue
    const rendered = renderTemplate(template, payload, facts, maxChars).text
    if (/[\r\n]/.test(rendered)) continue
    out[name] = rendered
  }
  return out
}

/** Placeholder names in a template, used by the settings card to preview substitutions. */
export function placeholdersOf(template: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = (match[1] ?? '').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}
