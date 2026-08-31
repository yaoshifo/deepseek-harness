/**
 * The platform's per-message caches are bounded: a long-running daemon
 * accumulates one entry per message id (permission bodies, ask metadata,
 * answered flags, card-action routing), so unbounded Maps grow without
 * limit. The caches evict the oldest entry past the capacity.
 *
 * @module dsh-feishu-bridge/tests-platform-caches
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform } from '../../src/feishu/platform.ts'
import { platformCacheCapacity } from '../../src/feishu/platform.ts'

function newPlatform(): FeishuPlatform {
  return new FeishuPlatform({ appID: 'cli_x', appSecret: 's', apiClient: {
    reply: async () => undefined,
    create: async () => undefined,
  } })
}

describe('bounded per-message caches', () => {
  it('exposes the capacity constant', () => {
    expect(platformCacheCapacity).toBeGreaterThan(0)
  })

  it('evicts the oldest entry once past the capacity', () => {
    const p = newPlatform()
    for (let i = 0; i < platformCacheCapacity + 1; i++) {
      p.permBodyCache.set(`om_${i}`, `body_${i}`)
    }
    expect(p.permBodyCache.get('om_0'), 'the oldest entry was evicted').toBeUndefined()
    expect(p.permBodyCache.get(`om_${platformCacheCapacity}`)).toBe('body_' + String(platformCacheCapacity))
  })
})
