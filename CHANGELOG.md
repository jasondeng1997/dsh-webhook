# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

First release.

### Added

- **Inbound receiver** on a configurable address and port, with routes matched by
  path. Deliveries are acknowledged with `202` before the agent turn starts,
  because upstreams time out in seconds and an agent turn takes minutes.
- **Signature verification** for GitHub (`x-hub-signature-256`, with the legacy
  SHA-1 header accepted only when the strong one is absent), GitLab
  (`x-gitlab-token`), Gitee (`x-gitee-token`), and a generic
  `x-webhook-signature` scheme. Comparisons are constant-time, and an endpoint
  with no resolvable secret fails closed unless it explicitly opts into unsigned
  deliveries.
- **Secrets from the credential store**: `secretRef` resolves through
  `ctx.credentials` per request, so rotating a secret needs no restart. Inline
  secrets are supported but reported as a configuration problem.
- **Prompt templates** with `{{ dotted.path }}` placeholders plus
  `{{ __route }}`, `{{ __source }}`, `{{ __event }}`, `{{ __deliveryId }}`,
  `{{ __receivedAt }}`, and `{{ json }}`. The renderer resolves paths only: no
  evaluation, no helpers, no way for a payload to reach anything but output.
- **Session binding**: `session: auto` lazily creates one session per route and
  reuses it; any other value is an existing session id. `workspace` and
  `agentPreset` apply to sessions the route creates.
- **Event filtering** per route, so a route can subscribe to `push` without also
  being woken by every comment.
- **Callback delivery**: the agent's answer is posted back to the route's
  `callbackUrl` as JSON, with bounded retries, `Retry-After` support, and no
  retry for a `4xx` (a rejection repeated is a small flood).
- **Bounded overload behaviour**: a route runs `maxConcurrency` deliveries at
  once and holds at most `queueLimit` waiting, then answers `503` so the upstream
  retries instead of the bridge growing an invisible backlog.
- **Settings card** in the Plugins section for the plugin's scalars and its route
  list, keyed by the `dsh-webhook` settings namespace. Edits are staged locally
  and written as revision-fenced mutations.
- **Diagnostics**: `GET /healthz` for liveness, and a token-guarded
  `GET /deliveries` returning a bounded in-memory delivery log. Neither exposes
  secrets, headers, or raw payloads.
- **Outbound tool** (`webhook_send`), off by default, with an optional host
  allowlist, so the model can push messages outward when the deployment wants it.
- Unit tests for the configuration rules, signature schemes, template renderer,
  payload parsing, retry policy, delivery pipeline, HTTP receiver, delivery log,
  and settings-card staging — all of them runnable without a harness.

[Unreleased]: https://github.com/jasondeng1997/dsh-webhook/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jasondeng1997/dsh-webhook/releases/tag/v0.1.0
