/**
 * Build script for dsh-webhook.
 *
 * The harness ships two artifacts per plugin, and neither comes from a build
 * preset available outside the harness repository, so this script reproduces
 * both:
 *
 * - `lib/index.js` — the host half. Plain ESM for Node; every `@deepseek-ai/*`
 *   specifier stays external and resolves from the profile's own installation.
 * - `lib/client.js` — the browser half. The harness loader does not load ES
 *   modules: it evaluates a classic script that registers a factory with
 *   `window.__ModuleLoader__.load({ id, factory })`, and that factory's
 *   `require` can only answer the frozen platform seed table plus the bundles
 *   the boot graph places before this one. So the client bundle is emitted as
 *   CommonJS and wrapped in exactly that factory shape, with `react` and
 *   `react/jsx-runtime` left external (both are seed words) and everything else
 *   inlined.
 *
 * Usage:
 *   node build.mjs            # one-shot build
 *   node build.mjs --watch    # rebuild on change
 *   node build.mjs --check    # build, then assert the artifact shapes
 *
 * @module dsh-webhook/build
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, context } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** The plugin id stamped into the module-loader registration. */
const id = manifest.name

/**
 * Specifiers the browser bundle must not inline.
 *
 * These are exactly the platform seed words the harness shell shares into its
 * module table, because `require` inside a client bundle can answer nothing
 * else. Inlining one of them would give this plugin a second copy of a
 * singleton the shell already owns — a second React, a second cordis — which
 * fails at runtime in ways that are hard to read.
 */
const PLATFORM_SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Node builtins plus every harness package, kept external in the host half.
 *
 * Wildcards rather than a package list: the host half imports harness packages
 * for their types and reaches their runtime only through the cordis context, so
 * the artifact must never carry a copy of one. A bundled `@deepseek-ai/*` would
 * load a second instance next to the profile's own — the classic duplicate
 * service registry failure — and would silently disagree with the host about
 * that package's version.
 */
const hostExternal = ['node:*', '@deepseek-ai/*']

/** Shared esbuild options. */
const shared = {
  bundle: true,
  logLevel: 'info',
  sourcemap: true,
  minify: false,
  target: ['node20', 'es2023'],
  legalComments: 'none',
}

/** The host-half build. */
const hostConfig = {
  ...shared,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  format: 'esm',
  platform: 'node',
  external: hostExternal,
  banner: { js: `/** dsh-webhook ${manifest.version} — host half. MIT licensed. */` },
}

/** The browser-half build, wrapped in the harness module-loader factory shape. */
const clientConfig = {
  ...shared,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  external: PLATFORM_SEED_MODULES,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  banner: {
    js: [
      `/** dsh-webhook ${manifest.version} — browser half. MIT licensed. */`,
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
}

/**
 * Emit the type declarations the package's `types` fields point at.
 *
 * A generated `.d.ts` rollup would have to resolve the harness type packages,
 * which this plugin deliberately does not depend on, so the two published
 * declaration files are authored in `types/` and copied into `lib/types/` here.
 * One authored source per half, one generated artifact.
 */
async function emitTypes() {
  const targets = [
    { source: 'public-host.d.ts', target: join(root, 'lib/types/index.d.ts') },
    { source: 'public-client.d.ts', target: join(root, 'lib/types/client/index.d.ts') },
  ]
  for (const { source, target } of targets) {
    const text = await readFile(join(root, 'types', source), 'utf8')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text)
  }
}

/** Assert the artifacts are shaped the way the harness expects to consume them. */
async function verifyArtifacts() {
  const problems = []
  const client = await readFile(join(root, 'lib/client.js'), 'utf8')
  const expectedBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
  if (!client.startsWith(`/** dsh-webhook ${manifest.version}`)) {
    problems.push('lib/client.js does not start with the version banner')
  }
  if (!client.includes(expectedBanner)) {
    problems.push(`lib/client.js is missing the module-loader banner for id ${id}`)
  }
  // The epilogue must close the factory, with nothing after it but comments
  // (esbuild appends a sourcemap reference line).
  const epilogueAt = client.indexOf('return module.exports; } });')
  if (epilogueAt === -1) {
    problems.push('lib/client.js does not end with the factory epilogue')
  } else {
    const trailing = client.slice(epilogueAt + 'return module.exports; } });'.length)
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'))
    if (trailing.length > 0) {
      problems.push(`lib/client.js has executable code after the factory epilogue: ${trailing[0].slice(0, 60)}`)
    }
  }
  if (!/require\(\s*["']react["']\s*\)/.test(client)) {
    problems.push('lib/client.js inlined react instead of requiring it from the module table')
  }
  if (!/require\(\s*["']react\/jsx-runtime["']\s*\)/.test(client)) {
    problems.push('lib/client.js inlined react/jsx-runtime instead of requiring it from the module table')
  }
  for (const specifier of PLATFORM_SEED_MODULES) {
    if (!client.includes(`"${specifier}"`) && !client.includes(`'${specifier}'`)) continue
    // A seed specifier may only appear as an external reference, never inlined:
    // an inlined copy would ship a second React or a second cordis instance.
    const asRequire = new RegExp(`require\\(\\s*["']${specifier.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}["']\\s*\\)`)
    if (client.includes(`${specifier} =`) && !asRequire.test(client)) {
      problems.push(`lib/client.js appears to inline the platform module "${specifier}"`)
    }
  }
  const host = await readFile(join(root, 'lib/index.js'), 'utf8')
  if (!host.includes('export')) {
    problems.push('lib/index.js is not an ES module')
  }
  if (/require\(/.test(host)) {
    problems.push('lib/index.js contains a require call; the host half must stay ESM')
  }
  return problems
}

const args = new Set(process.argv.slice(2))

if (args.has('--watch')) {
  const contexts = await Promise.all([context(hostConfig), context(clientConfig)])
  await Promise.all(contexts.map((ctx) => ctx.watch()))
  await emitTypes()
  console.log('dsh-webhook: watching src/ for changes')
} else {
  await Promise.all([build(hostConfig), build(clientConfig)])
  await emitTypes()
  if (args.has('--check')) {
    const problems = await verifyArtifacts()
    if (problems.length > 0) {
      console.error('dsh-webhook: artifact check failed')
      for (const problem of problems) console.error(`  - ${problem}`)
      process.exitCode = 1
    } else {
      console.log('dsh-webhook: artifact check passed')
    }
  }
  console.log(`dsh-webhook ${manifest.version}: lib/index.js and lib/client.js written`)
}
