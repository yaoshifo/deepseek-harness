/**
 * Queued-message takeover surface wiring: the in-loop drain that hands the
 * event loop to a queued message must install a fresh streaming preview into
 * the interactive state — the loop re-reads it from the state at every select
 * boundary, so a stale preview PATCHes the previous turn's already-terminal
 * card.
 *
 * @module dsh-feishu-bridge/tests-engine-queued-takeover
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import type { QueuedMessage } from '../../src/engine/engine.ts'
import { createStubAgent, createStubPlatform, newControllableSession, type ControllableAgentSession } from '../stubs/engine-stubs.ts'
import type { Platform, ProgressContent } from '../../src/core/types.ts'

/** Platform recording every preview start in order. */
function createCardRecorderPlatform(): Platform & { starts: ProgressContent[] } {
  const starts: ProgressContent[] = []
  return Object.assign(createStubPlatform('feishu'), {
    starts,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      starts.push(content)
      return `card-${starts.length}`
    },
    async updateMessage(_rc: unknown, _content: ProgressContent): Promise<void> {},
  })
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

describe('queued takeover installs fresh turn surfaces', () => {
  it('the queued turn opens its own card, not the previous turn\'s', async () => {
    const p = createCardRecorderPlatform()
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    // Tool progress hands the card to the stream preview: each turn's pump
    // opens its own placeholder card.
    e.setDisplayConfig({ toolProgress: true })
    const key = 'test:user1'
    const sess: ControllableAgentSession = newControllableSession('takeover-1')
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.pendingMessages = [queuedMsg(p, 'second turn')]
    e.interactiveStates.set(key, state)

    // Turn 2's events arrive from the send hook, mirroring real adapters
    // (the queued arm drains the channel before send).
    const origSend = sess.send.bind(sess)
    sess.send = (prompt: string) => {
      if (prompt.includes('second turn')) {
        setTimeout(() => {
          sess.channel.push({ type: 'thinking', content: 'second turn thinking', done: false })
          sess.channel.push({ type: 'result', content: 'second turn done', done: true })
        }, 10)
      }
      return origSend(prompt, [], [])
    }

    sess.channel.push({ type: 'thinking', content: 'first turn thinking', done: false })
    sess.channel.push({ type: 'result', content: 'first turn done', done: true })

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx'),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('loop did not finish')) }, 5000) }),
    ])

    // Turn 1 opened one card; the queued turn must open a SECOND card through
    // the fresh preview instead of PATCHing the previous turn's (already
    // terminal) card.
    expect(p.starts.length, `starts=${JSON.stringify(p.starts.map(c => c.text))}`).toBe(2)
  })
})
