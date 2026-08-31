import { describe, expect, it } from 'vitest'
import { chatIDFromSessionKey, dedupMemberIDs } from '../../src/feishu/members.ts'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.ts'
import { retryTiming } from '../../src/feishu/retry.ts'

// Ported from cc-connect platform/feishu/feishu_members_test.go. The Go tests
// drove an httptest server; here the page verb is a fake that reproduces the
// same wire behavior (first call times out, second succeeds).

describe('dedupMemberIDs', () => {
  it('drops empty ids, the bot, and duplicates preserving order', () => {
    expect(dedupMemberIDs(['a', '', 'b', 'a', 'bot', 'c', 'b'], 'bot')).toEqual(['a', 'b', 'c'])
  })

  it('returns empty for nil input', () => {
    expect(dedupMemberIDs(undefined, 'bot')).toEqual([])
  })
})

describe('chatIDFromSessionKey', () => {
  it.each([
    ['feishu:oc_hub:user-1', 'oc_hub'],
    ['feishu:oc_spawned', 'oc_spawned'],
    ['feishu:oc_x:thread:t_123', 'oc_x'],
    ['feishu:oc_y:root:om_abc', 'oc_y'],
    ['', ''],
    ['no-colon', ''],
  ])('%s → %s', (sessionKey, want) => {
    expect(chatIDFromSessionKey(sessionKey)).toBe(want)
  })
})

function newPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_members',
    appSecret: 'secret',
    apiClient: api,
    wsStart: async () => {},
    botOpenID: 'ou_bot',
  })
}

describe('listChatMembers', () => {
  it('retries a transient first-page timeout and returns the second attempt\'s members', async () => {
    // Shrink the backoff so the retry is fast; the transient error text is
    // what the Go test produced via a per-attempt deadline.
    const original = { ...retryTiming }
    retryTiming.initialDelay = 1
    retryTiming.maxDelay = 2
    retryTiming.maxRetries = 3
    try {
      let hits = 0
      const api: FeishuApiClient = {
        async reply() {
          return { messageId: 'om' }
        },
        async create() {
          return { messageId: 'om' }
        },
        async listChatMembersPage() {
          hits += 1
          if (hits === 1) throw new Error('context deadline exceeded')
          // pageToken omitted → iteration stops after this page.
          return { memberIDs: ['ou_aaa', 'ou_bot'] }
        },
      }
      const p = newPlatform(api)

      const ids = await p.listChatMembers('feishu:oc_hub')

      expect(ids).toEqual(['ou_aaa']) // the bot itself is excluded
      expect(hits).toBe(2) // 1 timeout + 1 success
    } finally {
      Object.assign(retryTiming, original)
    }
  })

  it('errors on an empty chat id', async () => {
    const p = newPlatform({
      async reply() {
        return { messageId: 'om' }
      },
      async create() {
        return { messageId: 'om' }
      },
    })
    await expect(p.listChatMembers('no-colon')).rejects.toThrow('empty chat id')
  })
})

describe('addChatMembers', () => {
  it('batches at 50 per call and skips the bot and duplicates', async () => {
    const calls: Array<{ chatId: string; idList: string[] }> = []
    const api: FeishuApiClient = {
      async reply() {
        return { messageId: 'om' }
      },
      async create() {
        return { messageId: 'om' }
      },
      async createChatMembers(params) {
        calls.push(params)
        return { code: 0 }
      },
    }
    const p = newPlatform(api)

    const ids = ['ou_1', 'ou_1', 'ou_bot', ...Array.from({ length: 60 }, (_, i) => `ou_x${i}`)]
    await p.addChatMembers('feishu:oc_hub', ids)

    expect(calls).toHaveLength(2) // 61 unique non-bot ids → 50 + 11
    expect(calls[0]!.idList).toHaveLength(50)
    expect(calls[1]!.idList).toHaveLength(11)
    expect(calls[0]!.idList).not.toContain('ou_bot')
    expect(calls.every(c => c.chatId === 'oc_hub')).toBe(true)
  })

  it('is a no-op when nothing remains after dedup', async () => {
    const api: FeishuApiClient = {
      async reply() {
        return { messageId: 'om' }
      },
      async create() {
        return { messageId: 'om' }
      },
      async createChatMembers() {
        throw new Error('must not be called')
      },
    }
    const p = newPlatform(api)
    await p.addChatMembers('feishu:oc_hub', ['ou_bot', ''])
  })
})
