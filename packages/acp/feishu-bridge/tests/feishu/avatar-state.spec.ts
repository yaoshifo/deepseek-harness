import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'

// Ported from cc-connect platform/feishu/feishu_avatar_state_test.go: which
// branch setChatAvatarActive takes (per-group custom keys, global bot keys, or
// skip) is asserted from the avatar key sent to the chat-update verb.

interface AvatarSwitch {
  captured: string
  calls: number
}

function newAvatarSwitchPlatform(
  colorKey: string,
  grayKey: string,
  meta?: { colorAvatarKey: string; grayAvatarKey: string },
): { p: FeishuPlatform; sw: AvatarSwitch } {
  const sw: AvatarSwitch = { captured: '', calls: 0 }
  const api: FeishuApiClient = {
    async reply() {
      return { messageId: 'om' }
    },
    async create() {
      return { messageId: 'om' }
    },
    async updateChat({ avatar }) {
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
    botAvatarKey: colorKey,
    botAvatarKeyGray: grayKey,
  })
  if (meta !== undefined) {
    p.spawnStore.set('oc_x', { active: true, ...meta })
  }
  return { p, sw }
}

describe('setChatAvatarActive', () => {
  it('restores the global color key when active', async () => {
    const { p, sw } = newAvatarSwitchPlatform('img_color', 'img_gray')
    await p.setChatAvatarActive('feishu:oc_x', true)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('img_color')
  })

  it('dims to the global gray key when inactive', async () => {
    const { p, sw } = newAvatarSwitchPlatform('img_color', 'img_gray')
    await p.setChatAvatarActive('feishu:oc_x', false)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('img_gray')
  })

  it('uses the per-group color key when the chat has custom keys', async () => {
    const { p, sw } = newAvatarSwitchPlatform('global_color', 'global_gray', { colorAvatarKey: 'custom_color', grayAvatarKey: 'custom_gray' })
    await p.setChatAvatarActive('feishu:oc_x', true)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('custom_color')
  })

  it('uses the per-group gray key when inactive', async () => {
    const { p, sw } = newAvatarSwitchPlatform('global_color', 'global_gray', { colorAvatarKey: 'custom_color', grayAvatarKey: 'custom_gray' })
    await p.setChatAvatarActive('feishu:oc_x', false)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('custom_gray')
  })

  it('skips dimming when the custom gray key is missing (no global fallback)', async () => {
    const { p, sw } = newAvatarSwitchPlatform('global_color', 'global_gray', { colorAvatarKey: 'custom_color', grayAvatarKey: '' })
    await expect(p.setChatAvatarActive('feishu:oc_x', false)).resolves.toBeUndefined()
    expect(sw.calls).toBe(0)
  })

  it('falls back to the global keys when the spawned meta has none', async () => {
    const { p, sw } = newAvatarSwitchPlatform('global_color', 'global_gray', { colorAvatarKey: '', grayAvatarKey: '' })
    await p.setChatAvatarActive('feishu:oc_x', true)
    expect(sw.calls).toBe(1)
    expect(sw.captured).toBe('global_color')
  })

  it('skips avatar dimming when the global gray key is missing', async () => {
    const { p, sw } = newAvatarSwitchPlatform('img_color', '')
    await expect(p.setChatAvatarActive('feishu:oc_x', false)).resolves.toBeUndefined()
    expect(sw.calls).toBe(0)
  })
})
