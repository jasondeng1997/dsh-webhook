# 贡献指南

[English](CONTRIBUTING.en.md) | 中文

欢迎任何形式的贡献 —— bug 报告、文档修正、新的验签方案、新的模板占位符。本页说明怎么把改动跑起来、代码按什么原则写，以及提交前的检查清单。

## 开发环境

只需要 Node 和 npm：

```sh
git clone https://github.com/jasondeng1997/dsh-webhook
cd dsh-webhook
npm install
```

`engines` 声明 `node >= 20.19.0`。开发时**不需要**克隆 DeepSeek Harness —— 见下面的「为什么不需要 Harness」。

常用命令：

```sh
npm run check      # 类型检查 + 单测 + 构建 + 产物格式校验（提交前请跑这个）
npm run typecheck  # 只做 tsc --noEmit
npm run test       # 只跑单测（vitest run）
npm run test:watch # 监听模式
npm run build      # 只构建 lib/index.js 与 lib/client.js
node build.mjs --watch
```

单测跑得很快，且**全部离线**：不监听端口、不发网络请求、不加载 Harness。HTTP 相关的测试用的是随机端口（`port: 0`）和真实的 `node:http` 服务器，因此测的是真行为而不是 mock。

## 为什么不需要 Harness

本插件的每一块可测试逻辑都刻意与宿主解耦：

| 文件 | 职责 | 是否依赖 Harness |
|---|---|---|
| `src/config.ts` | 配置归一化、校验、问题收集 | 否 |
| `src/signature.ts` | 四种验签方案、常量时间比较 | 否 |
| `src/template.ts` | 占位符解析与渲染 | 否 |
| `src/payload.ts` | JSON / 表单 / 纯文本载荷解析 | 否 |
| `src/outbound.ts` | 回调 POST、重试策略、主机白名单 | 否 |
| `src/dispatcher.ts` | 投递流水线、并发与排队 | 否（走 `SessionPort` 接口） |
| `src/receiver.ts` | HTTP 接收器、路由匹配、状态码 | 否 |
| `src/delivery-log.ts` | 有界投递日志 | 否 |
| `src/client/card-face.ts` | 设置卡片的状态机与暂存逻辑 | 否 |
| `src/index.ts` | **唯一**与宿主耦合的文件 | 是 |

`src/index.ts` 通过实现 `SessionPort`（`ensureSession` / `prompt` / `snapshot` / `waitForIdle`）把 Harness 能力注入给 `Dispatcher`。新的业务逻辑应该落在上表的「否」列里，并补上单测；只有「调用宿主某个 seam」这一层才写进 `src/index.ts`。

这条约束不是洁癖：它让 135 个测试在没有 DSH 安装的机器上也能跑，也意味着 CI 里的失败基本能定位到本次改动，而不是环境差异。

## 目录结构

```
src/
  config.ts        配置归一化（唯一的事实来源：默认值、范围、校验规则）
  signature.ts     验签
  template.ts      模板渲染
  payload.ts       载荷解析
  outbound.ts      出站发送与重试
  dispatcher.ts    投递流水线（校验后 → 渲染 → 提示会话 → 回传）
  receiver.ts      HTTP 服务器
  delivery-log.ts  投递日志
  version.ts       版本号与设置命名空间
  index.ts         宿主适配层（cordis plugin：inject / Config / apply）
  client/          浏览器半边（设置卡片）
    index.ts       注册 slot 与语言包
    card-face.ts   卡片状态机
    WebhookCard.tsx
    locales.ts
test/              与 src 一一对应的 *.spec.ts
types/             tsconfig 的路径映射目标 + 发布用手写声明
docs/              路由示例与安全模型（中英双语）
build.mjs          两个构建目标 + 产物格式校验
cordis.patch.yml   bundle 补丁层
```

## 关键约束

### 1. 客户端产物必须保持模块加载器工厂形状

Harness 的浏览器端**不加载 ES 模块**：它求值一段经典脚本，脚本通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，工厂里的 `require` 只能解析平台预置的种子模块表。因此 `lib/client.js` 必须是 CJS 且被包在这个工厂里。`build.mjs` 会强制校验这一点（`node build.mjs --check`）：

- 以版本 banner 开头；
- 含 `window.__ModuleLoader__.load({ id: "dsh-webhook", ... })`；
- 以 `return module.exports; } });` 结尾，其后除注释外不能有可执行代码；
- **`react` 与 `react/jsx-runtime` 必须是 `require` 而不是被内联**。

最后一条最容易被无意破坏：往浏览器半边加一个依赖，如果它是种子模块（见 `build.mjs` 里的 `PLATFORM_SEED_MODULES`），esbuild 必须把它留在 `external`；如果不是种子模块，它会被内联 —— 这时**先确认它没有依赖 React 或 cordis 的单例**。

内联一份 React 会得到两个 React 实例，报错信息通常出现在钩子调用处，和真正的原因隔得很远。

### 2. 宿主产物不得打包 `@deepseek-ai/*`

