/**
 * /reload completion-notice tests: with a pending marker the restarted
 * daemon replies through the recorded (engine, platform) pair, and when the
 * mounted mcp-client tool surface is large the completion notice is followed
 * by a reminder naming the per-server breakdown.
 *
 * @module dsh-feishu-bridge/tests-reload-completion
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { I18n } from '../src/i18n/index.ts'
import { completePendingReload } from '../src/engine/reload-commands.ts'
import type { Platform } from '../src/core/types.ts'
import type { Engine } from '../src/engine/engine.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.LOG_DIR
})

/** Fresh LOG_DIR carrying a pending marker for (project-a, feishu, c1). */
function pendingMarker(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fb-reload-completion-'))
  dirs.push(dir)
  process.env.LOG_DIR = dir
  const marker = join(dir, 'feishu-bridge-reload-pending.json')
  writeFileSync(marker, JSON.stringify({
    pid: 1,
    engine: 'project-a',
    platform: 'feishu',
    replyCtx: { chat: 'c1' },
    at: Date.now(),
  }))
  return marker
}

/** Minimal platform recording every send into `sent`. */
function fakePlatform(sent: string[]): Platform {
  return {
    name: () => 'feishu',
    start: async () => {},
    reply: async (_ctx: unknown, content: string) => { sent.push(content) },
    send: async (_ctx: unknown, content: string) => { sent.push(content) },
    stop: async () => {},
  }
}

/** Minimal engine naming the platform and carrying a zh i18n. */
function fakeEngine(platform: Platform): Engine {
  return { name: 'project-a', platforms: [platform], i18n: new I18n('zh') } as unknown as Engine
}

/** Registry surface with `devxCount` devx tools plus the live trio (zread ×3, web ×2). */
function devxHeavySurface(devxCount: number): { schemas(): Array<{ name: string }> } {
  const names = Array.from({ length: devxCount }, (_, i) => `mcp__devx__tool_${i}`)
  names.push(
    'mcp__zread__search_doc', 'mcp__zread__read_file', 'mcp__zread__get_repo_structure',
    'mcp__web-reader__webReader', 'mcp__web-search-prime__web_search_prime',
  )
  return { schemas: () => names.map(name => ({ name })) }
}

describe('completePendingReload', () => {
  it('follows the completion notice with an MCP surface reminder when the mcp tool count is large', async () => {
    const sent: string[] = []
    const engine = fakeEngine(fakePlatform(sent))
    const marker = pendingMarker()
    await completePendingReload([engine], devxHeavySurface(71))
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('Reload 完成')
    expect(sent[1]).toContain('76')
    expect(sent[1]).toContain('devx 71')
    expect(existsSync(marker)).toBe(false)
  })

  it('sends no reminder when the surface is within the line (the live daemon carries 5 tools)', async () => {
    const sent: string[] = []
    const engine = fakeEngine(fakePlatform(sent))
    pendingMarker()
    await completePendingReload([engine], devxHeavySurface(0))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Reload 完成')
  })

  it('fires exactly above the line: 20 tools stay silent, 21 remind', async () => {
    const silent: string[] = []
    pendingMarker()
    await completePendingReload([fakeEngine(fakePlatform(silent))], devxHeavySurface(15))
    expect(silent).toHaveLength(1)

    const reminded: string[] = []
    pendingMarker()
    await completePendingReload([fakeEngine(fakePlatform(reminded))], devxHeavySurface(16))
    expect(reminded).toHaveLength(2)
    expect(reminded[1]).toContain('21')
  })

  it('keeps the completion notice and the marker cleanup when the reminder send fails', async () => {
    const sent: string[] = []
    const platform: Platform = {
      ...fakePlatform(sent),
      send: async (_ctx: unknown, content: string) => {
        if (content.includes('MCP')) throw new Error('send failed')
        sent.push(content)
      },
    }
    const marker = pendingMarker()
    await completePendingReload([fakeEngine(platform)], devxHeavySurface(71))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Reload 完成')
    expect(existsSync(marker)).toBe(false)
  })

  it('sends nothing on a plain start without a marker', async () => {
    const sent: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'fb-reload-completion-'))
    dirs.push(dir)
    process.env.LOG_DIR = dir
    await completePendingReload([fakeEngine(fakePlatform(sent))], devxHeavySurface(71))
    expect(sent).toHaveLength(0)
  })
})
