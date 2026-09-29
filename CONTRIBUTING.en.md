# Contributing

English | [中文](CONTRIBUTING.md)

Contributions of any kind are welcome — bug reports, documentation fixes, new signature schemes, new template placeholders. This page covers how to get the project running, the principles the code follows, and the checklist before you open a pull request.

## Setup

All you need is Node and npm:

```sh
git clone https://github.com/jasondeng1997/dsh-webhook
cd dsh-webhook
npm install
```

`engines` declares `node >= 20.19.0`. You do **not** need a DeepSeek Harness checkout to develop — see "Why no harness is needed" below.

Common commands:

```sh
npm run check      # typecheck + unit tests + build + artifact shape assertions (run before committing)
npm run typecheck  # tsc --noEmit only
npm run test       # unit tests only (vitest run)
npm run test:watch # watch mode
npm run build      # build lib/index.js and lib/client.js only
node build.mjs --watch
```

The unit tests are fast and entirely offline: nothing listens on a port, nothing reaches the network, nothing loads the harness. The HTTP tests use a real `node:http` server on an ephemeral port (`port: 0`), so they exercise real behaviour rather than a mock.

## Why no harness is needed

Every testable piece of this plugin is deliberately decoupled from the host:

| File | Responsibility | Harness dependency |
|---|---|---|
| `src/config.ts` | Config normalization, validation, problem collection | no |
| `src/signature.ts` | Four signature schemes, constant-time comparison | no |
| `src/template.ts` | Placeholder parsing and rendering | no |
| `src/payload.ts` | JSON / form / plain-text payload parsing | no |
| `src/outbound.ts` | Callback POST, retry policy, host allowlist | no |
| `src/dispatcher.ts` | Delivery pipeline, concurrency and queueing | no (goes through the `SessionPort` interface) |
| `src/receiver.ts` | HTTP server, route matching, status codes | no |
| `src/delivery-log.ts` | Bounded delivery log | no |
| `src/client/card-face.ts` | Settings-card state machine and staging | no |
| `src/index.ts` | **The only** file coupled to the host | yes |

`src/index.ts` implements `SessionPort` (`ensureSession` / `prompt` / `snapshot` / `waitForIdle`) and hands it to the `Dispatcher`. New business logic belongs in the "no" column above, with tests; only the layer that calls a host seam goes into `src/index.ts`.

This constraint is not fussiness: it is why 135 tests run on a machine with no DSH installed, and why a CI failure generally points at the change under review rather than at an environment difference.

## Layout

```
src/
  config.ts        config normalization (single source of truth for defaults, ranges, rules)
  signature.ts     signature verification
  template.ts      template rendering
  payload.ts       payload parsing
  outbound.ts      outbound sending and retries
  dispatcher.ts    delivery pipeline (verified → rendered → prompted → replied)
  receiver.ts      HTTP server
  delivery-log.ts  delivery log
  version.ts       version and settings namespace
  index.ts         host adapter (cordis plugin: inject / Config / apply)
  client/          browser half (the settings card)
    index.ts       slot and dictionary registration
    card-face.ts   card state machine
    WebhookCard.tsx
    locales.ts
test/              one *.spec.ts per module in src/
types/             tsconfig path targets + hand-authored published declarations
docs/              route examples and the security model (zh + en)
build.mjs          two build targets + artifact shape assertions
cordis.patch.yml   the bundle patch layer
```

## Invariants

### 1. The client artifact must keep the module-loader factory shape

The harness browser side does **not** load ES modules. It evaluates a classic script that registers a factory with `window.__ModuleLoader__.load({ id, factory })`, and `require` inside that factory resolves only the platform seed module table. So `lib/client.js` must be CommonJS wrapped in exactly that factory. `build.mjs` enforces this (`node build.mjs --check`):

- it starts with the version banner;
- it contains `window.__ModuleLoader__.load({ id: "dsh-webhook", ... })`;
- it ends with `return module.exports; } });` with nothing but comments after it;
- **`react` and `react/jsx-runtime` must be `require`d, never inlined.**

The last one is the easiest to break by accident. If you add a dependency to the browser half and it is a seed module (see `PLATFORM_SEED_MODULES` in `build.mjs`), esbuild has to keep it external; if it is not a seed module it gets inlined — and then check that it does not depend on the React or cordis singleton.

Inlining a copy of React gives you two React instances, and the error surfaces at a hook call, far away from the actual cause.

### 2. The host artifact must not bundle `@deepseek-ai/*`

