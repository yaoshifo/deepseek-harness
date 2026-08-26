/**
 * Engine-side lifecycle-phase avatar transitions: the askUser entry/settle
 * matrix (plan-review → blue/approved|discussing, other asks → attention →
 * baseline), turn-end error/success, and the best-effort applyChatPhase
 * semantics.
 *
 * @module dsh-feishu-bridge/tests-engine-avatar-phase
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  testQuestions,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { ChatBasePhase, ChatPhase, Message } from '../../src/core/types.js'

interface PhaseCall {
  sessionKey: string
  phase: ChatPhase
}

/** Stub platform recording ChatPhasePainter calls; basePhase is scriptable. */
interface PhasePlatform extends StubPlatform {
  phaseCalls: PhaseCall[]
  basePhase: ChatBasePhase
  failPhase: boolean
  setChatPhase(sessionKey: string, phase: ChatPhase): Promise<void>
  chatBasePhase(sessionKey: string): ChatBasePhase
}

function newPhasePlatform(): PhasePlatform {
  const p = createStubPlatform('test') as unknown as PhasePlatform
  p.phaseCalls = []
  p.basePhase = 'discussing'
  p.failPhase = false
  p.setChatPhase = async (sessionKey: string, phase: ChatPhase) => {
    if (p.failPhase) throw new Error('phase failed')
    p.phaseCalls.push({ sessionKey, phase })
  }
  p.chatBasePhase = (_sessionKey: string) => p.basePhase
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
