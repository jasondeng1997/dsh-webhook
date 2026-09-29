# 安全策略 / Security Policy

[中文](#中文) · [English](#english)

---

## 中文

### 支持范围

| 版本 | 是否接收安全修复 |
|---|---|
| 最新发布版 | ✅ |
| `main` 分支 | ✅ |
| 更早的发布版 | ❌ 请先升级 |

本项目处于 `0.x` 阶段，接口仍可能变动，但**安全修复会以补丁版本回移到最新的发布线上**。

### 报告漏洞

**请不要用公开 issue 报告安全问题。**

首选渠道：[GitHub 私密漏洞报告](https://github.com/jasondeng1997/dsh-webhook/security/advisories/new)（Security → Advisories → Report a vulnerability）。这是一条只有维护者可见的私密通道，报告、讨论和修复可以都在那里完成。

如果该入口不可用，请开一个**不含任何技术细节**的 issue，只说你需要一个私下的联系方式，维护者会来对接。

### 请在报告中包含

1. **受影响的版本**（`package.json` 的 `version` 或 `GET /healthz` 返回的 `version`）；
2. **受影响的组件**：验签（`signature.ts`）、模板（`template.ts`）、接收器（`receiver.ts`）、出站（`outbound.ts`）、流水线（`dispatcher.ts`）、卡片（`client/`）等；
3. **可复现的最小步骤**：请求方法、路径、请求头（**密钥请用占位符**）、载荷、以及路由配置；
4. **实际影响**：能读什么、能写什么、需要什么前置条件（例如是否需要已持有有效密钥、是否要求端口已暴露到公网）；
5. **是否已在公开场合披露过**。

如果只是「我觉得这里大概有问题」，也欢迎用同样渠道发过来 —— 猜测常常比我们自己的审查更快指向真正的缺陷。

### 响应预期

这是个人维护的开源项目，没有 SLA。实际做法是：

- **确认收到**：通常在几天内；
- **初步判定**（是否在范围内、严重程度）：确认后在私密报告里回复；
- **修复与披露**：修复进入补丁版本后，在私密 advisory 里发布并致谢（除非你希望匿名）。

### 严重程度如何判定

本插件把入站 HTTP 请求变成 Agent 会话输入，因此最严重的一类缺陷是「**绕过鉴权、让未授权的投递驱动一次会话**」。其次是能让载荷逃出模板沙箱（模板只做点路径取值，不执行任何东西），再其次是信息泄露（载荷、请求头、密钥、令牌进入日志或诊断接口）。

### 在范围内

- 验签绕过、降级、时序侧信道；
- 模板渲染逃逸（任意代码执行、原型污染、二次替换）；
- 请求体上限绕过、慢速客户端长期占住槽位；
- 未授权访问 `GET /deliveries` 或从 `/healthz` 取得敏感信息；
- 密钥、令牌或原始载荷进入日志、错误信息或诊断接口；
- 出站主机白名单绕过（`sendToolAllowHosts`）；
- 因载荷构造导致的崩溃或拒绝服务（**而非单纯的高负载**）。

### 不在范围内（设计如此）

这些是已知的、有意的取舍，见 [`docs/security.zh.md`](docs/security.zh.md)：

- **不做 TLS**。它只说明文 HTTP，TLS 由前置代理终止。
- **不做限流与来源白名单**。`503` 是背压，不是限流器；已配置的路径会接受任何持有密钥的人的签名请求。
- **不检查载荷内容**。载荷里的提示词注入属于模型与路由 `instructions` 需要共同面对的问题。
- 在不设置 `managementToken` 时 `GET /deliveries` 返回 `404` —— 这是刻意的，「没设密码」不等于「空密码可用」。
- 需要已经持有有效密钥、且已经能把请求打到监听端口才能触发的「攻击」。
- 依赖项的已知漏洞：请直接报告给上游。

### 安全港

我们不会对遵循本策略的安全研究追究责任。请**不要**做这些事：

- 访问、修改或删除他人的数据；
- 对非你所有的实例进行测试；
- 用真实密钥、真实会话或在生产实例上做大流量测试；
- 在修复发布前公开披露细节。

### 加固清单

部署到公网前请逐条确认：

1. 密钥用随机长字符串，放凭据库（`secretRef`）而不是配置文件里的 `secret`；
2. 能用 `cloudflared` / 反代就别把端口直接暴露，优先保持 `host: 127.0.0.1`；
3. 配置 `managementToken`，或者接受 `/deliveries` 不存在；
4. 不需要出站工具就别开 `sendTool`；开了就用 `sendToolAllowHosts` 收窄；
5. 公网端点的 TLS、访问控制与限流放在前置代理上；
6. **不要**给公网可达的路由开 `allowUnsigned: true`；
7. 密钥一旦可能泄露就立即轮换 —— `secretRef` 每次请求都会重新解析，改凭据库即生效，不需要重启。

---

## English

### Supported versions

| Version | Receives security fixes |
|---|---|
| Latest release | ✅ |
| `main` | ✅ |
| Older releases | ❌ upgrade first |

This project is pre-`0.x`-stability, so APIs may still move — but **security fixes are backported to the latest release line as a patch**.

### Reporting a vulnerability

**Please do not report security issues in a public issue.**

Preferred channel: [GitHub private vulnerability reporting](https://github.com/jasondeng1997/dsh-webhook/security/advisories/new) (Security → Advisories → Report a vulnerability). It is visible only to the maintainer, and the report, the discussion, and the fix can all happen there.

If that entry point is unavailable, open an issue containing **no technical detail** — just say you need a private channel and the maintainer will follow up.

### What to include

1. **Affected version** (`version` in `package.json`, or the `version` returned by `GET /healthz`);
2. **Affected component**: signature verification (`signature.ts`), templates (`template.ts`), receiver (`receiver.ts`), outbound (`outbound.ts`), pipeline (`dispatcher.ts`), card (`client/`), etc.;
3. **Minimal reproduction**: method, path, headers (**use a placeholder for any secret**), payload, and the route configuration;
4. **Actual impact**: what can be read or written, and what preconditions it needs (does it require a valid secret already? does it require the port to be exposed to the internet?);
5. **Whether it has already been disclosed publicly.**

If it is only "this looks wrong to me", send it through the same channel anyway — a hunch often finds a real defect faster than our own review does.

### What to expect

This is a personally maintained open-source project with no SLA. In practice:

- **Acknowledgement**: usually within a few days;
- **Initial assessment** (in scope or not, severity): a reply in the private report once triaged;
- **Fix and disclosure**: once the fix ships in a patch release, published in the private advisory with credit — unless you ask to stay anonymous.

### How severity is judged

This plugin turns inbound HTTP requests into agent session input, so the most severe class of defect is one that **bypasses authentication and lets an unauthorised delivery drive a session**. Next is letting a payload escape the template sandbox (the renderer does dotted-path lookup only and executes nothing), and then information disclosure — payloads, headers, secrets, or tokens reaching the log or the diagnostics endpoints.

### In scope

- Signature bypass, downgrade, or timing side channels;
- Template rendering escapes (code execution, prototype pollution, double substitution);
- Body-limit bypass, or slow clients holding a slot indefinitely;
- Unauthorised access to `GET /deliveries`, or sensitive information from `/healthz`;
- Secrets, tokens, or raw payloads reaching the log, an error message, or a diagnostics endpoint;
- Outbound host allowlist bypass (`sendToolAllowHosts`);
- Crashes or denial of service caused by a crafted payload (**as opposed to plain high load**).

### Out of scope (by design)

These are known, deliberate trade-offs; see [`docs/security.en.md`](docs/security.en.md):

- **No TLS.** It speaks plain HTTP; TLS terminates in front of it.
- **No rate limiting and no source allowlist.** The `503` is backpressure, not a rate limiter; a configured path accepts a correctly signed request from anyone holding the secret.
- **No payload inspection.** Prompt injection inside a payload is a problem the model and the route's `instructions` face together.
- `GET /deliveries` returns `404` when no `managementToken` is configured — deliberately, because "no password set" must not mean "empty password accepted".
- "Attacks" that require already holding a valid secret and already being able to reach the listening port.
- Known vulnerabilities in dependencies: report those upstream.

### Safe harbour

We will not pursue security researchers who follow this policy. Please **do not**:

- access, modify, or delete anyone else's data;
- test instances you do not own;
- use real secrets, real sessions, or high-volume testing against a production instance;
- disclose details publicly before a fix is released.

### Hardening checklist

Confirm each of these before exposing the port to the internet:

1. Use a long random secret, kept in the credential store (`secretRef`) rather than as an inline `secret` in the config file;
2. Prefer `cloudflared` or a reverse proxy over exposing the port; keep `host: 127.0.0.1` when you can;
3. Configure `managementToken`, or accept that `/deliveries` does not exist;
4. Leave `sendTool` off if you do not need it; if you do, narrow it with `sendToolAllowHosts`;
5. Put TLS, access control, and rate limiting on the proxy in front of a public endpoint;
6. Do **not** set `allowUnsigned: true` on an internet-reachable route;
7. Rotate the secret the moment it may have leaked — `secretRef` re-resolves on every request, so updating the credential store takes effect without a restart.
