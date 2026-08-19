/**
 * Session-domain misc ported from cc-connect (M7-c):
 * reset_on_idle (Go maybeAutoResetSessionOnIdle + engine_test.go tests),
 * filter_external_sessions (/list owned-session filtering), and
 * auto_compress (Go SetAutoCompressConfig + cmdCompress + the turn-end
 * trigger) re-based on dsh's native ctx.compaction service. The
 * session_cleanup_days /cleanup of Go is not ported — see MIGRATION.md.
 *
 * @module dsh-feishu-bridge/tests-session-misc
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import {
  estimateTokensWithPendingAssistant,
  maybeAutoResetSessionOnIdle,
  registerSessionMiscCommands,
  runCompress,
} from '../../src/engine/session-misc.js'
import type { Agent, AgentSessionInfo, Message } from '../../src/core/types.js'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  newResultAgentSession,
  type ControllableAgentSession,
  type StubPlatform,
} from '../stubs/engine-stubs.js'

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:user1',
    platform: 'test',
    messageID: '',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
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

function newEngine(agent: Agent): { e: Engine; p: StubPlatform } {
  const p = createStubPlatform('test')
  const e = new Engine('test', agent, [p], '', 'en')
  return { e, p }
}

// ── reset_on_idle (engine_test.go AutoResetOnIdle) ───────────────────────

describe('reset_on_idle', () => {
  it('rotates a stale session to a fresh one and preserves the old session', async () => {
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => newResultAgentSession('fresh reply') })
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const old = e.sessions.getOrCreateActive(key)
    old.addHistory('user', 'stale context')
    old.setAgentSessionID('old-session', 'stub')
    old.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    e.handleMessage(p, msg({ content: 'hello after idle', userID: 'u1' }))
    await vi.waitFor(() => {
      const active = e.sessions.getOrCreateActive(key)
      expect(active.id).not.toBe(old.id)
      expect(active.getHistory(0).length).toBeGreaterThanOrEqual(2)
    })

    const active = e.sessions.getOrCreateActive(key)
    const history = active.getHistory(0)
    expect(history[0]?.role).toBe('user')
    expect(history[0]?.content).toBe('hello after idle')
    expect(history[1]?.content).toBe('fresh reply')
    // The old session keeps its identity for /switch back.
    expect(old.getAgentSessionID()).toBe('old-session')
    expect(old.getHistory(0).length).toBe(1)
    const sent = p.getSent()
    expect(sent[0]).toContain(e.i18n.t('session_auto_reset_idle').split('%d')[0] ?? 'auto-reset')
    expect(sent[sent.length - 1]).toBe('fresh reply')
  })

  it('does not rotate a fresh session', async () => {
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => newResultAgentSession('normal reply') })
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.addHistory('user', 'recent context')
    session.setAgentSessionID('existing-session', 'stub')
    session.updatedAt = new Date(Date.now() - 5 * 60_000).toISOString()

    e.handleMessage(p, msg({ content: 'follow up', userID: 'u1' }))
    await vi.waitFor(() => { expect(session.getHistory(0).length).toBeGreaterThanOrEqual(2) })

    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
    for (const line of p.getSent()) {
      expect(line).not.toContain('auto-reset')
    }
  })

  it('does not trigger for a slash command', async () => {
    const { e, p } = newEngine(createStubAgent())
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.addHistory('user', 'stale context')
    session.setAgentSessionID('old-session', 'stub')
    session.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    e.handleMessage(p, msg({ content: '/list', userID: 'u1' }))
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
  })

  it('a session with no history and no backend is never rotated', () => {
    const { e, p } = newEngine(createStubAgent())
    e.setResetOnIdle(60_000)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    const rotated = maybeAutoResetSessionOnIdle(e, p, msg(), session)

    expect(rotated).toBeUndefined()
    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
  })
})

// ── filter_external_sessions (engine_test.go FilterExternalSessions) ─────

function listAgent(sessions: AgentSessionInfo[]): Agent {
  return { ...createStubAgent(), listSessions: async () => sessions }
}

describe('filter_external_sessions', () => {
  it('only shows tracked sessions when enabled', async () => {
    const agent = listAgent([
      { id: 'tracked-1', summary: 'Tracked 1', messageCount: 5, modifiedAt: Date.now() },
      { id: 'tracked-2', summary: 'Tracked 2', messageCount: 3, modifiedAt: Date.now() },
      { id: 'external-1', summary: 'External CLI session', messageCount: 10, modifiedAt: Date.now() },
    ])
    const { e, p } = newEngine(agent)
    registerSessionCommands(e)
    e.setFilterExternalSessions(true)
    const key = 'test:user1'
    const s1 = e.sessions.getOrCreateActive(key)
    s1.setAgentSessionID('tracked-1', 'dsh')
    // s1's id moves on: 'tracked-1' lands in pastAgentSessionIDs and stays known.
    s1.setAgentSessionID('', '')
    const s2 = e.sessions.newSession(key, 'session2')
    s2.setAgentSessionID('tracked-2', 'dsh')

    e.dispatchCommand(p, msg(), '/list')
    await vi.waitFor(() => { expect(p.getSent().length).toBe(1) })

    const reply = p.getSent()[0] ?? ''
    expect(reply).toContain('Tracked 1')
    expect(reply).toContain('Tracked 2')
    expect(reply).not.toContain('External CLI session')
  })

  it('shows all sessions by default', async () => {
    const agent = listAgent([
      { id: 'tracked-1', summary: 'Tracked session', messageCount: 5, modifiedAt: Date.now() },
      { id: 'external-1', summary: 'External session', messageCount: 10, modifiedAt: Date.now() },
    ])
    const { e, p } = newEngine(agent)
    registerSessionCommands(e)
    const s = e.sessions.getOrCreateActive('test:user1')
    s.setAgentSessionID('tracked-1', 'dsh')

    e.dispatchCommand(p, msg(), '/list')
    await vi.waitFor(() => { expect(p.getSent().length).toBe(1) })

    const reply = p.getSent()[0] ?? ''
    expect(reply).toContain('Tracked session')
    expect(reply).toContain('External session')
  })
})

// ── NO_REPLY #28 (engine-level suppression) ──────────────────────────────

describe('NO_REPLY turn suppression', () => {
  it('a bare NO_REPLY result delivers no text and keeps the marker in history', async () => {
    const cs = newControllableSession('s1')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)

    cs.channel.push({ type: 'result', content: 'NO_REPLY', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    expect(p.getSent()).toEqual([])
    // The agent's own decision stays in the transcript (Go records the
    // original baseResponse).
    const history = session.getHistory(0)
    expect(history.some(h => h.role === 'assistant' && h.content.includes('NO_REPLY'))).toBe(true)
  })

  it('a trailing NO_REPLY marker strips the marker but delivers the text', async () => {
    const cs = newControllableSession('s1')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)

    cs.channel.push({ type: 'result', content: '先说结论。\n\nNO_REPLY', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)

    const sent = p.getSent().join('')
    expect(sent).toContain('先说结论。')
    expect(sent).not.toContain('NO_REPLY')
  })
})

// ── auto_compress ────────────────────────────────────────────────────────

/** A controllable session with a recording compressor. */
function compressorSession(id: string): ControllableAgentSession & { compressCalls: number; fail?: Error } {
  const s = newControllableSession(id)
  const rec = { ...s, compressCalls: 0 } as ControllableAgentSession & { compressCalls: number; fail?: Error }
  ;(rec as unknown as { compress(signal?: AbortSignal): Promise<void> }).compress = async () => {
    rec.compressCalls++
    if (rec.fail !== undefined) throw rec.fail
  }
  return rec
}

