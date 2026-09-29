#!/usr/bin/env node
/**
 * Pretend to be the upstream: sign a realistic webhook and deliver it.
 *
 * This is the half of the example you cannot get from a real service. GitHub
 * will happily send you a `pull_request` event — when someone opens a pull
 * request, into a repo that has a public URL pointing at your machine. Neither
 * condition is under your control while you are wiring things up, so this script
 * produces exactly what GitHub would send, signed with the same scheme, and
 * listens for the answer.
 *
 * Use it against the local bridge (`npm run example:bridge`), against a real DSH
 * profile, or against your deployed endpoint behind a tunnel. Apart from the
 * signature it makes no assumptions about what is on the other side, so a `401`
 * here is a real `401` from real bridge code.
 *
 *   node examples/trigger.mjs --url http://127.0.0.1:8787/hooks/github/pr \
 *                             --secret my-shared-secret
 *
 * Exit code is 0 when the delivery behaved as its scenario describes.
 *
 * @module dsh-webhook/examples/trigger
 */

import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { block, bold, blue, dim, green, line, padRight, parseArgs, red, rule, sleep, yellow } from './lib/terminal.mjs'

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const USAGE = `
模拟一次真实的上游投递，并等待 Agent 的回答回传。

用法:
  node examples/trigger.mjs --url <端点> --secret <密钥> [选项]

必填:
  --url <url>          上游要打的完整地址，例如
                       http://127.0.0.1:8787/hooks/github/pr
  --secret <secret>    上游那边配置的同一个密钥（签名场景必填）

常用:
  --source <name>      签名方案: github | gitlab | gitee | generic    (默认 github)
  --event <name>       事件名，例如 pull_request                    (默认按 source 取)
  --scenario <name>    见下表                                       (默认 ok)
  --listen <port>      本地回调接收端口                              (默认 9099)
  --timeout <seconds>  等待回调的秒数                                (默认 120)

其他:
  --payload <file>     用文件里的 JSON 替换内置示例载荷
  --show-payload       打印将要发送的完整 JSON
  --no-listen          不启动回调接收器（只关心投递结果时用）
  --help               显示这段帮助

场景:
  ok                 签名正确、事件匹配 —— 应当 202，并且能收到回调
  wrong-signature    用错误的密钥签名 —— 应当 401，且投递不进流水线
  unsigned           完全不带签名 —— 应当 401（没有密钥就默认关闭）
  wrong-event        签名正确但事件不在路由的 events 里 —— 应当 202 但不惊动 Agent
  oversized          请求体超过 maxBodyBytes —— 应当 413
  wrong-path         打到一个没配置的路径 —— 应当 404
  get                用 GET 打端点 —— 应当 405
  replay             连发两条相同投递 —— 两条都应回传，且落在同一个会话
`

const argv = parseArgs(process.argv.slice(2), ['help', 'show-payload', 'no-listen'])

if (argv.help === true || argv.url === undefined) {
  console.log(USAGE.trim())
  process.exit(argv.help === true ? 0 : 1)
}

const url = String(argv.url)
const source = String(argv.source ?? 'github')
const scenario = String(argv.scenario ?? 'ok')
const listenPort = argv.noListen === true ? undefined : Number(argv.listen ?? 9099)
const timeoutMs = Number(argv.timeout ?? 120) * 1_000
const secret = argv.secret === undefined ? '' : String(argv.secret)

