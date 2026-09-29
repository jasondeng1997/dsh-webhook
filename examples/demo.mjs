#!/usr/bin/env node
/**
 * A runnable end-to-end demo of dsh-webhook.
 *
 * This script imports the *built* artifact (`lib/index.js`) and drives it
 * through a minimal stand-in for the harness, so the whole pipeline runs for
 * real: a real HTTP listener, a real signature check, a real template render, a
 * real callback POST. Only two things are faked, and both are labelled in the
 * output:
 *
 *   - the agent turn (a 1.2s timer instead of a model call, so the demo needs
 *     no API key and no network)
 *   - the credential store (a lookup table instead of the harness's)
 *
 * Everything else is the shipped code path. That is the point: if the demo
 * works, the artifact loads, the routes route, the signatures verify, the
 * dispatcher dispatches, and the retry policy runs.
 *
 * Run it with `npm run demo`. Build first if `lib/` is missing.
 *
 * @module dsh-webhook/examples/demo
 */

import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'index.js')

if (!existsSync(bundle)) {
  console.error('找不到构建产物 lib/index.js —— 请先执行：npm run build')
  process.exit(1)
}

const plugin = await import(pathToFileURL(bundle).href)

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true
const paint = (code) => (text) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : String(text))
const dim = paint(2)
const bold = paint(1)
const red = paint(31)
const green = paint(32)
const yellow = paint(33)
const blue = paint(36)

const rule = (title) => {
  console.log('')
  const dashes = '─'.repeat(Math.max(0, 62 - displayWidth(title) - 3))
  console.log(bold(blue(`── ${title} ${dashes}`)))
}

const line = (label, value, paintValue = (x) => x) => {
  console.log(`  ${dim(padRight(label, 14))} ${paintValue(String(value))}`)
}

/**
 * Terminal cells a string occupies. CJK glyphs are double-width, so `padEnd`
 * on a Chinese label silently under-pads and the columns drift apart.
 */
