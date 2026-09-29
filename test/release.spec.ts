/**
 * Release integrity tests.
 *
 * Two things drift silently in a published plugin: the version it reports and
 * the defaults its published type declarations promise. Both are checked here
 * against the single source of truth, so a release that forgets one fails the
 * build rather than shipping a wrong answer.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { SETTINGS_NAMESPACE, VERSION } from '../src/version.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Read one file from the repository root. */
function read(relative: string): Promise<string> {
  return readFile(`${root}${relative}`, 'utf8')
}

describe('version', () => {
  it('matches the published package version', async () => {
    const manifest = JSON.parse(await read('package.json')) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })

  it('matches the changelog\u2019s newest entry', async () => {
    const changelog = await read('CHANGELOG.md')
    expect(changelog).toContain(`## ${VERSION}`)
  })
})

describe('settings namespace', () => {
  it('is the key both halves register under', async () => {
    const client = await read('src/client/index.ts')
    expect(SETTINGS_NAMESPACE).toBe('dsh-webhook')
    expect(client).toContain("key: NS")
    expect(client).toContain("namespace: NS")
  })
})

describe('published defaults', () => {
  it('documents the same values the code applies', async () => {
    const declarations = await read('types/public-host.d.ts')
    const documented: [string, string | number][] = [
      ['host', DEFAULT_CONFIG.host],
      ['port', DEFAULT_CONFIG.port],
      ['maxBodyBytes', DEFAULT_CONFIG.maxBodyBytes],
      ['requestTimeoutMs', DEFAULT_CONFIG.requestTimeoutMs],
      ['replyTimeoutMs', DEFAULT_CONFIG.replyTimeoutMs],
      ['callbackAttempts', DEFAULT_CONFIG.callbackAttempts],
      ['callbackBackoffMs', DEFAULT_CONFIG.callbackBackoffMs],
      ['callbackTimeoutMs', DEFAULT_CONFIG.callbackTimeoutMs],
      ['maxPromptChars', DEFAULT_CONFIG.maxPromptChars],
      ['deliveryLogSize', DEFAULT_CONFIG.deliveryLogSize],
    ]
    for (const [field, value] of documented) {
      expect(declarations).toContain(`Defaults to \`${value}\``)
      expect(declarations).toContain(field)
    }
  })
})

describe('bundle manifest', () => {
  it('declares the patch layer the profile composes', async () => {
    const manifest = JSON.parse(await read('package.json')) as {
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
      exports?: Record<string, unknown>
      files?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports).toHaveProperty('./client')
    // A client half without both halves in `files` would publish a package whose
    // browser bundle 404s on the harness's own /plugins route.
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.files?.some((entry) => entry.startsWith('lib/'))).toBe(true)
  })

  it('mounts exactly one loader row, named after the package', async () => {
    const patch = await read('cordis.patch.yml')
    expect(patch).toContain('id: dsh-webhook')
    expect(patch).toContain("name: 'dsh-webhook'")
  })
})
