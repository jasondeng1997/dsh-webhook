# 路由与上游接入示例

[English](routes.en.md) | 中文

本页给出四种上游的完整配置与对接步骤。所有示例都假设插件监听 `127.0.0.1:8787`，并且你已经把它暴露到一个公网地址（例如 `https://hooks.example.com`）。

## 目录

- [GitHub](#github)
- [GitLab](#gitlab)
- [Gitee](#gitee)
- [通用 HMAC 发送方](#通用-hmac-发送方)
- [一个上游触发多条路由](#一个上游触发多条路由)
- [会话绑定的三种用法](#会话绑定的三种用法)
- [常见问题](#常见问题)

---

## GitHub

**验签方式**：`x-hub-signature-256`，HMAC-SHA256 十六进制；旧版 `x-hub-signature`（SHA-1）只在强签名缺失时兜底，防止降级。

```yaml
- id: dsh-webhook
  config:
    routes:
      - id: gh-ci
        path: /hooks/gh/ci
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [workflow_run]
        session: auto
        workspace: /Users/you/project
        template: |
          工作流事件：{{ action }}
          仓库：{{ repository.full_name }}
          工作流：{{ workflow_run.name }}
          结论：{{ workflow_run.conclusion }}
          分支：{{ workflow_run.head_branch }}
          日志地址：{{ workflow_run.html_url }}

          如果结论是 failure，请拉取失败任务的日志定位原因，给出最小修复方案；如果结论是 success，只回复一行摘要。
        callbackUrl: https://你的服务.example.com/dsh/reply
```

对接步骤：

1. 仓库 **Settings → Webhooks → Add webhook**。
2. **Payload URL** 填 `https://hooks.example.com/hooks/gh/ci`。
3. **Content type** 选 `application/json`。
4. **Secret** 填 `GITHUB_WEBHOOK_SECRET` 对应的同一个值。
5. **Events** 选 *Let me select individual events* → *Workflow runs*（或按你的路由选择）。
6. 保存后 GitHub 会立刻发一次 `ping`；如果路由没开 `events` 过滤，你会收到一次投递。

> GitHub 要求在 10 秒内收到响应，因此本插件先回 `202`，再在后台跑会话。就算 Agent 要跑十分钟，GitHub 那边也是「投递成功」。

## GitLab

**验签方式**：`x-gitlab-token` 与配置的密钥逐字节常量时间比较。

```yaml
      - id: gl-mr
        path: /hooks/gl/mr
        source: gitlab
        secretRef: GITLAB_WEBHOOK_TOKEN
        events: [merge_request]
        session: auto
        template: |
          Merge Request 事件：{{ object_attributes.action }}
          项目：{{ project.path_with_namespace }}
          标题：{{ object_attributes.title }}
          来源分支：{{ object_attributes.source_branch }}
          目标分支：{{ object_attributes.target_branch }}
          链接：{{ object_attributes.url }}

          请检查这次变更是否涉及数据库迁移或接口协议变更，并给出需要同步更新的文档清单。
```

对接步骤：项目 **Settings → Webhooks**，URL 填 `https://hooks.example.com/hooks/gl/mr`，**Secret token** 填同一个值，Trigger 只勾 *Merge request events*。

GitLab 也支持表单编码的请求体（`application/x-www-form-urlencoded`），本插件会自动解析成扁平字段。

## Gitee

**验签方式**：`x-gitee-token` 与你在 Gitee 后台设置的「WebHook 密码」比较。

```yaml
      - id: gitee-push
        path: /hooks/gitee/push
        source: gitee
        secretRef: GITEE_WEBHOOK_PASSWORD
        events: [push]
        session: auto
        template: |
          推送事件
          仓库：{{ repository.full_name }}
          分支：{{ ref }}
          提交数：{{ total_commits_count }}
          最新提交：{{ head_commit.message }}

          请检查这次推送是否修改了 CI 配置或依赖清单，并说明影响。
```

## 通用 HMAC 发送方

任何能计算 HMAC-SHA256 的系统都可以用 `generic` 方案：把请求体的十六进制摘要放进 `x-webhook-signature`，前缀 `sha256=` 可选。

```sh
SECRET='your-shared-secret'
BODY='{"orderId":"A-1024","status":"refunded","amount":199}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

curl -sS -X POST https://hooks.example.com/hooks/order \
  -H "content-type: application/json" \
  -H "x-webhook-signature: sha256=$SIG" \
  -H "x-webhook-event: order_refunded" \
  -d "$BODY"
```

Node 侧等价写法：

```js
import { createHmac } from 'node:crypto'

const body = JSON.stringify({ orderId: 'A-1024', status: 'refunded', amount: 199 })
const signature = createHmac('sha256', process.env.SHARED_SECRET).update(body).digest('hex')

await fetch('https://hooks.example.com/hooks/order', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-webhook-signature': `sha256=${signature}`,
    'x-webhook-event': 'order_refunded',
  },
  body,
})
```

对应的路由：

```yaml
      - id: order
        path: /hooks/order
        source: generic
        secretRef: SHARED_SECRET
        events: [order_refunded]
        session: auto
        template: |
          订单退款：{{ orderId }}，金额 {{ amount }}
          请核对退款金额与订单应付金额是否一致，并指出需要跟进的环节。
        callbackUrl: https://你的服务.example.com/dsh/reply
```

## 一个上游触发多条路由

路由按路径区分，因此同一个服务可以按事件分流到不同会话、不同工作区，甚至不同 Agent Preset：

```yaml
      - id: ci-failure
        path: /hooks/gh/ci
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [workflow_run]
        session: auto
        workspace: /Users/you/platform
        agentPreset: 排障
        template: |
          工作流 {{ workflow_run.name }} 结果是 {{ workflow_run.conclusion }}，请定位失败原因。

      - id: pr-review
        path: /hooks/gh/pr
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [pull_request]
        session: auto
        workspace: /Users/you/platform
        template: |
          PR #{{ pull_request.number }}：{{ pull_request.title }}
          请给出审阅意见。
```

两条路由共用同一个密钥引用，但各自维护并发、排队与会话绑定。

## 会话绑定的三种用法

| 写法 | 行为 | 适合 |
|---|---|---|
| `session: auto` | 该路由第一次投递时创建一个会话，之后所有投递复用同一个会话 | 同一类事件的连续跟进（今天修的 CI、明天又挂同一个 workflow） |
| `session: <已有会话 ID>` | 投递全部进入你指定的会话 | 把外部事件续接到你在 Web/CLI 里正在聊的上下文 |
| `session: auto` + `events` 过滤 | 只有关心的事件才会触达，其余请求返回 `202` 但被标记为 `filtered` | 高噪声仓库 |

会话 ID 可以在 Web 界面的会话列表里找到，或通过 `/sessionlist` 之类的命令获取。

## 常见问题

**投递收到了，但一直停在 `queued`。**
会话在等模型或工具。用 `GET /deliveries?token=…` 看阶段；`prompted` 表示已提交但路由没有回传配置。

**回答没回到我的 callback。**
检查投递记录的 `detail`：`timeout` 表示在 `replyTimeoutMs` 内没有产生新的助手回合；`callback-failed` 表示回调被拒（`4xx` 不重试）或超时。回调请求体里没有密钥，可以放心打日志。

**模板里的字段全是空。**
用投递记录里的 `missing` 列表核对字段路径；GitLab 的字段名和 GitHub 不同（例如 `object_attributes.title` 对应 GitLab，`pull_request.title` 对应 GitHub）。也可以先用 `{{ json }}` 把载荷原样打出来。

**想先不配密钥试一下。**
把路由设成 `allowUnsigned: true`，插件会在启动日志、`GET /healthz` 的 `problems` 计数和设置卡片里持续提醒你这是暴露状态。试完立刻关掉。
