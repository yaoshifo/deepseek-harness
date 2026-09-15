/**
 * Turn-loop catch-handler card finalization (2026-09-14 progress-card audit
 * F2): an exception escaping a turn loop's try block used to leave the card
 * it was driving frozen on 执行中 with a live stop button — the three catch
 * handlers only logged. They now settle that card, and they use
 * markFailedIfUnsettled rather than markFailed because an error can surface
 * after the turn already settled (the drain phase): failing a settled card
 * would overwrite its terminal render.
 *
 * @module dsh-feishu-bridge/tests-engine-turn-catch-card
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState, type QueuedMessage } from '../../src/engine/engine.ts'
import {
  createControllableAgent,
  createStubPlatform,
  ev,
  newControllableSession,
  newStubMessage,
  type ControllableAgentSession,
} from '../stubs/engine-stubs.ts'
import type { Event, Message, Platform, ProgressContent } from '../../src/core/types.ts'

/** Platform recording the header state of every preview send/PATCH. */
function createPreviewStatesPlatform(): Platform & { states: Array<string | undefined> } {
  const states: Array<string | undefined> = []
  return Object.assign(createStubPlatform('test'), {
    states,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      states.push(content.status?.state)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      states.push(content.status?.state)
    },
  })
}

/** Inbound message driving one user turn on `test:user1`. */
function turnMessage(): Message {
  return {
    ...newStubMessage(),
    sessionKey: 'test:user1',
    platform: 'test',
    userID: 'user1',
    content: 'hi',
    replyCtx: 'ctx',
  }
}

/** An event type the interactive switch cannot route; its assertNever throws. */
function malformedEvent(): Event {
  return { type: 'not-an-event', content: '', done: false } as unknown as Event
}

function queuedMessage(p: Platform): QueuedMessage {
  return {
    platform: p,
    replyCtx: 'ctx',
    messageID: '',
    content: 'queued turn',
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

/**
 * Wait until the recorder stops growing. A text-path turn's finalize tail can
 * land one more card PATCH after `processInteractiveMessageWith` returns, so a
 * baseline captured mid-tail would attribute that PATCH to the next turn.
 *
 * @param states - Recorder to watch.
 * @param stableMs - Length of the growth-free window that ends the wait.
 */
async function waitForQuiet(states: Array<string | undefined>, stableMs = 100): Promise<void> {
  let last = states.length
  let stableSince = Date.now()
  while (Date.now() - stableSince < stableMs) {
    await new Promise(resolve => setTimeout(resolve, 10))
    if (states.length !== last) {
      last = states.length
      stableSince = Date.now()
    }
  }
}

function statesPlatform(toolProgress: boolean = true): {
  p: Platform & { states: Array<string | undefined> }
  sess: ControllableAgentSession
  e: Engine
} {
  const p = createPreviewStatesPlatform()
  const sess = newControllableSession('turn-catch')
  const e = new Engine('test', createControllableAgent(sess), [p], '', 'en')
  // Tool progress hands the card to the stream preview, so each pump opens a
  // placeholder card the catch handlers can settle.
  e.setDisplayConfig({ toolProgress })
  return { p, sess, e }
}

describe('turn-loop catch handlers settle the card they left running', () => {
  it('fails the running card when the turn loop throws', async () => {
    const { p, sess, e } = statesPlatform()
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    expect(session.tryLock()).toBe(true)
    // The turn drains the fresh state's channel before its send, so the
    // malformed event is pushed from the send hook — the placeholder card is
    // already open when the loop reads it.
    sess.send = async (): Promise<void> => { sess.channel.push(malformedEvent()) }

    await e.processInteractiveMessageWith(p, turnMessage(), session, key)

    await vi.waitFor(
      () => { expect(p.states, `states=${JSON.stringify(p.states)}`).toContain('failed') },
      { timeout: 2000 },
    )
  })

  it('fails the queued turn card when the drained turn throws', async () => {
    const { p, sess, e } = statesPlatform()
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.pendingMessages = [queuedMessage(p)]
    e.interactiveStates.set(key, state)
    // The queued turn's pump opens its own card; the malformed event it reads
    // throws out of that pump into the drain loop's catch.
    sess.send = async (): Promise<void> => { sess.channel.push(malformedEvent()) }
    expect(session.tryLock()).toBe(true)

    await e.drainPendingMessages(state, session, e.sessions, key)

    await vi.waitFor(
      () => { expect(p.states, `states=${JSON.stringify(p.states)}`).toContain('failed') },
      { timeout: 2000 },
    )
  })

  it('leaves a card the turn already settled untouched when a later error escapes', async () => {
    // The card settles through the text path (no tool progress): finish()
    // keeps the preview handle, so a markFailed() from the safety net would
    // re-render the settled card (and a stopped card would flip color) —
    // markFailedIfUnsettled must leave it alone.
    const { p, sess, e } = statesPlatform(false)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)

    // Turn 1 streams text and completes: the card settles green.
    sess.send = async (): Promise<void> => {
      sess.channel.push({ type: 'text', content: '答案在此', done: false })
      sess.channel.push(ev({ type: 'result', content: '答案在此', done: true }))
    }
    expect(session.tryLock()).toBe(true)
    await e.processInteractiveMessageWith(p, turnMessage(), session, key)
    await vi.waitFor(
      () => { expect(p.states, `states=${JSON.stringify(p.states)}`).toContain('completed') },
      { timeout: 2000 },
    )
    await waitForQuiet(p.states)
    const settled = p.states.length

    // Turn 2 throws before installing its own card, so the escaping error
    // reaches the catch with turn 1's settled card still on the state.
    sess.send = (() => { throw new Error('prompt send threw') })
    expect(session.tryLock()).toBe(true)
    await e.processInteractiveMessageWith(p, turnMessage(), session, key)

    // Wait past the finalize tail so a clobbering fix cannot slip through by
    // being late.
    await waitForQuiet(p.states)
    expect(p.states.slice(settled), `states=${JSON.stringify(p.states)}`).toEqual([])
  })
})
