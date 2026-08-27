/**
 * Group-name generation tests ported 1:1 from cc-connect
 * core/engine_groupname_test.go. Assertion semantics match the Go stubs
 * exactly; async rename callbacks are awaited with a waitFor poll.
 *
 * @module dsh-feishu-bridge/tests-engine-groupname
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Engine } from '../../src/engine/engine.js'
import { Session } from '../../src/engine/session.js'
import { ctxBridgeDispatch } from '../../src/bridge-service.js'
import { registerChatroomPolicyListeners } from '../../src/engine/chatroom-policy.js'
import { cmdNew } from '../../src/engine/commands.js'
import { lucideIconSVG } from '../../src/lucide/icon.js'
import {
  chatroomHubGroupName,
  classifyIcon,
  fallbackGroupIcon,
  groupIconRecentMax,
  iconsPerCategory,
  loadIconCategories,
  parseGroupIcon,
  sampleAcrossCategories,
  sanitizeGroupName,
  shortenGroupPathTokens,
  truncateGroupName,
  iconCategoryMisc,
} from '../../src/engine/groupname.js'
import type { Agent, Message } from '../../src/core/types.js'
import {
  createGroupNameAgent,
  createGroupNameSwitcherAgent,
  createStubPlatform,
  createStubTitleRenamePlatform,
  newBlockingSendSession,
  newStubMessage,
  type GroupNameAgentState,
  type StubTitleRenamePlatform,
} from '../stubs/engine-stubs.js'
import { ev } from '../stubs/engine-stubs.js'

/** Poll cond until it holds or the deadline passes (Go waitFor). */
async function waitFor(cond: () => boolean, msg: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error(msg)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

function newGroupNameEngine(agent: Agent): { e: Engine; p: StubTitleRenamePlatform } {
  const p = createStubTitleRenamePlatform('test')
  const e = new Engine('test', agent, [p], '', 'en')
  return { e, p }
}

describe('generateGroupName', () => {
  it('cleans the LLM output', async () => {
    // leading blank line, surrounding whitespace + quotes + backticks,
    // trailing second line
    const a = createGroupNameAgent({ resp: '\n  `"登录页 500 错误修复"`  \nsecond line ignored' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const [name] = await e.generateGroupName('帮我修登录页 500')
    expect(name).toBe('登录页 500 错误修复')
  })

  it('truncates over 60 runes', async () => {
    const a = createGroupNameAgent({ resp: '啊'.repeat(80) })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const [name] = await e.generateGroupName('x')
    expect(Array.from(name)).toHaveLength(60)
    expect(name.endsWith('...')).toBe(true)
  })

  it('forwards the custom prompt and seed', async () => {
    const a = createGroupNameAgent({ resp: '名' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, 'MY CUSTOM PROMPT')

    await expect(e.generateGroupName('用户的首条消息 XYZ')).resolves.toBeDefined()
    expect(a.state.gotPrompt).toContain('MY CUSTOM PROMPT')
    expect(a.state.gotPrompt).toContain('用户的首条消息 XYZ')
  })

  it('uses the default prompt when empty, still embedding the seed', async () => {
    const a = createGroupNameAgent({ resp: '名' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '') // empty → default prompt

    await expect(e.generateGroupName('hello world')).resolves.toBeDefined()
    expect(a.state.gotPrompt).toContain('hello world')
  })

  it('propagates the query error', async () => {
    const a = createGroupNameAgent({ err: new Error('boom') })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    await expect(e.generateGroupName('x')).rejects.toThrow('boom')
  })

  it('falls back to the active provider when none configured', async () => {
    const a = createGroupNameSwitcherAgent('active-prov', { resp: '名' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, '', 1000, '') // empty provider → fallback

    await expect(e.generateGroupName('x')).resolves.toBeDefined()
    expect(a.state.gotProvider).toBe('active-prov')
  })

  it('parses the icon line', async () => {
    const a = createGroupNameAgent({ resp: '数据库迁移\ndatabase' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const [name, icon] = await e.generateGroupName('把 mysql 迁到 pg')
    expect(name).toBe('数据库迁移')
    expect(icon).toBe('database')
  })

  it('falls back to a deterministic icon when the LLM omits it', async () => {
    const a = createGroupNameAgent({ resp: '群头像排查' })
    const { e } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const [name, icon] = await e.generateGroupName('排查头像不更新的问题')
    expect(name).toBe('群头像排查')
    expect(icon).not.toBe('')
    expect(icon).toBe(fallbackGroupIcon('群头像排查'))
  })
})

describe('handleGroupNameGenerate (fork → RenameGroup wiring)', () => {
  it('calls the group renamer', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')

    await waitFor(() => p.renamedKeys.length === 1, 'RenameGroup was not called')

    expect(p.renamedKeys).toEqual(['test:chat-1'])
    expect(p.renamedNames).toEqual(['调试 500 错误'])
  })

  it('falls back to the first message on error (no avatar)', async () => {
    const a = createGroupNameAgent({ err: new Error('boom') })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(true)

    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')

    // LLM failure → fall back to naming via the first message (the group was
    // created under a neutral placeholder that must not stay).
    await waitFor(() => p.renamedNames.length === 1, 'fallback RenameGroup was not called')

    expect(p.renamedNames).toEqual(['帮我修 500 错误'])
    // The fallback is a degraded path: no avatar.
    expect(p.avatarIcons).toEqual([])
  })

  it('renames with an independent signal (expired-ctx regression)', async () => {
    // Regression: the LLM query exhausts exactly the timeout before
    // returning a good name — the rename must use an independent deadline,
    // not the expired query's, otherwise the rename is falsely judged failed
    // (the Put request actually reached the platform) and the first-message
    // fallback clobbers the fresh LLM name.
    const a = createGroupNameAgent({ resp: '续读最重要之事\nbook', blockUntilSignal: true })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 50, '')

    e.handleGroupNameGenerate(p, 'test:chat-1', '首条消息', 'test:chat-1')

    await waitFor(() => p.renamedNames.length === 1, 'RenameGroup was not called', 3000)

    expect(p.renamedNames).toEqual(['续读最重要之事'])
  })

  it('falls back to the first message on an empty name', async () => {
    const a = createGroupNameAgent({ resp: '' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')

    await waitFor(() => p.renamedNames.length === 1, 'fallback RenameGroup was not called')

    expect(p.renamedNames).toEqual(['帮我修 500 错误'])
  })

  it('skips when manually renamed inside the window', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    // The user manually /rename'd inside the LLM query window; the async
    // rename must skip and not clobber the manual name.
    e.markPendingRename('test:chat-1')
    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')

    await waitFor(() => !e.hasPendingRename('test:chat-1'), 'rename window did not finish')
    await sleep(100)
    expect(p.renamedKeys).toEqual([])
    expect(p.renamedNames).toEqual([])
  })

  it('consumes the pending-rename mark after the window', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    // Round 1: mark, then handle — the async rename is skipped.
    e.markPendingRename('test:chat-1')
    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')
    // The mark is cleared once the callback finishes — use its disappearance
    // as the "callback finished" signal.
    await waitFor(() => !e.hasPendingRename('test:chat-1'), 'pendingRename should be cleared after consume')
    expect(p.renamedKeys).toEqual([])

    // Round 2: no mark (a /new first message) — handle renames normally.
    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')
    await waitFor(() => p.renamedKeys.length === 1, 'second round should rename normally')
    expect(p.renamedKeys).toEqual(['test:chat-1'])
    expect(p.renamedNames[0]).toBe('调试 500 错误')
  })

  it('clears an orphan pendingRename on /new', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    // Simulate: the LLM rename callback already ended, then the user
    // /rename'd again, leaving an orphan mark.
    e.markPendingRename('test:chat-1')
    expect(e.hasPendingRename('test:chat-1')).toBe(true)

    // /new resets the session — the orphan mark must be cleared.
    const m = { ...newStubMessage(), sessionKey: 'test:chat-1', replyCtx: 'test-rctx', isSpawnedGroup: true, platform: 'test', userID: 'u1' } satisfies Message
    await cmdNew(e, p, m, [])
    expect(e.hasPendingRename('test:chat-1')).toBe(false)

    // The new first message's LLM rename proceeds normally.
    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')
    await waitFor(() => p.renamedKeys.length === 1, 'first message after /new should rename normally')
    expect(p.renamedKeys).toEqual(['test:chat-1'])
    expect(p.renamedNames[0]).toBe('调试 500 错误')
  })

  it('skips non-renamer platforms without panicking', async () => {
    // A plain platform does NOT implement GroupRenamer.
    const p = createStubPlatform('test')
    const a = createGroupNameAgent({ resp: '名' })
    const e = new Engine('test', a, [p], '', 'en')
    e.setGroupNameConfig(true, 'p', 1000, '')

    // Must not throw.
    e.handleGroupNameGenerate(p, 'test:chat-1', 'x', 'test:chat-1')
    await sleep(100)
  })
})

describe('handleGroupNameGenerate → SetGroupIconAvatar wiring (#52)', () => {
  it('sets the icon avatar after renaming', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误\nbug' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(true)

    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')

    await waitFor(() => p.avatarIcons.length === 1, 'SetGroupIconAvatar was not called')

    expect(p.avatarIcons).toEqual(['bug'])
    expect(p.avatarKeys).toEqual(['test:chat-1'])
    expect(p.avatarGroups).toEqual(['调试 500 错误'])
  })

  it('skips the setter when avatars are disabled', async () => {
    const a = createGroupNameAgent({ resp: '调试 500 错误\nbug' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(false) // explicitly disabled

    e.handleGroupNameGenerate(p, 'test:chat-1', '帮我修 500 错误', 'test:chat-1')
    await sleep(200)

    expect(p.avatarIcons).toEqual([])
  })

  it('falls back when the LLM returns a dash icon', async () => {
    // LLM returns "-" (explicitly no icon) or omits the second line → fall
    // back to a deterministic icon, still renaming + setting the avatar.
    const a = createGroupNameAgent({ resp: '打招呼\n-' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(true)

    e.handleGroupNameGenerate(p, 'test:chat-1', 'hello', 'test:chat-1')

    await waitFor(() => p.renamedKeys.length === 1, 'RenameGroup was not called')

    const want = fallbackGroupIcon('打招呼')
    await waitFor(() => p.avatarIcons.length === 1 && p.avatarIcons[0] === want, `SetGroupIconAvatar fallback icon ${want} not set`)
  })

  it('skips non-avatar-setter platforms silently', async () => {
    // A plain platform does NOT implement GroupIconAvatarSetter.
    const p = createStubPlatform('test')
    const a = createGroupNameAgent({ resp: '名\nbug' })
    const e = new Engine('test', a, [p], '', 'en')
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(true)

    // Must not throw.
    e.handleGroupNameGenerate(p, 'test:chat-1', 'x', 'test:chat-1')
    await sleep(200)
  })
})

describe('truncateGroupName', () => {
  it.each([
    ['帮我看下登录报错', '帮我看下登录报错'],
    ['第一行\n第二行', '第一行'],
    ['  带空白  ', '带空白'],
    ['', ''],
    ['字'.repeat(70), `${'字'.repeat(57)}...`],
    // Absolute path tokens collapse to basename, no 60-rune path dump (#49)
    ['读账本目录 /Users/hm/workspace/chatroom/ledgers/f9568b8f572912', '读账本目录 f9568b8f572912'],
    ['读取 /a/b/c/SYNTHESIS.md 并渲染', '读取 SYNTHESIS.md 并渲染'],
    // Relative paths / dates / single-segment paths untouched
    ['CI/CD流水线', 'CI/CD流水线'],
    ['2026/08/13', '2026/08/13'],
  ])('%j → %j', (input, want) => {
    expect(truncateGroupName(input)).toBe(want)
  })
})

describe('shortenGroupPathTokens', () => {
  it.each([
    // Absolute path token → basename
    ['/a/b/c', 'c'],
    ['读账本目录 /Users/hm/workspace/chatroom/ledgers/f9568b8f572912', '读账本目录 f9568b8f572912'],
    ['读取 /a/b/c/SYNTHESIS.md 并渲染', '读取 SYNTHESIS.md 并渲染'],
    // Home-dir path → basename
    ['~/repo/path/x', 'x'],
    // basename >16 runes truncates to 13 + …
    ['/a/b/' + 'x'.repeat(20), `${'x'.repeat(13)}...`],
    // Relative paths / dates / single-segment paths / URLs untouched
    ['CI/CD流水线', 'CI/CD流水线'],
    ['2026/08/13', '2026/08/13'],
    ['/file', '/file'],
    ['生产环境500错误排查', '生产环境500错误排查'],
    ['监控 https://example.com/a/b', '监控 https://example.com/a/b'],
  ])('%j → %j', (input, want) => {
    expect(shortenGroupPathTokens(input)).toBe(want)
  })
})

describe('sanitizeGroupName', () => {
  it.each([
    // First non-empty line + quote/backtick stripping (existing behavior)
    ['"登录页 500 错误修复"', '登录页 500 错误修复'],
    ['\n  `"生产环境500错误排查"`  \nsecond ignored', '生产环境500错误排查'],
    // Path abbreviation without triggering truncation
    ['读账本目录 /Users/hm/workspace/chatroom/ledgers/f9568b8f572912', '读账本目录 f9568b8f572912'],
    // Overlong still truncates at 60 runes (no paths involved)
    ['字'.repeat(70), `${'字'.repeat(57)}...`],
  ])('%j → %j', (input, want) => {
    expect(sanitizeGroupName(input)).toBe(want)
  })
})

describe('parseGroupIcon', () => {
  it.each([
    ['two lines', '登录页修复\nbug', 'bug'],
    ['extra blank lines', '登录页修复\n\nbug\n', 'bug'],
    ['dash means none', '打招呼\n-', ''],
    ['missing second line', '只有群名', ''],
    ['strips quotes', '名\n`bug`', 'bug'],
    ['lowercased', '名\nBUG', 'bug'],
    ['leading blank then two lines', '\n  `名`  \nDatabase', 'database'],
  ])('%s', (_name, raw, want) => {
    expect(parseGroupIcon(raw)).toBe(want)
  })
})

describe('fallbackGroupIcon', () => {
  it('is deterministic, non-empty, distributed, and sprite-valid', () => {
    // Deterministic: same name → same icon.
    expect(fallbackGroupIcon('数据库迁移')).toBe(fallbackGroupIcon('数据库迁移'))
    expect(fallbackGroupIcon('数据库迁移')).not.toBe('')
    // Different names should spread across several icons.
    const seen = new Set<string>()
    for (const n of ['auth', 'deploy', 'bug fix', 'refactor', '调研', '测试', '文档', '配置']) {
      seen.add(fallbackGroupIcon(n))
    }
    expect(seen.size).toBeGreaterThanOrEqual(3)
    // Pool validity: returned icons must exist in the Lucide sprite.
    for (const n of ['数据库迁移', 'deploy api', 'bug', 'hello world']) {
      expect(lucideIconSVG(fallbackGroupIcon(n), '#ffffff')).toBeDefined()
    }
  })
})

describe('classifyIcon', () => {
  it.each([
    ['bug', 'dev'],
    ['code-xml', 'dev'],
    ['git-branch', 'dev'],
    ['chart-line', 'data'],
    ['bar-chart-3', 'data'],
    ['message-square', 'comm'],
    ['mail', 'comm'],
    ['lock', 'security'],
    ['shield-check', 'security'],
    ['settings-2', 'settings'],
    ['circle-check', 'status'],
    ['layout-dashboard', 'layout'],
    ['dollar-sign', 'finance'],
    // No match → misc
    ['circle', 'misc'],
    ['sparkles', 'misc'],
    ['xyz-unknown', 'misc'],
  ])('%j → %j', (id, want) => {
    expect(classifyIcon(id)).toBe(want)
  })
})

describe('sampleAcrossCategories', () => {
  it('samples without replacement across categories', () => {
    const cats = loadIconCategories()
    expect(cats.size).toBeGreaterThan(1)
    let nonMisc = 0
    const validByID = new Map<string, string>()
    for (const [cat, ids] of cats) {
      if (cat !== iconCategoryMisc) nonMisc++
      for (const id of ids) validByID.set(id, cat)
    }
    expect(nonMisc).toBeGreaterThan(0)

    const pool = sampleAcrossCategories(iconsPerCategory)
    expect(pool.length).toBeGreaterThan(0)
    expect(pool.length).toBeLessThanOrEqual(nonMisc * iconsPerCategory)

    // No duplicates; every icon is in the sprite and not misc.
    const seen = new Set<string>()
    for (const name of pool) {
      expect(seen.has(name)).toBe(false)
      seen.add(name)
      expect(validByID.has(name)).toBe(true)
      expect(validByID.get(name)).not.toBe(iconCategoryMisc)
    }

    // Boundary: perCat<=0 yields empty.
    expect(sampleAcrossCategories(0)).toEqual([])
    // Randomness: two consecutive samples should not be identical.
    expect(sampleAcrossCategories(iconsPerCategory)).not.toEqual(sampleAcrossCategories(iconsPerCategory))
  })
})

describe('recentGroupIcons', () => {
  it('records and evicts ring-buffer style', () => {
    const { e } = newGroupNameEngine(createGroupNameAgent({ resp: '名' }))
    // Empty ignored
    e.recordGroupIcon('')
    expect(e.recentGroupIcons()).toEqual([])
    for (let i = 0; i < groupIconRecentMax + 3; i++) {
      e.recordGroupIcon(`icon-${i}`)
    }
    const got = e.recentGroupIcons()
    expect(got).toHaveLength(groupIconRecentMax)
    // Ring: the oldest 3 rolled out, keeping icon-3 onward.
    expect(got[0]).toBe('icon-3')
    // Duplicate records do not grow the buffer
    const before = got.length
    e.recordGroupIcon('icon-3')
    expect(e.recentGroupIcons()).toHaveLength(before)
  })
})

describe('buildGroupNamePrompt', () => {
  it('fills the icon pool and omits the recent rule when empty', () => {
    const { e } = newGroupNameEngine(createGroupNameAgent({ resp: '名' }))
    const out = e.buildGroupNamePrompt('我的种子消息')
    expect(out).not.toContain('{{icon_pool}}')
    expect(out).not.toContain('{{recent_icons_rule}}')
    expect(out).toContain('可选图标')
    expect(out).toContain('我的种子消息')
    // No recent icons → the recent rule is omitted
    expect(out).not.toContain('避免重复')
  })

  it('includes the recent rule once icons are recorded', () => {
    const { e } = newGroupNameEngine(createGroupNameAgent({ resp: '名' }))
    e.recordGroupIcon('siren')
    e.recordGroupIcon('microscope')
    const out = e.buildGroupNamePrompt('x')
    expect(out).toContain('避免重复')
    expect(out).toContain('siren')
    expect(out).toContain('microscope')
  })

  it('keeps a custom prompt without placeholders verbatim', () => {
    const { e } = newGroupNameEngine(createGroupNameAgent({ resp: '名' }))
    e.setGroupNameConfig(true, 'p', 1000, 'MY CUSTOM PROMPT')
    const out = e.buildGroupNamePrompt('用户的首条消息 XYZ')
    expect(out).toContain('MY CUSTOM PROMPT')
    expect(out).toContain('用户的首条消息 XYZ')
    // A custom prompt without placeholders stays verbatim: no random pool
    // injection.
    expect(out).not.toContain('{{icon_pool}}')
  })
})

describe('renameHubToTopic', () => {
  it('LLM name overwrites the topic fallback', async () => {
    const a = createGroupNameAgent({ resp: '资产配置讨论' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const topic = '我想做下资产配置 地理分散投资 本来想同时投美股和A股'
    e.renameHubToTopic(p, 'test:hub-1', 'group', topic, [])

    // The LLM overwrite is async and always lands after the topic fallback.
    const wantLLM = '资产配置讨论'
    await waitFor(
      () => p.renamedNames.includes(wantLLM),
      'LLM-generated name did not overwrite topic fallback',
      3000,
    )

    expect(a.state.callCount).toBe(1)
    expect(a.state.gotPrompt).toContain(topic)

    const wantFallback = chatroomHubGroupName(topic)
    expect(p.renamedNames.includes(wantFallback)).toBe(true)
  })

  it('keeps only the topic fallback when disabled', async () => {
    const a = createGroupNameAgent({ resp: '不应被使用' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(false, '', 0, '')

    const topic = '某议题文本'
    e.renameHubToTopic(p, 'test:hub-1', 'group', topic, [])

    await waitFor(() => p.renamedNames.length === 1, 'topic fallback rename did not happen')

    expect(a.state.callCount).toBe(0)
    expect(p.renamedNames).toEqual([chatroomHubGroupName(topic)])
  })

  it('degrades to the fallback when the LLM fork fails', async () => {
    const a = createGroupNameAgent({ err: new Error('fork unavailable') })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')

    const topic = '某议题文本'
    e.renameHubToTopic(p, 'test:hub-1', 'group', topic, [])

    // Wait for the failing LLM query to run.
    await waitFor(() => a.state.callCount === 1, 'LightweightQuery was not invoked')

    expect(p.renamedNames).toEqual([chatroomHubGroupName(topic)])
  })

  it('stamps one family avatar across hub + children', async () => {
    const a = createGroupNameAgent({ resp: '资产配置\nchart-pie' })
    const { e, p } = newGroupNameEngine(a)
    e.setGroupNameConfig(true, 'p', 1000, '')
    e.setGroupNameAvatarEnabled(true)

    const topic = '资产配置 地理分散投资'
    const childKeys = ['test:role-1', 'test:role-2']
    e.renameHubToTopic(p, 'test:hub-1', 'group', topic, childKeys)

    await waitFor(() => p.familyCalls === 1, 'SetChatroomFamilyAvatar was not invoked', 3000)

    expect(p.familyHub).toBe('test:hub-1')
    expect(p.familyChildren).toEqual(['test:role-1', 'test:role-2'])
    expect(p.familyIcon).toBe('chart-pie')
    expect(p.familyName).toBe('资产配置')
  })
})

describe('rename-exemption policy (feishuBridge/rename-exemption)', () => {
  it('exempts chatroom roles, research assistants, and direct roles only', () => {
    const ctx = new Context()
    registerChatroomPolicyListeners(ctx)
    const exempt = (session: Session): boolean =>
      ctxBridgeDispatch(ctx).waterfall('feishuBridge/rename-exemption', { session }, () => false)

    const role = new Session()
    role.setChatroomHubKey('test:hub-1')
    expect(exempt(role)).toBe(true)

    const assistant = new Session()
    assistant.setResearchAssistant(true)
    expect(exempt(assistant)).toBe(true)

    const direct = new Session()
    direct.setChatroomDirectRole(true)
    expect(exempt(direct)).toBe(true)

    expect(exempt(new Session())).toBe(false)
    void Promise.allSettled([ctx.fiber.dispose()])
  })
})

describe('spawn rename skips chatroom sessions', () => {
  /**
   * Drive one spawned-group first message through
   * processInteractiveMessageWith to completion (Go runSpawnRenameFlow).
   */
  async function runSpawnRenameFlow(
    groupNameEnabled: boolean,
    decorate?: (s: Session) => void,
  ): Promise<{ a: Agent & { state: GroupNameAgentState }; p: StubTitleRenamePlatform }> {
    const p = createStubTitleRenamePlatform('test')
    const base = createGroupNameAgent({ resp: 'LLM 群名' })
    const sess = newBlockingSendSession('flow-turn')
    const flowAgent: Agent & { state: GroupNameAgentState } = { ...base, startSession: async () => sess }
    // The exemption rides the rename-exemption policy listener (the
    // production composition) — a bare engine has no chatroom listener.
    const policyCtx = new Context()
    registerChatroomPolicyListeners(policyCtx)
    const e = new Engine('test', flowAgent, [p], '', 'en', ctxBridgeDispatch(policyCtx))
    e.setGroupNameConfig(groupNameEnabled, 'p', 1000, '')

    const sessionKey = 'test:chat-1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    expect(session.tryLock()).toBe(true)
    if (decorate !== undefined) decorate(session)

    const done = e.processInteractiveMessageWith(p, {
      ...newStubMessage(),
      sessionKey,
      platform: 'test',
      userID: 'user1',
      content: '[主持] [并行收集] 本轮并行收集各角色独立判断',
      replyCtx: 'ctx',
      isSpawnedGroup: true,
    }, session)
    await sess.sendStarted
    sess.unblock()
    sess.channel.push(ev({ type: 'result', content: 'ok', done: true }))
    await done
    void Promise.allSettled([policyCtx.fiber.dispose()])
    return { a: flowAgent, p }
  }

  it.each([
    { name: 'chatroom role group, LLM enabled', enabled: true, decorate: (s: Session) => { s.setChatroomHubKey('test:hub-1') } },
    { name: 'research assistant group, LLM enabled', enabled: true, decorate: (s: Session) => { s.setResearchAssistant(true) } },
    { name: 'direct-role group, LLM enabled', enabled: true, decorate: (s: Session) => { s.setChatroomDirectRole(true) } },
    { name: 'chatroom role group, LLM disabled fallback path', enabled: false, decorate: (s: Session) => { s.setChatroomHubKey('test:hub-1') } },
  ])('$name stays unnamed', async ({ enabled, decorate }) => {
    const { a, p } = await runSpawnRenameFlow(enabled, decorate)
    // Wait out the (1s-timeout) query window so a late rename cannot slip
    // through after the assertion.
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      expect(a.state.callCount).toBe(0)
      expect(p.renamedNames).toEqual([])
      await sleep(50)
    }
  })

  it('plain spawned group still renames (control)', async () => {
    const { a, p } = await runSpawnRenameFlow(true)
    await waitFor(() => a.state.callCount > 0, 'control: expected LLM rename to fire for plain spawned group')
    await waitFor(() => p.renamedNames.length > 0, 'control: expected group to be renamed')
  })
})
