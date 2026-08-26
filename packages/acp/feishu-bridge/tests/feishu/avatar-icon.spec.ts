import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'

// Ported from cc-connect platform/feishu/feishu_avatar_icon_test.go. The Go
// suite captured uploads and PUT /im/v1/chats bodies; here the same assertions
// run against a recording fake of the avatar-upload and chat-update verbs.

interface Captured {
  uploadCount: number
  uploadKeys: string[]
  avatarCaptured: string
  nameCaptured: string
  avatarByChat: Map<string, string>
  nameByChat: Map<string, string>
}

function newIconAvatarPlatform(): { p: FeishuPlatform; captured: Captured } {
  const captured: Captured = {
    uploadCount: 0,
    uploadKeys: [],
    avatarCaptured: '',
    nameCaptured: '',
    avatarByChat: new Map(),
    nameByChat: new Map(),
  }
  const api: FeishuApiClient = {
    async reply() {
      return { messageId: 'om' }
    },
    async create() {
      return { messageId: 'om' }
    },
    async uploadAvatar() {
      captured.uploadCount += 1
      const key = `img-key-${captured.uploadCount}`
      captured.uploadKeys.push(key)
      return key
    },
    async updateChat({ chatId, name, avatar }) {
      if (avatar !== undefined) {
        captured.avatarCaptured = avatar
        captured.avatarByChat.set(chatId, avatar)
      }
      if (name !== undefined) {
        captured.nameCaptured = name
        captured.nameByChat.set(chatId, name)
      }
      return { code: 0 }
    },
  }
  const p = new FeishuPlatform({
    appID: 'cli_av',
    appSecret: 'sec_ic',
    apiClient: api,
    wsStart: async () => {},
  })
  return { p, captured }
}

describe('setGroupIconAvatar', () => {
  it('uploads the discussing + done pair, sets yellow, and seeds phase bookkeeping', async () => {
    const { p, captured } = newIconAvatarPlatform()

    await expect(p.setGroupIconAvatar('feishu:oc_spawn1', 'bug', '登录500修复')).resolves.toBeUndefined()

    expect(captured.uploadCount).toBe(2)
    expect(captured.avatarCaptured).toBe('img-key-1')

    const meta = p.spawnStore.get('oc_spawn1')
    expect(meta).toBeDefined()
    expect(meta?.iconName).toBe('bug')
    expect(meta?.phase).toBe('discussing')
    expect(meta?.basePhase).toBe('discussing')
    expect(meta?.lastAvatarKey).toBe('img-key-1')
    expect(meta?.avatarKeys).toEqual({ discussing: 'img-key-1', done: 'img-key-2' })
  })

  it('falls back to a pooled icon when the name is not in the sprite', async () => {
    const { p, captured } = newIconAvatarPlatform()

    await expect(
      p.setGroupIconAvatar('feishu:oc_spawn1', 'totally-not-a-real-icon-xyz', 'g'),
    ).resolves.toBeUndefined()
    expect(captured.uploadCount).toBeGreaterThan(0)
    expect(captured.avatarCaptured).not.toBe('')
  })

  it('preserves existing spawned-chat meta flags', async () => {
    const { p } = newIconAvatarPlatform()
    p.spawnStore.set('oc_spawn1', { active: true, backfilled: true })

    await p.setGroupIconAvatar('feishu:oc_spawn1', 'bug', 'g')

    const meta = p.spawnStore.get('oc_spawn1')
    expect(meta?.active).toBe(true)
    expect(meta?.backfilled).toBe(true)
  })
})

describe('brandChat', () => {
  it('uploads color only, renames the chat, and never tracks it as spawned', async () => {
    const { p, captured } = newIconAvatarPlatform()

    await expect(p.brandChat('feishu:oc_hub', '收发室', 'trending-up-down')).resolves.toBeUndefined()

    expect(captured.uploadCount).toBe(1)
    expect(captured.avatarCaptured).toBe('img-key-1')
    expect(captured.nameCaptured).toBe('收发室')
    expect(p.spawnStore.isSpawned('oc_hub')).toBe(false)
  })
})

describe('setChatroomFamilyAvatar', () => {
  it('shares one color + one gray upload across the family and persists child keys', async () => {
    const { p, captured } = newIconAvatarPlatform()
    p.spawnStore.set('oc_role1', { active: true, backfilled: true })
    p.spawnStore.set('oc_role2', { active: true })

    await expect(
      p.setChatroomFamilyAvatar('feishu:oc_hub', ['feishu:oc_role1', 'feishu:oc_role2'], 'bug', '登录500修复'),
    ).resolves.toBeUndefined()

    expect(captured.uploadCount).toBe(2)
    for (const cid of ['oc_hub', 'oc_role1', 'oc_role2']) {
      expect(captured.avatarByChat.get(cid)).toBe('img-key-1')
    }
    // The hub is not tracked as spawned; children keep active + get keys.
    expect(p.spawnStore.isSpawned('oc_hub')).toBe(false)
    for (const cid of ['oc_role1', 'oc_role2']) {
      const meta = p.spawnStore.get(cid)
      expect(meta?.active).toBe(true)
      expect(meta?.colorAvatarKey).toBe('img-key-1')
      expect(meta?.grayAvatarKey).toBe('img-key-2')
    }
    expect(p.spawnStore.get('oc_role1')?.backfilled).toBe(true)
  })

  it('skips the gray upload when there are no children', async () => {
    const { p, captured } = newIconAvatarPlatform()

    await expect(p.setChatroomFamilyAvatar('feishu:oc_hub', [], 'bug', '主题')).resolves.toBeUndefined()

    expect(captured.uploadCount).toBe(1)
    expect(captured.avatarByChat.get('oc_hub')).toBe('img-key-1')
    expect(p.spawnStore.isSpawned('oc_hub')).toBe(false)
  })
})
