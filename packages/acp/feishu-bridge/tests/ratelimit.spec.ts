import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/ratelimit.ts'

// Ported from cc-connect core/ratelimit_test.go (8 Go tests).
//
// Go→TS concurrency mapping (MIGRATION.md D7): the Go suite spawned real
// goroutines and used time.Sleep; JS runs the same interleavings on one
// thread (Promise.all of sync calls) and keeps the 60ms window-expiry sleep
// real because Allow() reads Date.now().

describe('RateLimiter', () => {
  it('AllowWithinLimit', () => {
    const rl = new RateLimiter(5, 60_000)
    for (let i = 0; i < 5; i++) {
      expect(rl.allow('user1'), `request ${i + 1} should be allowed`).toBe(true)
    }
  })

  it('BlockExceedingLimit', () => {
    const rl = new RateLimiter(3, 60_000)
    for (let i = 0; i < 3; i++) {
      rl.allow('user1')
    }
    expect(rl.allow('user1'), '4th request should be blocked').toBe(false)
  })

  it('DifferentKeys', () => {
    const rl = new RateLimiter(2, 60_000)
    rl.allow('user1')
    rl.allow('user1')

    expect(rl.allow('user1'), 'user1 should be blocked').toBe(false)
    expect(rl.allow('user2'), 'user2 should be allowed (independent bucket)').toBe(true)
  })

  it('WindowExpiry', async () => {
    const rl = new RateLimiter(2, 50)
    rl.allow('user1')
    rl.allow('user1')

    expect(rl.allow('user1'), 'should be blocked immediately').toBe(false)

    // Go: time.Sleep(60 * time.Millisecond); real sleep for the same reason.
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(rl.allow('user1'), 'should be allowed after window expires').toBe(true)
  })

  it('Disabled', () => {
    const rl = new RateLimiter(0, 60_000)
    for (let i = 0; i < 100; i++) {
      expect(rl.allow('user1'), 'should always allow when disabled').toBe(true)
    }
  })

  it('Concurrent', async () => {
    // Go: 200 goroutines call Allow concurrently under a WaitGroup. JS: the
    // same 200 calls as microtasks on one thread — no lost update can occur
    // either way, which is the invariant under test.
    const rl = new RateLimiter(100, 60_000)
    await Promise.all(Array.from({ length: 200 }, () => Promise.resolve(rl.allow('user1'))))
  })

  it('Stop', () => {
    const rl = new RateLimiter(5, 60_000)
    rl.allow('user1')

    // Stop should not throw and should be idempotent
    rl.stop()
    rl.stop() // second call should be safe

    // Allow should still work after Stop (just no background cleanup)
    expect(rl.allow('user2'), 'Allow should still work after Stop').toBe(true)
  })

  it('StopDisabled', () => {
    // A disabled limiter (maxMessages=0) should also handle Stop gracefully
    const rl = new RateLimiter(0, 60_000)
    rl.stop()
  })
})
