/**
 * Card-style structured progress card finalization: with the default display
 * config the compact writer (not the stream preview) owns the progress card
 * the user watches on card-style platforms; its state must reach a terminal
 * color when the turn settles (Go EventResult's cp.Finalize, gated on
 * !sp.inProgressMode — when the preview card carries tool progress, the
 * preview's own terminal render is the visible one).
 *
 * @module dsh-feishu-bridge/tests-engine-card-progress-finalize
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.js'
import type { Platform, ProgressContent } from '../../src/core/types.js'

interface CardProgressPlatform extends Platform {
  starts: ProgressContent[]
  updates: ProgressContent[]
}

/** Card-style platform recording structured preview traffic in order. */
function createCardProgressPlatform(): CardProgressPlatform {
  const starts: ProgressContent[] = []
  const updates: ProgressContent[] = []
  return Object.assign(createStubPlatform('feishu'), {
    starts,
    updates,
    progressStyle: () => 'card',
    supportsProgressCardPayload: () => true,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      starts.push(content)
      return 'progress-card-1'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      updates.push(content)
    },
  })
}

/** State of a recorded card-kind content, '' for text-kind entries. */
function cardStateOf(content: ProgressContent): string {
  return content.kind === 'card' ? (content.payload.state ?? '') : ''
}

describe('card-style progress card finalization', () => {
  it('greens the structured card when the turn completes', async () => {
    const p = createCardProgressPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const sess = newControllableSession('finalize-1')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    sess.channel.push({ type: 'thinking', content: '分析请求', done: false })
    sess.channel.push({ type: 'result', content: '答案在此', done: true })

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')

    expect(p.starts.length, `starts=${JSON.stringify(p.starts)}`).toBe(1)
    expect(p.starts[0]?.kind).toBe('card')
    const states = p.updates.map(cardStateOf)
    expect(states, `updates=${JSON.stringify(states)}`).toContain('completed')
  })

  it('fails the structured card when the turn errors', async () => {
    const p = createCardProgressPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const sess = newControllableSession('finalize-2')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    sess.channel.push({ type: 'thinking', content: '分析请求', done: false })
    sess.channel.push({ type: 'result', content: '', errorText: 'provider down', done: true })

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')

    const states = p.updates.map(cardStateOf)
    expect(states, `updates=${JSON.stringify(states)}`).toContain('failed')
  })

  it('fails the structured card on an error event (not only an errored result)', async () => {
    const p = createCardProgressPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const sess = newControllableSession('finalize-3')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    sess.channel.push({ type: 'thinking', content: '分析请求', done: false })
    sess.channel.push({ type: 'error', error: new Error('agent crashed'), content: '', done: true })

    await e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')

    const states = p.updates.map(cardStateOf)
    expect(states, `updates=${JSON.stringify(states)}`).toContain('failed')
  })
})