function displayWidth(text) {
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
function padRight(text, target) {
  return String(text) + ' '.repeat(Math.max(0, target - displayWidth(text)))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ask the OS for a port nobody is using, then close it. */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------------------
// The fake harness
// ---------------------------------------------------------------------------

/** How long the fake agent "thinks" for. */
const AGENT_LATENCY_MS = 1_200

/**
 * Build a stand-in for the harness: sessions that record messages, agents that
 * report `running`/`idle`, and a session controller that creates and prompts
 * them. This is the smallest surface `src/index.ts` touches.
 */
function createFakeHarness(log) {
  const sessions = new Map()
  const prompts = []
  let sequence = 0

  const answer = (promptText, sessionId) => {
    const turn = (sessions.get(sessionId)?.messages.length ?? 0) + 1
    const highlights = promptText
      .split('\n')
      .filter((row) => /refs\/heads|失败提交|提交说明/.test(row))
      .map((row) => `    ${row.trim()}`)
    return [
      '【演示用的假 Agent —— 真实部署里这里是模型的回答】',
      `这是会话 ${sessionId} 的第 ${turn} 个回合，提示词 ${promptText.length} 字符。`,
      '我从提示词里读到了：',
      ...highlights,
      `结论：${turn > 1 ? '这个会话我已经处理过同类事件，可以直接复用上下文。' : '首次收到该仓库的失败通知，需要先读日志。'}`,
    ].join('\n')
  }

  return {
    /** Every prompt submitted, in order — printed at the end of the demo. */
    prompts,
    /** Session ids the bridge created, in order. */
    created: [],

    create({ cwd, agentPreset }) {
      const sessionId = `sess_${String(++sequence).padStart(2, '0')}`
      sessions.set(sessionId, {
        session: { id: sessionId, deriveMessages: () => entries.messages.slice() },
        messages: [],
        status: 'idle',
        waiters: [],
      })
      const entries = sessions.get(sessionId)
      this.created.push({ sessionId, cwd, agentPreset })
      log('info', `[harness] sessionController.create({ cwd: %s, agentPreset: %s }) → %s`,
        cwd ?? '-', agentPreset ?? '-', sessionId)
      return { sessionId }
    },

    prompt({ sessionId, content, requestId }) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) throw new Error(`no such session: ${sessionId}`)
      const text = content.map((block) => block.text).join('\n')
      prompts.push({ sessionId, requestId, text })
      log('info', '[harness] sessionController.prompt(%s) — 假 Agent 开始思考 %dms', sessionId, AGENT_LATENCY_MS)
      entry.status = 'running'
      setTimeout(() => {
        entry.messages.push({ role: 'assistant', content: [{ type: 'text', text: answer(text, sessionId) }] })
        entry.status = 'idle'
        entry.waiters.splice(0).forEach((resolve) => resolve())
        log('info', '[harness] 假 Agent 回合结束，会话 %s 回到 idle', sessionId)
      }, AGENT_LATENCY_MS)
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
 * Build a stand-in cordis context exposing exactly the seams `apply` reaches
 * for. `credentials.resolve` is a lookup table, which is what a real credential
 * store amounts to from the plugin's side.
 */
function createFakeContext(harness, log, secrets) {
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
    // `settings` and `tools` stay uncomposed on purpose: `apply` is supposed to
    // work without them, and this proves it rather than asserting it.
    return undefined
  }
  const logger = (...args) => log('info', ...args)
  logger.info = (...args) => log('info', ...args)
  logger.warn = (...args) => log('warn', ...args)
  logger.error = (...args) => log('error', ...args)
  logger.debug = (...args) => log('debug', ...args)

  const ctx = {
    logger: () => logger,
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

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

/** The shared secret the "credential store" hands back for the GitHub route. */
const GITHUB_SECRET = 'a-demo-shared-secret-not-for-production'

/** The payload GitHub would send for a failed push. */
const PUSH_PAYLOAD = {
  ref: 'refs/heads/main',
  repository: {
    full_name: 'jasondeng1997/dsh-webhook',
    html_url: 'https://github.com/jasondeng1997/dsh-webhook',
    default_branch: 'main',
  },
  head_commit: {
    id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    message: 'fix: bound the callback retry queue',
    author: { name: 'JasonDeng', email: '15301580353@163.com' },
  },
  commits: [
    { id: 'a1b2c3d', message: 'fix: bound the callback retry queue' },
    { id: 'b2c3d4e', message: 'test: cover 503 on queue saturation' },
    { id: 'c3d4e5f', message: 'docs: explain the fail-closed default' },
  ],
  sender: { login: 'jasondeng1997' },
}

const logs = []
const log = (level, format, ...args) => {
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
  logs.push({ level, text })
  const tone = level === 'warn' ? yellow : level === 'error' ? red : dim
  console.log(`  ${tone('│')} ${tone(text)}`)
}

const port = await freePort()
const callbackPort = await freePort()
const managementToken = 'demo-management-token'

/** Collects the callbacks the bridge posts back. */
const callbacks = []
const callbackServer = createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    callbacks.push({ path: request.url, headers: request.headers, body })
    log('info', '[callback] ← POST %s (%d bytes)', request.url, body.length)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
})
await new Promise((resolve) => callbackServer.listen(callbackPort, '127.0.0.1', resolve))

// ---------------------------------------------------------------------------

console.log('')
console.log(bold('dsh-webhook 端到端演示'))
console.log(dim(`  桥监听端口 http://127.0.0.1:${port}`))
console.log(dim(`  回调接收端口 http://127.0.0.1:${callbackPort}`))
console.log(dim(`  插件构建产物 ${bundle.replace(process.cwd() + '/', '')}`))

rule('加载插件')

const harness = createFakeHarness(log)
const { ctx, dispose } = createFakeContext(harness, log, { GITHUB_WEBHOOK_SECRET: GITHUB_SECRET })

console.log(`  ${dim('name  ')} ${plugin.name}`)
console.log(`  ${dim('inject')} ${JSON.stringify(plugin.inject)}`)
console.log(`  ${dim('exports')} ${Object.keys(plugin).join(', ')}`)

const config = {
  enabled: true,
  host: '127.0.0.1',
  port,
  managementToken,
  callbackAttempts: 2,
  callbackBackoffMs: 200,
  routes: [
    {
      id: 'ci',
      path: '/hooks/ci',
      source: 'github',
      secretRef: 'GITHUB_WEBHOOK_SECRET',
      events: ['push'],
      workspace: '/tmp/demo-repo',
      agentPreset: 'default',
      callbackUrl: `http://127.0.0.1:${callbackPort}/agent-reply`,
      callbackHeaders: { 'x-demo-route': '{{ __route }}', 'x-demo-event': '{{ __event }}' },
      template: [
        'CI 在 {{ repository.full_name }} 的 {{ ref }} 上失败了，请排查。',
        '',
        '失败提交：{{ head_commit.id }}',
        '提交说明：{{ head_commit.message }}',
        '提交人：{{ head_commit.author.name }}',
        '',
        '最近 3 个提交：',
        '  1. {{ commits[0].message }}',
        '  2. {{ commits[1].message }}',
        '  3. {{ commits[2].message }}',
        '',
        '请阅读失败日志、定位根因，并给出可以直接执行的修复建议。',
      ].join('\n'),
      instructions: '回答请控制在 6 行以内，用中文。',
      maxConcurrency: 2,
    },
    {
      id: 'ops',
      path: '/hooks/ops',
      source: 'generic',
      allowUnsigned: true,
      replyMode: 'none',
      template: '运维事件 {{ __event }}：{{ message }}',
    },
  ],
}

plugin.apply(ctx, config)

console.log(`  ${dim('apply()')} 已调用，等待监听端口就绪…`)

// Wait for the listener to answer, rather than sleeping a guessed amount.
const health = `http://127.0.0.1:${port}/healthz`
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const probe = await fetch(health)
    if (probe.ok) break
  } catch {
    /* not listening yet */
  }
  await sleep(50)
}