`lib/index.js` 里所有 `@deepseek-ai/*` 说明符保持 external，从 profile 自己的安装里解析。打包进来会得到第二份服务注册表，同样是难以定位的重复实例问题。

### 3. `types/` 分两类，别混淆

- `types/cordis.d.ts`、`types/schemastery.d.ts`、`types/dsh-tools.d.ts`、`types/dsh-client.d.ts`：**仅用于类型检查**的结构性打桩，通过 `tsconfig.json` 的 `paths` 映射，让本仓库在没有 Harness checkout 时也能 `tsc`。
- `types/public-host.d.ts`、`types/public-client.d.ts`：**发布用**的手写声明，由 `build.mjs` 复制到 `lib/types/`。

改动 `src/config.ts` 的默认值时，`types/public-host.d.ts` 里的 `Defaults to \`…\`` 注释必须跟着改 —— `test/release.spec.ts` 会逐项比对，不匹配就红灯。

### 4. 安全相关的默认值是「关着」

新加一个能放宽鉴权或暴露信息的配置项时，默认值必须是保守的那一个，并且放宽时要在启动日志、`GET /healthz` 的问题计数和设置卡片里都可见。参考 `allowUnsigned` 与内联 `secret` 的处理方式。

## 常见改动怎么做

### 加一个配置项

1. `src/config.ts`：加进 `Config` 类型、`DEFAULT_CONFIG`、`normalizeConfig()`（含范围钳制与问题收集）；
2. `src/index.ts`：加进 schemastery schema，用 `.default()` 与 `.description()` 补齐；
3. `types/public-host.d.ts`：加上字段与 `Defaults to \`值\``（否则 release 测试失败）；
4. `src/client/card-face.ts`：如果它需要出现在设置卡片里，加进 `toSettings` / 标量暂存逻辑；
5. `README.md` 与 `README.en.md` 的配置表；
6. `test/config.spec.ts` 补一条归一化测试。

### 加一种验签方案

1. `src/signature.ts` 里加 `verifyXxx`，复用 `timingSafeEqualHex` / `timingSafeEqualText`，**不要**自己写比较；
2. 在 `verifyDelivery` 的 switch 里接上；
3. `src/payload.ts` 的 `EVENT_HEADERS` 里加该平台的事件头名；
4. `src/config.ts` 的 `source` 联合类型与 `normalizeConfig()` 的枚举校验；
5. `docs/security.zh.md` / `docs/security.en.md` 的鉴权表格；
6. `test/signature.spec.ts`：正确签名通过、错误签名拒绝、**密钥为空时必须拒绝**、降级路径必须被堵住（如果存在弱签名）。

### 加一个模板占位符

1. `src/template.ts`：新增宿主上下文用 `__` 前缀的保留名，或让取值走已有的点路径解析；
2. `README.md` / `README.en.md` 的占位符表；
3. `test/template.spec.ts`。注意：**不要让载荷里的值参与第二次替换**，这条性质由测试守住。

### 改投递流水线的阶段或状态机

`src/dispatcher.ts` 的阶段集合是 `DeliveryStage` 联合类型，`src/client/card-face.ts` 与 `src/delivery-log.ts` 会消费它。加阶段时要同时更新这两处与对应的测试。

## 提交前

```sh
npm run check
```

它依次跑类型检查、全部单测、构建，并校验产物形状。CI（`.github/workflows/ci.yml`）在 Node 20 与 22 上执行同样的命令，两个版本都必须是绿的。

## 提交与 PR

- 分支名：`fix/…`、`feat/…`、`docs/…`。
- 提交信息用祈使句，说明**为什么**改而不是只说什么变了：

  ```
  fix(dispatcher): keep the route queue bounded when concurrency is saturated

  The limiter defaulted to 100 queued deliveries, so a burst produced a
  backlog that grew invisibly instead of a 503 the upstream could retry.
  ```

- 一个 PR 做一件事。纯重构和纯格式化**分开**提交，否则 diff 里读不出真正的改动。
- PR 描述里请写：改了什么、为什么、怎么验证的。如果改了安全相关的默认值，请明确说明。
- 新增行为请带测试。修 bug 请带一个能复现该 bug 的测试 —— 它是这次修复唯一的防回归手段。

## 发布

维护者流程：

1. 更新 `src/version.ts` 的 `VERSION` 与 `package.json` 的 `version`（`test/release.spec.ts` 会强校验二者一致）；
2. 在 `CHANGELOG.md` 顶部加 `## <版本号>`（测试同样会校验）；
3. `npm run check`；
4. `npm publish`（`prepare` 脚本会在发布前构建 `lib/`；确认 `files` 白名单已覆盖新产物）；
5. 打 tag 并推到 GitHub：`git tag v<版本号> && git push --tags`；
6. 补上 CHANGELOG 底部的 compare 链接。

## 许可证

本项目以 [MIT](LICENSE) 发布。提交贡献即表示你同意你的贡献以同一许可证分发。
