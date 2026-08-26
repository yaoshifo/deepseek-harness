import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  TagManager,
  type TagApi,
  buildDirWordFreq,
  pickDirTagName,
  sanitizeTagName,
  splitTagWords,
} from '../../src/feishu/tag.js'
import { projectBaseForTag } from '../../src/feishu/spawn.js'
import { activeTagName as defaultActiveTag } from '../../src/feishu/tag.js'

// Ported from cc-connect platform/feishu/feishu_tag_test.go. The Go tests
// stood up httptest servers around the SDK client; here the same wire behavior
// is fed through a recording fake of the four tag API verbs.

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(d => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-tag-'))
  tempDirs.push(dir)
  return dir
}

/**
 * Fake tag API mirroring the Go tests' HTTP handlers: created ids only "stick"
 * when listed in liveIDs (a dangling id binds with code=0 but never shows up
 * when the relation is read back).
 */
function fakeTagApi(opts: {
  tagName: string
  create?: (name: string) => { code?: number; msg?: string; id?: string; duplicateId?: string }
  liveIDs?: string[]
}): TagApi & { createCalls: string[] } {
  const live = new Set(opts.liveIDs ?? [])
  const attached = new Map<string, boolean>()
  const createCalls: string[] = []
  return {
    createCalls,
    async createTag(name) {
      createCalls.push(name)
      return opts.create?.(name) ?? { code: 0, id: '' }
    },
    async getTagRelation() {
      const tags: Array<{ id?: string; name?: string }> = []
      for (const [id, ok] of attached) {
        if (ok) tags.push({ id, name: opts.tagName })
      }
      return { code: 0, tags }
    },
    async createTagRelation(_chatId, tagIds) {
      for (const id of tagIds) {
        if (live.has(id)) attached.set(id, true)
      }
      return { code: 0 }
    },
    async updateTagRelation() {
      return { code: 0 }
    },
  }
}

function newManager(api: TagApi, opts: Partial<ConstructorParameters<typeof TagManager>[0]> = {}): TagManager {
  return new TagManager({
    api,
    spawnedChatIDs: () => ['oc_spawned'],
    ...opts,
  })
}

describe('resolveAndAttachActiveTag', () => {
  it('recovers from a stale cached id (evict, create fresh, verify, persist)', async () => {
    const staleID = '7645150666582740159' // dangling, attaches but never sticks
    const freshID = '7645256997377543388' // live, sticks on attach
    const api = fakeTagApi({ tagName: defaultActiveTag, liveIDs: [freshID], create: () => ({ code: 0, id: freshID }) })
    const p = newManager(api, { activeTagOverride: defaultActiveTag })
    p.seedTagCache(defaultActiveTag, staleID)

    await p.resolveAndAttachActiveTag('oc_spawned')

    expect(await p.chatHasActiveTag('oc_spawned')).toBe(true)
    expect(p.cachedTagID(defaultActiveTag)).toBe(freshID)
    expect(api.createCalls).toHaveLength(1)
  })

  it('keeps a valid cached id without any create call', async () => {
    const liveID = '7645256997377543388'
    const api = fakeTagApi({ tagName: defaultActiveTag, liveIDs: [liveID], create: () => ({ code: 0, id: liveID }) })
    const p = newManager(api, { activeTagOverride: defaultActiveTag })
    p.seedTagCache(defaultActiveTag, liveID)

    await p.resolveAndAttachActiveTag('oc_spawned')

    expect(api.createCalls).toHaveLength(0)
    expect(p.cachedTagID(defaultActiveTag)).toBe(liveID)
  })
})

