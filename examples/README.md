# 示例

[English](README.en.md) | 中文

这个目录里的四样东西，按「先跑起来 → 再接真实上游」的顺序用。全部只依赖 `npm install`，不需要装 DSH，也不需要 API Key —— 唯一被替换掉的是那个「模型回合」，脚本里会明确标出来。

| 文件 | 它扮演谁 | 怎么用 |
|---|---|---|
| `demo.mjs` | 桥 + 假 Harness（同一进程） | `npm run demo` |
| `local-bridge.mjs` | 桥 + 假 Harness（常驻服务） | `npm run example:bridge` |
| `trigger.mjs` | 上游（GitHub / GitLab / Gitee / 自建系统）+ 回调接收端 | `npm run example:trigger -- --url … --secret …` |
| `github-pr-review.patch.yml` | — | 直接粘进 `~/.dsh/profiles/web/cordis.patch.yml` |

`demo.mjs` 用来看效果，`local-bridge.mjs` + `trigger.mjs` 用来验证你自己的部署。两者加载的都是 `lib/index.js`（`npm run build` 的产物），不是源码 —— 打包环节出的错（external 写错包名、漏声明依赖、`files` 漏产物）只有在这一步才会暴露。

---

## 一、看效果：`npm run demo`

一条命令，一个进程，六个场景跑完并打印每一步的真实状态码、回调报文和投递日志。

```sh
git clone https://github.com/jasondeng1997/dsh-webhook && cd dsh-webhook
npm install
npm run demo
```

---

## 二、验证你自己的部署：两个终端

这是真实部署的形状：一个常驻的桥，一个从外面打进来的上游。开两个终端。

**终端 A —— 起桥（假 Harness，真插件）：**

```sh
npm run example:bridge
```

它会打印：监听地址、密钥、应该把 `callbackUrl` 指向哪个端口，以及**这段配置对应的 profile YAML** —— 和 `github-pr-review.patch.yml` 是同一份配置，区别只是那时候有真的模型来回答。

**终端 B —— 发一条投递（假 GitHub，真签名）：**

```sh
npm run example:trigger -- --url http://127.0.0.1:8787/hooks/github/pr --secret dev-shared-secret
```

它会用 HMAC-SHA256 签一个真实的 `pull_request` 载荷，POST 出去，监听回调端口，收到回答后打印出来。`--secret` 要和终端 A 打印的一致。

输出长这样：

```
── 将要发送的请求 ─────────────────────────────────────────────
  方法           POST
  地址           http://127.0.0.1:8787/hooks/github/pr
  签名方案       github (x-hub-signature-256, HMAC-SHA256)
  事件           pull_request
  载荷           555 字节
  回调接收       http://127.0.0.1:9099（路由的 callbackUrl 必须指向这个端口）
                 x-github-event: pull_request
                 x-hub-signature-256: sha256=d5faa95393025dca…7a18eaa5

── 上游视角 ───────────────────────────────────────────────────
  HTTP   202 （期望 202）
  耗时   9ms —— 上游不需要等 Agent 跑完
  响应体 {"ok":true,"deliveryId":"6e02100b-807b-4c38-8e4d-db05032cfd7a"}

── 收到 1 条回调 ──────────────────────────────────────────────
  #1 POST /dsh/reply
  投递           6e02100b…
  路由           pr-review
  会话           sess_01
  事件           pull_request
  耗时           402ms (从收到到回答)
  自定义头       x-dsh-route: pr-review  x-dsh-delivery: 6e02100b-…
  答案
    【假 Agent —— 真实部署里这里是模型的回答】
    ...
```

两个值得注意的地方：**9ms** 是因为桥先回 `202` 再去跑会话，上游不会被 Agent 拖住；**402ms** 是假 Agent 的固定延迟，真实部署里这一步是模型在读代码，可能是几十秒到几分钟。

### 八个场景

`--scenario` 可以让你在不碰上游后台的情况下，把每一种接入错误都验一遍：

```sh
npm run example:trigger -- --url … --secret dev-shared-secret --scenario wrong-signature
```

