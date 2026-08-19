import { describe, expect, it } from 'vitest'
import { ChatNameCache } from '../../src/feishu/chatname.js'

// Ported from cc-connect platform/feishu/chatname_stale_test.go: an entry past
// its TTL must be ignored and the name re-fetched (then cached fresh), or a
// renamed chat would show its stale name forever.

describe('resolveChatName stale entry', () => {
  it('ignores a stale entry, re-fetches once, and caches the fresh name', async () => {
    const cache = new ChatNameCache()
    const ttl = 10 * 60_000
    cache.put('oc_stale', { name: 'stale-wrong-name', at: Date.now() - ttl - 60_000 })

    let calls = 0
    const got = await cache.resolve('oc_stale', async () => {
      calls += 1
      return { name: 'fetched-name' }
    })
    expect(got).toBe('fetched-name')
    expect(calls).toBe(1)

    // A second call hits the fresh cache — no extra API call.
    const got2 = await cache.resolve('oc_stale', async () => {
      calls += 1
      return { name: 'other' }
    })
    expect(got2).toBe('fetched-name')
    expect(calls).toBe(1)

    // The cache holds a fresh entry with the fetched name.
    const entry = cache.get('oc_stale')
    expect(entry).toMatchObject({ name: 'fetched-name' })
    expect(typeof (entry as { at: number }).at).toBe('number')
  })

  it('caches fetch failures and returns the chat id until the fail TTL passes', async () => {
    const cache = new ChatNameCache()
    let calls = 0
    const got = await cache.resolve('oc_fail', async () => {
      calls += 1
      throw new Error('api down')
    })
    expect(got).toBe('oc_fail')
    expect(calls).toBe(1)

    // Still inside the fail TTL: no re-fetch.
    const got2 = await cache.resolve('oc_fail', async () => {
      calls += 1
      return { name: 'recovered' }
    })
    expect(got2).toBe('oc_fail')
    expect(calls).toBe(1)
  })
})
