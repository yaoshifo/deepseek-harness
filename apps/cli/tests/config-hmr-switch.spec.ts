/**
 * DSH_CONFIG_HMR_DISABLED at the profile launcher: REAL `runProfile` boots of
 * a minimal empty-bundle profile. The switch must skip BOTH the fallback
 * watch-only HMR mount and the user patch-layer watchers, so cordis.patch.yml
 * edits apply only at the next boot; with the switch unset, the same harness
 * observes a live apply (the control that gives the inert windows meaning).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '../src/profile-boot.ts'

const PROFILE = 'switch-spec'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-config-hmr-'))

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Fixed window a live apply would land well inside (the control test pins the timing). */
const inertWindow = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 500))

/** Rows the profile's own patch layer inserts; extra rows vary per case. */
function writeProfile(home: string, extraRows: readonly string[] = []): void {
  const dir = join(home, 'profiles', PROFILE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'switch-spec-profile',
    private: true,
    type: 'module',
    dsh: { profile: { bundles: [] } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'marker.mjs'), 'export function apply() {}\n')
  writePatch(home, ['marker', ...extraRows])
}

function writePatch(home: string, rowIds: readonly string[], markerValue = 'base'): void {
  const rows = {
    marker: [
      '- id: marker',
      '  name: ./marker.mjs',
      '  config:',
      `    value: ${markerValue}`,
    ],
    // The own-hmr case needs the timer row too: HMR injects it, and no
    // bundle layer is around to mount one.
    timer: [
      '- id: timer',
      "  name: '@deepseek-ai/cordis-plugin-timer'",
    ],
    hmr: [
      '- id: hmr',
      "  name: '@deepseek-ai/cordis-plugin-hmr'",
      '  config:',
      '    root: []',
    ],
  } as Record<string, readonly string[]>
  const body = ['- insert:', ...rowIds.flatMap(id => rows[id]?.map(line => `    ${line}`) ?? [])]
  writeFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), `${body.join('\n')}\n`)
}

/**
 * Replace the profile's patch layer with one whose marker row carries the new
 * value. A refresh re-applies every layer onto the re-read empty root, so a
 * generation must be self-contained — a bare id-targeted override would warn
 * about a missing target and change nothing.
 */
function editMarkerValue(home: string, value: string): void {
  writePatch(home, ['marker'], value)
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

function markerValue(ctx: Context): string | undefined {
  return (entryConfig(ctx, 'marker') as { value?: string } | undefined)?.value
}

async function bootProfile(home: string): Promise<Context> {
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh', home),
    profile: PROFILE,
    patchFiles: [],
    args: [],
  })
  return ctx
}

describe('DSH_CONFIG_HMR_DISABLED', () => {
  let home: string

  beforeEach(() => {
    home = tmp()
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    delete process.env.DSH_CONFIG_HMR_DISABLED
  })

  it('keeps the user patch layer live when the switch is unset', { timeout: 30_000 }, async () => {
    writeProfile(home)
    const ctx = await bootProfile(home)
    try {
      // An empty-bundle composition mounts no HMR service of its own: the
      // launcher's watch-only fallback is what carries config HMR here.
      expect(ctx.get('hmr')).toBeDefined()
      editMarkerValue(home, 'live')
      await eventually(() => markerValue(ctx) === 'live', 'user patch edit was not applied live')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips the fallback HMR mount and leaves patch edits inert (any non-empty value)', { timeout: 30_000 }, async () => {
    writeProfile(home)
    process.env.DSH_CONFIG_HMR_DISABLED = '0' // falsy-looking values count
    const ctx = await bootProfile(home)
    try {
      expect(markerValue(ctx)).toBe('base')
      expect(ctx.get('hmr')).toBeUndefined()
      editMarkerValue(home, 'edited')
      await inertWindow()
      expect(markerValue(ctx)).toBe('base')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still skips the watchers when the composition mounts its own hmr service', { timeout: 30_000 }, async () => {
    process.env.DSH_CONFIG_HMR_DISABLED = '1'
    writeProfile(home, ['timer', 'hmr'])
    const ctx = await bootProfile(home)
    try {
      expect(markerValue(ctx)).toBe('base')
      expect(ctx.get('hmr')).toBeDefined()
      editMarkerValue(home, 'edited')
      await inertWindow()
      expect(markerValue(ctx)).toBe('base')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
