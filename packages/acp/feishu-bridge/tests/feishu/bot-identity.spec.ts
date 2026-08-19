/**
 * BotIdentityProvider (Go BotDisplayName): the Feishu platform reports the
 * bot's app_name for p2p jump-button labels. The constructor option pre-seeds
 * it (same pattern as botOpenID); the startup bot-info probe fills it from
 * getBotInfo.
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform } from '../../src/feishu/platform.js'
import { asBotIdentityProvider } from '../../src/core/types.js'

function newPlatform(options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    ...options,
  })
}

describe('FeishuPlatform botDisplayName', () => {
  it('returns the configured display name', () => {
    const p = newPlatform({ botDisplayName: '记账驴' })
    expect(p.botDisplayName()).toBe('记账驴')
  })

  it('defaults to empty before the probe resolves', () => {
    const p = newPlatform()
    expect(p.botDisplayName()).toBe('')
  })

  it('satisfies the BotIdentityProvider capability check', () => {
    const p = newPlatform({ botDisplayName: '开发虾' })
    expect(asBotIdentityProvider(p)?.botDisplayName()).toBe('开发虾')
  })
})
