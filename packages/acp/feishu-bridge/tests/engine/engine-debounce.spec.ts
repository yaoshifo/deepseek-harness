/**
 * Debounce-window semantics for drained queued messages (Go
 * debounceWaitAndMerge): the wait must yield to the event loop — timers and
 * other macrotask work keep running inside the window — and a message queued
 * during the window merges into the lead turn instead of opening a second
 * one.
 *
 * @module dsh-feishu-bridge/tests-engine-debounce
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import type { QueuedMessage } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform, newQueuingSession } from '../stubs/engine-stubs.js'
import type { Platform } from '../../src/core/types.js'

/** Queuing session whose every Send immediately emits a result event, so each
 * drained turn terminates instead of parking on the idle watchdog. */
function newResultingQueuingSession(id: string): ReturnType<typeof newQueuingSession> {
  const s = newQueuingSession(id)
  const origSend = s.send
  s.send = async (prompt: string) => {
    await origSend(prompt, [], [])
    s.channel.push({ type: 'result', content: 'done', done: true })
  }
  return s
}

function queuedMsg(p: Platform, content: string): QueuedMessage {
  return {
    platform: p,
    replyCtx: 'ctx',
    messageID: '',
    content,
    images: [],
    files: [],
    fromVoice: false,
    isSpawnedGroup: false,
    userID: 'user1',
    userName: 'User One',
    msgPlatform: 'test',
    msgSessionKey: 'test:user1',
    metadata: undefined,
  }
}

interface DebounceEngine {
  e: Engine
  p: ReturnType<typeof createStubPlatform>
  sess: ReturnType<typeof newQueuingSession>
  key: string
  state: InteractiveState
}

function newDebounceEngine(): DebounceEngine {
  const p = createStubPlatform()
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  const sess = newResultingQueuingSession('deb-1')
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  session.tryLock()
  const state = new InteractiveState()
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  return { e, p, sess, key, state }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { setTimeout(() => { reject(new Error(label)) }, ms) }),
  ])
}

describe('DebounceWaitAndMerge', () => {
  it('yields to the event loop: a timer fires inside the debounce window', async () => {
    const { e, p, sess, key, state } = newDebounceEngine()
    e.setDebounceInterval(300)
    state.pendingMessages.push(queuedMsg(p, 'first message'))

    const drainP = e.drainPendingMessages(state, e.sessions.getOrCreateActive(key), e.sessions, key)

    const t0 = Date.now()
    await new Promise((r) => { setTimeout(r, 5) })
    const elapsed = Date.now() - t0
    // A spinning microtask loop starves every timer until the whole window
    // elapses; a sleep-poll of ~10ms lets the 5ms timer fire right away.
    expect(elapsed, '5ms timer must fire well inside the 300ms window').toBeLessThan(150)

    await withTimeout(drainP, 2000, 'drain did not finish')
    sess.close()
  })

  it('merges a message queued inside the window into the lead turn', async () => {
    const { e, p, sess, key, state } = newDebounceEngine()
    e.setDebounceInterval(250)
    state.pendingMessages.push(queuedMsg(p, 'first message'))

    const drainP = e.drainPendingMessages(state, e.sessions.getOrCreateActive(key), e.sessions, key)
    // A message queued from a macrotask inside the window merges into the
    // lead turn; the merge re-arms the window.
    setTimeout(() => { state.pendingMessages.push(queuedMsg(p, 'second message')) }, 30)

    await withTimeout(drainP, 3000, 'drain did not finish')
    sess.close()

    expect(sess.sendCalls, 'both messages share one lead turn').toHaveLength(1)
    expect(sess.sendCalls[0]).toContain('first message')
    expect(sess.sendCalls[0]).toContain('second message')
  })
})