// ---------------------------------------------------------------------------

const sign = (body, secret) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/**
 * Fire one delivery at the bridge and report what came back.
 * @returns the parsed delivery id, when the bridge returned one.
 */
async function deliver({ label, path, body, headers, expect }) {
  rule(label)
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  console.log(`  ${dim('POST')} ${path}`)
  for (const [name, value] of Object.entries(headers)) {
    const shown = name.toLowerCase().includes('signature')
      ? `${value.slice(0, 20)}…${value.slice(-8)}`
      : value
    console.log(`  ${dim('    ↳')} ${name}: ${shown}`)
  }

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  })
  const text = await response.text()
  const ok = response.status === expect
  console.log(`  ${dim('    ←'.padEnd(6))} HTTP ${ok ? green(response.status) : red(response.status)} ${dim(`(期望 ${expect})`)}`)
  console.log(`  ${dim('    ←')} ${text}`)
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const pushBody = JSON.stringify(PUSH_PAYLOAD)
const githubHeaders = {
  'x-github-event': 'push',
  'x-github-delivery': 'd-1111-2222',
  'x-hub-signature-256': sign(pushBody, GITHUB_SECRET),
}

// 1. A properly signed delivery drives a session, and the answer comes back.
const first = await deliver({
  label: '① 合法投递：签名正确、事件匹配 → 驱动会话并回传',
  path: '/hooks/ci',
  body: pushBody,
  headers: githubHeaders,
  expect: 202,
})

await sleep(AGENT_LATENCY_MS + 900)

// 2. The same route again: `session: auto` means the same conversation.
const second = await deliver({
  label: '② 再来一条：会话被复用，而不是每投递建一个新会话',
  path: '/hooks/ci',
  body: pushBody,
  headers: { ...githubHeaders, 'x-github-delivery': 'd-3333-4444' },
  expect: 202,
})

await sleep(AGENT_LATENCY_MS + 900)