| 场景 | 期望 | 它验的是什么 |
|---|---|---|
| `ok` | `202` + 1 条回调 | 整条链路通 |
| `replay` | `202` + 2 条回调 | `session: auto` 让两条投递落进同一个会话 |
| `wrong-signature` | `401` | 用错密钥签名会被拒，且投递不进流水线（连投递记录都没有） |
| `unsigned` | `401` | 没有可用密钥的端点默认关闭，不会降级放行 |
| `wrong-event` | `202`，无回调 | `events` 过滤器生效，Agent 没被叫醒 |
| `oversized` | `413` | 超过 `maxBodyBytes` 的请求体在读阶段就被拒，比验签更早 |
| `wrong-path` | `404` | 路径没配置 |
| `get` | `405` | 路径存在但不是 POST 端点 |

脚本退出码 0 表示「实际行为与场景描述一致」，可以直接放进 CI 或部署后的冒烟测试。

### 其他常用参数

```sh
--source gitlab|gitee|generic   # 换验签方案与内置载荷
--event push                    # 换事件名
--payload ./my.json             # 用你自己的载荷，验证模板占位符写对没有
--show-payload                  # 打印将要发送的完整 JSON
--listen 9099                   # 回调接收端口，要和路由的 callbackUrl 一致
--no-listen                     # 只关心投递结果，不等回调
--timeout 300                   # 真实模型可能要跑几分钟
```

---

## 三、切到真实上游

本地跑通之后，改动只有三处：

1. **把配置贴进 profile。** 复制 `github-pr-review.patch.yml` 的内容到 `~/.dsh/profiles/web/cordis.patch.yml`，把 `managementToken`、`workspace`、`callbackUrl` 换成你自己的值。

2. **密钥放进凭据库**（`~/.dsh/.credentials.yaml`，热加载，不用重启）：

   ```yaml
   version: 1
   refs:
     GITHUB_WEBHOOK_SECRET: 你生成的随机字符串
   ```

3. **把端口暴露出去**，然后在 GitHub 的 **Settings → Webhooks** 里填 Payload URL（`https://你的域名/hooks/github/pr`）、Content type（`application/json`）、Secret（第 2 步的同一个值）、事件（Pull requests）。

```sh
cloudflared tunnel --url http://127.0.0.1:8787     # 临时调试最省事
```

切过去之前，可以用模拟器先验一遍**公网那一段**是否通 —— 把 `--url` 换成你的公网地址即可，签名、载荷、事件名都不用动：

```sh
npm run example:trigger -- --url https://你的域名/hooks/github/pr --secret 那个随机串
```

**GitHub 保存 Webhook 时会立刻发一次 `ping`。** 如果这个 `ping` 驱动了一次会话，说明路由没写 `events` 过滤 —— 用 `--scenario wrong-event` 可以提前看到这个行为。

---

## 关于 `local-bridge.mjs` 假在哪

只有两处，其余全是真代码：

- **模型回合**：一个定时器代替，`--latency` 可调。
- **凭据库**：一张查找表代替 `ctx.credentials`，所以取不到密钥的失败路径和线上一致。

真的部分是：HTTP 监听、路由匹配、常量时间验签、载荷解析、模板渲染、会话绑定、并发与排队、`503` 过载拒绝、回调 POST 与重试策略、投递日志、诊断接口。`settings` 与 `tools` 两个服务故意不给 —— 插件必须在没有它们时也能跑，这里是验证而不是假设。

---

## 一个容易踩的坑：GitLab 的事件名

事件名取自**请求头**而不是载荷字段，两者不一致时以请求头为准。GitLab 的 `X-Gitlab-Event` 发的是 `Merge Request Hook`，而载荷里的 `object_kind` 是 `merge_request`：

```yaml
events: [Merge Request Hook]     # ✅ 过滤生效
events: [merge_request]          # ❌ 永远不匹配，投递会被静默过滤掉
```

拿不准的时候先不加 `events`，用 `--show-payload` 发一条，看桥实际报出的事件名是什么（投递记录的 `event` 字段）。
