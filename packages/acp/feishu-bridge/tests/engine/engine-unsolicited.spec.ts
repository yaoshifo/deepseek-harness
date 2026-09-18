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

  it('keeps the reader armed while a completion notice is in flight, then resets the count and clears the card hint at the grace cap', async () => {
    const { e, state, agentSession } = armed()
    // The wait is already 30s old when the reader takes over; both counted
    // jobs settled 5s ago — after the anchor, before the notice landed.
    state.backgroundTasksPending = 2
    state.bgWaitStartedAt = Date.now() - 30_000
    agentSession.jobs.push(
      { id: 'j1', ownerSession: 's1', status: 'completed', startedAt: 0, finishedAt: Date.now() - 5_000, reported: false },
      { id: 'j2', ownerSession: 's1', status: 'completed', startedAt: 0, finishedAt: Date.now() - 5_000, reported: false },
    )
    const hints: string[] = []
    state.preview = {
      canPreview: () => true,
      setBackgroundHint: (hint: string) => { hints.push(hint) },
    } as never
    e.setDisplayConfig({ toolProgress: true })
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(60_000)
    expect(state.unsolicitedReader).toBeDefined()
    expect(state.backgroundTasksPending).toBe(2)

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    // Grace exhausted with no live job left: the count drops so the hint and
    // the reaper shield do not stick forever — and the card stops showing
    // the stale 💡 N hint (2026-09-16 oc_3c16b: the card froze on it).
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.backgroundTasksPending).toBe(0)
    expect(state.bgWaitStartedAt).toBe(0)
    expect(hints).toEqual([''])
  })

  it('keeps waiting past the grace cap while the owner still has a live background job', async () => {
    const { e, state, agentSession } = armed()
    agentSession.jobs.push({ id: 'j1', ownerSession: 's1', status: 'running', startedAt: 0, reported: false })
    const hints: string[] = []
    state.preview = {
      canPreview: () => true,
      setBackgroundHint: (hint: string) => { hints.push(hint) },
    } as never
    e.setDisplayConfig({ toolProgress: true })
    state.backgroundTasksPending = 1
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    for (let i = 0; i < 35; i++) await vi.advanceTimersByTimeAsync(60_000)
    // Past the 30-minute grace the job is still live (a slow build outlives
    // the cap, 2026-09-16 oc_3c16b): the count, the hint, and the reader all
    // stay so the completion notice remains deliverable.
    expect(state.unsolicitedReader).toBeDefined()
    expect(state.backgroundTasksPending).toBe(1)
    expect(state.bgWaitStartedAt).not.toBe(0)
    expect(hints).toEqual([])
  })

  it('reconciles a leaked count at the first idle tick when every job settled and was collected in-turn', async () => {
    // 2026-09-17 oc_f85284: bash run_in_background + job_output(wait) inside
    // one turn — tool-jobs suppresses the completion notice (the wait already
    // delivered the terminal state), no decrement path ever fires, and the
    // leaked count held the settled card for the whole 30-minute grace
    // before the reissued card showed a fresh timestamp.
    const { e, state } = armed()
    const hints: string[] = []
    state.preview = {
      canPreview: () => true,
      setBackgroundHint: (hint: string) => { hints.push(hint) },
    } as never
    e.setDisplayConfig({ toolProgress: true })
    state.backgroundTasksPending = 1
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    // First idle fire (~60s): the registry knows every counted job settled
    // and was already collected — the count is a leak, cleared now, not at
    // the 30-minute cap.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.backgroundTasksPending).toBe(0)
    expect(state.bgWaitStartedAt).toBe(0)
    expect(hints).toEqual([''])
  })

  it('stops counting a notice-delivered zombie that settled before the wait anchor', async () => {
    // The residual oc_f85284 shape: the notice WAS delivered (an
    // engine-woken turn consumed it) but `reported` never flips on delivery,
    // so the unanchored probe counted the job forever and the reconcile
    // fell through to the 30-minute grace give-up.
    const { e, state, agentSession } = armed()
    agentSession.jobs.push({ id: 'j1', ownerSession: 's1', status: 'completed', startedAt: 0, finishedAt: Date.now() - 60_000, reported: false })
    const hints: string[] = []
    state.preview = {
      canPreview: () => true,
      setBackgroundHint: (hint: string) => { hints.push(hint) },
    } as never
    e.setDisplayConfig({ toolProgress: true })
    state.backgroundTasksPending = 1
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    // First idle fire: the anchor does not exist yet (bgWaitStartedAt 0
    // counts every settled job — conservative for a job whose notice may be
    // mid-delivery right now); this tick only sets the anchor.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(state.backgroundTasksPending).toBe(1)
    expect(state.bgWaitStartedAt).not.toBe(0)

    // Second idle fire: the zombie settled before the anchor — reconciled
    // away in ~2 minutes, not at the 30-minute cap.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.unsolicitedReader).toBeUndefined()
    expect(state.backgroundTasksPending).toBe(0)
    expect(state.bgWaitStartedAt).toBe(0)
    expect(hints).toEqual([''])
  })

  it('keeps waiting for a job that settled during the wait, anchored at bgWaitStartedAt', async () => {
    const { e, state, agentSession } = armed()
    state.backgroundTasksPending = 1
    state.bgWaitStartedAt = Date.now() - 30_000
    agentSession.jobs.push({ id: 'j1', ownerSession: 's1', status: 'completed', startedAt: 0, finishedAt: Date.now() - 5_000, reported: false })
    const hints: string[] = []
    state.preview = {
      canPreview: () => true,
      setBackgroundHint: (hint: string) => { hints.push(hint) },
    } as never
    e.setDisplayConfig({ toolProgress: true })
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60_000)
    // The job settled after the wait anchor: its notice is still owed, so
    // the count, the hint, and the armed reader all stay.
    expect(state.unsolicitedReader).toBeDefined()
    expect(state.backgroundTasksPending).toBe(1)
    expect(state.bgWaitStartedAt).not.toBe(0)
    expect(hints).toEqual([])
    // The probe is anchored at the wait start, not at the tick time.
    expect(agentSession.settledUnreportedSince.length).toBeGreaterThan(0)
    expect(Math.max(...agentSession.settledUnreportedSince)).toBe(state.bgWaitStartedAt)
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

/**
 * Preview recorder that also captures the card's background-hint line: a
 * running card renders it beside the stop button, outside `content.text`, so
 * the plain recorder cannot see a hint that never reaches a terminal card.
 * @returns Stub platform with the recorded card texts and hint lines.
 */
function createHintRecorderPlatform(): StubPlatform & { messages: string[]; hints: string[] } {
  const messages: string[] = []
  const hints: string[] = []
  return Object.assign(createStubPlatform(), {
    messages,
    hints,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      messages.push(`start:${previewText(content)}`)
      hints.push(content.bgTaskHint ?? '')
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      messages.push(`update:${previewText(content)}`)
      hints.push(content.bgTaskHint ?? '')
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
    // The job is still running while the first turn settles: the registry
    // reports it live, so the settle-time reconcile leaves the count alone.
    let liveJobs = 1
    agentSession.pendingBackgroundJobs = () => liveJobs
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
    liveJobs = 0
    agentSession.channel.push({ type: 'result', content: 'deploy finished', done: true })
    await waitFor(() => (e.interactiveStates.get(KEY)?.backgroundTasksPending ?? -1) === 0)
    expect(session.lastResult).toBe('deploy finished')
    // The final card no longer carries the running hint.
    const withHint = p.messages.filter(m => m.includes('background task'))
    expect(withHint.length).toBeGreaterThan(0)
    expect(p.messages[p.messages.length - 1]).not.toContain('background task')
  })

  it('drops the count when the completion notice is spliced into the running turn', async () => {
    const p = createPreviewRecorderPlatform()
    const agentSession = newControllableSession('s1')
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      agentSession.channel.push({
        type: 'tool_use', toolName: 'bash', toolInput: '{}', toolID: 'c1', content: '', done: false,
        toolBackground: true,
      })
      agentSession.channel.push({ type: 'tool_result', toolResult: 'job started', toolID: 'c1', content: '', done: false })
      // The job settles while the turn is still running: tool-jobs splices
      // the notice into the next-step inbox (no woken turn), the model reads
      // it and collects the output before the turn ends (2026-09-15
      // oc_1b7e1: the count climbed to 7 with every task already done).
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      agentSession.channel.push({ type: 'text', content: 'collected via job_output', done: false })
      agentSession.channel.push({ type: 'result', content: 'deploy finished', done: true })
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
    await waitFor(() => session.lastResult === 'deploy finished')

    const state = e.interactiveStates.get(KEY)
    // The notice's delivery — not a later woken turn — consumed the slot.
    expect(state?.backgroundTasksPending).toBe(0)
    // The settle path found nothing left to clear; the final card carries no hint.
    expect(p.messages[p.messages.length - 1]).not.toContain('background task')
  })

  it('renders the registry\'s live count when a notice drops a slot', async () => {
    const p = createHintRecorderPlatform()
    const agentSession = newControllableSession('s1')
    // The slot this notice consumes belongs to a job whose suppressed notice
    // (job_output(wait) already delivered it) left the slot behind: the pending
    // count reaches 0 while the registry still holds two running jobs. The
    // hint line must name what is running, not what the count tracks.
    let liveJobs = 1
    agentSession.pendingBackgroundJobs = () => liveJobs
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      agentSession.channel.push({
        type: 'tool_use', toolName: 'bash', toolInput: '{}', toolID: 'c1', content: '', done: false,
        toolBackground: true,
      })
      agentSession.channel.push({ type: 'tool_result', toolResult: 'job started', toolID: 'c1', content: '', done: false })
      liveJobs = 2
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      agentSession.channel.push({ type: 'text', content: 'still running', done: false })
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
    e.receiveMessage(p, msg)

    await waitFor(() => p.hints.some(h => h.includes('2 background task')))
    expect(e.interactiveStates.get(KEY)?.backgroundTasksPending).toBe(0)
  })

  it('names the started job only once its call has registered it', async () => {
    const p = createHintRecorderPlatform()
    const agentSession = newControllableSession('s1')
    // Two jobs from an earlier turn are still running; this turn starts a
    // third. The bridge sees tool/call before the tool body registers the job,
    // so the hint this call earns must wait for the call's result: the pending
    // count (1) would misname the three running jobs as one.
    let liveJobs = 2
    agentSession.pendingBackgroundJobs = () => liveJobs
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      agentSession.channel.push({
        type: 'tool_use', toolName: 'bash', toolInput: '{}', toolID: 'c1', content: '', done: false,
        toolBackground: true,
      })
      liveJobs = 3
      agentSession.channel.push({ type: 'tool_result', toolResult: 'job started', toolID: 'c1', content: '', done: false })
      agentSession.channel.push({ type: 'text', content: 'still running', done: false })
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
    e.receiveMessage(p, msg)

    await waitFor(() => p.hints.some(h => h.includes('3 background task')))
    expect(p.hints.some(h => h.includes('1 background task'))).toBe(false)
  })

  it('drops the hint on a woken completion turn whose job has already finished', async () => {
    const p = createHintRecorderPlatform()
    const agentSession = newControllableSession('s1')
    // One call, one running job: the count and the registry agree, so the
    // foreground turn renders an honest 💡 1. The job then finishes while the
    // owner is idle — the notice that wakes the completion turn finds a slot
    // the registry no longer backs, and the woken turn must not repeat it.
    let liveJobs = 1
    agentSession.pendingBackgroundJobs = () => liveJobs
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
    expect(p.hints.some(h => h.includes('1 background task'))).toBe(true)

    const mark = p.hints.length
    liveJobs = 0
    agentSession.channel.push({ type: 'result', content: 'deploy finished', done: true })
    await waitFor(() => (e.interactiveStates.get(KEY)?.backgroundTasksPending ?? -1) === 0)

    // The woken turn renders its placeholder and then its settled card: neither
    // may name a job the registry no longer holds.
    expect(p.hints.slice(mark).some(h => h.includes('background task'))).toBe(false)
  })

  it('runs a background call without a writable card when the platform has none', async () => {
    // createStubPlatform holds no message updater, so the turn's preview can
    // never be written: the hint must be skipped, and the turn must still land.
    const p = createStubPlatform()
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
    // Without a writable card the reply still goes out as a plain message, and
    // the hint write is skipped rather than attempted.
    expect(p.getSent().some(m => m.includes('deploy started'))).toBe(true)
  })

  it('consumes a late re-projection of the same notice exactly once', async () => {
    const p = createPreviewRecorderPlatform()
    const agentSession = newControllableSession('s1')
    // The second job is still running when this turn settles: the registry
    // reports it live, so the settle-time reconcile keeps the remaining slot.
    agentSession.pendingBackgroundJobs = () => 1
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      for (const id of ['c1', 'c2']) {
        agentSession.channel.push({
          type: 'tool_use', toolName: 'bash', toolInput: '{}', toolID: id, content: '', done: false,
          toolBackground: true,
        })
        agentSession.channel.push({ type: 'tool_result', toolResult: 'job started', toolID: id, content: '', done: false })
      }
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      // The runtime re-projects the same splice: only one slot may drop.
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      agentSession.channel.push({ type: 'result', content: 'two jobs, one delivered notice', done: true })
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
    await waitFor(() => session.lastResult === 'two jobs, one delivered notice')

    expect(e.interactiveStates.get(KEY)?.backgroundTasksPending).toBe(1)
  })

  it('leaves the count at zero when a notice arrives with nothing pending', async () => {
    const p = createPreviewRecorderPlatform()
    const agentSession = newControllableSession('s1')
    agentSession.send = async () => {
      agentSession.sendCalls.push('sent')
      // A bridge restart lost the count; the notice must not drive it negative.
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      agentSession.channel.push({ type: 'result', content: 'done', done: true })
    }
    const e = new Engine('test', createControllableAgent(agentSession), [p], '', 'en')
    e.setDisplayConfig({ toolProgress: true })
    const msg = {
      sessionKey: KEY, platform: 'test', messageID: '', userID: '', userName: '',
      chatName: '', chatType: '', content: 'go', originalContent: '', images: [], files: [],
      extraContent: '', replyCtx: 'ctx', fromVoice: false, isSpawnedGroup: false,
      isPermissionAction: false, isAskqCardAction: false, isCardAction: false,
      parentMessageID: '', quotedText: '',
    }
    const session = e.sessions.getOrCreateActive(KEY)

    e.receiveMessage(p, msg)
    await waitFor(() => session.lastResult === 'done')

    expect(e.interactiveStates.get(KEY)?.backgroundTasksPending).toBe(0)
  })

  it('consumes a notice arriving while idle without opening a turn', async () => {
    const { e, agentSession, state } = armed()
    state.backgroundTasksPending = 1
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)

      // Wake-budget exhaustion delivers the notice to a next-step inbox while
      // the owner is idle: the count still drops, and no orphan turn opens.
      agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
      await waitFor(() => state.backgroundTasksPending === 0)
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(false)
    } finally {
      infoSpy.mockRestore()
    }
  })
  it('drops a notice slot when no card is open to carry the hint', async () => {
    const { e, agentSession, state } = armed()
    e.setDisplayConfig({ toolProgress: true })
    state.backgroundTasksPending = 1
    // No turn has opened a card for this state: the hint write has no preview
    // to reach, and the slot must drop all the same.
    e.startUnsolicitedReader(e.sessions.getOrCreateActive(KEY), e.sessions, KEY)
    agentSession.channel.push({ type: 'bg_task_notice', content: '', done: false, bgNoticeIDs: ['n1'] })
    await waitFor(() => state.backgroundTasksPending === 0)
    // The notice itself consumed the slot (not a reconcile later on): the
    // hint write it triggers has no preview to reach.
    expect(state.consumedNoticeIDs.has('n1')).toBe(true)
    expect(state.preview).toBeUndefined()
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
