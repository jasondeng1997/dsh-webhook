# Security model

[中文](security.zh.md) | English

dsh-webhook turns inbound HTTP requests into agent turns. That makes it a remote execution surface with extra steps, and this page states exactly what it defends against, how, and what it does not do.

## Threat model

| Adversary | Capability assumed | Defence |
|---|---|---|
| Anyone who can reach the port | Send arbitrary bodies, headers, and volumes | Loopback bind by default, signature verification, body ceiling, request deadline, bounded queue |
| A legitimate sender replaying or forging | Knows the endpoint URL, may once have held a valid secret | Per-request secret resolution, constant-time comparison, no downgrade path |
| A malicious payload author | Controls every byte inside the JSON | No template evaluation, path-lookup-only substitution, prompt truncation |
| A malicious callback receiver | Controls the response to a callback POST | Bounded excerpt capture, no retry on `4xx`, no secret in the request |
| A curious log reader | Reads the boot log, the delivery log, `GET /healthz` | Payloads and headers never logged; diagnostics carry ids, stages, and timings only |

## Authentication

Every route authenticates with a shared secret, verified before the body is parsed:

| `source` | Scheme | Notes |
|---|---|---|
| `github` | `x-hub-signature-256` (HMAC-SHA256 hex) | The legacy `x-hub-signature` (SHA-1) is consulted **only** when the strong header is absent, so a delivery that carried a strong signature cannot be downgraded |
| `gitlab` | `x-gitlab-token` (verbatim secret) | Constant-time comparison; whitespace is part of the secret and not trimmed |
| `gitee` | `x-gitee-token` (webhook password) | Same comparison rules |
| `generic` | `x-webhook-signature` (HMAC-SHA256 hex, `sha256=` prefix optional) | Also accepts the GitHub header name, so one sender can serve both endpoint kinds |

An endpoint with **no resolvable secret** answers `401` to every delivery. It does not fall through to "no authentication configured, therefore accepted". Opting out is an explicit `allowUnsigned: true`, which the plugin then reports as a problem in the boot log, in `GET /healthz`'s problem count, and in the settings card for as long as it is set.

Secrets live in the credential store, referenced by name:

```yaml
routes:
  - id: ci
    secretRef: GITHUB_WEBHOOK_SECRET
```

`secretRef` is resolved through the harness credential seam on **every request**, which means rotating a secret takes effect immediately — no restart, no reconnect. The inline `secret` field exists for local experiments and is reported as a configuration problem on every boot, because it lands in the profile's configuration tree, which is a file people paste into issues.

## Payload handling

- **Size**: bodies over `maxBodyBytes` are refused with `413`. An oversized body is drained rather than cut off, so the sender learns *why* it was refused instead of seeing a connection reset; nothing past the ceiling is retained.
- **Shape**: JSON, form-encoded, and unknown bodies are all handled. A body that announces JSON but cannot be parsed degrades to raw text rather than failing the delivery, because a readable prompt beats a dropped event.
- **Templates**: substitution resolves `{{ dotted.path }}` lookups and nothing else. There is no evaluation, no helper functions, no partials, and no recursive substitution — a payload value that looks like a placeholder is emitted verbatim. This is the single most important property in the plugin: an evaluable template would let whoever writes the payload run code inside the harness process.
- **Truncation**: renders longer than `maxPromptChars` are cut and marked, so a large payload cannot silently consume the model's context budget.

## Outbound requests

Callback delivery and the `webhook_send` tool share one poster with these rules:

- retries only where retrying could plausibly succeed: transport failure, timeout, `408`, `429`, `5xx`;
- `4xx` is never retried — a rejection repeated is a small flood;
- `Retry-After` is honored, capped by the caller's ceiling, and exponential backoff applies otherwise;
- callback header values are rendered through the same sandboxed renderer, and header names that fail a token check — or that would smuggle a CRLF, or that are `host`, `content-length`, or `transfer-encoding` — are dropped rather than sent;
- the outbound tool is **off by default**, and when enabled can be narrowed with `sendToolAllowHosts` (`.example.com` covers the domain and its subdomains).

## Diagnostics without exposure

- `GET /healthz` reports liveness, the version, how many routes are live, and how many configuration problems were found. It does not list routes, session ids, or counters — an unauthenticated probe learns nothing worth having.
- `GET /deliveries` requires `managementToken`. When no token is configured the endpoint answers `404`, because "no password set" must not mean "empty password accepted". Records carry a delivery id, route id, source, event name, receipt time, stage, duration, the session id, and text the plugin wrote itself. **No payloads, no headers, no secrets, no tokens.**
- The boot log reports configuration problems by field name. Secret *values* are never logged; only the reference names.

## Overload

A route processes `maxConcurrency` deliveries at once and holds at most `queueLimit` waiting; beyond that the receiver answers `503` with a reason. This is deliberate: an upstream that supports retries is a better place to hold work than an unbounded in-process queue of agent turns, and a bounded refusal is visible in the delivery log while a growing backlog is not.

Request reads are bounded by `requestTimeoutMs`, and the HTTP server carries matching header, request, and keep-alive timeouts, so a slow or oversized client cannot hold a slot indefinitely.

## What this plugin does not do

- **No TLS.** It speaks plain HTTP. Terminate TLS in front of it, or keep it on loopback and tunnel.
- **No rate limiting.** `503` on saturation is backpressure, not a rate limiter. Put a proxy in front of a public endpoint.
- **No request allowlisting.** Any path not configured answers `404`, but any configured path accepts any signed request from anyone holding the secret. If a secret leaks, rotate it — that is the whole revocation story.
- **No payload inspection.** The bridge does not judge whether a delivery is *sensible*, only whether it is *authentic* and *in scope*. Prompt-injection resistance inside the payload is the model's and your instructions' problem, which is why `instructions` exists on a route.

## Reporting a vulnerability

See [`../SECURITY.md`](../SECURITY.md).