Every `@deepseek-ai/*` specifier in `lib/index.js` stays external and resolves from the profile's own installation. Bundling one produces a second service registry — the same duplicate-instance class of bug.

### 3. `types/` holds two different things; don't mix them up

- `types/cordis.d.ts`, `types/schemastery.d.ts`, `types/dsh-tools.d.ts`, `types/dsh-client.d.ts`: **typecheck-only** structural shims, mapped through `tsconfig.json`'s `paths`, so this repository typechecks without a harness checkout.
- `types/public-host.d.ts`, `types/public-client.d.ts`: **published** declarations, authored by hand and copied into `lib/types/` by `build.mjs`.

When you change a default in `src/config.ts`, the matching `` Defaults to `…` `` comment in `types/public-host.d.ts` has to change too — `test/release.spec.ts` compares them field by field and fails otherwise.

### 4. Security-relevant defaults are "off"

When you add a setting that could loosen authentication or expose information, the default must be the conservative one, and loosening it must be visible in the startup log, in the `GET /healthz` problem count, and in the settings card. Follow how `allowUnsigned` and inline `secret` are handled.

## How to make common changes

### Adding a config field

1. `src/config.ts`: add it to the `Config` type, `DEFAULT_CONFIG`, and `normalizeConfig()` (including range clamping and problem reporting);
2. `src/index.ts`: add it to the schemastery schema with `.default()` and `.description()`;
3. `types/public-host.d.ts`: add the field and its `` Defaults to `…` `` line (or the release test fails);
4. `src/client/card-face.ts`: if it belongs on the settings card, wire it into `toSettings` and the scalar staging logic;
5. the config tables in `README.md` and `README.en.md`;
6. a normalization test in `test/config.spec.ts`.

### Adding a signature scheme

1. add `verifyXxx` in `src/signature.ts`, reusing `timingSafeEqualHex` / `timingSafeEqualText` — do **not** roll your own comparison;
2. wire it into the `verifyDelivery` switch;
3. add the platform's event header name to `EVENT_HEADERS` in `src/payload.ts`;
4. extend the `source` union and the enum validation in `src/config.ts`;
5. the authentication tables in `docs/security.zh.md` / `docs/security.en.md`;
6. `test/signature.spec.ts`: correct signature accepted, wrong signature rejected, **empty secret rejected**, and any weak/legacy path closed off if one exists.

### Adding a template placeholder

1. `src/template.ts`: host context uses the reserved `__` prefix; value lookup goes through the existing dotted-path resolver;
2. the placeholder tables in `README.md` / `README.en.md`;
3. `test/template.spec.ts`. Note that a value coming from the payload must **never** be substituted twice — a test guards that property.

### Changing a delivery stage or the state machine

The stage set in `src/dispatcher.ts` is the `DeliveryStage` union, consumed by `src/client/card-face.ts` and `src/delivery-log.ts`. Adding a stage means updating both and their tests.

## Before committing

```sh
npm run check
```

It runs the typecheck, all unit tests, the build, and the artifact shape assertions. CI (`.github/workflows/ci.yml`) runs the same command on Node 20 and 22; both must be green.

## Commits and pull requests

- Branch names: `fix/…`, `feat/…`, `docs/…`.
- Write commit messages in the imperative and explain **why**, not just what changed:

  ```
  fix(dispatcher): keep the route queue bounded when concurrency is saturated

  The limiter defaulted to 100 queued deliveries, so a burst produced a
  backlog that grew invisibly instead of a 503 the upstream could retry.
  ```

- One thing per pull request. Keep pure refactors and pure formatting in **separate** commits, or the real change disappears into the diff.
- In the description, say what changed, why, and how you verified it. If the change touches a security-relevant default, call it out explicitly.
- New behaviour needs tests. A bug fix needs a test that reproduces the bug — that test is the only thing standing between you and a regression.

## Releasing

Maintainer flow:

1. bump `VERSION` in `src/version.ts` and `version` in `package.json` (`test/release.spec.ts` asserts they agree);
2. add `## <version>` at the top of `CHANGELOG.md` (also asserted);
3. `npm run check`;
4. `npm publish` (the `prepare` script builds `lib/` before packing; confirm the `files` allowlist covers any new artifact);
5. tag and push: `git tag v<version> && git push --tags`;
6. add the compare link at the bottom of the changelog.

## License

Released under the [MIT](LICENSE) license. By contributing you agree that your contribution is distributed under the same license.
