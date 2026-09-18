import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SpawnedChatStore, extractFeishuChatID } from '../../src/feishu/spawn.ts'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.ts'
import type { Message } from '../../src/core/types.ts'

// Ported from cc-connect platform/feishu/feishu_spawn_evict_test.go, plus
// dispatch-level checks of SpawnGroup/SpawnGroupWithOptions against a fake
// API client (the Go suite covered only the retention sweep).

const tempDirs: string[] = []
afterAll(async () => {
  await Promise.all(tempDirs.map(d => rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-spawn-'))
  tempDirs.push(dir)
  return dir
}

describe('saveSpawnedChats eviction sweep', () => {
  it('evicts done entries past retention, backfills legacy DoneAt, keeps the rest', async () => {
    const tmp = await tempDir()
    const file = join(tmp, 'spawned.json')
    const store = new SpawnedChatStore(file)

    const now = Date.now()
    const hour = 3600_000
    const retention = 7 * 24 * hour
    store.set('oc_active', { active: true })
    store.set('oc_recent_done', { active: false, doneAt: new Date(now - hour).toISOString() })
    store.set('oc_old_done', { active: false, doneAt: new Date(now - retention - hour).toISOString() })
    store.set('oc_legacy_done', { active: false }) // pre-DoneAt migration

    await store.save()

    expect(store.get('oc_active')).toBeDefined()
    expect(store.get('oc_recent_done')).toBeDefined()
    expect(store.get('oc_old_done')).toBeUndefined()
    const legacy = store.get('oc_legacy_done')
    expect(legacy).toBeDefined()
    expect(legacy?.doneAt).toBeTruthy()

    // The on-disk file must reflect the surviving set (no oc_old_done).
    const data = await readFile(file, 'utf8')
    expect(data).not.toContain('oc_old_done')
    expect(data).toContain('oc_active')
  })
})

describe('phase-field persistence round-trip', () => {
  it('keeps phase, basePhase, iconName, avatarKeys, and lastAvatarKey across reload', async () => {
    const tmp = await tempDir()
    const file = join(tmp, 'spawned.json')
    const store = new SpawnedChatStore(file)
    const meta = {
      active: true,
      iconName: 'bug',
      phase: 'approved',
      basePhase: 'approved',
      lastAvatarKey: 'k2',
      avatarKeys: { discussing: 'k1', approved: 'k2', done: 'k3' },
    } as const
    store.set('oc_task', { ...meta })
    await store.save()

    const reloaded = new SpawnedChatStore(file)
    await reloaded.load()
    expect(reloaded.get('oc_task')).toEqual(meta)
  })
})

describe('extractFeishuChatID', () => {
  it('takes the second colon-separated field', () => {
    expect(extractFeishuChatID('feishu:oc_x:ou_user')).toBe('oc_x')
    expect(extractFeishuChatID('feishu:oc_x')).toBe('oc_x')
    expect(extractFeishuChatID('no-colon')).toBe('')
  })
})

/** Recording fake API client for the spawn dispatch checks. */
function spawnFakeClient(): FeishuApiClient & {
  creates: Array<{ chatId: string; msgType: string; content: string }>
  createdChats: Array<{ name: string; userIdList: string[]; groupMessageType?: string; avatar?: string }>
  createdTags: string[]
  tagCalls: Array<{ chatId: string; tagIds: string[] }>
  /** Keys returned per avatar upload. An array, not a counter: the platform
   * wraps this client, so only reference-shaped state survives the wrap. */
  uploads: string[]
  updates: Array<{ chatId: string; name?: string; avatar?: string }>
} {
  let chatNum = 0
  const bound = new Map<string, string[]>()
  return {
    creates: [],
    createdChats: [],
    createdTags: [],
    tagCalls: [],
    uploads: [],
    updates: [],
    async reply() {
      return { messageId: 'om_reply' }
    },
    async create(params) {
      this.creates.push(params)
      return { messageId: `om_${this.creates.length}` }
    },
    async createChat(params) {
      this.createdChats.push(params)
      chatNum += 1
      return { chatId: `oc_spawned_${chatNum}` }
    },
    async uploadAvatar() {
      const key = `img_rendered_${this.uploads.length + 1}`
      this.uploads.push(key)
      return key
    },
    async updateChat(params: { chatId: string; name?: string; avatar?: string }) {
      this.updates.push(params)
      return { code: 0 }
    },
    async createTag({ name }) {
      this.createdTags.push(name)
      return { code: 0, id: `tag_${name}` }
    },
    async getTagRelation({ chatId }: { chatId: string }) {
      return { code: 0, tags: (bound.get(chatId) ?? []).map(id => ({ id })) }
    },
    async createTagRelation(params: { chatId: string; tagIds: string[] }) {
      this.tagCalls.push(params)
      bound.set(params.chatId, params.tagIds)
      return { code: 0 }
    },
  }
}

function spawnPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_spawn',
    appSecret: 'secret',
    apiClient: api,
    wsStart: async () => {},
    botAvatarKey: 'img_bot_color',
    workDir: '/nonexistent-ws/money',
  })
}

