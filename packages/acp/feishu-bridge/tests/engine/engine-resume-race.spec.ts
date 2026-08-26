/**
 * Resume races against agent-session teardown (2026-08-21 incident, chat
 * oc_6ee6): a user stop (⏹/停止) removes the interactive state and closes the
 * agent session fire-and-forget; the immediately following 「继续」 resumes the
 * same persisted id while dsh still holds it live, the resume hard-fails, and
 * the engine degrades to a fresh session. These suites pin the three
 * mitigations: the stop's closing guard, the live-guard bounded retry, and
 * the degraded fallback rebinding the session record.
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import type { Agent, AgentSession, Message } from '../../src/core/types.js'
import { createStubAgent, createStubPlatform, newControllableSession } from '../stubs/engine-stubs.js'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:ch:user1',
    platform: 'test',
    messageID: 'm1',
    userID: 'user1',
    userName: '',
    chatName: '',
    chatType: '',
    content: '继续',
    originalContent: '继续',
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

async function waitFor(verify: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!verify() && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  expect(verify()).toBe(true)
}

/** A session whose send pushes one result event; close can be deferred. */
function resultSession(id: string, result: string): AgentSession & {
  releaseClose: () => void
  closeStarted: Promise<void>
} {
  const base = newControllableSession(id)
  base.sessionID = id
  base.send = async () => {
    base.channel.push({ type: 'result', content: result, done: true })
  }
  let release!: () => void
  const closeGate = new Promise<void>((resolve) => { release = resolve })
  let closeSignalled!: () => void
  const closeStarted = new Promise<void>((resolve) => { closeSignalled = resolve })
  base.close = async () => {
    if (!base.aliveFlag) return
    closeSignalled()
    await closeGate
    base.aliveFlag = false
    base.channel.close()
  }
  return { ...base, releaseClose: release, closeStarted }
}

describe('stop then continue waits out the agent teardown', () => {
  it('does not degrade when the message arrives while close is still in flight', async () => {
    const p = createStubPlatform('test')
    const resumed = resultSession('sess-1', 'second reply')
    const first = resultSession('sess-1', 'first reply')
    const startCalls: string[] = []
    const agent: Agent = {
      ...createStubAgent(),
      startSession: async (id: string) => {
        startCalls.push(id)
        return id === '' ? first : resumed
      },
    }
    const e = new Engine('test', agent, [p], '', 'en')
    const key = 'test:ch:user1'

    e.receiveMessage(p, msg({ content: 'task' }))
    await waitFor(() => p.sent.some(s => s.includes('first reply')))

    expect(e.stopInteractiveSession(key)).toBe(true)
    e.receiveMessage(p, msg())

    // Close is deferred: the follow-up must wait, not resume or degrade.
    await first.closeStarted
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    expect(startCalls).toEqual([''])
    expect(p.sent.some(s => s.includes('Session resume failed') || s.includes('会话恢复失败'))).toBe(false)

    first.releaseClose()
    await waitFor(() => p.sent.some(s => s.includes('second reply')))
    expect(startCalls).toEqual(['', 'sess-1'])
    expect(p.sent.some(s => s.includes('Session resume failed') || s.includes('会话恢复失败'))).toBe(false)
  })
})

describe('live-guard resume failure retries before degrading', () => {
  it('retries the resume after the live guard and completes without degrade', async () => {
    const p = createStubPlatform('test')
    const recovered = resultSession('sess-1', 'recovered reply')
    let liveGuardThrows = 1
    const startCalls: string[] = []
    const agent: Agent = {
      ...createStubAgent(),
      startSession: async (id: string) => {
        startCalls.push(id)
        if (id === 'sess-1' && liveGuardThrows > 0) {
          liveGuardThrows--
          throw new Error('cannot prepare session "sess-1" while it is live')
        }
        return recovered
      },
    }
    const e = new Engine('test', agent, [p], '', 'en')
    e.setLiveGuardRetryBudgetMs(2000, 10)
    const key = 'test:ch:user1'
    e.sessions.getOrCreateActive(key).setAgentSessionID('sess-1', 'stub')

    e.receiveMessage(p, msg())
    await waitFor(() => p.sent.some(s => s.includes('recovered reply')))
    expect(startCalls).toEqual(['sess-1', 'sess-1'])
    expect(p.sent.some(s => s.includes('Session resume failed') || s.includes('会话恢复失败'))).toBe(false)
  })

  it('degrades and rebinds the session record when the live guard never clears', async () => {
    const p = createStubPlatform('test')
    const fresh = resultSession('sess-fresh', 'fresh reply')
    const agent: Agent = {
      ...createStubAgent(),
      startSession: async (id: string) => {
        if (id === 'sess-1') throw new Error('cannot prepare session "sess-1" while it is live')
        return fresh
      },
    }
    const e = new Engine('test', agent, [p], '', 'en')
    e.setLiveGuardRetryBudgetMs(30, 10)
    const key = 'test:ch:user1'
    const record = e.sessions.getOrCreateActive(key)
    record.setAgentSessionID('sess-1', 'stub')

    e.receiveMessage(p, msg())
    await waitFor(() => p.sent.some(s => s.includes('Session resume failed') || s.includes('会话恢复失败')))
    await waitFor(() => p.sent.some(s => s.includes('fresh reply')))

    // The poisoned id must not stay pinned: the record follows the fresh
    // session so the chat's next message resumes the fresh id.
    expect(record.getAgentSessionID()).toBe('sess-fresh')
  })
})

describe('stop-path close is bounded', () => {
  it('warns and abandons a hung close after the timeout instead of leaking silently', async () => {
    const p = createStubPlatform('test')
    const base = newControllableSession('sess-1')
    base.sessionID = 'sess-1'
    base.send = async () => {
      base.channel.push({ type: 'result', content: 'first reply', done: true })
    }
    base.close = (): Promise<void> => new Promise(() => {})
    const agent: Agent = { ...createStubAgent(), startSession: async () => base }
    const e = new Engine('test', agent, [p], '', 'en')
    e.setAgentCloseTimeout(100)
    const key = 'test:ch:user1'

    e.receiveMessage(p, msg({ content: 'task' }))
    await waitFor(() => p.sent.some(s => s.includes('first reply')))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(e.stopInteractiveSession(key)).toBe(true)
      await waitFor(() => warnSpy.mock.calls.some(c => String(c[0]).includes('close timed out')))
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('close timed out'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
