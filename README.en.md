# dsh-webhook

English | [中文](README.md)

Bridge **any HTTP webhook** into DeepSeek Harness: verify the signature, match a route, render a prompt, drive a session, and post the agent's answer back to your endpoint.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jasondeng1997/dsh-webhook/actions/workflows/ci.yml/badge.svg)](https://github.com/jasondeng1997/dsh-webhook/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)
![Tests](https://img.shields.io/badge/tests-135%20passing-brightgreen)

---

## Why this exists

CI fails, someone opens a pull request, a monitor fires, an order is refunded — all of it arrives as a webhook on some HTTP endpoint. What you want next is an agent turn: read the logs, look at the diff, reach a conclusion, send it somewhere.

dsh-webhook is that glue, without the glue ending up in your application: it opens its own listener, matches deliveries by path, verifies the signature, renders the payload into a prompt for a harness session, and posts the agent's answer back to a URL you choose.

```
GitHub / GitLab / Gitee / your own service
        │  POST /hooks/ci   (signed)
        ▼
┌──────────────────────────────────────────────────┐
│ dsh-webhook (this plugin, own listener)          │
│  verify → filter → render → bind to a session    │
└──────────────────────────────────────────────────┘
        │  ctx.sessionController.prompt()
        ▼
   DeepSeek Harness session (the agent runs tools, reaches a conclusion)
        │  answer
        ▼
   callback POST → your system (comment, alert, ticket, Slack…)
```

## Features

- **Four signature schemes**: GitHub (`x-hub-signature-256`, with the legacy SHA-1 header accepted only when the strong one is absent), GitLab (`x-gitlab-token`), Gitee (`x-gitee-token`), and a generic `x-webhook-signature` HMAC-SHA256 scheme. All comparisons are constant-time, and an endpoint whose secret cannot be resolved **fails closed** unless the route explicitly opts into unsigned deliveries.
- **Secrets from the credential store**: `secretRef` is re-resolved through `ctx.credentials` on every request, so rotating a secret needs no restart.
- **A safe template renderer**: `{{ dotted.path }}` lookups only — no expressions, no helpers, no recursion. The payload is attacker-controlled by definition; a template language that can execute hands the attacker a foothold inside the harness process.
- **Session binding**: `session: auto` lazily creates one session per route and reuses it; any other value is an existing session id.
- **Event filtering** per route, so a route can care about `push` without also being woken by every comment.
- **Callback delivery**: the answer is posted back to the route's `callbackUrl` as JSON, with bounded retries and `Retry-After` support, and no retry for a `4xx` — a rejection repeated is a small flood.
- **Bounded overload behaviour**: a route runs `maxConcurrency` deliveries and holds at most `queueLimit` waiting, then answers `503`. An upstream that can retry is a better place to hold work than an invisible in-process backlog.
- **A settings card** in the Plugins section, keyed by the `dsh-webhook` settings namespace, editing the plugin's scalars and its route list. Edits are staged locally and written as revision-fenced mutations.
- **Diagnostics**: `GET /healthz` for liveness; `GET /deliveries` behind `managementToken` returns a bounded delivery log. Neither exposes secrets, headers, or raw payloads.
- **An outbound tool** (`webhook_send`, off by default) with an optional host allowlist, letting the model push messages outward when the deployment wants it.

## Install

From the published package:

```sh
dsh plugin --profile web add -w dsh-webhook
```

Restart `dsh web` (or the desktop client), refresh the browser, then open **Settings → Plugins → Configurable** and find the **Webhook bridge** card.

Or install straight from GitHub:

```sh
dsh plugin --profile web add -w github:jasondeng1997/dsh-webhook
```

> A git install fetches **sources, not built artifacts**, so this package's `prepare` script builds `lib/` with esbuild at install time. pnpm 10 and later refuses to run a dependency's build script until it is allowed; the first `add` fails and prints the exact `allowBuilds` key for the profile's `pnpm-workspace.yaml`. Allow it and re-run. **Allowing that is permission for the package to execute code on your machine** — only do it for sources you trust, and pin a commit with `#<commit-sha>`.

## Sixty-second local demo

You do not need DSH installed to watch this work. `examples/demo.mjs` loads the **built artifact** (`npm run build` output, not the sources) and drives it through a minimal stand-in for the harness, so the whole path is real: a real HTTP listener, a real HMAC check, a real template render, a real callback POST, the real retry policy, the real delivery log. The only thing faked is the model turn — a 1.2s timer stands in for it, which is why the demo needs **no API key and no network**.

```sh
git clone https://github.com/jasondeng1997/dsh-webhook && cd dsh-webhook
npm install
npm run demo
```

It walks through six deliveries:

| # | Scenario | Expected |
|---|---|---|
| 1 | Valid signature, matching event | `202` → session created → agent answers → callback received |
| 2 | A second delivery on the same route | `202`, reusing **the same session** (`session: auto`) |
| 3 | Wrong signature | `401`; the delivery never reaches the pipeline |
| 4 | Valid signature, event not in `events` | `202`; the agent is never woken |
| 5 | No signature at all | `401` — no secret means closed, not degraded |
| 6 | A route with explicit `allowUnsigned: true` | `202` (a deliberate opt-out, not a default) |

It then prints the exact prompt the agent received, the full callback payload, the live `GET /healthz` and `GET /deliveries` responses, and which stage each delivery record reached.

## Quick start: review every pull request

**1. Put a secret in the credential store.** Write it into `~/.dsh/.credentials.yaml` (the file is watched and hot-reloaded, so no restart):

```yaml
version: 1
refs:
  GITHUB_WEBHOOK_SECRET: a-long-random-string-you-generate
```

A launch environment variable of the same name works too, but environment changes need a host restart.

**2. Configure one route in the profile's `cordis.patch.yml`** (`~/.dsh/profiles/web/cordis.patch.yml`):

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
        workspace: /Users/you/project
        template: |
          A pull_request event arrived: {{ action }}
          Repository: {{ repository.full_name }}
          Title: {{ pull_request.title }}
          Author: {{ pull_request.user.login }}
          Link: {{ pull_request.html_url }}

          Read the diff, then report likely defects, missing tests, and risks in a short review.
        callbackUrl: https://your-service.example.com/dsh/reply
```

> A patch layer **replaces** the whole `config` value for the row id rather than deep-merging keys. Restate every key you need; omitted keys fall back to the schema defaults.

**3. Get public traffic to that port.** The plugin binds loopback by default, so expose it deliberately:

```sh
# Option A: tunnel the local port (the fastest way to try it)
cloudflared tunnel --url http://127.0.0.1:8787

# Option B: your reverse proxy forwards /hooks/ to 127.0.0.1:8787
```

**4. Add the webhook in GitHub**: payload URL `https://your-host/hooks/github/pr`, content type `application/json`, the same secret as step 1, and the *Pull requests* event.

**5. Open a pull request.** The plugin answers `202` immediately — the upstream sees "received" — and drives the session in the background. When the agent finishes, your `callbackUrl` receives:

```json
{
  "deliveryId": "3f1c…",
  "route": "pr-review",
  "source": "github",
  "event": "pull_request",
  "sessionId": "…",
  "receivedAt": "2026-09-29T02:11:03.412Z",
  "answeredAt": "2026-09-29T02:12:47.006Z",
  "answer": "the review text…"
}
```

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | When off, the plugin loads but opens no port |
| `host` | `127.0.0.1` | Bind address. `0.0.0.0` hands the port to the network — pair it with a firewall or proxy access control |
| `port` | `8787` | Bind port; `0` asks the OS for an ephemeral port |
| `maxBodyBytes` | `1048576` | Body ceiling in bytes; oversized requests get `413` before verification |
| `requestTimeoutMs` | `15000` | Per-request read/write deadline |
| `replyTimeoutMs` | `600000` | Default wait for an agent answer |
| `queueLimit` | `4` | Deliveries a route may hold waiting before `503` is returned |
| `callbackAttempts` | `3` | Callback POST attempts, including the first |
| `callbackBackoffMs` | `1000` | Callback backoff base (grows exponentially) |
| `callbackTimeoutMs` | `15000` | Per-attempt callback timeout |
| `maxPromptChars` | `100000` | Prompt ceiling; longer renders are truncated and marked |
| `sendTool` | `false` | Register the outbound `webhook_send` tool |
| `sendToolAllowHosts` | `[]` | Outbound host allowlist; empty allows any host, `.example.com` covers the domain and its subdomains |
| `deliveryLogSize` | `200` | Delivery records kept in memory |
| `managementToken` | unset | Guards `GET /deliveries`; unset makes that endpoint `404` |
| `routes` | `[]` | The route list |

### Route fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Route identity, used in logs, delivery records, and the card |
| `path` | yes | Endpoint path, e.g. `/hooks/ci` |
| `source` | | `github` / `gitlab` / `gitee` / `generic`; picks the signature scheme, defaults to `generic` |
| `enabled` | | Whether the endpoint accepts deliveries; defaults to `true` |
| `secretRef` | | Credential name; one of `secretRef`, `secret`, or `allowUnsigned` |
| `secret` | | Inline secret, local experiments only — it lands in the configuration tree and is reported as a problem |
| `allowUnsigned` | | Opt in to unsigned deliveries; defaults to `false`. **Anyone who can reach the port can drive the session** |
| `session` | | `auto` (default: lazily created per route and reused) or an existing session id |
| `workspace` | | Working directory for the session this route creates |
| `agentPreset` | | Agent preset for sessions this route creates |
| `template` | | Prompt template; empty uses the built-in one |
| `instructions` | | Extra instructions appended after the rendered prompt |
| `events` | | Event filter such as `[push, pull_request]`; empty delivers all |
| `callbackUrl` | | Where the answer is posted; setting it enables callback delivery by default |
| `callbackHeaders` | | Extra callback headers; values support the same placeholders |
| `replyMode` | | `none` or `callback`; inferred from `callbackUrl` when omitted |
| `replyTimeoutMs` | | Per-route override of the reply wait |
| `maxConcurrency` | | Per-route concurrency; defaults to `2` |

A configuration problem never stops the plugin from starting: the offending route is dropped, and the reason is written to the boot log, counted in `GET /healthz`, and shown in the settings card.

## Template syntax

| Placeholder | Meaning |
|---|---|
| `{{ repository.full_name }}` | Payload lookup by dotted path; `a[0].b` and `a["odd key"]` work |
| `{{ json }}` | The whole payload as formatted JSON |
| `{{ __route }}` | Route id |
| `{{ __source }}` | Upstream kind |
| `{{ __event }}` | Event name, empty when the upstream names none |
| `{{ __deliveryId }}` | This delivery's id |
| `{{ __receivedAt }}` | Receipt time, ISO-8601 |

A path that resolves to nothing renders as an empty string and is recorded in the delivery's `missing` list — a mistyped field name is visible rather than silently rendered as `undefined`.

## HTTP surface

| Method | Path | Behaviour |
|---|---|---|
| `POST` | each route's `path` | Accepts a delivery. `202 { ok, deliveryId }` on success; `401` bad signature; `413` over the body ceiling; `404` unconfigured path; `405` non-POST; `503` when the route is saturated |
| `GET` | `/healthz` | `{ ok, version, routes, problems }` — no sensitive detail |
| `GET` | `/deliveries?limit=50` | Delivery records and counters. Requires `managementToken` (via `x-webhook-token` or `?token=`); returns `404` when none is configured |

## Security

The plugin turns public input into agent input, so the default posture is "closed":

- an endpoint with no resolvable secret answers `401` unless it explicitly sets `allowUnsigned: true`;
- signature comparisons are constant-time, and a GitHub route never lets the weak signature rescue a failed strong one;
- payloads never reach the log, and delivery records carry only ids, stages, timings, and text the plugin wrote itself;
- templates execute nothing, so a payload cannot reach anything but the output string;
- the diagnostics endpoint does not exist unless `managementToken` is set, rather than being open with an empty password;
- the outbound tool is off by default, and can be narrowed further with a host allowlist.

What remains yours: **TLS, access control, and rate limiting in front of the port.** The plugin verifies signatures, bounds bodies and request durations, and refuses overload — it does not replace a reverse proxy.

See [`docs/security.en.md`](docs/security.en.md).

## Development

```sh
npm install
npm run check     # typecheck + unit tests + build + artifact shape check
npm run test      # unit tests only
npm run build     # build only
npm run demo      # end-to-end demo: loads the built artifact, needs no DSH and no API key
```

The core logic — routing rules, signature schemes, templates, payload parsing, the retry policy, the delivery pipeline, the HTTP receiver, the delivery log, and the card's staging state machine — **does not depend on the harness**, so the unit tests need no host. The harness coupling lives in one file, `src/index.ts`.

To try it against a local profile:

```sh
node build.mjs
dsh plugin --profile web add -w ./
dsh --profile web --dump-config     # expect a "# == dsh-webhook" layer
```

More detail in [`CONTRIBUTING.en.md`](CONTRIBUTING.en.md).

## Documentation

- [Routes and upstream examples](docs/routes.en.md)
- [Security model](docs/security.en.md)
- [Contributing](CONTRIBUTING.en.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
