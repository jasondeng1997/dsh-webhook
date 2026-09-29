#!/usr/bin/env node
/**
 * A local stand-in for DSH, so the bridge can be driven without installing it.
 *
 * `npm run demo` runs everything in one process; this script splits it in two,
 * which is the shape you actually deploy: a long-lived bridge listening on a
 * port, and something else posting to it. Run this in one terminal and
 * `examples/trigger.mjs` in another, and you are looking at the real deployment
 * topology with only the model call faked.
 *
 * It imports the built artifact (`lib/index.js`), so a broken build or a wrong
 * external specifier fails here rather than inside a harness boot. The route it
 * mounts is the same one `examples/github-pr-review.patch.yml` configures, and
 * it prints that configuration as YAML so you can compare the two.
 *
 *   node examples/local-bridge.mjs --port 8787 --secret shared-secret
 *
 * @module dsh-webhook/examples/local-bridge
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger, dim, bold, green, line, parseArgs, red, rule } from './lib/terminal.mjs'
import { createStubContext, createStubHarness, loadBundle, waitForHealth } from './lib/stub-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'lib', 'index.js')

const USAGE = `
起一个本地桥，用一个假 Agent 顶替 Harness 会话，用来验证整条链路。

用法:
  node examples/local-bridge.mjs [选项]

选项:
  --port <port>             桥监听的端口                          (默认 8787)
  --secret <value>          存进假凭据库的密钥                     (默认 dev-shared-secret)
  --token <value>           GET /deliveries 的口令                 (默认 dev-management-token)
  --route <path>            路由路径                              (默认 /hooks/github/pr)
  --source <name>           验签方案: github | gitlab | gitee | generic  (默认 github)
  --workspace <dir>         假会话的工作目录                       (默认当前目录)
  --callback-port <port>    回调地址里的端口，要和 trigger 一致      (默认 9099)
  --latency <ms>            假 Agent 每次「思考」多久                (默认 1200)
  --help                    显示这段帮助
`

const argv = parseArgs(process.argv.slice(2), ['help'])
if (argv.help === true) {
  console.log(USAGE.trim())
  process.exit(0)
}

const port = Number(argv.port ?? 8787)
const secret = String(argv.secret ?? 'dev-shared-secret')
const managementToken = String(argv.token ?? 'dev-management-token')
const routePath = String(argv.route ?? '/hooks/github/pr')
const source = String(argv.source ?? 'github')
const workspace = String(argv.workspace ?? process.cwd())
const callbackPort = Number(argv.callbackPort ?? 9099)
const latencyMs = Number(argv.latency ?? 1200)
const secretRef = 'GITHUB_WEBHOOK_SECRET'

/** Same route as examples/github-pr-review.patch.yml, as code. */
const route = {
  id: 'pr-review',
  path: routePath,
  source,
  secretRef,
  events: source === 'github' ? ['pull_request'] : [],
  session: 'auto',
  workspace,
  agentPreset: 'default',
  maxConcurrency: 2,
  template: [
    'GitHub 上有一个 PR 事件：{{ action }}',
    '仓库：{{ repository.full_name }}',
    '标题：{{ pull_request.title }}',
    '作者：{{ pull_request.user.login }}',
    '基点分支：{{ pull_request.base.ref }} ← {{ pull_request.head.ref }}',
    '链接：{{ pull_request.html_url }}',
    '',
    '请阅读这次改动，指出可能的缺陷、缺失的测试和风险点，输出一份简明的审阅意见。',
  ].join('\n'),
  instructions: '用中文回答，控制在 15 行以内。结论先行，再列理由。',
  callbackUrl: `http://127.0.0.1:${callbackPort}/dsh/reply`,
  callbackHeaders: { 'x-dsh-route': '{{ __route }}', 'x-dsh-delivery': '{{ __deliveryId }}' },
}

const logs = []
const log = createLogger(logs)