if (!['github', 'gitlab', 'gitee', 'generic'].includes(source)) {
  console.error(`未知的 --source "${source}"，可选值: github | gitlab | gitee | generic`)
  process.exit(1)
}
const SIGNING_SCENARIOS = new Set(['ok', 'wrong-event', 'oversized', 'wrong-path', 'get', 'replay'])
if (secret === '' && SIGNING_SCENARIOS.has(scenario)) {
  console.error(`场景 "${scenario}" 需要 --secret（从上游的 Webhook 配置里取同一个值）`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Payloads: what each upstream actually sends
// ---------------------------------------------------------------------------

/** GitHub `pull_request` / `opened`. Trimmed to the fields a prompt tends to use. */
const GITHUB_PULL_REQUEST = {
  action: 'opened',
  number: 42,
  pull_request: {
    title: 'feat: bound the callback retry queue',
    user: { login: 'jasondeng1997' },
    body: '把回调队列改成有界的，超出直接拒绝，让上游去重试。',
    html_url: 'https://github.com/jasondeng1997/dsh-webhook/pull/42',
    base: { ref: 'main' },
    head: { ref: 'fix/retry-queue' },
    additions: 128,
    deletions: 12,
    changed_files: 4,
  },
  repository: {
    full_name: 'jasondeng1997/dsh-webhook',
    html_url: 'https://github.com/jasondeng1997/dsh-webhook',
    default_branch: 'main',
  },
  sender: { login: 'jasondeng1997' },
}

/** GitHub `ping`, which every webhook sends once when you save it. */
const GITHUB_PING = {
  zen: 'Design for failure.',
  hook_id: 512345678,
  repository: GITHUB_PULL_REQUEST.repository,
  sender: GITHUB_PULL_REQUEST.sender,
}

/** GitLab `merge_request` / `open`. */
const GITLAB_MERGE_REQUEST = {
  object_kind: 'merge_request',
  user: { username: 'jasondeng' },
  project: { path_with_namespace: 'platform/dsh-webhook', web_url: 'https://gitlab.example.com/platform/dsh-webhook' },
  object_attributes: {
    action: 'open',
    title: 'fix: bound the callback retry queue',
    source_branch: 'fix/retry-queue',
    target_branch: 'main',
    url: 'https://gitlab.example.com/platform/dsh-webhook/-/merge_requests/7',
    description: '把回调队列改成有界的，超出直接拒绝。',
  },
}

/** A hand-rolled sender: an order refund notice from an internal system. */
const GENERIC_ORDER_REFUNDED = {
  orderId: 'A-1024',
  status: 'refunded',
  amount: 199,
  currency: 'CNY',
  reason: '用户重复下单',
  occurredAt: '2026-09-29T09:12:44+08:00',
}

const PAYLOADS = {
  github: { pull_request: GITHUB_PULL_REQUEST, ping: GITHUB_PING },
  gitlab: { 'Merge Request Hook': GITLAB_MERGE_REQUEST },
  gitee: { 'Merge Request Hook': GITLAB_MERGE_REQUEST, 'Push Hook': GITLAB_MERGE_REQUEST },
  generic: { order_refunded: GENERIC_ORDER_REFUNDED },
}

/**
 * The event name each upstream reports for the default payload.
 *
 * Note the GitLab case: the event rides in `X-Gitlab-Event` as `Merge Request
 * Hook`, and the bridge takes the header in preference to the payload's
 * `object_kind`. A route filtering on `[merge_request]` would therefore never
 * match — the filter has to use the header's wording.
 */
const DEFAULT_EVENT = {
  github: 'pull_request',
  gitlab: 'Merge Request Hook',
  gitee: 'Merge Request Hook',
  generic: 'order_refunded',
}

const event = String(argv.event ?? DEFAULT_EVENT[source])

/** Build the payload for this run, honouring `--payload` and the scenario. */
function buildPayload() {
  if (typeof argv.payload === 'string') {
    return JSON.parse(readFileSync(argv.payload, 'utf8'))
  }
  const bank = PAYLOADS[source] ?? {}
  if (scenario === 'wrong-event') {
    // A correctly signed delivery whose event the route does not subscribe to.
    // GitHub's `ping` is the honest example: it is what a real save produces.
    return bank.ping ?? Object.values(bank)[0] ?? { event: 'ping' }
  }
  return bank[event] ?? Object.values(bank)[0] ?? GENERIC_ORDER_REFUNDED
}

/** Headers that authenticate this delivery, per scheme. */
function signatureHeaders(body, signingSecret) {
  const digest = (algorithm) => createHmac(algorithm, signingSecret).update(body).digest('hex')
  switch (source) {
    case 'github':
      return {
        'x-github-event': scenario === 'wrong-event' ? 'ping' : event,
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${digest('sha256')}`,
      }
    case 'gitlab':
      return {
        'x-gitlab-event': scenario === 'wrong-event' ? 'Push Hook' : event,
        'x-gitlab-token': signingSecret,
      }
    case 'gitee':
      return {
        'x-gitee-event': scenario === 'wrong-event' ? 'Push Hook' : event,
        'x-gitee-token': signingSecret,
      }
    default:
      return {
        'x-webhook-event': scenario === 'wrong-event' ? 'ping' : event,
        'x-webhook-signature': `sha256=${digest('sha256')}`,
      }
  }
}

// ---------------------------------------------------------------------------
// What each scenario expects
// ---------------------------------------------------------------------------

/**
 * `expect` is the status the receiver must return, `callback` is how many
 * answers to wait for. Everything not listed here is unreachable by design:
 * a `401` never enters the pipeline, so it produces no delivery record and no
 * callback — which is the point of rejecting it early.
 */
const SCENARIOS = {
  ok: { label: '签名正确、事件匹配', expect: 202, callback: 1 },
  'wrong-signature': { label: '签名错误（用另一个密钥签名）', expect: 401, callback: 0 },
  unsigned: { label: '完全不带签名', expect: 401, callback: 0 },
  'wrong-event': { label: '验签通过但事件被 events 过滤', expect: 202, callback: 0 },
  oversized: { label: '请求体超过 maxBodyBytes', expect: 413, callback: 0 },
  'wrong-path': { label: '打到未配置的路径', expect: 404, callback: 0 },
  get: { label: '用 GET 打端点', expect: 405, callback: 0 },
  replay: { label: '连发两条相同投递', expect: 202, callback: 2 },
}

const plan = SCENARIOS[scenario]
if (plan === undefined) {
  console.error(`未知的 --scenario "${scenario}"，可运行 --help 查看全部场景`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// The callback receiver
// ---------------------------------------------------------------------------

/** Answers the bridge posts back, in arrival order. */
const callbacks = []
let callbackServer

if (listenPort !== undefined) {
  callbackServer = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      callbacks.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      // 200 with a tiny JSON body: the bridge retries anything that is not 2xx,
      // so a sloppy response here turns into a duplicate answer three times over.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
  })
  await new Promise((resolve, reject) => {
    callbackServer.once('error', reject)
    callbackServer.listen(listenPort, '127.0.0.1', resolve)
  })
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

const signingSecret = scenario === 'wrong-signature' ? `${secret}-not-the-real-one` : secret

let body = JSON.stringify(buildPayload(), null, argv.showPayload === true ? 2 : 0)
if (scenario === 'oversized') {
  // 2 MiB of padding: comfortably past the 1 MiB default maxBodyBytes, and past
  // any upstream's own payload limit, so only the bridge can be answering 413.
  body = JSON.stringify({ ...buildPayload(), padding: 'x'.repeat(2 * 1_048_576) })
}

const headers = {
  'content-type': 'application/json',
  ...(scenario === 'unsigned' ? {} : signatureHeaders(body, signingSecret)),
}

const target = new URL(url)
const path = scenario === 'wrong-path' ? `${target.pathname}-no-such-route` : target.pathname
const endpoint = `${target.origin}${path}`

console.log('')
console.log(bold('dsh-webhook —— 模拟一次上游投递'))
console.log(dim(`  场景 ${scenario} —— ${plan.label}`))

rule('将要发送的请求')
line('方法', scenario === 'get' ? 'GET' : 'POST')
line('地址', endpoint)
line('签名方案', `${source}${source === 'github' ? ' (x-hub-signature-256, HMAC-SHA256)' : source === 'generic' ? ' (x-webhook-signature, HMAC-SHA256)' : ` (x-${source}-token)`}`)
line('事件', headers['x-github-event'] ?? headers['x-gitlab-event'] ?? headers['x-gitee-event'] ?? headers['x-webhook-event'] ?? dim('(无)'))
line('载荷', `${Buffer.byteLength(body)} 字节${scenario === 'oversized' ? dim('（超过 1 MiB 上限）') : ''}`)
if (listenPort !== undefined) {
  line('回调接收', `http://127.0.0.1:${listenPort}${dim('（路由的 callbackUrl 必须指向这个端口）')}`)
}
for (const [name, value] of Object.entries(headers)) {
  if (name === 'content-type') continue
  if (argv.showPayload !== true) {
    const shown = /token|signature/.test(name)
      ? `${String(value).startsWith('sha256=') ? 'sha256=' : ''}${String(value).replace(/^sha256=/, '').slice(0, 16)}…${String(value).slice(-8)}`
      : value
    console.log(`  ${' '.repeat(15)}${dim(`${name}: ${String(shown)}`)}`)
  }
}
if (argv.showPayload === true) {
  console.log(dim('\n  载荷:'))
  console.log(block(body.length > 4_000 ? `${body.slice(0, 4_000)}\n… (截断显示，实际发送 ${body.length} 字节)` : body))
}

rule('上游视角')
const startedAt = Date.now()
let response
try {
  response = await fetch(endpoint, {
    method: scenario === 'get' ? 'GET' : 'POST',
    headers,
    body: scenario === 'get' ? undefined : body,
  })
} catch (error) {
  console.log(`  ${red('✗')} 请求发不出去: ${error.message}`)
  console.log(dim('    端点没起来？先确认桥在监听，或者 --url 里的地址和端口是否正确。'))
  process.exit(1)
}
const roundTrip = Date.now() - startedAt
const responseText = await response.text()
const statusOk = response.status === plan.expect

console.log(`  ${dim('HTTP')}   ${statusOk ? green(response.status) : red(response.status)} ${dim(`（期望 ${plan.expect}）`)}`)
console.log(`  ${dim('耗时')}   ${roundTrip}ms ${roundTrip < 500 ? green('—— 上游不需要等 Agent 跑完') : ''}`)
console.log(`  ${dim('响应体')} ${responseText.slice(0, 200)}`)

let deliveryId
try {
  const parsed = JSON.parse(responseText)
  if (typeof parsed.deliveryId === 'string') deliveryId = parsed.deliveryId
} catch {
  /* not JSON; the status code is the signal that matters */
}

if (scenario === 'replay') {
  const second = await fetch(endpoint, { method: 'POST', headers, body })
  const secondText = await second.text()
  console.log(`  ${dim('第二条')} HTTP ${second.status === plan.expect ? green(second.status) : red(second.status)} ${secondText.slice(0, 120)}`)
}

// ---------------------------------------------------------------------------
// Wait for the answer
// ---------------------------------------------------------------------------

if (plan.callback > 0) {
  rule(`等待回调（最多 ${Math.round(timeoutMs / 1_000)} 秒）`)
  console.log(dim('  桥在后台跑会话。真实场景里这一步是模型在跑工具，可能要几分钟。'))
  const deadline = Date.now() + timeoutMs
  while (callbacks.length < plan.callback && Date.now() < deadline) {
    await sleep(200)
  }
  if (callbacks.length < plan.callback) {
    console.log(`  ${yellow('…')} 等了 ${Math.round(timeoutMs / 1_000)} 秒，只收到 ${callbacks.length}/${plan.callback} 条回调`)
    console.log(dim('    排查顺序：路由的 callbackUrl 是否指向这个端口；replyMode 是否为 none；'))
    console.log(dim('    会话是否卡在工具调用上（GET /deliveries 看阶段）；replyTimeoutMs 是否太短。'))
  }
} else {
  // These scenarios end at the status code; say so rather than leaving a pause.
  const reason = {
    'wrong-signature': '401 发生在验签阶段，投递从未进入流水线，所以不会有回调，也不会有投递记录。',
    unsigned: '没有可用密钥的端点默认关闭。这不是配置错误，是设计上的默认姿态。',
    'wrong-event': '202 表示上游的投递已经被接收；事件被过滤，Agent 没有被叫醒。',
    oversized: '413 在读取阶段就拒绝了，比验签更早，避免为一个超大载荷做任何工作。',
    'wrong-path': '404 表示没有路由匹配这个路径。路由表在启动时打印，也在 GET /healthz 里报数量。',
    get: '405 表示路径存在但不是这个方法的端点。',
  }[scenario]
  if (reason !== undefined) {
    console.log('')
    console.log(`  ${dim('说明')} ${reason}`)
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (callbacks.length > 0) {
  rule(`收到 ${callbacks.length} 条回调`)
  for (const [index, entry] of callbacks.entries()) {
    let parsed
    try {
      parsed = JSON.parse(entry.body)
    } catch {
      console.log(`  ${red('✗')} 回调体不是 JSON: ${entry.body.slice(0, 200)}`)
      continue
    }
    console.log('')
    console.log(`  ${bold(`#${index + 1}`)} ${dim('POST')} ${entry.path}`)
    line('投递', `${String(parsed.deliveryId).slice(0, 8)}…`)
    line('路由', parsed.route)
    line('会话', parsed.sessionId)
    line('事件', parsed.event)
    line('耗时', `${Date.parse(parsed.answeredAt) - Date.parse(parsed.receivedAt)}ms ${dim('(从收到到回答)')}`)
    const custom = Object.keys(entry.headers).filter((name) => name.startsWith('x-dsh-'))
    if (custom.length > 0) {
      line('自定义头', custom.map((name) => `${name}: ${entry.headers[name]}`).join('  '), blue)
    }
    console.log(`  ${dim('答案')}`)
    console.log(block(parsed.answer, '    '))
  }

  if (plan.callback > 1) {
    const sessions = new Set(callbacks.map((entry) => JSON.parse(entry.body).sessionId))
    console.log('')
    line(
      '会话复用',
      sessions.size === 1
        ? `${[...sessions][0]} —— 两条投递共用一个会话 ✓（session: auto 生效）`
        : `${sessions.size} 个不同会话 ✗`,
      sessions.size === 1 ? green : red,
    )
  }
}

rule('结论')
const checks = [
  ['上游 → 桥', `HTTP ${response.status}（期望 ${plan.expect}）`, statusOk],
  ['桥 → 会话', plan.callback > 0 ? '已提交并在后台运行' : '未进入流水线（符合预期）', true],
  ['会话 → 回调', plan.callback > 0 ? `收到 ${callbacks.length}/${plan.callback} 条` : '本场景不产生回调', callbacks.length >= plan.callback],
]
for (const [name, detail, ok] of checks) {
  console.log(`  ${ok ? green('✓') : red('✗')} ${padRight(name, 14)} ${detail}`)
}

const allPassed = statusOk && callbacks.length >= plan.callback

if (scenario === 'ok' && deliveryId !== undefined) {
  console.log('')
  console.log(dim(`  投递 ID ${deliveryId}`))
  console.log(dim('  它现在应该出现在诊断接口里：'))
  console.log(dim('    curl -H "x-webhook-token: $TOKEN" http://127.0.0.1:8787/deliveries | jq'))
}

console.log('')
console.log(bold('  同样的请求，用 curl 发出来是这样：'))
const curlSecret = source === 'gitlab' || source === 'gitee' ? secret : '你的密钥'
if (source === 'gitlab' || source === 'gitee') {
  console.log(dim(`    curl -sS -X POST '${endpoint}' \\`))
  console.log(dim(`      -H 'content-type: application/json' \\`))
  console.log(dim(`      -H 'x-${source}-token: ${curlSecret}' \\`))
  console.log(dim(`      -H 'x-${source}-event: ${event}' \\`))
  console.log(dim(`      -d '${body.slice(0, 120)}${body.length > 120 ? '…' : ''}'`))
} else {
  const signatureHeader = source === 'github' ? 'x-hub-signature-256' : 'x-webhook-signature'
  console.log(dim('    SECRET=\'你的密钥\''))
  console.log(dim(`    BODY='{"action":"opened", ...}'      # 见 examples/ 里的载荷示例`))
  console.log(dim('    SIG=$(printf \'%s\' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk \'{print $2}\')'))
  console.log(dim(`    curl -sS -X POST '${endpoint}' \\`))
  console.log(dim(`      -H 'content-type: application/json' \\`))
  console.log(dim(`      -H '${signatureHeader}: sha256=$SIG' \\`))
  console.log(dim(`      -H '${source === 'github' ? 'x-github' : 'x-webhook'}-event: ${event}' \\`))
  console.log(dim('      -d "$BODY"'))
}
console.log('')

// ---------------------------------------------------------------------------

if (callbackServer !== undefined) {
  callbackServer.closeAllConnections?.()
  await new Promise((resolve) => callbackServer.close(resolve))
}
console.log(allPassed ? green('  场景通过。') : red('  场景未按预期结束，请对照上面的检查项。'))
console.log('')

// `fetch` keeps sockets alive in the shared agent, which would hold the event
// loop open after the last line is printed.
process.exit(allPassed ? 0 : 1)
