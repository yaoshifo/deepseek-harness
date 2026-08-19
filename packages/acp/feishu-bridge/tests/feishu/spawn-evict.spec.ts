import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SpawnedChatStore, extractFeishuChatID } from '../../src/feishu/spawn.js'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'
import type { Message } from '../../src/core/types.js'

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
} {
  let chatNum = 0
  const bound = new Map<string, string[]>()
  return {
    creates: [],
    createdChats: [],
    createdTags: [],
    tagCalls: [],
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
