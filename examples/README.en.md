# Examples

English | [中文](README.md)

The four things in this directory are meant to be used in order: get it running, then wire it to a real upstream. All of them need nothing beyond `npm install` — no DSH install, no API key. The only thing replaced is the model turn, and each script says so where it matters.

| File | Plays the part of | Run it with |
|---|---|---|
| `demo.mjs` | bridge + fake harness, in one process | `npm run demo` |
| `local-bridge.mjs` | bridge + fake harness, as a long-lived service | `npm run example:bridge` |
| `trigger.mjs` | the upstream (GitHub / GitLab / Gitee / your own system) plus a callback receiver | `npm run example:trigger -- --url … --secret …` |
| `github-pr-review.patch.yml` | — | paste into `~/.dsh/profiles/web/cordis.patch.yml` |

`demo.mjs` is for seeing it work. `local-bridge.mjs` plus `trigger.mjs` is for verifying your own deployment. Both load `lib/index.js` — the output of `npm run build`, not the sources — because packaging mistakes (a wrong external specifier, an undeclared dependency, an artifact missing from `files`) only surface at that step.

---

## 1. See it work: `npm run demo`

One command, one process, six scenarios, printing the real status code, callback body and delivery log at each step.

```sh
git clone https://github.com/jasondeng1997/dsh-webhook && cd dsh-webhook
npm install
npm run demo
```

---

## 2. Verify your own deployment: two terminals

This is the shape of a real deployment: a long-lived bridge, and something outside posting to it. Open two terminals.

**Terminal A — start the bridge (fake harness, real plugin):**

```sh
npm run example:bridge
```

It prints the listening address, the secret, which port the `callbackUrl` should point at, and **the profile YAML this configuration corresponds to** — the same configuration as `github-pr-review.patch.yml`, except that a real model answers.

**Terminal B — send a delivery (fake GitHub, real signature):**

```sh
npm run example:trigger -- --url http://127.0.0.1:8787/hooks/github/pr --secret dev-shared-secret
```

It signs a realistic `pull_request` payload with HMAC-SHA256, posts it, listens on the callback port, and prints the answer when it arrives. `--secret` must match what terminal A printed.

The output looks like:

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

Two numbers are worth reading: **9ms**, because the bridge acknowledges with `202` and runs the session afterwards, so an agent turn never holds the upstream open; and **402ms**, which is the fake agent's fixed delay — in a real deployment that step is a model reading code and can take anywhere from seconds to minutes.

### Eight scenarios

`--scenario` lets you check every wiring mistake without touching the upstream's settings:

```sh
npm run example:trigger -- --url … --secret dev-shared-secret --scenario wrong-signature
```

| Scenario | Expect | What it verifies |
|---|---|---|
| `ok` | `202` + 1 callback | the whole path works |
| `replay` | `202` + 2 callbacks | `session: auto` puts both deliveries in one conversation |
| `wrong-signature` | `401` | a wrong secret is rejected and never enters the pipeline — there is not even a delivery record |
| `unsigned` | `401` | an endpoint with no resolvable secret is closed by default, not degraded |
| `wrong-event` | `202`, no callback | the `events` filter works; the agent is not woken |
| `oversized` | `413` | a body past `maxBodyBytes` is refused at read time, before signature verification |
| `wrong-path` | `404` | no route matches the path |
| `get` | `405` | the path exists but is not a POST endpoint |

Exit code 0 means "behaviour matched the scenario", so this can go straight into CI or a post-deploy smoke test.

### Other useful flags

```sh
--source gitlab|gitee|generic   # switch the signature scheme and the built-in payload
--event push                    # switch the event name
--payload ./my.json             # send your own payload to check your template placeholders
--show-payload                  # print the full JSON about to be sent
--listen 9099                   # callback port; must match the route's callbackUrl
--no-listen                     # only care about the delivery result, do not wait for an answer
--timeout 300                   # a real model may take minutes
```

---

## 3. Switch to a real upstream

Once it works locally, three things change:

1. **Paste the configuration into the profile.** Copy `github-pr-review.patch.yml` into `~/.dsh/profiles/web/cordis.patch.yml`, replacing `managementToken`, `workspace` and `callbackUrl` with your own values.

2. **Put the secret in the credential store** (`~/.dsh/.credentials.yaml`, hot-reloaded, no restart):

   ```yaml
   version: 1
   refs:
     GITHUB_WEBHOOK_SECRET: 你生成的随机字符串
   ```

3. **Expose the port**, then fill in GitHub's **Settings → Webhooks**: Payload URL (`https://your-domain/hooks/github/pr`), Content type (`application/json`), Secret (the same value as step 2), and the Pull requests event.

```sh
cloudflared tunnel --url http://127.0.0.1:8787     # quickest for temporary debugging
```

Before switching over, you can use the simulator to check **the public leg** on its own — point `--url` at your public address; the signature, payload and event name do not change:

```sh
npm run example:trigger -- --url https://your-domain/hooks/github/pr --secret that-random-string
```

**GitHub sends one `ping` the moment you save a webhook.** If that `ping` drives a session, the route is missing its `events` filter — `--scenario wrong-event` shows you the same behaviour ahead of time.

---

## What `local-bridge.mjs` fakes

Two things, and only two:

- **the model turn** — a timer instead of a call, adjustable with `--latency`;
- **the credential store** — a lookup table instead of `ctx.credentials`, so the resolve-failure path behaves exactly as it does in production.

Everything else is the real thing: the HTTP listener, route matching, constant-time verification, payload parsing, template rendering, session binding, concurrency and queueing, `503` on overload, the callback POST and its retry policy, the delivery log, and the diagnostics endpoints. The `settings` and `tools` services are deliberately absent — the plugin has to work without them, and this verifies that rather than assuming it.

---

## One trap worth knowing: GitLab event names

The event name comes from a **header**, not from the payload, and the header wins when the two disagree. GitLab sends `Merge Request Hook` in `X-Gitlab-Event`, while the payload's `object_kind` says `merge_request`:

```yaml
events: [Merge Request Hook]     # ✅ the filter matches
events: [merge_request]          # ❌ never matches; deliveries are silently filtered out
```

When unsure, leave `events` off, send one delivery with `--show-payload`, and read the event name the bridge reports (the `event` field of the delivery record).
