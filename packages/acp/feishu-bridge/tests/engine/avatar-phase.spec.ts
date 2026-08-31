/**
 * Engine-side lifecycle-phase avatar transitions: the askUser entry/settle
 * matrix (plan-review → blue/approved|discussing, other asks → attention →
 * baseline), turn-end error/success, the best-effort applyChatPhase
 * semantics, and the /done freeze that keeps late engine repaints (stop-
 * settled asks, turn-end baselines) off the gray terminal phase.
 *
 * @module dsh-feishu-bridge/tests-engine-avatar-phase
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  testQuestions,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'
import type { ChatBasePhase, ChatPhase, Message } from '../../src/core/types.ts'

interface PhaseCall {
  sessionKey: string
  phase: ChatPhase
}

/** Stub platform recording ChatPhasePainter calls; basePhase is scriptable. */
interface PhasePlatform extends StubPlatform {
  phaseCalls: PhaseCall[]
  basePhase: ChatBasePhase
  failPhase: boolean
  doneKeys: Set<string>
  setChatPhase(sessionKey: string, phase: ChatPhase): Promise<void>
  chatBasePhase(sessionKey: string): ChatBasePhase
  isSpawnedChatActive(sessionKey: string): boolean
  isSpawnedChatDone(sessionKey: string): boolean
}

function newPhasePlatform(): PhasePlatform {
  const p = createStubPlatform('test') as unknown as PhasePlatform
  p.phaseCalls = []
  p.basePhase = 'discussing'
  p.failPhase = false
  p.doneKeys = new Set<string>()
  p.setChatPhase = async (sessionKey: string, phase: ChatPhase) => {
    if (p.failPhase) throw new Error('phase failed')
    p.phaseCalls.push({ sessionKey, phase })
  }
  p.chatBasePhase = (_sessionKey: string) => p.basePhase
  p.isSpawnedChatActive = (_sessionKey: string) => true
  p.isSpawnedChatDone = (sessionKey: string) => p.doneKeys.has(sessionKey)
  return p
}

function newEngine(p: PhasePlatform): Engine {
  return new Engine('test', createStubAgent(), [p], '', 'en')
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:chat:user1',
    platform: 'test',
    messageID: '',
    userID: 'user1',
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

function armedState(e: Engine, p: PhasePlatform, sessionKey = 'test:chat:user1'): InteractiveState {
  const state = new InteractiveState()
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set(sessionKey, state)
  return state
}

/** Let the ask's card render settle before asserting. */
async function tick(): Promise<void> {
  await new Promise((r) => { setTimeout(r, 10) })
}

describe('askUser phase transitions', () => {
  it('a parked plan review paints plan-review, approval settles approved', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'plan-review' }])

    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'approved' })
  })

  it('a denied plan review settles back to discussing', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'perm:deny', isPermissionAction: true }), 'perm:deny')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'discussing' })
  })

  it('a withdrawn plan review (stop) settles back to discussing', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    const state = armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()

    state.markStopped()
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'discussing' })
  })

  it('a parked permission ask paints attention and settles to the baseline', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'attention' }])

    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'discussing' })
  })

  it('a questions ask paints attention and settles to the baseline once answered', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'attention' }])

    expect(e.routeAskResponse(p, msg({ content: '2' }), '2')).toBe(true)
    await expect(decision).resolves.toBeDefined()
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'discussing' })
  })

  it('a settle after an approved plan returns to approved, not discussing', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const planDecision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()
    e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    await expect(planDecision).resolves.toEqual({ outcome: 'allowed-once' })

    // The real platform persists the new baseline; mirror it on the stub.
    p.basePhase = 'approved'
    const permDecision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()
    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    await expect(permDecision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.phaseCalls.at(-1)).toEqual({ sessionKey: 'test:chat:user1', phase: 'approved' })
  })

  it('an unattended ask (no interactive state) paints nothing', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)

    await expect(e.askUser('relay:a:b', { kind: 'permission', toolName: 'Bash', preview: '' }))
      .resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.phaseCalls).toEqual([])
  })
})

