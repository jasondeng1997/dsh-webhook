/**
 * Terminal output helpers shared by the runnable examples.
 *
 * Kept in one place because two things here are easy to get wrong twice: colour
 * must be suppressed when stdout is not a TTY (piped output is how these scripts
 * get read most of the time), and column padding must count display cells rather
 * than characters, because CJK glyphs occupy two cells and `padEnd` on a Chinese
 * label drifts the whole table right by one cell per character.
 *
 * @module dsh-webhook/examples/lib/terminal
 */

const useColor = process.stdout.isTTY === true
const paint = (code) => (text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : String(text))

export const dim = paint(2)
export const bold = paint(1)
export const red = paint(31)
export const green = paint(32)
export const yellow = paint(33)
export const blue = paint(36)

/** Cells a string occupies in a monospace terminal. */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    const wide = (code >= 0x1100 && code <= 0x115F)
      || (code >= 0x2E80 && code <= 0xA4CF)
      || (code >= 0xAC00 && code <= 0xD7A3)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFE30 && code <= 0xFE6F)
      || (code >= 0xFF00 && code <= 0xFF60)
      || (code >= 0xFFE0 && code <= 0xFFE6)
    width += wide ? 2 : 1
  }
  return width
}

/** Pad to a target display width rather than a character count. */
export function padRight(text, target) {
  return String(text) + ' '.repeat(Math.max(0, target - displayWidth(text)))
}

/** A titled horizontal rule. */
export function rule(title) {
  console.log('')
  const dashes = '─'.repeat(Math.max(0, 62 - displayWidth(title) - 3))
  console.log(bold(blue(`── ${title} ${dashes}`)))
}

/** One `label  value` row, aligned on display width. */
export function line(label, value, paintValue = (x) => x) {
  console.log(`  ${dim(padRight(label, 14))} ${paintValue(String(value))}`)
}

/** Wrap text into aligned continuation lines. */
export function block(text, indent = '    ') {
  return String(text)
    .split('\n')
    .map((row) => `${indent}${row}`)
    .join('\n')
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build a logger that mimics the harness's `ctx.logger` surface: callable, plus
 * `.info/.warn/.error/.debug`, with `%s`/`%d`/`%j` interpolation. The plugin
 * really does call a logger this way, so the examples exercise that path rather
 * than stubbing it out.
 *
 * @param entries - array every line is also pushed into, for end-of-run summaries.
 */
export function createLogger(entries) {
  const emit = (level, format, ...args) => {
    let index = 0
    const text = String(format).replace(/%[sdofjO%]/g, (token) => {
      if (token === '%%') return '%'
      const value = args[index++]
      if (token === '%d') return String(Number(value))
      if (token === '%o' || token === '%O' || token === '%j') {
        try { return JSON.stringify(value) } catch { return String(value) }
      }
      return String(value)
    })
    entries.push({ level, text })
    const tone = level === 'warn' ? yellow : level === 'error' ? red : dim
    console.log(`  ${tone('│')} ${tone(text)}`)
  }
  const logger = (...args) => emit('info', ...args)
  logger.info = (...args) => emit('info', ...args)
  logger.warn = (...args) => emit('warn', ...args)
  logger.error = (...args) => emit('error', ...args)
  logger.debug = (...args) => emit('debug', ...args)
  return logger
}

/** Ask the OS for a port nobody is using, then release it. */
export async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Parse `--flag value` / `--flag=value` / `--bool` into a plain object.
 * @param argv - `process.argv.slice(2)`.
 * @param known - flags that take no value.
 */
export function parseArgs(argv, known = []) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [rawName, inline] = token.slice(2).split('=')
    const name = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase())
    if (inline !== undefined) {
      out[name] = inline
    } else if (known.includes(rawName)) {
      out[name] = true
    } else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
      out[name] = argv[index + 1]
      index += 1
    } else {
      out[name] = true
    }
  }
  return out
}