const plugin = await loadBundle(bundle)

/**
 * The fake agent. It reads the rendered prompt back rather than inventing an
 * answer, so whatever the template produced is visible in the callback body —
 * which is the quickest way to see a template mistake.
 */
const answer = (promptText, sessionId, turn) => {
  const headings = promptText
    .split('\n')
    .filter((row) => /仓库|标题|作者|基点分支|链接|事件/.test(row))
    .map((row) => `  ${row.trim()}`)
  return [
    '【假 Agent —— 真实部署里这里是模型的回答】',
    `会话 ${sessionId} 的第 ${turn} 个回合，读到的提示词 ${promptText.length} 字符：`,
    ...headings,
    turn > 1
      ? '结论：这个会话里我已经看过同一个仓库的上下文，直接接着上次的判断说。'
      : '结论：首次接入，链路是通的；把这几行换成真实审阅意见即可。',
  ].join('\n')
}

const harness = createStubHarness({ log, latencyMs, answer })
const { ctx, dispose } = createStubContext({ harness, log, secrets: { [secretRef]: secret } })

console.log('')
console.log(bold('本地桥（假 Harness，真插件）'))
console.log(dim(`  构建产物 ${bundle.replace(`${process.cwd()}/`, '')}`))
console.log(dim(`  假 Agent 每次思考 ${latencyMs}ms —— 全程不调用任何模型 API`))

log('info', '[plugin] name=%s inject=%s', plugin.name, JSON.stringify(plugin.inject))

const config = {
  enabled: true,
  host: '127.0.0.1',
  port,
  managementToken,
  callbackAttempts: 2,
  callbackBackoffMs: 200,
  routes: [route],
}

try {
  plugin.apply(ctx, config)
} catch (error) {
  console.log(`  ${red('✗')} apply() 失败: ${error.message}`)
  process.exit(1)
}

const health = `http://127.0.0.1:${port}/healthz`
if (!await waitForHealth(health)) {
  console.log(`  ${red('✗')} 端口 ${port} 没能起来。换个 --port 试试，或者看看上面的启动日志。`)
  process.exit(1)
}

console.log('')
rule('已就绪')
line('监听', `http://127.0.0.1:${port}${routePath}`)
line('密钥', `${secretRef} = ${secret === 'dev-shared-secret' ? secret : '（已设置，不回显）'}`)
line('回调', route.callbackUrl + dim(`  ← trigger 需要监听 ${callbackPort}`))
line('诊断', `curl -H "x-webhook-token: ${managementToken}" http://127.0.0.1:${port}/deliveries`)

console.log('')
console.log(`  ${bold('在另一个终端里发一条投递：')}`)
console.log(green(`    node examples/trigger.mjs --url http://127.0.0.1:${port}${routePath} --secret ${secret}`))
console.log('')
console.log(dim('  想试别的场景就加 --scenario，例如 wrong-signature / unsigned / wrong-event。'))

console.log('')
rule('这个脚本用的路由配置（和 examples/github-pr-review.patch.yml 一致）')
console.log(dim(`  把下面这段贴进 ~/.dsh/profiles/web/cordis.patch.yml 就是同样的效果，`))
console.log(dim('  区别只是那时候有真的模型来回答。'))
console.log('')
console.log(`- id: dsh-webhook
  config:
    enabled: true
    host: 127.0.0.1
    port: ${port}
    managementToken: ${managementToken}
    routes:
      - id: pr-review
        path: ${routePath}
        source: ${source}
        secretRef: ${secretRef}
        events: [pull_request]
        session: auto
        workspace: ${workspace}
        agentPreset: default
        maxConcurrency: 2
        callbackUrl: ${route.callbackUrl}`)

console.log('')
rule('运行日志（Ctrl-C 退出）')

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  console.log('')
  dispose()
  console.log(`  ${dim(`桥已关闭，共 ${logs.length} 条日志。`)}`)
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
