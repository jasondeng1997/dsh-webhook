# Routes and upstream examples

[中文](routes.zh.md) | English

Complete configurations and setup steps for four upstreams. Every example assumes the plugin listens on `127.0.0.1:8787` and that you have exposed it at a public address such as `https://hooks.example.com`.

## Contents

- [GitHub](#github)
- [GitLab](#gitlab)
- [Gitee](#gitee)
- [A generic HMAC sender](#a-generic-hmac-sender)
- [One upstream, several routes](#one-upstream-several-routes)
- [Three ways to bind a session](#three-ways-to-bind-a-session)
- [Troubleshooting](#troubleshooting)

---

## GitHub

**Scheme**: `x-hub-signature-256`, HMAC-SHA256 hex. The legacy `x-hub-signature` (SHA-1) is consulted only when the strong header is absent, so a delivery cannot be downgraded.

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
          Workflow event: {{ action }}
          Repository: {{ repository.full_name }}
          Workflow: {{ workflow_run.name }}
          Conclusion: {{ workflow_run.conclusion }}
          Branch: {{ workflow_run.head_branch }}
          Logs: {{ workflow_run.html_url }}

          If the conclusion is failure, pull the failing job's log, find the cause, and propose the smallest fix. If it succeeded, reply with a one-line summary.
        callbackUrl: https://your-service.example.com/dsh/reply
```

Setup:

1. Repository **Settings → Webhooks → Add webhook**.
2. **Payload URL**: `https://hooks.example.com/hooks/gh/ci`.
3. **Content type**: `application/json`.
4. **Secret**: the same value as `GITHUB_WEBHOOK_SECRET`.
5. **Events**: *Let me select individual events* → *Workflow runs* (or whatever your route expects).
6. Saving sends an immediate `ping` delivery; with no `events` filter your route will process it.

> GitHub expects a response within ten seconds, which is why the bridge answers `202` first and runs the session in the background. A ten-minute agent turn is still a "successful delivery" from GitHub's side.

## GitLab

**Scheme**: `x-gitlab-token` compared byte-for-byte, in constant time, against the configured secret.

```yaml
      - id: gl-mr
        path: /hooks/gl/mr
        source: gitlab
        secretRef: GITLAB_WEBHOOK_TOKEN
        # The event name comes from the X-Gitlab-Event header, which spells it
        # "Merge Request Hook". The payload's object_kind says merge_request, but
        # the filter reads the header.
        events: ['Merge Request Hook']
        session: auto
        template: |
          Merge request event: {{ object_attributes.action }}
          Project: {{ project.path_with_namespace }}
          Title: {{ object_attributes.title }}
          Source branch: {{ object_attributes.source_branch }}
          Target branch: {{ object_attributes.target_branch }}
          Link: {{ object_attributes.url }}

          Check whether this change touches a database migration or a wire protocol, and list the docs that must be updated.
```

Setup: project **Settings → Webhooks**, URL `https://hooks.example.com/hooks/gl/mr`, **Secret token** the same value, trigger only *Merge request events*.

GitLab also sends form-encoded bodies (`application/x-www-form-urlencoded`); the bridge parses them into flat fields.

## Gitee

**Scheme**: `x-gitee-token` against the webhook password you set in Gitee.

```yaml
      - id: gitee-push
        path: /hooks/gitee/push
        source: gitee
        secretRef: GITEE_WEBHOOK_PASSWORD
        # Also from a header: X-Gitee-Event spells it "Push Hook".
        events: ['Push Hook']
        session: auto
        template: |
          Push event
          Repository: {{ repository.full_name }}
          Ref: {{ ref }}
          Commits: {{ total_commits_count }}
          Latest: {{ head_commit.message }}

          Check whether this push changed the CI configuration or the dependency manifest, and say what it affects.
```

## A generic HMAC sender

Anything that can compute an HMAC-SHA256 can use the `generic` scheme: put the hex digest of the raw body in `x-webhook-signature`, with or without the `sha256=` prefix.

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

The Node equivalent:

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

And the route:

```yaml
      - id: order
        path: /hooks/order
        source: generic
        secretRef: SHARED_SECRET
        events: [order_refunded]
        session: auto
        template: |
          Refund for order {{ orderId }}, amount {{ amount }}.
          Check the refunded amount against the order total and name the next step that is owed.
        callbackUrl: https://your-service.example.com/dsh/reply
```

## One upstream, several routes

Routes are distinguished by path, so a single upstream can fan out to different sessions, workspaces, and even different agent presets:

```yaml
      - id: ci-failure
        path: /hooks/gh/ci
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [workflow_run]
        session: auto
        workspace: /Users/you/platform
        agentPreset: incident
        template: |
          Workflow {{ workflow_run.name }} finished as {{ workflow_run.conclusion }}; find the cause.

      - id: pr-review
        path: /hooks/gh/pr
        source: github
        secretRef: GITHUB_WEBHOOK_SECRET
        events: [pull_request]
        session: auto
        workspace: /Users/you/platform
        template: |
          PR #{{ pull_request.number }}: {{ pull_request.title }}
          Write a review.
```

Both routes share one secret reference while keeping independent concurrency, queueing, and session bindings.

## Three ways to bind a session

| Setting | Behaviour | Fits |
|---|---|---|
| `session: auto` | One session is created on the route's first delivery and reused afterwards | Following the same class of event over time — the CI job that broke yesterday and broke again today |
| `session: <existing id>` | Every delivery lands in the session you name | Continuing external events in a context you are already working in from the Web UI or CLI |
| `session: auto` + `events` | Only the events you care about reach the session; the rest are acknowledged and marked `filtered` | Noisy repositories |

Session ids appear in the Web session list, or can be listed with commands such as `/sessionlist`.

## Troubleshooting

**The delivery arrived but stays `queued`.**
The session is waiting on the model or a tool. Check the stage with `GET /deliveries?token=…`; `prompted` means it was submitted but the route has no callback configured.

**The answer never reached my callback.**
Read the record's `detail`: `timeout` means no new assistant turn appeared within `replyTimeoutMs`; `callback-failed` means the callback was rejected (`4xx` — never retried) or timed out. Callback bodies carry no secrets, so they are safe to log.

**Every template field is empty.**
Check the paths against the record's `missing` list. GitLab and GitHub use different field names (`object_attributes.title` versus `pull_request.title`). Rendering `{{ json }}` prints the payload as-is while you work it out.

**`events` is set but never matches — every delivery is `filtered`.**
The event name comes from a **header**, not from a payload field, and the header wins when the two disagree. The three upstreams spell it differently:

| Upstream | Header | Values look like |
|---|---|---|
| GitHub | `X-GitHub-Event` | `pull_request`, `push`, `workflow_run`, `ping` (lowercase, snake_case) |
| GitLab | `X-Gitlab-Event` | `Merge Request Hook`, `Push Hook`, `Pipeline Hook` |
| Gitee | `X-Gitee-Event` | `Merge Request Hook`, `Push Hook`, `Issue Hook` |

So on GitLab, `events: [merge_request]` never matches: the payload's `object_kind` really is `merge_request`, but the filter compares against the header's `Merge Request Hook`. When unsure, leave `events` off, send one delivery, and read the `event` field of the delivery record — or check it locally with `examples/trigger.mjs`.

**I want to try it without a secret.**
Set `allowUnsigned: true` on the route. The plugin keeps reporting that exposure in the boot log, in `GET /healthz`'s problem count, and in the settings card. Turn it off as soon as you are done.
