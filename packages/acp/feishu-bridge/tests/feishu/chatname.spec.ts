import { describe, expect, it } from 'vitest'
import { ChatNameCache } from '../../src/feishu/chatname.js'

// Ported from cc-connect platform/feishu/chatname_cache_test.go. A cache miss
// would call the fetcher; the tests assert the cache short-circuits instead.

describe('resolveChatName TTL cache', () => {
  it('returns a fresh cached name without calling the API', async () => {
    const cache = new ChatNameCache()
    cache.put('oc_fresh', { name: 'fresh-name', at: Date.now() })

    let calls = 0
    const got = await cache.resolve('oc_fresh', async () => {
      calls += 1
      return { name: 'api-name' }
    })
    expect(got).toBe('fresh-name')
    expect(calls).toBe(0)
  })

  it('short-circuits on an empty chat id', async () => {
    const cache = new ChatNameCache()
    let calls = 0
    const got = await cache.resolve('', async () => {
      calls += 1
      return { name: 'x' }
    })
    expect(got).toBe('')
    expect(calls).toBe(0)
  })

  it('reads a legacy plain-string entry as fresh', async () => {
    const cache = new ChatNameCache()
    cache.put('oc_legacy', 'legacy-name')
    let calls = 0
    const got = await cache.resolve('oc_legacy', async () => {
      calls += 1
      return { name: 'api-name' }
    })
    expect(got).toBe('legacy-name')
    expect(calls).toBe(0)
  })
})
