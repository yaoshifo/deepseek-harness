import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'
import type { SpawnedChatMeta } from '../../src/feishu/spawn.js'

// Ported from cc-connect platform/feishu/feishu_avatar_state_test.go and
// reworked for the phase axis: which key setChatPhase applies (cached phase
// key, lazily rendered variant, legacy custom pair, or bot pair) is asserted
// from the avatar key sent to the chat-update verb, plus the same-key dedup
// that keeps avatar updates from spamming chat system messages.

interface AvatarSwitch {
  captured: string
  calls: number
  uploadCount: number
  failUpdate: boolean
}

function newPhasePlatform(
  botColorKey: string,
  botGrayKey: string,
  meta?: SpawnedChatMeta,
): { p: FeishuPlatform; sw: AvatarSwitch } {
  const sw: AvatarSwitch = { captured: '', calls: 0, uploadCount: 0, failUpdate: false }
  const api: FeishuApiClient = {
    async reply() {
      return { messageId: 'om' }
    },
    async create() {
      return { messageId: 'om' }
    },
    async uploadAvatar() {
      sw.uploadCount += 1
      return `img-rendered-${sw.uploadCount}`
    },
    async updateChat({ avatar }) {
      if (sw.failUpdate) throw new Error('update failed')
      sw.calls += 1
      if (avatar !== undefined) sw.captured = avatar
      return { code: 0 }
    },
  }
  const p = new FeishuPlatform({
    appID: 'cli_av',
    appSecret: 'secret_av',
    apiClient: api,
    wsStart: async () => {},
    botAvatarKey: botColorKey,
    botAvatarKeyGray: botGrayKey,
  })
  if (meta !== undefined) {
    p.spawnStore.set('oc_x', { active: true, ...meta })
  }
  return { p, sw }
}

/** A phase-painted chat: seeded the way setGroupIconAvatar leaves it. */
function phaseMeta(overrides: Partial<SpawnedChatMeta> = {}): SpawnedChatMeta {
  return {
    active: true,
    iconName: 'bug',
    phase: 'discussing',
    basePhase: 'discussing',
    lastAvatarKey: 'k-discuss',
    avatarKeys: { discussing: 'k-discuss', done: 'k-done' },
    ...overrides,
  }
}

describe('setChatPhase', () => {
  it('swaps to the cached phase key and publishes the phase after the apply', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta({ avatarKeys: { discussing: 'k-discuss', done: 'k-done', approved: 'k-approve' } }))
    await p.setChatPhase('feishu:oc_x', 'approved')
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('k-approve')
    const meta = p.spawnStore.get('oc_x')
    expect(meta?.phase).toBe('approved')
    expect(meta?.basePhase).toBe('approved')
    expect(meta?.lastAvatarKey).toBe('k-approve')
  })

  it('skips the update call when the target key is already applied', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta({ avatarKeys: { discussing: 'k-discuss', done: 'k-done', approved: 'k-approve' } }))
    await p.setChatPhase('feishu:oc_x', 'approved')
    await p.setChatPhase('feishu:oc_x', 'approved')
    expect(sw.calls).toBe(1)
  })

  it('lazily renders and caches a missing phase variant from the stored icon name', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta())
    await p.setChatPhase('feishu:oc_x', 'approved')
    expect(sw.uploadCount).toBe(1)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('img-rendered-1')
    const meta = p.spawnStore.get('oc_x')
    expect(meta?.avatarKeys?.approved).toBe('img-rendered-1')
    // Second entry into the same phase reuses the cached key.
    await p.setChatPhase('feishu:oc_x', 'discussing')
    await p.setChatPhase('feishu:oc_x', 'approved')
    expect(sw.uploadCount).toBe(1)
    expect(sw.calls).toBe(3)
  })

  it('keeps the baseline untouched for overlay phases', async () => {
    const { p } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta({ basePhase: 'approved', avatarKeys: { discussing: 'k-discuss', done: 'k-done', attention: 'k-red' } }))
    await p.setChatPhase('feishu:oc_x', 'attention')
    expect(p.spawnStore.get('oc_x')?.basePhase).toBe('approved')
    await p.setChatPhase('feishu:oc_x', 'done')
    expect(p.spawnStore.get('oc_x')?.basePhase).toBe('approved')
  })

  it('falls back to the legacy custom pair for pre-phase entries', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', { active: true, colorAvatarKey: 'custom_color', grayAvatarKey: 'custom_gray' })
    await p.setChatPhase('feishu:oc_x', 'done')
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('custom_gray')
    await p.setChatPhase('feishu:oc_x', 'attention')
    expect(sw.calls).toBe(2)
    expect(sw.captured).toBe('custom_color')
  })

  it('falls back to the bot avatar pair when the legacy keys are empty', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', { active: true })
    await p.setChatPhase('feishu:oc_x', 'discussing')
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('bot_color')
    await p.setChatPhase('feishu:oc_x', 'done')
    expect(sw.calls).toBe(2)
    expect(sw.captured).toBe('bot_gray')
  })

  it('skips when no key resolves at all', async () => {
    const { p, sw } = newPhasePlatform('', '', { active: true })
    await expect(p.setChatPhase('feishu:oc_x', 'done')).resolves.toBeUndefined()
    expect(sw.calls).toBe(0)
    expect(p.spawnStore.get('oc_x')?.phase).toBeUndefined()
  })

  it('no-ops for chats outside the spawn store', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray')
    await expect(p.setChatPhase('feishu:oc_other', 'done')).resolves.toBeUndefined()
    expect(sw.calls).toBe(0)
  })

  it('does not publish the phase when the avatar apply fails', async () => {
    const { p, sw } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta({ avatarKeys: { discussing: 'k-discuss', done: 'k-done', approved: 'k-approve' } }))
    sw.failUpdate = true
    await expect(p.setChatPhase('feishu:oc_x', 'approved')).rejects.toThrow('update failed')
    const meta = p.spawnStore.get('oc_x')
    expect(meta?.phase).toBe('discussing')
    expect(meta?.basePhase).toBe('discussing')
  })

  it('throws when the session key carries no chat ID', async () => {
    const { p } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta())
    await expect(p.setChatPhase('feishu:', 'done')).rejects.toThrow('no chat ID')
  })
})

describe('chatBasePhase', () => {
  it('returns the persisted baseline and defaults to discussing', async () => {
    const { p } = newPhasePlatform('bot_color', 'bot_gray', phaseMeta({ basePhase: 'approved' }))
    expect(p.chatBasePhase('feishu:oc_x')).toBe('approved')
    expect(p.chatBasePhase('feishu:oc_none')).toBe('discussing')
  })
})
