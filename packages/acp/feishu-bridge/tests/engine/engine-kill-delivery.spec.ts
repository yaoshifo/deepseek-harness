/**
 * Kill-path partial-answer delivery (dsh-im absorption batch 1, u4): the
 * two forceful exits — stall exhaustion and the hard turn cap — used to
 * return without delivering the turn's completed streamed text; the
 * channel-closed path already delivered it. Drives the event pump with a
 * controllable session that streams one text block then goes silent, and
 * asserts both kills deliver the completed textParts alongside their
 * notice.
 *
 * @module dsh-feishu-bridge/tests-engine-kill-delivery
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform } from '../../src/core/types.ts'

/** Platform whose sends succeed (records texts). */
function okPlatform(): Platform & { sent: string[] } {
  return createStubPlatform('test') as Platform & { sent: string[] }
}

/**
 * Run one turn whose session streams a text block, then goes silent until
 * the engine's idle watchdog kills it (no stall retries).
 * @param p - Platform recording sends.
 * @param opts - idle window.
 */
async function runKilledTurn(
  p: Platform,
  opts: { idleMs: number },
): Promise<{ e: Engine; state: InteractiveState }> {
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.setDisplayConfig({ toolProgress: false })
  e.setEventIdleTimeout(opts.idleMs)
  e.setStallMaxRetries(-1)
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  const state = new InteractiveState()
  const sess = newControllableSession('kill-session')
  // The prompt send resolves (success); the session streams one completed
  // text block, then the channel stays open and silent.
  sess.send = async () => {
    sess.channel.push({ type: 'text', content: 'precious partial answer', done: false })
  }
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  const sendDone = sess.send('task', [], [])
  await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')
  return { e, state }
}

/**
 * Run one turn whose session streams a text block, then keeps the pump fed
 * with thinking deltas under the idle window until the hard turn cap
 * (idle×2×3) fires on a delta event.
 * @param p - Platform recording sends.
 * @param opts - idle window.
 */
async function runHardCappedTurn(
  p: Platform,
  opts: { idleMs: number },
): Promise<{ e: Engine; state: InteractiveState }> {
  const e = new Engine('test', createStubAgent(), [p], '', 'en')
  e.setDisplayConfig({ toolProgress: false })
  e.setEventIdleTimeout(opts.idleMs)
  const key = 'test:user1'
  const session = e.sessions.getOrCreateActive(key)
  const state = new InteractiveState()
  const sess = newControllableSession('kill-session')
  sess.send = async () => {
    sess.channel.push({ type: 'text', content: 'precious partial answer', done: false })
    // Keep events flowing well past the hard cap (idle×2×3) without ever
    // completing the turn: each delta resets the stall clock, and the cap
    // check runs on every event arrival.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, Math.max(20, opts.idleMs / 4)))
      sess.channel.push({ type: 'thinking_delta', content: `tick ${i} `, done: false })
    }
  }
  state.agentSession = sess
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(key, state)
  const sendDone = sess.send('task', [], [])
  await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')
  return { e, state }
}

describe('kill-path partial-answer delivery', () => {
  it('stall exhaustion delivers the completed streamed text before the kill', { timeout: 10_000 }, async () => {
    const p = okPlatform()
    const { state } = await runKilledTurn(p, { idleMs: 80 })
    expect(state.textParts, 'the streamed block completed into textParts').toHaveLength(1)
    const texts = p.sent.join('\n')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious partial answer')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('stopped responding')
  })

  it('hard turn cap delivers the completed streamed text before the kill', { timeout: 10_000 }, async () => {
    const p = okPlatform()
    const { state } = await runHardCappedTurn(p, { idleMs: 80 })
    const texts = p.sent.join('\n')
    expect(state.textParts, 'the streamed block completed into textParts').toHaveLength(1)
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('precious partial answer')
    expect(texts, `sent=${JSON.stringify(p.sent)}`).toContain('exceeded the maximum turn duration')
  })
})