const callerMsg = {
  sessionKey: 'feishu:oc_src:ou_user',
  platform: 'feishu',
  messageID: 'om_src',
  userID: 'ou_user',
  userName: '张三',
  chatName: '',
  chatType: 'group',
  content: '修个 bug',
  originalContent: '',
  images: [],
  files: [],
  extraContent: '',
  replyCtx: {},
  fromVoice: false,
  isSpawnedGroup: false,
  isPermissionAction: false,
  isAskqCardAction: false,
  isCardAction: false,
  parentMessageID: '',
  quotedText: '',
} satisfies Message

describe('spawnGroup', () => {
  it('creates the chat with the caller, registers it active, tags it, and forwards the first message', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)

    const synthetic = await p.spawnGroup(callerMsg, 'bug 修复', '第一句')

    expect(api.createdChats).toEqual([
      { name: 'bug 修复', userIdList: ['ou_user'], groupMessageType: 'chat', avatar: 'img_bot_color' },
    ])
    const chatID = api.createdChats[0] ? 'oc_spawned_1' : ''
    expect(synthetic.sessionKey).toBe(`feishu:${chatID}`)
    expect(synthetic.userID).toBe('ou_user')
    expect(synthetic.chatName).toBe('bug 修复')
    expect(synthetic.content).toBe('第一句')
    // The synthetic message carries a reply context bound to the new chat.
    const rc = synthetic.replyCtx as { chatID: string; sessionKey: string }
    expect(rc.chatID).toBe(chatID)
    expect(rc.sessionKey).toBe(`feishu:${chatID}`)
    // The chat is registered as an active spawned chat (no @-gate there).
    expect(p.spawnStore.isSpawned(chatID)).toBe(true)
    expect(p.spawnStore.isActive(chatID)).toBe(true)
    // The first message is forwarded into the new chat.
    expect(api.creates).toHaveLength(1)
    expect(api.creates[0]!.chatId).toBe(chatID)
    // The dir tag is applied asynchronously; wait for it.
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(api.createdTags).toEqual(['money'])
    expect(api.tagCalls).toEqual([{ chatId: chatID, tagIds: ['tag_money'] }])
  })

  it('spawnGroupWithOptions derives the tag from a worktree workDir via projectBaseForTag', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)

    await p.spawnGroupWithOptions(callerMsg, 'topic', 'hi', {
      topicGroup: true,
      workDir: '/home/hm/workspace/cc-connect/.claude/worktrees/task-1',
    })

    expect(api.createdChats[0]).toMatchObject({ groupMessageType: 'thread' })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    // projectBaseForTag maps the worktree slug back to the repo name
    // ("cc-connect"), then pickDirTagName picks the rarest word ("connect"
    // wins the all-zero-df tie as the tail word).
    expect(api.createdTags).toEqual(['connect'])
  })

  it('rejects when the caller user id is missing', async () => {
    const p = spawnPlatform(spawnFakeClient())
    await expect(p.spawnGroup({ ...callerMsg, userID: '' }, 'g', '')).rejects.toThrow('could not determine caller user ID')
  })
})

