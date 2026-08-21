/**
 * Fork-at session-start degradation (Go engine_events.go __forkat__ guard):
 * when the truncated transcript behind a `__forkat__<newID>` sentinel cannot
 * be resumed (the persisted copy vanished between cmdFork and the child's
 * first message), the engine falls back to a fresh session and tells the user
 * with the fork-degrade wording instead of the generic resume-degrade one.
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import type { Message } from '../../src/core/types.js'
import { createStubAgent, createStubAgentSession, createStubPlatform } from '../stubs/engine-stubs.js'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:oc_child:ou_u',
    platform: 'test',
    messageID: 'm1',
    userID: 'user1',
    userName: '',
    chatName: 'child',
    chatType: 'group',
    content: 'hello',
    originalContent: 'hello',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

describe('fork-at resume failure degrades to a fresh session', () => {
  it('replies with the fork-degrade wording and replaces the sentinel', async () => {
    const p = createStubPlatform('test')
    const started: string[] = []
    const agent = {
      ...createStubAgent(),
      startSession: async (id: string) => {
        started.push(id)
        if (id.startsWith('__forkat__')) throw new Error('dsh: session not found')
        return createStubAgentSession()
      },
    }
    const e = new Engine('test', agent, [p], '', 'en')
    e.sessions.getOrCreateActive('test:oc_child:ou_u').setAgentSessionID('__forkat__cc-gone', 'stub')

    e.receiveMessage(p, msg())
    const deadline = Date.now() + 2000
    while (p.sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 5) })
    }

    // first attempt hits the sentinel; the fallback starts fresh
    expect(started[0]).toBe('__forkat__cc-gone')
    expect(started[1]).toBe('')
    expect(p.sent[0]).toContain('Fork degraded')
    // the sentinel is replaced by the fresh session's concrete id
    expect(e.sessions.getOrCreateActive('test:oc_child:ou_u').getAgentSessionID()).toBe('stub-session')
  })
})
