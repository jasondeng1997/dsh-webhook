# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.2

### Added

- `examples/trigger.mjs`, an upstream simulator. It signs a realistic payload
  with the scheme the route declares, posts it, and listens for the answer, so
  the half of an integration you cannot schedule — a real GitHub delivery into
  an endpoint only your machine can see — becomes one command. Eight scenarios
  (`ok`, `replay`, `wrong-signature`, `unsigned`, `wrong-event`, `oversized`,
  `wrong-path`, `get`) cover the failure paths; exit code 0 means behaviour
  matched the documentation, so `--url` pointed at a real endpoint makes it a
  post-deploy check.
- `examples/local-bridge.mjs`, the bridge as a long-lived service behind a fake
  harness — the shape a deployment actually has, one process listening and
  another posting to it. It prints the profile YAML it is emulating.
- `examples/github-pr-review.patch.yml`, a paste-ready profile configuration.
- `examples/smoke.mjs` and `npm run example:smoke`: mounts the bridge in-process
  and drives all eight scenarios, so the next change that breaks the examples
  fails a command instead of being discovered by a reader. It runs in CI.
- `test/examples.spec.ts`, which pins the example route across the profile file,
  the local bridge and the trigger — three files that have to agree on the path,
  the secret reference and the callback port, and whose disagreement would show
  up as a callback that never arrives.

### Fixed

- `docs/routes.*.md` told GitLab and Gitee users to filter on `merge_request`
  and `push`, which never match. The event name comes from a header, and those
  upstreams spell it `Merge Request Hook` and `Push Hook`; the payload's
  `object_kind` is not consulted when a header is present. Both examples are
  corrected, and the header-versus-payload rule is documented under
  Troubleshooting with the value format for all three upstreams.

### Changed

- `demo.mjs` no longer carries its own copy of the stub harness and the terminal
  helpers; both moved to `examples/lib/` and are shared with the new scripts.
  The demo's output is unchanged.

## 0.1.1

### Added

- `examples/demo.mjs`, runnable with `npm run demo`. It loads the **built**
  artifact and drives it through a stand-in harness, so the receiver, the
  signature check, the template renderer, the dispatcher, the callback POST, the
  retry policy, and the delivery log can all be watched working without DSH
  installed, without an API key, and without a network. It walks through six
  deliveries: a valid one, a repeat that reuses the session, a bad signature, a
  filtered event, a missing signature, and an explicitly unsigned route.

### Fixed

- Declared the two runtime imports `lib/index.js` actually makes.
  `@deepseek-ai/schemastery` is now a `dependencies` entry and
  `@deepseek-ai/dsh-tools` a `peerDependencies` entry, matching what the official
  plugins declare. Neither was listed before, so loading the bundle depended on
  the profile's hoisted `node_modules` happening to contain a compatible copy —
  which it does for a default profile and does not for a strict one.

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

[Unreleased]: https://github.com/jasondeng1997/dsh-webhook/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/jasondeng1997/dsh-webhook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jasondeng1997/dsh-webhook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jasondeng1997/dsh-webhook/releases/tag/v0.1.0
