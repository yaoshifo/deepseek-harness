/**
 * The unsolicited reader (Go runUnsolicitedReader, B5): after a foreground
 * turn's pump exits the reader owns the agent event channel — disarming after
 * the idle quiet period, staying alive while an ask is parked, a tool call is
 * in flight (tool-in-flight budget), or a background task is pending
 * (background grace), relaying spillover duplicate frames as plain text, and
 * disarming when a new user turn takes the channel back.
 *
 * @module dsh-feishu-bridge/tests-engine-unsolicited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import {
  createControllableAgent,
  createStubPlatform,
  newBlockingSendSession,
  newControllableSession,
  newPendingAsk,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'
import { previewText } from '../stubs/preview-content.ts'
import type { Agent, Platform, ProgressContent } from '../../src/core/types.ts'

const KEY = 'test:u1'

/** Engine + state with a live controllable session and an armed reader. */
function armed(p?: Platform, agent?: Agent): {
  e: Engine
  p: StubPlatform
  agentSession: ReturnType<typeof newControllableSession>
  state: InteractiveState
} {
  const platform = p ?? createStubPlatform()
  const agentSession = newControllableSession('s1')
  const e = new Engine('test', agent ?? createControllableAgent(agentSession), [platform], '', 'en')
  const state = new InteractiveState()
  state.agentSession = agentSession
  state.platform = platform
  state.replyCtx = 'ctx'
  e.interactiveStates.set(KEY, state)
  e.sessions.getOrCreateActive(KEY)
  return { e, p: platform as StubPlatform, agentSession, state }
}

describe('unsolicited reader idle timeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('disarms after the idle quiet period and marks the channel for resync', async () => {
    const { e, state } = armed()
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)
    expect(state.unsolicitedReader).toBeDefined()

    await vi.advanceTimersByTimeAsync(59_999)
    expect(state.unsolicitedReader).toBeDefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.eventsNeedResync).toBe(true)
  })

  it('zero disables the idle disarm', async () => {
    const { e, state } = armed()
    e.setUnsolicitedConfig({ idleTimeoutMs: 0 })
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(state.unsolicitedReader).toBeDefined()
  })

  it('stays armed while an ask is parked (the user deciding is not silence)', async () => {
    const { e, state } = armed()
    state.pendingAsk = newPendingAsk({ request: { kind: 'permission', toolName: 'bash', preview: 'ls' } })
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    await vi.advanceTimersByTimeAsync(180_000)
    expect(state.unsolicitedReader).toBeDefined()
  })
})

describe('unsolicited reader tool-in-flight budget', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('keeps the reader armed for a quiet in-flight tool, then finalizes past the budget', async () => {
    const { e, state } = armed()
    state.activeToolCalls = 1
    state.lastEventAt = Date.now()
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    // Idle fires repeatedly but the tool stays within its 30-minute budget.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60_000)
    expect(state.unsolicitedReader).toBeDefined()

    // Past the tool-in-flight budget the reader finalizes: a hung background
    // tool cannot pin the channel forever.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.eventsNeedResync).toBe(true)
  })

  it('a zero budget disarms the reader on the first idle fire with tools in flight', async () => {
    const { e, state } = armed()
    e.setUnsolicitedConfig({ toolInFlightTimeoutMs: 0 })
    state.activeToolCalls = 1
    state.lastEventAt = Date.now()
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.unsolicitedReader).toBeUndefined()
  })
})

describe('unsolicited reader background grace', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('keeps the reader armed while a background task is pending, then resets the count at the grace cap', async () => {
    const { e, state } = armed()
    state.backgroundTasksPending = 2
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000)
    expect(state.unsolicitedReader).toBeDefined()
    expect(state.backgroundTasksPending).toBe(2)

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    // Grace exhausted: the task will never complete; the count drops so the
    // hint and the reaper shield do not stick forever.
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.backgroundTasksPending).toBe(0)
    expect(state.bgWaitStartedAt).toBe(0)
  })
})