// 3. A wrong signature never reaches the dispatcher.
await deliver({
  label: '③ 签名错误 → 401，投递不进流水线',
  path: '/hooks/ci',
  body: pushBody,
  headers: { ...githubHeaders, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
  expect: 401,
})

// 4. Correct signature, but the route only subscribes to `push`.
await deliver({
  label: '④ 验签通过但事件被过滤（路由只订阅 push）→ 202，不惊动 Agent',
  path: '/hooks/ci',
  body: JSON.stringify({ zen: 'Design for failure.', repository: PUSH_PAYLOAD.repository }),
  headers: { ...githubHeaders, 'x-github-event': 'ping', 'x-hub-signature-256': sign(JSON.stringify({ zen: 'Design for failure.', repository: PUSH_PAYLOAD.repository }), GITHUB_SECRET) },
  expect: 202,
})

// 5. No secret at all: the endpoint fails closed instead of degrading.
await deliver({
  label: '⑤ 完全不带签名 → 401（没有 secret 就默认关闭，不会降级放行）',
  path: '/hooks/ci',
  body: pushBody,
  headers: { 'x-github-event': 'push' },
  expect: 401,
})

// 6. An explicitly unsigned endpoint, which is the deliberate opt-out.
await deliver({
  label: '⑥ 显式声明 allowUnsigned 的路由 → 202（这是主动选择，不是默认）',
  path: '/hooks/ops',
  body: { event: 'disk-pressure', message: 'volume /data 剩余 4%' },
  headers: { 'x-webhook-event': 'disk-pressure' },
  expect: 202,
})

await sleep(AGENT_LATENCY_MS + 600)

// ---------------------------------------------------------------------------

rule('Agent 实际收到的提示词')
console.log(dim('  模板渲染后的第一条（模板只取值，不执行任何表达式）：'))
console.log('')
console.log(
  harness.prompts[0].text
    .split('\n')
    .map((row) => `  ${green('│')} ${row}`)
    .join('\n'),
)

rule('回传的答案')
for (const [index, entry] of callbacks.entries()) {
  const body = JSON.parse(entry.body)
  console.log(`  ${bold(`#${index + 1}`)} ${dim('POST')} ${entry.path}`)
  line('投递', body.deliveryId.slice(0, 8) + '…')
  line('路由', body.route)
  line('会话', body.sessionId)
  line('事件', body.event)
  line('耗时', `${Math.round((Date.parse(body.answeredAt) - Date.parse(body.receivedAt)))}ms`)
  line('自定义头', `${entry.headers['x-demo-route']} / ${entry.headers['x-demo-event']}`, blue)
  console.log(`  ${dim('答案')}`)
  console.log(
    body.answer
      .split('\n')
      .map((row) => `    ${row}`)
      .join('\n'),
  )
  console.log('')
}

rule('会话复用情况')
const ciSession = harness.created[0].sessionId
const ciPrompts = harness.prompts.filter((entry) => entry.sessionId === ciSession)
line('ci 的投递', `2 次 → 全部落在会话 ${ciSession}`)
line('会话总数', `${harness.created.length} 个（ci 与 ops 各一个，而非每次投递一个）`)
line('会话参数', `cwd=${harness.created[0].cwd} agentPreset=${harness.created[0].agentPreset}`)
line('提示词', `${harness.prompts.length} 条`)
line(
  '结论',
  harness.created.length === 2 && ciPrompts.length === 2
    ? 'session: auto 让一条路由的两条投递共用一个会话 ✓'
    : '会话绑定与预期不符 ✗',
  green,
)

rule('诊断接口')
const healthResponse = await fetch(health)
const healthBody = await healthResponse.json()
console.log(`  ${dim('GET /healthz')} → HTTP ${healthResponse.status} ${dim('（只报存活与路由数，不泄露任何路由细节）')}`)
console.log(`  ${JSON.stringify(healthBody, null, 2).split('\n').join('\n  ')}`)
console.log('')

const token = { 'x-webhook-token': managementToken }
const unauthorized = await fetch(`http://127.0.0.1:${port}/deliveries`)
console.log(`  ${dim('GET /deliveries（不带 token）')} → HTTP ${red(unauthorized.status)}`)
const deliveriesResponse = await fetch(`http://127.0.0.1:${port}/deliveries?limit=20`, { headers: token })
const deliveriesBody = await deliveriesResponse.json()
console.log(`  ${dim('GET /deliveries（带 x-webhook-token）')} → HTTP ${green(deliveriesResponse.status)}`)
line('计数器', JSON.stringify(deliveriesBody.summary))
console.log('')
for (const row of deliveriesBody.deliveries) {
  const stage = row.stage === 'answered'
    ? green(String(row.stage).padEnd(10))
    : row.stage === 'filtered' ? dim(String(row.stage).padEnd(10)) : yellow(String(row.stage).padEnd(10))
  console.log(`  ${dim(row.id.slice(0, 8))}  ${stage} ${String(row.route).padEnd(4)} ${String(row.event ?? '-').padEnd(14)} ${dim(`${row.durationMs ?? 0}ms`)}`)
}
console.log('')
console.log(dim('  注意：被 401 拒掉的投递不会出现在这里 —— 它在验签阶段就结束了，'))
console.log(dim('  从没进过流水线，也就没有投递记录。这是有意为之。'))

// ---------------------------------------------------------------------------

rule('收尾')
dispose()
await new Promise((resolve) => callbackServer.close(resolve))
callbackServer.closeAllConnections?.()
console.log(`  ${green('✓')} 监听端口已关闭，回调服务已停止`)
console.log(`  ${dim(`共产生 ${logs.length} 条日志，${plugin.name} 全程未接触任何模型 API`)}`)
console.log('')
console.log(bold('  演示结束。'))
console.log(dim('  这份脚本加载的是 lib/index.js —— npm run build 的产物，不是源码。'))
console.log('')

// `fetch` keeps sockets alive in the shared agent, which would otherwise hold
// the event loop open after the last line is printed.
process.exit(0)
