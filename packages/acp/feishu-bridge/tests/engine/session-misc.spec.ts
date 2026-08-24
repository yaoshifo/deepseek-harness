/**
 * Session-domain misc ported from cc-connect (M7-c):
 * reset_on_idle (Go maybeAutoResetSessionOnIdle + engine_test.go tests) and
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
import type { Agent, HistoryEntry, Message, RecentTurnsReader } from '../../src/core/types.js'
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

/** Agent whose recent-turn window serves a fixed entry list per native session id. */
function windowAgent(entriesBySession: Record<string, HistoryEntry[]>): Agent & RecentTurnsReader {
  return {
    ...createStubAgent(),
    recentTurns: async (id: string) => entriesBySession[id] ?? [],
  }
}

// ── reset_on_idle (engine_test.go AutoResetOnIdle) ───────────────────────

describe('reset_on_idle', () => {
  it('rotates a stale session to a fresh one and preserves the old session', async () => {
    const { e, p } = newEngine({
      ...windowAgent({ 'old-session': [{ role: 'user', content: 'stale context', timestamp: '2026-01-01T00:00:00Z' }] }),
      startSession: async () => newResultAgentSession('fresh reply'),
    })
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const old = e.sessions.getOrCreateActive(key)
    old.setAgentSessionID('old-session', 'stub')
    old.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    await e.handleMessage(p, msg({ content: 'hello after idle', userID: 'u1' }))
    await vi.waitFor(() => {
      expect(e.sessions.getOrCreateActive(key).id).not.toBe(old.id)
    })

    // The old session keeps its identity for /switch back.
    expect(old.getAgentSessionID()).toBe('old-session')
    await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThan(1) })
    const sent = p.getSent()
    expect(sent[0]).toContain(e.i18n.t('session_auto_reset_idle').split('%d')[0] ?? 'auto-reset')
    expect(sent[sent.length - 1]).toBe('fresh reply')
  })

  it('does not rotate a fresh session', async () => {
    const { e, p } = newEngine({
      ...windowAgent({ 'existing-session': [{ role: 'user', content: 'recent context', timestamp: '2026-01-01T00:00:00Z' }] }),
      startSession: async () => newResultAgentSession('normal reply'),
    })
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.setAgentSessionID('existing-session', 'stub')
    session.updatedAt = new Date(Date.now() - 5 * 60_000).toISOString()

    await e.handleMessage(p, msg({ content: 'follow up', userID: 'u1' }))
    await vi.waitFor(() => { expect(p.getSent().length).toBeGreaterThan(0) })

    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
    for (const line of p.getSent()) {
      expect(line).not.toContain('auto-reset')
    }
  })

  it('does not trigger for a slash command', async () => {
    const { e, p } = newEngine(windowAgent({ 'old-session': [{ role: 'user', content: 'stale context', timestamp: '2026-01-01T00:00:00Z' }] }))
    e.setResetOnIdle(60 * 60_000)
    registerSessionCommands(e)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.setAgentSessionID('old-session', 'stub')
    session.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    await e.handleMessage(p, msg({ content: '/list', userID: 'u1' }))
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
  })

  it('a session with no history and no backend is never rotated', async () => {
    const { e, p } = newEngine(createStubAgent())
    e.setResetOnIdle(60_000)
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    session.updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()

    const rotated = await maybeAutoResetSessionOnIdle(e, p, msg(), session)

    expect(rotated).toBeUndefined()
    expect(e.sessions.getOrCreateActive(key).id).toBe(session.id)
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
  it('resolves the compact alias (Go builtinCommands)', () => {
    const { e } = newEngine(createStubAgent())
    registerSessionMiscCommands(e)
    expect(e.commandResolver?.('compact')).toBe('compress')
  })

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
    // The estimate reads the agent's recent-turn window for the live session.
    const agent: Agent & RecentTurnsReader = {
      ...createStubAgent(),
      startSession: async () => cs,
      recentTurns: async (id: string) => id === 's1'
        ? [{ role: 'user', content: 'x'.repeat(200), timestamp: '2026-01-01T00:00:00Z' }]
        : [],
    }
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

    cs.channel.push({ type: 'result', content: 'y'.repeat(100), done: true })
    await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
    await vi.waitFor(() => { expect(cs.compressCalls).toBe(1) })

    // The auto path still notifies the user about the compaction.
    expect(p.getSent().some(m => m.includes('🗜'))).toBe(true)
  })

  it('does not re-trigger within the min gap', async () => {
    const cs = compressorSession('s1')
    const agent: Agent & RecentTurnsReader = {
      ...createStubAgent(),
      startSession: async () => cs,
      recentTurns: async (id: string) => id === 's1'
        ? [{ role: 'user', content: 'x'.repeat(200), timestamp: '2026-01-01T00:00:00Z' }]
        : [],
    }
    const { e, p } = newEngine(agent)
    registerSessionMiscCommands(e)
    e.setAutoCompressConfig(true, 10, 30 * 60_000)
    const state = new InteractiveState()
    state.agentSession = cs
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:user1', state)
    state.lastAutoCompressAt = Date.now()
    const session = e.sessions.getOrCreateActive('test:user1')

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

    await runCompress(e, state, p, 'ctx', false)
    expect(p.getSent().some(m => m.includes('busy'))).toBe(true)
  })
})
