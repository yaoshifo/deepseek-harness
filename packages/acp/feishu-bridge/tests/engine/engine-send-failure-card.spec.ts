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

/** Platform recording preview starts/updates with their header states. */
function createPreviewStatesPlatform(): Platform & {
  states: Array<string | undefined>
  updates: ProgressContent[]
} {
  const states: Array<string | undefined> = []
  const updates: ProgressContent[] = []
  return Object.assign(createStubPlatform('test'), {
    states,
    updates,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      states.push(content.kind === 'text' ? content.status?.state : undefined)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      updates.push(content)
      states.push(content.kind === 'text' ? content.status?.state : undefined)
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

  it('fails the card-style structured progress card when a send fails after events flowed', async () => {
    // A slow send failure can settle after the agent already streamed a
    // thinking event (card style: that event opened the compact writer's
    // structured card). The send arm must fail that card too, not only the
    // stream preview — the same terminal treatment as the error event.
    const p = createPreviewStatesPlatform()
    Object.assign(p, {
      progressStyle: () => 'card',
      supportsProgressCardPayload: () => true,
    })
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = newControllableSession('send-fail-2')
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    state.agentSession.events().push({ type: 'thinking', content: '分析请求', done: false })
    const sendDone = new Promise<unknown>((resolve) => {
      setTimeout(() => { resolve(new Error('prompt send failed')) }, 30)
    })

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', sendDone, 'ctx')

    const cardStates = p.updates.map(c => (c.kind === 'card' ? (c.payload.state ?? '') : ''))
    expect(cardStates, `updates=${JSON.stringify(cardStates)}`).toContain('failed')
    expect(state.eventsNeedResync, 'the next turn must drain the channel first').toBe(true)
  })
})
