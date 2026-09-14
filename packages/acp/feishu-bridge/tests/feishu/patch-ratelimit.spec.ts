/**
 * PATCH rate limiter tests ported from cc-connect platform/feishu
 * feishu_patch_ratelimit_test.go.
 *
 * @module dsh-feishu-bridge/tests-feishu-patch-ratelimit
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform } from '../../src/feishu/platform.ts'
import { TokenBucketRateLimiter } from '../../src/feishu/retry.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('patchRateWait', () => {
  it('a fresh limiter consumes burst tokens instantly', async () => {
    // Go's nil-limiter no-op maps to not calling wait at all (the platform
    // always constructs a limiter); here the first burst token resolves.
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
    await expect(p.patchRateWait('card-a')).resolves.toBeUndefined()
  })

  it('burst passes immediately', async () => {
    const rl = new TokenBucketRateLimiter(1000, 3)
    for (let i = 0; i < 3; i++) {
      const start = Date.now()
      await rl.wait()
      expect(Date.now() - start).toBeLessThan(50)
    }
  })

  it('blocks after burst exhausted', async () => {
    // interval 50ms + burst 1: first instant, second blocks ~50ms.
    const rl = new TokenBucketRateLimiter(50, 1)
    await rl.wait()
    const start = Date.now()
    await rl.wait()
    expect(Date.now() - start).toBeGreaterThanOrEqual(30)
  })

  it('respects abort while blocked', async () => {
    const rl = new TokenBucketRateLimiter(3_600_000, 1)
    await rl.wait()
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 20)
    await expect(rl.wait(controller.signal)).rejects.toThrow('aborted')
  })

  it('platform limiter initialized by default', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
    // burst=3 instant, the 4th waits out one default 200ms refill.
    for (let i = 0; i < 3; i++) {
      const start = Date.now()
      await p.patchRateWait('card-a')
      expect(Date.now() - start).toBeLessThan(50)
    }
    const start = Date.now()
    await p.patchRateWait('card-a')
    expect(Date.now() - start).toBeGreaterThanOrEqual(60)
  })

  it('patch rate interval configurable', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's', patchRateIntervalMs: 5 })
    for (let i = 0; i < 3; i++) {
      await p.patchRateWait('card-a')
    }
    const start = Date.now()
    await p.patchRateWait('card-a')
    expect(Date.now() - start).toBeGreaterThanOrEqual(3)
  })

  it('paces each card message in its own bucket', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's', patchRateIntervalMs: 200 })
    for (let i = 0; i < 3; i++) await p.patchRateWait('card-a')
    const hotStart = Date.now()
    await p.patchRateWait('card-a')
    // card-a's burst is spent, so its 4th PATCH waits out a refill...
    expect(Date.now() - hotStart).toBeGreaterThanOrEqual(60)
    // ...while card-b, on its own bucket and untouched by card-a's traffic,
    // still holds a full burst (a shared bucket would have charged it ~200ms).
    const otherStart = Date.now()
    await p.patchRateWait('card-b')
    expect(Date.now() - otherStart).toBeLessThan(50)
  })

  it('aborts a blocked wait for one card', async () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's', patchRateIntervalMs: 600 })
    for (let i = 0; i < 3; i++) await p.patchRateWait('card-a')
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 20)
    await expect(p.patchRateWait('card-a', controller.signal)).rejects.toThrow('aborted')
  })

  it('limiter refill allows sustained pacing', async () => {
    const rl = new TokenBucketRateLimiter(20, 1)
    const start = Date.now()
    await rl.wait()
    await rl.wait()
    await rl.wait()
    // Two refills at 20ms each.
    expect(Date.now() - start).toBeGreaterThanOrEqual(30)
    await sleep(0)
  })
})
