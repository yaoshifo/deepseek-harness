/**
 * build-info tests: the daemon's captured build identity (start time, loaded
 * lib mtimes, HEAD at start) and the drift lines computed against the live
 * disk/git state — the /status build row and the reload completion suffix
 * both render from here. The capture and probe collaborators are injected
 * white-box (setBuildInfoForTest / setBuildProbeForTest), matching the
 * package's ported-test convention.
 *
 * @module dsh-feishu-bridge/tests-engine-build-info
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  buildStatusLines,
  captureBuildInfo,
  setBuildInfoForTest,
  setBuildProbeForTest,
  type BuildInfo,
  type BuildProbe,
} from '../../src/engine/build-info.ts'
import { I18n } from '../../src/i18n/index.ts'

function info(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    startedAt: new Date('2026-09-12T16:03:33+08:00').getTime(),
    libMtime: new Date('2026-09-12T16:03:32+08:00').getTime(),
    entryMtime: new Date('2026-09-12T16:03:31+08:00').getTime(),
    headSha: '9c7b1d9eea1234567890abcdef1234567890abcd',
    ...overrides,
  }
}

/** Probe reporting exactly the captured state: no drift anywhere. */
function noDriftProbe(captured: BuildInfo): BuildProbe {
  return {
    statWatched: () => ({ lib: captured.libMtime, entry: captured.entryMtime }),
    gitHead: async () => captured.headSha,
    countBetween: async () => 0,
  }
}

describe('buildStatusLines', () => {
  const i18n = new I18n('en')

  beforeEach(() => {
    setBuildInfoForTest(undefined)
    setBuildProbeForTest(undefined)
  })

  it('renders the build summary line from the captured info', async () => {
    const captured = info()
    setBuildInfoForTest(captured)
    setBuildProbeForTest(noDriftProbe(captured))
    const lines = await buildStatusLines(i18n)
    expect(lines).toEqual(['Build: daemon started 9-12 16:03 · lib 9-12 16:03 · HEAD 9c7b1d9eea'])
  })

  it('flags a newer on-disk build with the /reload hint', async () => {
    const captured = info()
    const diskTime = new Date('2026-09-14T14:29:07+08:00').getTime()
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: diskTime, entry: captured.entryMtime }),
      gitHead: async () => captured.headSha,
      countBetween: async () => 0,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines[1]).toBe('⚠️ A newer build is on disk (9-14 14:29) but not loaded — run /reload to activate it')
  })

  it('ignores sub-second mtime jitter on the watched files', async () => {
    const captured = info()
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: (captured.libMtime ?? 0) + 500, entry: captured.entryMtime }),
      gitHead: async () => captured.headSha,
      countBetween: async () => 0,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines).toHaveLength(1)
  })

  it('flags HEAD moving past the captured sha with the commit count', async () => {
    const captured = info()
    const movedSha = '6b691c02ea1234567890abcdef1234567890abcd'
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: captured.libMtime, entry: captured.entryMtime }),
      gitHead: async () => movedSha,
      countBetween: async () => 2,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines[1]).toBe('⚠️ HEAD has moved to 6b691c02ea (+2 commits, not loaded by this daemon)')
  })

  it('drops the count from the HEAD line when rev-list is not computable', async () => {
    const captured = info()
    const movedSha = '6b691c02ea1234567890abcdef1234567890abcd'
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: captured.libMtime, entry: captured.entryMtime }),
      gitHead: async () => movedSha,
      countBetween: async () => undefined,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines[1]).toBe('⚠️ HEAD has moved to 6b691c02ea (+? commits, not loaded by this daemon)')
  })

  it('emits no HEAD line when the capture had no sha (non-git deployment)', async () => {
    const captured = info({ headSha: '' })
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: captured.libMtime, entry: captured.entryMtime }),
      gitHead: async () => 'somerefthatwontmatch',
      countBetween: async () => undefined,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('HEAD -')
  })

  it('emits no HEAD line when the live sha is unavailable', async () => {
    const captured = info()
    setBuildInfoForTest(captured)
    setBuildProbeForTest({
      statWatched: () => ({ lib: captured.libMtime, entry: captured.entryMtime }),
      gitHead: async () => '',
      countBetween: async () => undefined,
    })
    const lines = await buildStatusLines(i18n)
    expect(lines).toHaveLength(1)
  })

  it('renders no lines when nothing was captured (startup before capture)', async () => {
    const lines = await buildStatusLines(i18n)
    expect(lines).toEqual([])
  })

  it('captureBuildInfo populates the identity from the real module path and repo', async () => {
    await captureBuildInfo()
    try {
      const lines = await buildStatusLines(i18n)
      expect(lines).toHaveLength(1)
      // Running under vitest the module resolves into the repo, so the sha is
      // real: assert it against git itself instead of a fixture value.
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const head = (await promisify(execFile)('git', ['rev-parse', 'HEAD'],
        { cwd: fileURLToPath(new URL('.', import.meta.url)) })).stdout.trim()
      expect(lines[0]).toContain(`HEAD ${head.slice(0, 10)}`)
    } finally {
      setBuildInfoForTest(undefined)
    }
  })
})