describe('unsolicited reader spillover grace', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('relays duplicate frames right after a foreground completion as plain text', async () => {
    const { e, p, agentSession, state } = armed()
    e.setUnsolicitedConfig({ spilloverGraceMs: 10_000 })
    state.lastForegroundCompletionAt = Date.now()
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

      agentSession.channel.push({ type: 'text', content: 'partial frame', done: false })
      agentSession.channel.push({ type: 'result', content: 'duplicate result', done: true })
      await vi.advanceTimersByTimeAsync(0)

      // Relay: plain text delivery, history recorded, no orphan pump card.
      expect(p.getSent()).toEqual(['duplicate result'])
      expect(e.sessions.getOrCreateActive(KEY).lastResult).toBe('duplicate result')
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(false)
      // The reader stays armed for later turns.
      expect(state.unsolicitedReader).toBeDefined()
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('drops non-substantive stream noise without opening a turn', async () => {
    const { e, p, agentSession } = armed()
    e.setUnsolicitedConfig({ spilloverGraceMs: 10_000 })
    state0(e)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

      agentSession.channel.push({ type: 'text', content: '', done: false })
      agentSession.channel.push({ type: 'text_delta', content: '…', done: false })
      await vi.advanceTimersByTimeAsync(0)

      expect(p.getSent()).toEqual([])
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(false)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('runs a full orphan pump for events outside the spillover window', async () => {
    const { e, p, agentSession, state } = armed()
    e.setUnsolicitedConfig({ spilloverGraceMs: 1_000 })
    state.lastForegroundCompletionAt = Date.now() - 2_000
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

      agentSession.channel.push({ type: 'result', content: 'genuine report', done: true })
      await vi.advanceTimersByTimeAsync(0)

      expect(p.getSent().some(t => t.includes('genuine report'))).toBe(true)
      expect(e.sessions.getOrCreateActive(KEY).lastResult).toBe('genuine report')
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(true)
    } finally {
      infoSpy.mockRestore()
    }
  })
})

describe('unsolicited reader disarm', () => {
  it('a new user turn takes the channel back from the reader', async () => {
    const { e, agentSession, state } = armed()
    e.sessions.getOrCreateActive(KEY).setAgentSessionID('s1', 'controllable')
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)
    expect(state.unsolicitedReader).toBeDefined()

    // The next user message blocks inside send: its turn entry must have
    // disarmed the reader so the pump owns the channel alone.
    const blocking = newBlockingSendSession('s1')
    state.agentSession = blocking
    const msg = {
      sessionKey: KEY, platform: 'test', messageID: '', userID: '', userName: '',
      chatName: '', chatType: '', content: 'go', originalContent: '', images: [], files: [],
      extraContent: '', replyCtx: 'ctx', fromVoice: false, isSpawnedGroup: false,
      isPermissionAction: false, isAskqCardAction: false, isCardAction: false,
      parentMessageID: '', quotedText: '',
    }
    e.receiveMessage(e.platforms[0] ?? createStubPlatform(), msg)
    await blocking.sendStarted

    expect(state.unsolicitedReader).toBeUndefined()
    blocking.unblock()
    await agentSession.close().catch(() => undefined)
  })
})

/** Stamp a fresh foreground completion for the spillover window. */
function state0(e: Engine): void {
  const state = e.interactiveStates.get(KEY)
  if (state !== undefined) state.lastForegroundCompletionAt = Date.now()
}

/** Stub platform with the M2 preview capabilities, recording card PATCHes. */
function createPreviewRecorderPlatform(): StubPlatform & { messages: string[] } {
  const messages: string[] = []
  return Object.assign(createStubPlatform(), {
    messages,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      messages.push(`start:${previewText(content)}`)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      messages.push(`update:${previewText(content)}`)
    },
  })
}

