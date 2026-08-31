import { describe, expect, it } from 'vitest'
import { isOldMessage, MessageDedup, StartTime } from '../src/dedup.ts'

// Ported from cc-connect core/dedup_test.go (4 Go tests).
describe('MessageDedup', () => {
  it('Basic', () => {
    const d = new MessageDedup()
    expect(d.isDuplicate('msg-1'), 'first call should not be duplicate').toBe(false)
    expect(d.isDuplicate('msg-1'), 'second call should be duplicate').toBe(true)
    expect(d.isDuplicate('msg-2'), 'different ID should not be duplicate').toBe(false)
  })

  it('EmptyID', () => {
    const d = new MessageDedup()
    expect(d.isDuplicate(''), 'empty ID should never be duplicate').toBe(false)
    expect(d.isDuplicate(''), 'empty ID should never be duplicate on second call').toBe(false)
  })

  it('Concurrent', async () => {
    // Go: 100 goroutines call IsDuplicate concurrently. JS: the same 100
    // calls as microtasks on one thread; the no-crash/no-corruption
    // invariant is what the Go suite pinned down.
    const d = new MessageDedup()
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(d.isDuplicate(`msg-${String.fromCharCode(97 + (i % 26))}`))))
  })
})

describe('isOldMessage', () => {
  it('classifies around StartTime with a 2s grace period', () => {
    expect(isOldMessage(Date.now()), 'current time should not be considered old').toBe(false)
    expect(isOldMessage(Date.now() + 60_000), 'future time should not be considered old').toBe(false)
    expect(isOldMessage(StartTime - 10_000), 'message 10s before startup should be old').toBe(true)
    expect(isOldMessage(StartTime - 1_000), 'message 1s before startup should be within grace period').toBe(false)
  })
})
