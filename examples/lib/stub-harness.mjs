/**
 * The smallest stand-in for the harness that `src/index.ts` will accept.
 *
 * The plugin declares `inject = ['sessionController', 'sessions', 'agents']`, so
 * those three services are the entire contract a host has to satisfy. Faking
 * them — rather than importing the real harness — is what lets these examples
 * run with no DSH install, no API key, and no network, while still exercising
 * the shipped code path: the receiver, the signature check, the template
 * renderer, the dispatcher and the callback POST are all the real thing.
 *
 * Both `apply()` paths matter here. `settings` and `tools` are deliberately left
 * uncomposed so `ctx.get()` returns undefined for them: the plugin must work
 * without them, and this proves it rather than asserting it.
 *
 * @module dsh-webhook/examples/lib/stub-harness
 */

/**
 * @param options.log - the logger the plugin and this stub both write through.
 * @param options.latencyMs - how long the fake agent "thinks" for.
 * @param options.answer - `(promptText, sessionId, turn) => string`.
 */
export function createStubHarness({ log, latencyMs = 1_200, answer }) {
  const sessions = new Map()
  const prompts = []
  let sequence = 0

  return {
    /** Every prompt submitted, in order. */
    prompts,
    /** `{ sessionId, cwd, agentPreset }` for each session the bridge created. */
    created: [],
    /** How long the fake turn takes, so callers can size their waits. */
    latencyMs,

    create({ cwd, agentPreset }) {
      const sessionId = `sess_${String(++sequence).padStart(2, '0')}`
      const entry = {
        session: { id: sessionId, deriveMessages: () => entry.messages.slice() },
        messages: [],
        status: 'idle',
        waiters: [],
      }
      sessions.set(sessionId, entry)
      this.created.push({ sessionId, cwd, agentPreset })
      log('info', '[harness] sessionController.create({ cwd: %s, agentPreset: %s }) → %s',
        cwd ?? '-', agentPreset ?? '-', sessionId)
      return { sessionId }
    },

    prompt({ sessionId, content, requestId }) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) throw new Error(`no such session: ${sessionId}`)
      const text = content.map((block) => block.text).join('\n')
      const turn = entry.messages.length + 1
      prompts.push({ sessionId, requestId, text })
      log('info', '[harness] sessionController.prompt(%s) — 假 Agent 开始思考 %dms', sessionId, latencyMs)
      entry.status = 'running'
      setTimeout(() => {
        entry.messages.push({ role: 'assistant', content: [{ type: 'text', text: answer(text, sessionId, turn) }] })
        entry.status = 'idle'
        entry.waiters.splice(0).forEach((resolve) => resolve())
        log('info', '[harness] 假 Agent 回合结束，会话 %s 回到 idle', sessionId)
      }, latencyMs)
    },

    sessionOf: (sessionId) => sessions.get(sessionId)?.session,

    agentOf(sessionId) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) return undefined
      return {
        get status() { return entry.status },
        whenIdle: () => entry.status === 'idle'
          ? Promise.resolve()
          : new Promise((resolve) => entry.waiters.push(resolve)),
      }
    },
  }
}

/**
 * A stand-in cordis context exposing exactly the seams `apply` reaches for.
 *
 * `credentials.resolve` is a lookup table, which is what a real credential store
 * amounts to from the plugin's side; every lookup is logged, so a route whose
 * secret never resolves is visible in the output instead of just failing.
 *
 * @param options.secrets - `{ REF: 'value' }` the fake store answers with.
 * @param options.extraServices - anything else the caller wants `ctx.get` to serve.
 */
export function createStubContext({ harness, log, secrets, extraServices = {} }) {
  const disposers = []
  const get = (name) => {
    if (name === 'credentials') {
      return {
        resolve: async (ref) => {
          const hit = secrets[ref]
          log('info', '[ctx] credentials.resolve(%s) → %s', ref, hit === undefined ? '未找到' : '命中')
          return hit === undefined ? undefined : { value: hit }
        },
      }
    }
    return extraServices[name]
  }

  const ctx = {
    logger: () => log,
    get,
    effect: (fn) => { disposers.push(fn()) },
    sessionController: {
      create: (options) => Promise.resolve(harness.create(options)),
      prompt: (options) => Promise.resolve(harness.prompt(options)),
    },
    sessions: { get: (sessionId) => harness.sessionOf(sessionId) },
    agents: { get: (sessionId) => harness.agentOf(sessionId) },
  }
  return { ctx, dispose: () => disposers.forEach((fn) => fn()) }
}

/** Load the built artifact, with a message that says what to run instead of a stack trace. */
export async function loadBundle(bundlePath) {
  const { existsSync } = await import('node:fs')
  if (!existsSync(bundlePath)) {
    console.error(`找不到构建产物 ${bundlePath} —— 请先执行：npm run build`)
    process.exit(1)
  }
  const { pathToFileURL } = await import('node:url')
  return await import(pathToFileURL(bundlePath).href)
}

/** Wait until the receiver answers its health check, instead of sleeping a guess. */
export async function waitForHealth(healthUrl, attempts = 60) {
  const { sleep } = await import('./terminal.mjs')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const probe = await fetch(healthUrl)
      if (probe.ok) return true
    } catch {
      /* not listening yet */
    }
    await sleep(50)
  }
  return false
}
