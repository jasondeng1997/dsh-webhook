/**
 * Guards for the runnable examples.
 *
 * `examples/*.mjs` load the built artifact, which makes them the only place a
 * packaging mistake becomes visible — and, because no unit test imports them,
 * the easiest thing in the repository to leave broken. `examples/smoke.mjs`
 * covers the runtime half by driving every scenario; this file covers the other
 * half: the example route, the paste-ready profile file, and the trigger all
 * describe *one* route, and the docs promise exactly that. If they drift, the
 * claim "this is the same configuration" quietly becomes false, and the person
 * who finds out is the one pasting it into their profile.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one file from the repository root. */
function read(relative: string): Promise<string> {
  return readFile(`${root}${relative}`, 'utf8')
}

/** Everything the GitHub PR review example is made of, read once per test. */
async function exampleSources() {
  const [pasteReady, bridge, trigger, smoke, chinese, english] = await Promise.all([
    read('examples/github-pr-review.patch.yml'),
    read('examples/local-bridge.mjs'),
    read('examples/trigger.mjs'),
    read('examples/smoke.mjs'),
    read('examples/README.md'),
    read('examples/README.en.md'),
  ])
  return { pasteReady, bridge, trigger, smoke, chinese, english }
}

describe('the example route', () => {
  it('is one route, described identically by the file and the local bridge', async () => {
    const { pasteReady, bridge } = await exampleSources()

    // The paste-ready profile file.
    expect(pasteReady).toContain('path: /hooks/github/pr')
    expect(pasteReady).toContain('source: github')
    expect(pasteReady).toContain('secretRef: GITHUB_WEBHOOK_SECRET')
    expect(pasteReady).toContain('events: [pull_request]')
    expect(pasteReady).toContain('session: auto')
    expect(pasteReady).toContain('id: pr-review')

    // The same values as the defaults the local bridge mounts.
    expect(bridge).toContain("String(argv.route ?? '/hooks/github/pr')")
    expect(bridge).toContain("String(argv.source ?? 'github')")
    expect(bridge).toContain("const secretRef = 'GITHUB_WEBHOOK_SECRET'")
    expect(bridge).toContain("['pull_request']")
    expect(bridge).toContain("session: 'auto'")
    expect(bridge).toContain("id: 'pr-review'")
  })

  it('sends the answer to the port the trigger listens on', async () => {
    const { pasteReady, bridge, trigger } = await exampleSources()

    // Three files, one port: the route posts here, the bridge defaults here, and
    // the trigger listens here. A mismatch in any of the three produces a
    // "waiting for a callback" that never arrives, which is a miserable thing to
    // debug from the outside.
    expect(pasteReady).toContain('callbackUrl: http://127.0.0.1:9099/dsh/reply')
    expect(bridge).toContain('argv.callbackPort ?? 9099')
    expect(trigger).toContain('argv.listen ?? 9099')
  })

  it('documents an opt-out that actually exists', async () => {
    const { pasteReady } = await exampleSources()
    // The example must not teach the unsigned-endpoint mistake it warns about.
    expect(pasteReady).not.toContain('allowUnsigned')
  })
})

describe('the example scripts', () => {
  it('cover every scenario the trigger implements', async () => {
    const { trigger, smoke } = await exampleSources()
    const implemented = [...trigger.matchAll(/^  '?([a-z-]+)'?: \{ label:/gm)].map((hit) => hit[1])
    // `/^  ok: { label:/` and `/^  'wrong-signature': { label:/` both land here.
    expect(implemented.length).toBeGreaterThanOrEqual(8)

    const smokeList = /const SCENARIOS = \[([\s\S]*?)\]/.exec(smoke)?.[1] ?? ''
    for (const scenario of implemented) {
      expect(smokeList).toContain(`'${scenario}'`)
    }
  })

  it('load the built artifact rather than the sources', async () => {
    const { bridge, smoke } = await exampleSources()
    // Importing `src/` would make these examples pass while the published bundle
    // is broken, which is the one failure mode they exist to catch.
    for (const source of [bridge, smoke]) {
      const loadsBundle = /['"]lib['"],\s*['"]index\.js['"]/.test(source)
        || source.includes("'lib/index.js'")
      expect(loadsBundle).toBe(true)
      expect(source).not.toContain('src/index.ts')
    }
  })
})

describe('the example directory', () => {
  it('is documented in both languages, with the same file list', async () => {
    const { chinese, english } = await exampleSources()
    for (const name of ['demo.mjs', 'local-bridge.mjs', 'trigger.mjs', 'github-pr-review.patch.yml']) {
      expect(chinese).toContain(name)
      expect(english).toContain(name)
    }
    expect(chinese).toContain('[English](README.en.md)')
    expect(english).toContain('[中文](README.md)')
  })

  it('ships every example, and every example has a script', async () => {
    const manifest = JSON.parse(await read('package.json')) as {
      files?: string[]
      scripts?: Record<string, string>
    }
    expect(manifest.files).toContain('examples/**/*.mjs')
    expect(manifest.files).toContain('examples/**/*.yml')
    expect(manifest.files).toContain('examples/**/*.md')

    const { smoke } = await exampleSources()
    expect(smoke).not.toBe('')
    for (const name of ['demo', 'local-bridge', 'trigger', 'smoke']) {
      expect(Object.values(manifest.scripts ?? {}).some((command) => command.includes(`examples/${name}.mjs`)))
        .toBe(true)
    }
  })
})
