/**
 * Async sender tests ported from cc-connect core/async_sender_test.go. The
 * Go blocking-channel patterns become deferred promises; timing windows keep
 * the original real sleeps.
 *
 * @module dsh-feishu-bridge/tests-async-sender
 */

import { describe, expect, it } from 'vitest'
import { newAsyncSender } from '../src/async-sender.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('AsyncSender', () => {
  it('executes in FIFO order', async () => {
    const as = newAsyncSender('test')
    try {
      const order: number[] = []
      for (let i = 0; i < 10; i++) {
        as.enqueue(() => { order.push(i) })
      }
      await as.barrier()
      expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    } finally {
      as.close()
    }
  })

  it('barrier waits for in-flight work', async () => {
    const as = newAsyncSender('test')
    try {
      let ran = 0
      as.enqueue(async () => {
        await sleep(50)
        ran++
      })
      await as.barrier()
      expect(ran).toBe(1)
    } finally {
      as.close()
    }
  })

  it('double close does not throw', () => {
    const as = newAsyncSender('test')
    as.close()
    as.close()
  })

  it('drops when the queue is full (no deadlock)', async () => {
    const as = newAsyncSender('test')
    try {
      const block = deferred()
      as.enqueue(() => block.promise)
      await sleep(20) // consumer picks up the first item
      for (let i = 0; i < 256; i++) {
        as.enqueue(() => {})
      }
      as.enqueue(() => {}) // dropped, must not block
      block.resolve()
      await as.barrier()
    } finally {
      as.close()
    }
  })

  it('enqueueOrInline runs inline when the queue is full', async () => {
    const as = newAsyncSender('test')
    try {
      let ran = 0
      const block = deferred()
      as.enqueue(() => block.promise)
      await sleep(20)
      for (let i = 0; i < 256; i++) {
        as.enqueue(() => {})
      }
      as.enqueueOrInline(() => { ran++ })
      expect(ran).toBe(1)
      block.resolve()
      await as.barrier()
    } finally {
      as.close()
    }
  })

  it('concurrent enqueues all run', async () => {
    const as = newAsyncSender('test')
    try {
      let count = 0
      await Promise.all(Array.from({ length: 100 }, async () => {
        as.enqueue(() => { count++ })
      }))
      await as.barrier()
      expect(count).toBe(100)
    } finally {
      as.close()
    }
  })

  it('no panic after close', async () => {
    const as = newAsyncSender('test')
    as.close()
    as.enqueue(() => {})
    as.enqueueOrInline(() => {})
    await as.barrier()
  })

  it('coalescable requests skip stale snapshots (newest wins)', async () => {
    const as = newAsyncSender('test')
    try {
      const block = deferred()
      as.enqueue(() => block.promise)
      await sleep(20)
      const executed: number[] = []
      for (let i = 1; i <= 5; i++) {
        as.enqueueCoalescable(() => { executed.push(i) })
      }
      block.resolve()
      await as.barrier()
      expect(executed).toEqual([5])
    } finally {
      as.close()
    }
  })

  it('a lone coalescable request still runs', async () => {
    const as = newAsyncSender('test')
    try {
      let ran = 0
      as.enqueueCoalescable(() => { ran++ })
      await as.barrier()
      expect(ran).toBe(1)
    } finally {
      as.close()
    }
  })

  it('coalescable does not swallow barriers', async () => {
    const as = newAsyncSender('test')
    try {
      const block = deferred()
      as.enqueue(() => block.promise)
      await sleep(20)
      let executed = 0
      as.enqueueCoalescable(() => { executed += 10 })
      as.enqueueCoalescable(() => { executed += 100 })
      as.enqueueCoalescable(() => { executed += 1000 })
      block.resolve()
      await as.barrier()
      expect(executed).toBe(1000)
    } finally {
      as.close()
    }
  })

  it('regular requests interleaved with coalescable ones are never skipped', async () => {
    const as = newAsyncSender('test')
    try {
      const block = deferred()
      as.enqueue(() => block.promise)
      await sleep(20)
      const got: string[] = []
      const mk = (tag: string) => () => { got.push(tag) }
      as.enqueueCoalescable(mk('c1'))
      as.enqueueCoalescable(mk('c2')) // c1 stale, collapses into c2
      as.enqueue(mk('r1')) // regular — must run
      as.enqueueCoalescable(mk('c3'))
      as.enqueueCoalescable(mk('c4')) // c3 stale, collapses into c4
      block.resolve()
      await as.barrier()
      expect(got).toEqual(['c2', 'r1', 'c4'])
    } finally {
      as.close()
    }
  })
})
