#!/usr/bin/env node
/**
 * Smoke-test every scenario `trigger.mjs` implements, against a real receiver.
 *
 * The examples are the only place where the *built artifact* is loaded, which
 * makes them the only place where a packaging mistake is visible. That also
 * makes them the easiest thing in the repository to leave broken: they are not
 * imported by any unit test, so nothing fails when the artifact stops loading.
 * This script closes that gap — it mounts the bridge in-process, then drives
 * `trigger.mjs` through all eight scenarios as child processes, and fails if any
 * of them does not behave as documented.
 *
 * It is also the shortest way to check a machine after a Node upgrade, and the
 * right shape for a post-deploy check of a real endpoint (point `--url` at it).
 *
 *   node examples/smoke.mjs
 *   node examples/smoke.mjs --url https://your-domain/hooks/github/pr --secret s3cret
 *
 * @module dsh-webhook/examples/smoke
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bold, dim, freePort, green, line, parseArgs, red, rule } from './lib/terminal.mjs'
import { createStubContext, createStubHarness, loadBundle, waitForHealth } from './lib/stub-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const USAGE = `
把 trigger.mjs 的八个场景全部跑一遍，验证示例与构建产物都还正常。

用法:
  node examples/smoke.mjs [选项]

选项:
  --url <url>       不自己起桥，直接打这个已存在的端点（例如你的真实部署）
  --secret <value>  密钥；自己起桥时默认 dev-shared-secret
  --listen <port>   回调接收端口；自己起桥时自动分配
  --verbose         每个场景都打印完整输出
  --help            显示这段帮助
`

const argv = parseArgs(process.argv.slice(2), ['verbose', 'help'])
if (argv.help === true) {
  console.log(USAGE.trim())
  process.exit(0)
}

const secret = String(argv.secret ?? 'dev-shared-secret')
const explicitUrl = typeof argv.url === 'string' ? String(argv.url) : undefined
const callbackPort = argv.listen === undefined ? await freePort() : Number(argv.listen)

/** Every scenario `trigger.mjs` documents, in the order they make sense. */
const SCENARIOS = [
  'ok',
  'replay',
  'wrong-signature',
  'unsigned',
  'wrong-event',
  'oversized',
  'wrong-path',
  'get',
]

// ---------------------------------------------------------------------------
// Either mount a bridge here, or trust the one the caller named
// ---------------------------------------------------------------------------

let url = explicitUrl
let dispose = () => {}
let mount

if (url === undefined) {
  // A silent logger: this script reports on scenarios, and the bridge's own log
  // lines would interleave with the results table.
  const silent = Object.assign(() => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  const plugin = await loadBundle(join(root, 'lib', 'index.js'))

  const port = await freePort()
  const harness = createStubHarness({
    log: silent,
    latencyMs: 400,
    answer: (promptText, sessionId, turn) => `fake answer for ${sessionId} turn ${turn}`,
  })
  const context = createStubContext({ harness, log: silent, secrets: { GITHUB_WEBHOOK_SECRET: secret } })
  dispose = context.dispose

  // The same route examples/github-pr-review.patch.yml configures.
  plugin.apply(context.ctx, {
    enabled: true,
    host: '127.0.0.1',
    port,
    managementToken: 'smoke-management-token',
    callbackAttempts: 1,
    callbackBackoffMs: 100,
    routes: [{
      id: 'pr-review',
      path: '/hooks/github/pr',
      source: 'github',
      secretRef: 'GITHUB_WEBHOOK_SECRET',
      events: ['pull_request'],
      session: 'auto',
      workspace: root,
      callbackUrl: `http://127.0.0.1:${callbackPort}/dsh/reply`,
      callbackHeaders: { 'x-dsh-route': '{{ __route }}', 'x-dsh-delivery': '{{ __deliveryId }}' },
      template: 'PR {{ action }}: {{ pull_request.title }} by {{ pull_request.user.login }}',
    }],
  })

  const health = `http://127.0.0.1:${port}/healthz`
  if (!await waitForHealth(health)) {
    console.error(`${red('✗')} 桥没能在 ${port} 上起来`)
    process.exit(1)
  }
  url = `http://127.0.0.1:${port}/hooks/github/pr`
  mount = { port, callbackPort }
}

// ---------------------------------------------------------------------------
// Drive each scenario as a child process
// ---------------------------------------------------------------------------

console.log('')
console.log(bold('dsh-webhook 示例冒烟测试'))
if (mount === undefined) {
  console.log(dim(`  目标 ${url}（外部端点，本例不自起桥）`))
} else {
  console.log(dim(`  本轮自己起了桥：端点 ${url}，回调 ${mount.callbackPort}`))
  console.log(dim('  假 Agent 的延迟 400ms，全程不调用任何模型 API'))
}

rule(`跑 ${SCENARIOS.length} 个场景`)

const results = []

for (const scenario of SCENARIOS) {
  const child = spawn(process.execPath, [
    join(here, 'trigger.mjs'),
    '--url', url,
    '--secret', secret,
    '--listen', String(callbackPort),
    '--timeout', '20',
    '--scenario', scenario,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const code = await new Promise((resolve) => child.on('exit', resolve))

  const status = /HTTP\s+(\d{3})/.exec(stdout)?.[1] ?? '?'
  const expected = /期望\s+(\d{3})/.exec(stdout)?.[1] ?? '?'
  const callbacks = /收到 (\d+) 条回调/.exec(stdout)?.[1] ?? '0'
  const passed = code === 0
  results.push({ scenario, passed, status, expected, callbacks, stdout, stderr })

  const title = passed ? green('PASS') : red('FAIL')
  console.log(
    `  ${title}  ${scenario.padEnd(16)} HTTP ${String(status).padStart(3)} ${dim(`（期望 ${expected}）`)}`
    + `  回调 ${callbacks}`,
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = results.filter((row) => !row.passed)
if (failed.length > 0) {
  for (const row of failed) {
    rule(`场景 ${row.scenario} 的完整输出`)
    console.log(row.stdout)
    if (row.stderr.trim() !== '') {
      console.log(dim('  --- stderr ---'))
      console.log(row.stderr)
    }
  }
} else if (argv.verbose === true) {
  for (const row of results) {
    rule(`场景 ${row.scenario} 的完整输出`)
    console.log(row.stdout)
  }
} else {
  rule('一条 ok 场景的完整输出（-v 可看全部）')
  console.log(results[0].stdout)
}

rule('结论')
line('通过', `${results.length - failed.length}/${results.length}`, (value) => failed.length === 0 ? green(value) : red(value))
line('端点', url)
if (failed.length > 0) {
  line('失败场景', failed.map((row) => row.scenario).join(', '), red)
}

dispose()
console.log('')
console.log(failed.length === 0 ? green('  全部场景符合预期。') : red('  有场景未按预期结束，见上面的输出。'))
console.log('')

// Child processes used fetch; the shared agent's keep-alive sockets would hold
// this process open after the last line.
process.exit(failed.length === 0 ? 0 : 1)