describe('applySpawnDirTag', () => {
  it('recovers from a stale cached id (verify bind, evict, re-resolve, rebind)', async () => {
    const tagName = 'connect'
    const staleID = '7663097861491461340' // binds with code=0 but never sticks
    const freshID = '7662937435629735163' // live, sticks on bind
    const api = fakeTagApi({ tagName, liveIDs: [freshID], create: () => ({ code: 0, id: freshID }) })
    const p = newManager(api, { dirTagName: tagName })
    p.seedTagCache(tagName, staleID)

    await p.applySpawnDirTag('oc_spawned', tagName)

    expect(await p.chatHasTagID('oc_spawned', freshID)).toBe(true)
    expect(p.cachedTagID(tagName)).toBe(freshID)
    expect(api.createCalls).toHaveLength(1)
  })

  it('keeps a valid cached id without any create call', async () => {
    const tagName = 'money'
    const liveID = '7644168077189336260'
    const api = fakeTagApi({ tagName, liveIDs: [liveID], create: () => ({ code: 0, id: liveID }) })
    const p = newManager(api, { dirTagName: tagName })
    p.seedTagCache(tagName, liveID)

    await p.applySpawnDirTag('oc_spawned', tagName)

    expect(api.createCalls).toHaveLength(0)
    expect(p.cachedTagID(tagName)).toBe(liveID)
  })

  it('does not re-borrow a sibling id that failed bind verification', async () => {
    const tagName = 'riskai'
    const foreignID = '7649209605100195013' // another app's tag: binds with code=0, never sticks
    const dir = await tempDir()
    // A sibling cache file under a renamed platform shape — the sibling scan
    // must see any `*_tag_cache.json`, not just the old `_feishu_` one.
    await writeFile(join(dir, 'other_riskai_tag_cache.json'), JSON.stringify({ riskai: foreignID }))
    const api = fakeTagApi({
      tagName,
      liveIDs: [],
      create: () => ({ code: 402, msg: 'duplicate name in tenant' }),
    })
    const p = newManager(api, {
      dirTagName: tagName,
      tagCacheFile: join(dir, 'mine_tag_cache.json'),
    })
    await p.load()
    p.seedTagCache(tagName, foreignID)

    await p.applySpawnDirTag('oc_spawned', tagName)

    expect(await p.chatHasTagID('oc_spawned', foreignID)).toBe(false)
    // Evicted and not re-cached from the sibling file; the 402 create ran
    // once during the re-resolve and its error left the chat untagged.
    expect(p.cachedTagID(tagName)).toBeUndefined()
    expect(api.createCalls).toEqual([tagName])
    // The empty cache never persists (save skips empty maps).
    await expect(readFile(join(dir, 'mine_tag_cache.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('legacy tag cache migration', () => {
  it('merges legacy cache files under the primary file, primary entries winning', async () => {
    const dir = await tempDir()
    const primary = join(dir, 'bot_tag_cache.json')
    const legacyCurrent = join(dir, 'bot_riskai_tag_cache.json')
    const legacyFeishu = join(dir, 'bot_feishu_tag_cache.json')
    await writeFile(legacyCurrent, JSON.stringify({ riskai: 'id_current' }))
    await writeFile(legacyFeishu, JSON.stringify({ riskai: 'id_old', money: 'id_money' }))
    const api = fakeTagApi({ tagName: 'riskai' })
    const p = new TagManager({ api, tagCacheFile: primary, legacyTagCacheFiles: [legacyCurrent, legacyFeishu] })

    await p.load()

    expect(p.cachedTagID('riskai')).toBe('id_current')
    expect(p.cachedTagID('money')).toBe('id_money')
    expect(JSON.parse(await readFile(primary, 'utf8'))).toEqual({ riskai: 'id_current', money: 'id_money' })
  })
})

describe('resolveActiveTagName', () => {
  it('falls through to the first free heart candidate', async () => {
    const api = fakeTagApi({
      tagName: '💛',
      create: (name) => {
        // "❤️" and "🧡" are taken by other apps → 402 duplicate without id.
        if (name === '❤️' || name === '🧡') return { code: 402, msg: 'duplicate name in tenant' }
        return { code: 0, id: 'tag_yellow' }
      },
    })
    const p = newManager(api)

    const name = await p.resolveActiveTagName()

    expect(name).toBe('💛')
    expect(p.activeTagName()).toBe('💛')
    expect(p.cachedTagID('💛')).toBe('tag_yellow')
    expect(api.createCalls).toEqual(['❤️', '🧡', '💛'])
  })

  it('adopts a cached heart without any API call', async () => {
    const api = fakeTagApi({ tagName: defaultActiveTag })
    const p = newManager(api)
    p.seedTagCache(defaultActiveTag, '7645256997377543388')

    expect(await p.resolveActiveTagName()).toBe(defaultActiveTag)
  })

  it('recovers the claimed heart from cache after restart', () => {
    const p = newManager(fakeTagApi({ tagName: defaultActiveTag }), { projectName: '记账驴' })
    p.seedTagCache('cc-connect', '7644179412233047241')
    p.seedTagCache('🧡', '7646631680970624198')

    expect(p.activeTagName()).toBe('🧡')
    expect(p.activeTagName()).toBe('🧡') // idempotent
  })

  it('defaults to the global heart when the cache is empty', () => {
    const p = newManager(fakeTagApi({ tagName: defaultActiveTag }), { projectName: '记账驴' })
    p.seedTagCache('cc-connect', '7644179412233047241')

    expect(p.activeTagName()).toBe(defaultActiveTag)
  })
})

describe('sanitizeTagName', () => {
  it.each([
    ['short', 'money', 'money'],
    ['hyphen and underscore preserved', 'cc-connect_v2', 'cc-connect_v2'],
    ['at limit unchanged', 'knowledge-router', 'knowledge-router'],
    ['over limit truncated', 'llm-wiki-platform', 'llm-wiki-platfor'],
    ['strips punctuation and spaces', 'FX Backtest!', 'FXBacktest'],
    ['long truncated to 16', 'agent-1-cc-connect-subtask-spawn', 'agent-1-cc-conne'],
    ['emoji truncated by rune not byte', '🟢'.repeat(20), '🟢'.repeat(16)],
  ])('%s', (_name, input, want) => {
    expect(sanitizeTagName(input)).toBe(want)
  })
})

describe('splitTagWords', () => {
  it.each([
    ['hyphen', 'cc-connect', ['cc', 'connect']],
    ['underscore', 'FX_Backtest', ['FX', 'Backtest']],
    ['multi segment', 'claude-code-system-prompts', ['claude', 'code', 'system', 'prompts']],
    ['single word', 'money', ['money']],
    ['mixed separators', 'a_b-c d', ['a', 'b', 'c', 'd']],
    ['punctuation and space', 'FX Backtest!', ['FX', 'Backtest']],
    ['all separators', '---', []],
    ['empty', '', []],
  ])('%s', (_name, input, want) => {
    expect(splitTagWords(input)).toEqual(want)
  })
})

describe('buildDirWordFreq', () => {
  it('counts document frequency of words across subdirectory names', async () => {
    const workspace = await tempDir()
    for (const sub of ['cc-connect', 'cc-tools', 'skills', 'a-a']) {
      await mkdir(join(workspace, sub))
    }
    // Files must be ignored — only subdirectory names feed the corpus.
    await writeFile(join(workspace, 'file.txt'), 'x')

    const freq = await buildDirWordFreq(workspace)

    expect(freq['cc']).toBe(2)
    expect(freq['connect']).toBe(1)
    expect(freq['tools']).toBe(1)
    expect(freq['skills']).toBe(1)
    expect(freq['a']).toBe(1) // a-a deduped: the word "a" counts once
    expect(freq['file']).toBeUndefined()
  })

  it('returns an empty table for a missing workspace', async () => {
    const freq = await buildDirWordFreq(join(await tempDir(), 'does-not-exist'))
    expect(Object.keys(freq)).toHaveLength(0)
  })
})

describe('pickDirTagName', () => {
  it.each([
    ['prefer rarer word over common tail', { skills: 2, ljg: 1 }, 'ljg-skills', 'ljg'],
    ['tie breaks to last word', { cc: 1, connect: 1 }, 'cc-connect', 'connect'],
    ['degrades to tail on empty freq', {}, 'cc-connect', 'connect'],
    ['single word unchanged', { money: 1 }, 'money', 'money'],
    ['workspace example claude-code-system-prompts', { claude: 1, code: 1, system: 1, prompts: 1 }, 'claude-code-system-prompts', 'prompts'],
    ['workspace example FX_Backtest skips shared FX', { FX: 2, Backtest: 1 }, 'FX_Backtest', 'Backtest'],
    ['empty words falls back to sanitize', {}, '---', ''],
    ['over-limit single word truncated', {}, 'a'.repeat(20), 'a'.repeat(16)],
  ])('%s', (_name, freq, input, want) => {
    expect(pickDirTagName(input, freq)).toBe(want)
  })
})

describe('projectBaseForTag', () => {
  it.each([
    ['/home/hm/workspace/cc-connect/.claude/worktrees/task-0616-222159', 'cc-connect'],
    ['/home/hm/workspace/cc-connect/.claude/worktrees/feat-x-0102-030405', 'cc-connect'],
    ['/srv/apps/fx_backtest/.claude/worktrees/q1-report', 'fx_backtest'],
    ['repo/.claude/worktrees/slug', 'repo'],
    ['/home/hm/workspace/cc-connect', 'cc-connect'],
    ['/home/hm/workspace/other-project', 'other-project'],
  ])('%s → %s', (dir, want) => {
    expect(projectBaseForTag(dir)).toBe(want)
  })
})