describe('turn-end phase transitions', () => {
  function armedTurn(p: PhasePlatform, e: Engine): InteractiveState {
    const sessionKey = 'test:chat:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    const state = armedState(e, p, sessionKey)
    state.agentSession = newControllableSession('s1')
    void session
    return state
  }

  it('an errored turn paints attention', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    const state = armedTurn(p, e)

    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel
      .push({ type: 'result', content: '', errorText: 'No API key for provider', done: true })
    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:chat:user1'), e.sessions, 'test:chat:user1', 'm1', undefined, state.replyCtx)

    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'attention' }])
  })

  it('a successful turn returns to the baseline', async () => {
    const p = newPhasePlatform()
    p.basePhase = 'approved'
    const e = newEngine(p)
    const state = armedTurn(p, e)

    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel
      .push({ type: 'result', content: '任务完成', done: true })
    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:chat:user1'), e.sessions, 'test:chat:user1', 'm1', undefined, state.replyCtx)

    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'approved' }])
  })

  it('a turn ending under an outstanding done mark does not repaint the baseline', async () => {
    const p = newPhasePlatform()
    p.basePhase = 'approved'
    const e = newEngine(p)
    const state = armedTurn(p, e)
    p.doneKeys.add('test:chat:user1')

    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel
      .push({ type: 'result', content: '任务完成', done: true })
    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:chat:user1'), e.sessions, 'test:chat:user1', 'm1', undefined, state.replyCtx)

    expect(p.phaseCalls).toEqual([])
  })

  it('the baseline repaint fires only after the card renders terminal', async () => {
    const p = newPhasePlatform()
    // Preview-capable stub recording the operation order: the repaint must
    // not precede the card's terminal PATCH.
    const ops: string[] = []
    Object.assign(p, {
      async sendPreviewStart(): Promise<unknown> {
        ops.push('start')
        return { messageID: 'om_card' }
      },
      async updateMessage(_rc: unknown, content: { status?: { state: string } }): Promise<void> {
        ops.push(`update:${content.status?.state ?? 'plain'}`)
      },
      async deletePreviewMessage(): Promise<void> {},
    })
    const e = newEngine(p)
    e.setDisplayConfig({ toolProgress: true })
    const state = armedTurn(p, e)

    const inner = p.setChatPhase.bind(p)
    p.setChatPhase = async (sessionKey: string, phase: ChatPhase) => {
      ops.push('paint')
      await inner(sessionKey, phase)
    }

    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel.push(
      { type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'call-1', content: '', done: false })
    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel.push(
      { type: 'tool_result', toolResult: 'ok', toolID: 'call-1', content: '', done: false })
    ;(state.agentSession as ReturnType<typeof newControllableSession>).channel
      .push({ type: 'result', content: '任务完成', done: true })
    await e.processInteractiveEvents(state, e.sessions.getOrCreateActive('test:chat:user1'), e.sessions, 'test:chat:user1', 'm1', undefined, state.replyCtx)

    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'discussing' }])
    // The terminal PATCH (completed) precedes the repaint, so the repaint's
    // system message displaces a card that never reissues — no recall
    // tombstone from the turn-end avatar transition.
    const paintIdx = ops.indexOf('paint')
    const terminalIdx = ops.lastIndexOf('update:completed')
    expect(paintIdx).toBeGreaterThan(-1)
    expect(terminalIdx).toBeGreaterThan(-1)
    expect(terminalIdx).toBeLessThan(paintIdx)
  })
})

describe('done-freeze avatar semantics', () => {
  it('an outstanding done mark swallows engine repaints except done itself', async () => {
    const p = newPhasePlatform()
    p.doneKeys.add('test:chat:user1')
    const e = newEngine(p)

    await e.applyChatPhase(p, 'test:chat:user1', 'attention')
    await e.applyChatPhase(p, 'test:chat:user1', 'discussing')
    await e.applyChatPhase(p, 'test:chat:user1', 'approved')
    expect(p.phaseCalls).toEqual([])

    await e.applyChatPhase(p, 'test:chat:user1', 'done')
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'done' }])
  })

  it('a stop-settled ask (the /done sequence) does not repaint the baseline', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    const state = armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'attention' }])

    // The reordered cleanupOneChat commits the done mark before the stop
    // releases the parked ask's cancelled settlement.
    p.doneKeys.add('test:chat:user1')
    state.markStopped()
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'attention' }])
  })

  it('a user decision landing on a done-marked chat no longer repaints', async () => {
    const p = newPhasePlatform()
    const e = newEngine(p)
    armedState(e, p)

    const decision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'plan-review' }])

    p.doneKeys.add('test:chat:user1')
    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(p.phaseCalls).toEqual([{ sessionKey: 'test:chat:user1', phase: 'plan-review' }])
  })
})

describe('applyChatPhase best-effort semantics', () => {
  it('no-ops on a platform without the capability', async () => {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    await expect(e.applyChatPhase(p, 'test:chat:user1', 'attention')).resolves.toBeUndefined()
  })

  it('degrades to a warn when the paint fails', async () => {
    const p = newPhasePlatform()
    p.failPhase = true
    const e = newEngine(p)
    await expect(e.applyChatPhase(p, 'test:chat:user1', 'attention')).resolves.toBeUndefined()
  })
})
