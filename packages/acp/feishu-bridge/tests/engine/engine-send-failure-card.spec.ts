/**
 * Prompt-send failure terminalization: the loop's send arm is the one
 * failure path that left the placeholder card in its running state with a
 * live stop button — the error-event path (engine.ts case 'error') marks
 * the card failed and flags a resync; the send arm must do the same before
 * its error reply.
 *
 * @module dsh-feishu-bridge/tests-engine-send-failure-card
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.ts'
import type { Platform, ProgressContent } from '../../src/core/types.ts'

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

describe('processInteractiveEvents prompt-send failure', () => {
  it('fails the placeholder card and flags a resync before the error reply', async () => {
    const p = createPreviewStatesPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    e.setDisplayConfig({ toolProgress: true })
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = newControllableSession('send-fail-1')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    // The placeholder lands first (as over a real platform round-trip), then
    // the prompt send fails — settled the way the loop's callers settle it
    // (rejection mapped to a resolved error value).
    const sendDone = new Promise<unknown>((resolve) => {
      setTimeout(() => { resolve(new Error('prompt send failed')) }, 30)
    })

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')

    expect(p.states.includes('failed'), `states=${JSON.stringify(p.states)}`).toBe(true)
    expect(state.eventsNeedResync, 'the next turn must drain the channel first').toBe(true)
  })
})
