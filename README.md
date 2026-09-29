# dsh-webhook

[English](README.en.md) | 中文

把**任意 HTTP Webhook** 接进 DeepSeek Harness：校验签名、匹配路由、渲染提示词、驱动一个会话，再把 Agent 的回答回传到你的端点。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jasondeng1997/dsh-webhook/actions/workflows/ci.yml/badge.svg)](https://github.com/jasondeng1997/dsh-webhook/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)
![Tests](https://img.shields.io/badge/tests-135%20passing-brightgreen)

---

## 它解决什么问题

CI 跑挂了、有人提了 PR、监控告警了、订单退款了 —— 这些事件都会以 Webhook 的形式打到某个 HTTP 端点上。而你希望接下来发生的是一次 Agent 会话：读日志、翻代码、给结论、发通知。

dsh-webhook 就是这段胶水，但它不把胶水糊进你的业务代码：它自己开一个 HTTP 监听端口，按路径匹配路由，验签之后把载荷渲染成提示词交给 Harness 会话，并在 Agent 回答后把结果 POST 回你指定的地址。

```
GitHub / GitLab / Gitee / 自建系统
        │  POST /hooks/ci   （带签名）
        ▼
┌─────────────────────────────────────────────┐
│ dsh-webhook（本插件，独立监听端口）          │
│  验签 → 事件过滤 → 模板渲染 → 会话绑定        │
└─────────────────────────────────────────────┘
        │  ctx.sessionController.prompt()
        ▼
   DeepSeek Harness 会话（Agent 跑工具、给结论）
        │  回答
        ▼
   回调 POST → 你的系统（评论、告警、工单、Slack…）
```

## 特性

- **四种验签方案**：GitHub（`x-hub-signature-256`，兼容旧版 SHA-1）、GitLab（`x-gitlab-token`）、Gitee（`x-gitee-token`）、通用 `x-webhook-signature`（HMAC-SHA256）。全部常量时间比较；密钥解析不出来时**默认拒绝**，除非路由显式声明 `allowUnsigned: true`。
- **密钥走凭据库**：`secretRef` 每次请求都经 `ctx.credentials` 重新解析，换密钥不需要重启。
- **安全模板**：只支持 `{{ 点路径 }}` 取值，没有表达式、没有函数、没有递归。载荷来自公网，模板引擎能执行就等于把执行入口交给了对面。
- **会话绑定**：`session: auto` 让一条路由首次投递时自动建会话并复用；也可以绑定已存在的会话 ID。
- **事件过滤**：一条路由可以只关心 `push`，不必被每条评论叫醒。
- **回答回传**：Agent 回答以 JSON POST 回 `callbackUrl`，带重试、支持 `Retry-After`，`4xx` 不重试（被拒绝的请求重复发就是小型洪水）。
- **有界过载**：每条路由并发 `maxConcurrency`、排队至多 `queueLimit`，超出直接返回 `503` 让上游重试，而不是在插件里堆一条看不见的积压。
- **设置卡片**：出现在「设置 → 插件」里，按 `dsh-webhook` 命名空间挂载，可编辑全局项与路由列表。修改先在本地暂存，保存时按 revision 围栏写入。
- **诊断接口**：`GET /healthz` 探活；`GET /deliveries` 需要 `managementToken`，返回有界的投递记录。两者都不会泄露密钥、请求头或原始载荷。
- **出站工具**（`webhook_send`，默认关闭）：开启后模型可以主动向外部推送消息，支持主机白名单。

## 安装

推荐从 npm 安装已发布版本：

```sh
dsh plugin --profile web add -w dsh-webhook
```

重启 `dsh web`（或桌面端），刷新浏览器，然后打开「设置 → 插件 → 可配置」找到 **Webhook 桥** 卡片。

也可以直接从 GitHub 源码安装：

```sh
dsh plugin --profile web add -w github:jasondeng1997/dsh-webhook
```

> 从 git 安装拉取的是**源码而非产物**，因此本包的 `prepare` 脚本会在安装时用 esbuild 构建 `lib/`。pnpm 10 及以上会拦截依赖的构建脚本，第一次 `add` 会失败并在提示里给出需要写入 profile `pnpm-workspace.yaml` 的 `allowBuilds` 键值，按其提示放行后重新执行即可。**放行等于允许该包在你机器上执行代码**，请只对你信任的源码这么做，并用 `#<commit-sha>` 固定提交。

## 快速开始：GitHub PR 自动审阅

**1. 在凭据库里放一个密钥。** 直接写进 `~/.dsh/.credentials.yaml`（该文件热加载，不需要重启）：

```yaml
version: 1
refs:
  GITHUB_WEBHOOK_SECRET: 你生成的随机字符串
```

也可以改用启动环境变量 `GITHUB_WEBHOOK_SECRET=...`（环境变量需要重启 Host 才生效）。

**2. 在 profile 的 `cordis.patch.yml` 里配置一条路由**（`~/.dsh/profiles/web/cordis.patch.yml`）：

```yaml
- id: dsh-webhook
  config:
    enabled: true
    host: 127.0.0.1
    port: 8787
    routes:
      - id: pr-review
        path: /hooks/github/pr
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [pull_request]
        session: auto
        workspace: /Users/你/项目目录
        template: |
          GitHub 上有一个 PR 事件：{{ action }}
          仓库：{{ repository.full_name }}
          标题：{{ pull_request.title }}
          作者：{{ pull_request.user.login }}
          链接：{{ pull_request.html_url }}

          请阅读这次改动的 diff，指出可能的缺陷、缺失的测试和风险点，输出一份简明的审阅意见。
        callbackUrl: https://你的服务.example.com/dsh/reply
```

> patch 层会**整体替换**同一行 id 的 `config`，不是逐键合并。要覆盖默认值就把它需要的键一起写全；没写的键走 schema 默认值。

**3. 把公网流量送到这个端口。** 插件默认只监听 `127.0.0.1`，公网要能打到它，通常有两条路：

```sh
# 方案 A：把本机端口暴露出去（临时调试最省事）
cloudflared tunnel --url http://127.0.0.1:8787

# 方案 B：已有反向代理时，把 /hooks/ 转发到 127.0.0.1:8787
```

**4. 在 GitHub 仓库里添加 Webhook**：Payload URL 填 `https://你的域名/hooks/github/pr`，Content type 选 `application/json`，Secret 填第 1 步的同一个字符串，事件选 Pull requests。

**5. 提一个 PR。** 插件会立刻返回 `202`（上游看到的是「已收到」），随后在后台驱动会话；Agent 回答后，你的 `callbackUrl` 会收到：

```json
{
  "deliveryId": "3f1c…",
  "route": "pr-review",
  "source": "github",
  "event": "pull_request",
  "sessionId": "…",
  "receivedAt": "2026-09-29T02:11:03.412Z",
  "answeredAt": "2026-09-29T02:12:47.006Z",
  "answer": "审阅意见正文…"
}
```

## 配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件加载但不监听端口 |
| `host` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 等于把端口交给网络，请配合防火墙或代理访问控制 |
| `port` | `8787` | 监听端口；`0` 表示由系统分配临时端口 |
| `maxBodyBytes` | `1048576` | 请求体上限（字节）。超限先返回 `413`，不进入验签 |
| `requestTimeoutMs` | `15000` | 单次请求读写超时 |
| `replyTimeoutMs` | `600000` | 默认等待 Agent 回答的时长 |
| `queueLimit` | `4` | 每条路由在并发满之后还能排队多少条，超出返回 `503` |
| `callbackAttempts` | `3` | 回调 POST 尝试次数（含首次） |
| `callbackBackoffMs` | `1000` | 回调退避基数（指数增长） |
| `callbackTimeoutMs` | `15000` | 单次回调 POST 超时 |
| `maxPromptChars` | `100000` | 交给模型的提示词上限，超出截断并标注 |
| `sendTool` | `false` | 是否注册出站工具 `webhook_send` |
| `sendToolAllowHosts` | `[]` | 出站工具主机白名单，空表示不限制；`.example.com` 覆盖该域名及其子域 |
| `deliveryLogSize` | `200` | 内存中保留的投递记录数 |
| `managementToken` | 未设置 | 保护 `GET /deliveries`；不设置则该接口直接 `404` |
| `routes` | `[]` | 路由列表 |

### 路由字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 路由标识，出现在日志、投递记录和卡片里 |
| `path` | ✅ | 端点路径，如 `/hooks/ci` |
| `source` | | `github` / `gitlab` / `gitee` / `generic`，决定验签方式，默认 `generic` |
| `enabled` | | 是否接受投递，默认 `true` |
| `secretRef` | | 凭据库里的环境变量名；与 `secret`、`allowUnsigned` 三选一 |
| `secret` | | 内联密钥，仅本地试验用 —— 它会落在配置文件里，加载时会给出警告 |
| `allowUnsigned` | | 显式接受无签名投递，默认 `false`。**任何能访问该端口的人都能驱动这个会话** |
| `session` | | `auto`（默认，按路由懒创建并复用）或已有会话 ID |
| `workspace` | | 该路由创建会话时使用的工作目录 |
| `agentPreset` | | 该路由创建会话时使用的 Agent Preset |
| `template` | | 提示词模板，留空用内置模板 |
| `instructions` | | 追加在渲染结果之后的补充指令 |
| `events` | | 事件过滤器（如 `[push, pull_request]`），留空表示全部 |
| `callbackUrl` | | Agent 回答的接收地址；填了就默认开启回传 |
| `callbackHeaders` | | 回调附加请求头，值支持同样的模板占位符 |
| `replyMode` | | `none` 或 `callback`，默认按是否有 `callbackUrl` 推断 |
| `replyTimeoutMs` | | 该路由的等待时长覆盖值 |
| `maxConcurrency` | | 该路由并发上限，默认 `2` |

配置问题不会阻止插件启动：有问题的路由会被丢弃，具体原因写进启动日志、`GET /healthz` 的 `problems` 计数，以及设置卡片里的提示。

## 模板语法

| 占位符 | 含义 |
|---|---|
| `{{ repository.full_name }}` | 按点路径取载荷字段，支持 `a[0].b` 与 `a["odd key"]` |
| `{{ json }}` | 完整载荷（格式化 JSON） |
| `{{ __route }}` | 路由 ID |
| `{{ __source }}` | 上游类型 |
| `{{ __event }}` | 事件名（上游没给则为空） |
| `{{ __deliveryId }}` | 本次投递 ID |
| `{{ __receivedAt }}` | 收到时间（ISO-8601） |

取不到的路径渲染成空字符串，并记在投递记录的 `missing` 里 —— 字段名写错时能看见，而不是静默变成 `undefined`。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | 各路由 `path` | 接收投递。签名正确返回 `202 { ok, deliveryId }`；签名错误 `401`；超限 `413`；路径未配置 `404`；非 POST `405`；路由过载 `503` |
| `GET` | `/healthz` | 探活：`{ ok, version, routes, problems }`，不含任何敏感信息 |
| `GET` | `/deliveries?limit=50` | 投递记录与统计。需要 `managementToken`（`x-webhook-token` 头或 `?token=`），未配置时返回 `404` |

## 安全

这个插件会把公网输入变成 Agent 会话输入，因此默认姿态是「关着」：

- 没有可用密钥的端点一律 `401`，除非路由显式写 `allowUnsigned: true`；
- 签名比较是常量时间的；GitHub 路由在强签名存在时不会接受弱签名兜底（防降级）；
- 载荷不进入日志，投递记录里只有 ID、阶段、耗时和插件自己写的说明；
- 模板不执行任何东西，载荷无法触达输出之外的任何地方；
- `managementToken` 不设置时诊断接口直接不存在，而不是以空口令开放；
- 出站工具默认关闭，开启后可再套一层主机白名单。

仍然需要你自己承担的部分：**把端口暴露到公网时，前面的 TLS、访问控制和限流是你的责任**。本插件只做验签、体积上限、读写超时和过载拒绝。

详见 [`docs/security.zh.md`](docs/security.zh.md)。

## 开发

```sh
npm install
npm run check     # 类型检查 + 单元测试 + 构建 + 产物格式校验
npm run test      # 只跑单元测试
npm run build     # 只构建
```

核心逻辑（路由规则、验签、模板、载荷解析、重试策略、投递流水线、HTTP 接收器、投递日志、卡片状态机）**不依赖 Harness**，因此单测不需要启动宿主。与宿主的耦合集中在 `src/index.ts` 一个文件里。

用源码安装到本地 profile 调试：

```sh
node build.mjs
dsh plugin --profile web add -w ./
dsh --profile web --dump-config     # 应能看到 "# == dsh-webhook" 层
```

更细的说明见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 文档

- [路由与上游接入示例](docs/routes.zh.md)
- [安全模型](docs/security.zh.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 许可证

[MIT](LICENSE)