describe('estimateTokensWithPendingAssistant', () => {
  it('estimates one token per four runes including the pending reply', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(40), timestamp: '1' },
      { role: 'assistant' as const, content: 'b'.repeat(10), timestamp: '2' },
    ]
    expect(estimateTokensWithPendingAssistant(history, 'c'.repeat(6))).toBe(14)
    expect(estimateTokensWithPendingAssistant([], '')).toBe(0)
    expect(estimateTokensWithPendingAssistant([{ role: 'user' as const, content: 'x'.repeat(400), timestamp: '1' }], '')).toBe(100)
  })
})

describe('/compress', () => {
  it('compresses through the session compressor and replies done', async () => {
    const cs = compressorSession('s1')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    registerSessionMiscCommands(e)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:user1', state)

    e.dispatchCommand(p, msg(), '/compress')
    await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThanOrEqual(2) })

    expect(cs.compressCalls).toBe(1)
    const sent = p.getSent()
    expect(sent[0]).toContain('🗜')
    expect(sent.some(m => m.includes('✅') || m === e.i18n.t('compress_done'))).toBe(true)
  })

  it('replies not-supported when the session cannot compress', async () => {
    const cs = newControllableSession('s1')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    registerSessionMiscCommands(e)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:user1', state)

    e.dispatchCommand(p, msg(), '/compress')
    await vi.waitFor(() => { expect(p.getSent().length).toBe(2) })

    expect(p.getSent()[1]).toBe(e.i18n.t('compress_not_supported'))
  })

  it('replies no-session without a live agent session', async () => {
    const { e, p } = newEngine(createStubAgent())
    registerSessionMiscCommands(e)

    e.dispatchCommand(p, msg(), '/compress')
    await vi.waitFor(() => { expect(p.getSent().length).toBe(1) })

    expect(p.getSent()[0]).toBe(e.i18n.t('compress_no_session'))
  })
})

describe('auto_compress trigger', () => {
  it('fires runCompress after a long turn when the estimate crosses the cap', async () => {
    const cs = compressorSession('s1')
    const agent = { ...createStubAgent(), startSession: async () => cs }
    const { e, p } = newEngine(agent)
    registerSessionMiscCommands(e)
    e.setAutoCompressConfig(true, 10, 0)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(sessionKey, state)
    session.addHistory('user', 'x'.repeat(200))

    cs.channel.push({ type: 'result', content: 'y'.repeat(100), done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await vi.waitFor(() => { expect(cs.compressCalls).toBe(1) })

    // The auto path still notifies the user about the compaction.
    expect(p.getSent().some(m => m.includes('🗜'))).toBe(true)
  })

  it('does not re-trigger within the min gap', async () => {
    const cs = compressorSession('s1')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    registerSessionMiscCommands(e)
    e.setAutoCompressConfig(true, 10, 30 * 60_000)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:user1', state)
    state.lastAutoCompressAt = Date.now()
    const session = e.sessions.getOrCreateActive('test:user1')
    session.addHistory('user', 'x'.repeat(200))

    cs.channel.push({ type: 'result', content: 'y'.repeat(100), done: true })
    await e.processInteractiveEvents(state, session, e.sessions, 'test:user1', 'm1', undefined, state.replyCtx)
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(cs.compressCalls).toBe(0)
  })

  it('runCompress surfaces failures without throwing', async () => {
    const cs = compressorSession('s1')
    cs.fail = new Error('busy')
    const { e, p } = newEngine({ ...createStubAgent(), startSession: async () => cs })
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:user1', state)
    const session = e.sessions.getOrCreateActive('test:user1')
    session.addHistory('user', 'locked-turn')

    await runCompress(e, state, p, 'ctx', false)
    expect(p.getSent().some(m => m.includes('busy'))).toBe(true)
  })
})