/** Poll a predicate until it holds or the deadline passes. */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 10) })
  }
  if (!pred()) throw new Error('waitFor timeout')
}

describe('background task hint closed loop', () => {
  it('increments on a background tool call and clears when the completion turn finishes', async () => {
    const p = createPreviewRecorderPlatform()
    const agentSession = newControllableSession('s1')
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      agentSession.channel.push({
        type: 'tool_use', toolName: 'bash', toolInput: '{}', toolID: 'c1', content: '', done: false,
        toolBackground: true,
      })
      agentSession.channel.push({ type: 'tool_result', toolResult: 'job started', toolID: 'c1', content: '', done: false })
      agentSession.channel.push({ type: 'result', content: 'deploy started', done: true })
    }
    const e = new Engine('test', createControllableAgent(agentSession), [p], '', 'en')
    e.setDisplayConfig({ toolProgress: true })
    const msg = {
      sessionKey: KEY, platform: 'test', messageID: '', userID: '', userName: '',
      chatName: '', chatType: '', content: 'deploy', originalContent: '', images: [], files: [],
      extraContent: '', replyCtx: 'ctx', fromVoice: false, isSpawnedGroup: false,
      isPermissionAction: false, isAskqCardAction: false, isCardAction: false,
      parentMessageID: '', quotedText: '',
    }
    const session = e.sessions.getOrCreateActive(KEY)

    e.receiveMessage(p, msg)
    await waitFor(() => session.lastResult === 'deploy started')

    const state = e.interactiveStates.get(KEY)
    expect(state?.backgroundTasksPending).toBe(1)
    // The running count rides the turn card's hint line.
    expect(p.messages.some(m => m.includes('1 background task'))).toBe(true)

    // The task completes later as an engine-woken turn: the reader consumes
    // it, the placeholder announces the background-task processing, and the
    // count (and hint) drop to zero at the result.
    agentSession.channel.push({ type: 'result', content: 'deploy finished', done: true })
    await waitFor(() => (e.interactiveStates.get(KEY)?.backgroundTasksPending ?? -1) === 0)
    expect(session.lastResult).toBe('deploy finished')
    // The final card no longer carries the running hint.
    const withHint = p.messages.filter(m => m.includes('background task'))
    expect(withHint.length).toBeGreaterThan(0)
    expect(p.messages[p.messages.length - 1]).not.toContain('background task')
  })
})

describe('orphan pump with frozen stream clocks (2026-08-26 oc_b46da incident)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a stray frame whose stream clock froze newer than the pump cannot pin the session lock forever', async () => {
    const { e, agentSession } = armed()
    let streamActivityAt = 0
    Object.assign(agentSession, { lastStreamActivity: () => streamActivityAt })
    e.setStallMaxRetries(0)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

      // A stray text frame with no turn behind it (spillover relay disabled by
      // default) opens a background pump turn that then waits for events.
      agentSession.channel.push({ type: 'text', content: 'partial frame', done: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(true)
      expect(errSpy.mock.calls.some(c => String(c[0]).includes('orphan turn failed'))).toBe(false)

      // The runtime projects one later frame the pump never consumes: the
      // stream clock freezes 8s newer than the pump's last receive.
      streamActivityAt = Date.now() + 8_000
      const session = e.sessions.getOrCreateActive(KEY)

      // The first idle fire (10min) is still shielded: the stream went quiet
      // only 592s ago against the 600s budget.
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(session.tryLock()).toBe(false)

      // The second fire (20min): the stream has been silent past the budget —
      // the frozen pair no longer shields, the pump turn is killed, and the
      // lock returns for the next message-path turn.
      await vi.advanceTimersByTimeAsync(12 * 60_000)
      expect(errSpy.mock.calls.some(c => String(c[0]).includes('agent session idle timeout'))).toBe(true)
      expect(session.tryLock()).toBe(true)
      session.unlock()
      expect(e.interactiveStates.get(KEY)).toBeUndefined()
    } finally {
      infoSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