describe('avatarFrom', () => {
  it('gives the new group the source chat\'s icon, keys, and birth avatar', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)
    p.spawnStore.set('oc_origin', {
      active: true,
      iconName: 'message-circle-reply',
      phase: 'plan-review',
      basePhase: 'discussing',
      lastAvatarKey: 'k_plan',
      avatarKeys: { discussing: 'k_discuss', done: 'k_done', 'plan-review': 'k_plan' },
    })

    await p.spawnGroupWithOptions(callerMsg, '推敲群', 'hi', {
      topicGroup: false,
      workDir: '',
      avatarFrom: 'feishu:oc_origin',
    })

    // Born wearing the source's yellow variant: no bot-avatar flash, and no
    // avatar update of its own (which would post a chat system message).
    expect(api.createdChats[0]?.avatar).toBe('k_discuss')
    expect(api.uploads).toEqual([])
    expect(api.updates).toEqual([])
    const meta = p.spawnStore.get('oc_spawned_1')
    expect(meta).toMatchObject({
      active: true,
      iconName: 'message-circle-reply',
      phase: 'discussing',
      basePhase: 'discussing',
      lastAvatarKey: 'k_discuss',
    })
    // The phase keys are copied, not shared: a lazy render on either chat must
    // not write through to the other's record.
    expect(meta?.avatarKeys).toEqual({ discussing: 'k_discuss', done: 'k_done', 'plan-review': 'k_plan' })
    expect(meta?.avatarKeys).not.toBe(p.spawnStore.get('oc_origin')?.avatarKeys)

    // Its own later phases reuse the source's rendered keys.
    await p.setChatPhase('feishu:oc_spawned_1', 'plan-review')
    expect(api.updates).toEqual([{ chatId: 'oc_spawned_1', avatar: 'k_plan' }])
    expect(api.uploads).toEqual([])
  })

  it('keeps the bot avatar when the source chat is unknown to the store', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)

    await p.spawnGroupWithOptions(callerMsg, '推敲群', 'hi', {
      topicGroup: false,
      workDir: '',
      avatarFrom: 'feishu:oc_never_seen',
    })

    expect(api.createdChats[0]?.avatar).toBe('img_bot_color')
    expect(p.spawnStore.get('oc_spawned_1')).toEqual({ active: true })
  })

  it('keeps the bot avatar when the source chat carries no rendered icon', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)
    // Registered (main groups excepted, every chat is) but never named.
    p.spawnStore.set('oc_origin', { active: true })

    await p.spawnGroupWithOptions(callerMsg, '推敲群', 'hi', {
      topicGroup: false,
      workDir: '',
      avatarFrom: 'feishu:oc_origin',
    })

    expect(api.createdChats[0]?.avatar).toBe('img_bot_color')
    expect(p.spawnStore.get('oc_spawned_1')).toEqual({ active: true })
  })

  it('inherits an icon with no cached key, rendering its first phase from it', async () => {
    const api = spawnFakeClient()
    const p = spawnPlatform(api)
    p.spawnStore.set('oc_origin', { active: true, iconName: 'bug' })

    await p.spawnGroupWithOptions(callerMsg, '推敲群', 'hi', {
      topicGroup: false,
      workDir: '',
      avatarFrom: 'feishu:oc_origin',
    })

    // Nothing to apply at creation, but the icon identity survives into the
    // new record — so the first phase paints the inherited icon, not the bot
    // pair.
    expect(api.createdChats[0]?.avatar).toBe('img_bot_color')
    expect(p.spawnStore.get('oc_spawned_1')).toEqual({
      active: true,
      iconName: 'bug',
      phase: 'discussing',
      basePhase: 'discussing',
    })
    await p.setChatPhase('feishu:oc_spawned_1', 'discussing')
    expect(api.updates).toEqual([{ chatId: 'oc_spawned_1', avatar: 'img_rendered_1' }])
    expect(api.uploads).toEqual(['img_rendered_1'])
  })
})
