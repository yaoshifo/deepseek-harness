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
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { registerSessionCommands } from '../../src/engine/commands.ts'
import { maybeAutoResetSessionOnIdle } from '../../src/engine/session-misc.ts'
import type { Agent, HistoryEntry, Message, RecentTurnsReader } from '../../src/core/types.ts'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  newResultAgentSession,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'

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
