/**
 * Machine-message exemption for the parked-ask router (2026-09-13 chatroom
 * postmortem, session f64eb48bd04b0 hub seq 287/288): a subtask report wake
 * delivered through deliverMachineMessage while a questions ask was parked got
 * consumed as the ask's free-text answer (selected:[] + the report text),
 * killing the confirmation card. Synthetic machine messages must fall through
 * the ask router to the normal pipeline; human free text keeps answering.
 *
 * @module dsh-feishu-bridge/tests-engine-ask-machine
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubPlatform,
  testQuestions,
  type StubPlatform,
} from '../stubs/engine-stubs.ts'
import type { Message } from '../../src/core/types.ts'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
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

/** Engine + state armed on the standard test session key. */
function armedState(p: StubPlatform): { e: Engine; state: InteractiveState } {
  const e = newTestEngine()
  const state = new InteractiveState()
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set('test:chat:user1', state)
  return { e, state }
}

/** Let the ask's card render settle before asserting on sends. */
async function tick(): Promise<void> {
  await new Promise((r) => { setTimeout(r, 10) })
}

describe('routeAskResponse machine-message exemption', () => {
  it('a machine-flagged subtask report is not consumed as a question answer', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()
    expect(state.pendingAsk).toBeDefined()

    const report = '[子任务完成] render child:\n\n全量回执正文……'
    expect(e.routeAskResponse(p, msg({ content: report, machine: true }), report)).toBe(false)
    // The ask survives untouched: no answer recorded, no card settled.
    expect(state.pendingAsk).toBeDefined()
    expect(state.pendingAsk?.answers.size).toBe(0)

    state.pendingAsk?.resolve({ answers: [] })
    await expect(decision).resolves.toEqual({ answers: [] })
  })

  it('a machine-flagged message does not decide a parked permission either', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()

    // 「允许」 would resolve the permission as a free-text keyword; the
    // machine flag must keep it out of the ask router entirely.
    expect(e.routeAskResponse(p, msg({ content: '允许', machine: true }), '允许')).toBe(false)
    expect(state.pendingAsk).toBeDefined()

    state.pendingAsk?.resolve({ outcome: 'cancelled' })
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('human free text still answers the first unanswered question (regression)', async () => {
    const p = createStubCardPlatform('feishu')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: '2' }), '2')).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['SQLite'] }],
    })
  })

  it('a card action path stays exempt from the machine guard', async () => {
    const p = createStubCardPlatform('feishu')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()
    expect(p.sentCards).toHaveLength(1)

    // Card clicks never carry the machine flag; the askq payload must keep
    // settling its question.
    expect(e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['PostgreSQL'] }],
    })
  })
})
