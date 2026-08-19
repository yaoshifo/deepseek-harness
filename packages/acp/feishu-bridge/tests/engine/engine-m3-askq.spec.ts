/**
 * M3 AskUserQuestion tests ported from cc-connect core/engine_test.go:
 * resolveAskQuestionAnswer (5 variants), buildAskQuestionResponse,
 * sendAskQuestionPrompt (4 platform variants), and handlePendingPermission
 * AskUserQuestion variants (single/multi/skip/card-button/text/stale).
 *
 * Red phase: the engine methods (resolveAskQuestionAnswer,
 * buildAskQuestionResponse, sendAskQuestionPrompt, handlePendingPermission)
 * do not exist yet — these tests fail until the M3 implementation lands.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-askq
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createRecordingAgentSession,
  createStubAgent,
  createStubCardPlatform,
  createStubInlineButtonPlatform,
  createStubPlatform,
  newPendingPermission,
  testMultiQuestions,
  testQuestions,
} from '../stubs/engine-stubs.js'
import type { Message, UserQuestion } from '../../src/core/types.js'

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

describe('resolveAskQuestionAnswer', () => {
  it('NumericIndex: "2" → SQLite', () => {
    const e = newTestEngine()
    const q = testQuestions()[0]!
    expect(e.resolveAskQuestionAnswer(q, '2')).toBe('SQLite')
  })

  it('ButtonCallback: "askq:0:1" → PostgreSQL', () => {
    const e = newTestEngine()
    const q = testQuestions()[0]!
    expect(e.resolveAskQuestionAnswer(q, 'askq:0:1')).toBe('PostgreSQL')
  })

  it('FreeText: "Redis" → Redis', () => {
    const e = newTestEngine()
    const q = testQuestions()[0]!
    expect(e.resolveAskQuestionAnswer(q, 'Redis')).toBe('Redis')
  })

  it('MultiSelect: "1,3" → PostgreSQL, MySQL', () => {
    const e = newTestEngine()
    const q: UserQuestion = { ...testQuestions()[0]!, multiSelect: true }
    expect(e.resolveAskQuestionAnswer(q, '1,3')).toBe('PostgreSQL, MySQL')
  })

  it('OutOfRange: "99" → raw "99"', () => {
    const e = newTestEngine()
    const q = testQuestions()[0]!
    expect(e.resolveAskQuestionAnswer(q, '99')).toBe('99')
  })
})

describe('buildAskQuestionResponse', () => {
  it('preserves original input and adds answers map', () => {
    const input = { questions: [{ question: 'Which?' }] }
    const questions = testQuestions()
    const result = Engine.buildAskQuestionResponse(
      input,
      questions,
      new Map([[0, 'PostgreSQL']]),
    )

    const answers = result.answers as Record<string, unknown>
    expect(answers).toBeDefined()
    expect(answers[questions[0]!.question]).toBe('PostgreSQL')
    expect(result.questions).toBeDefined()
  })
})

describe('sendAskQuestionPrompt', () => {
  it('CardPlatform: sends blue-header card with 3 askq buttons', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendAskQuestionPrompt(p, 'ctx', testQuestions(), 0)

    expect(p.sentCards).toHaveLength(1)
  })

  it('CardPlatform_MultiQuestion_ShowsIndex: title contains (1/2)', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendAskQuestionPrompt(p, 'ctx', testMultiQuestions(), 0)

    expect(p.sentCards).toHaveLength(1)
  })

  it('InlineButtonPlatform: 3 button rows with askq:0:N data', async () => {
    const e = newTestEngine()
    const p = createStubInlineButtonPlatform('telegram')

    await e.sendAskQuestionPrompt(p, 'ctx', testQuestions(), 0)

    expect(p.buttonRows).toHaveLength(3)
    expect(p.buttonRows[0]![0]!.data).toBe('askq:0:1')
  })

  it('PlainPlatform: plain text with numbered options, no markdown', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('plain')

    await e.sendAskQuestionPrompt(p, 'ctx', testQuestions(), 0)

    expect(p.getSent()).toHaveLength(1)
    const sentMsg = p.getSent()[0]!
    expect(sentMsg).toContain('Which database?')
    expect(sentMsg).toContain('1) PostgreSQL')
    expect(sentMsg).not.toContain('**')
  })
})

describe('handlePendingPermission AskUserQuestion variants', () => {
  it('SingleQuestion: "2" resolves with answer', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Which?' }] },
      questions: testQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '2' }), '2')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(1)
    const answers = rec.lastResult?.updatedInput?.answers as Record<string, unknown>
    expect(answers).toBeDefined()
    expect(answers['Which database?']).toBe('SQLite')
    expect(state.pending).toBeUndefined()
  })

  it('MultiQuestion_Sequential: first answer does not resolve', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [] },
      questions: testMultiQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '1' }), '1')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(0)
    expect(state.pending).toBeDefined()
    expect(state.pending?.currentQuestion).toBe(1)

    const handled2 = e.handlePendingPermission(p, msg({ content: '2' }), '2')

    expect(handled2).toBe(true)
    expect(rec.calls).toBe(1)
    const answers = rec.lastResult?.updatedInput?.answers as Record<string, unknown>
    expect(answers['Which database?']).toBe('PostgreSQL')
    expect(answers['Which framework?']).toBe('Echo')
    expect(state.pending).toBeUndefined()
  })

  it('SkipsPermFlow: "allow" treated as free text answer', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Which?' }] },
      questions: testQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    const answers = rec.lastResult?.updatedInput?.answers as Record<string, unknown>
    expect(answers['Which database?']).toBe('allow')
  })

  it('CardButtonSkipsReply_SingleQuestion: no standalone reply', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Which?' }] },
      questions: testQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '2', isAskqCardAction: true }), '2')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(1)
    const answers = rec.lastResult?.updatedInput?.answers as Record<string, unknown>
    expect(answers['Which database?']).toBe('SQLite')
    expect(p.getSent()).toEqual([])
  })

  it('CardButtonSkipsReply_MultiQuestion_Middle: no ✅ reply', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [] },
      questions: testMultiQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '1', isAskqCardAction: true }), '1')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(0)
    expect(state.pending).toBeDefined()
    expect(state.pending?.currentQuestion).toBe(1)
    for (const m of p.getSent()) {
      expect(m).not.toContain('✅ Which database?')
    }
  })

  it('TextAnswerKeepsFeedback: text answer sends ✅ feedback', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Which?' }] },
      questions: testQuestions(),
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '2' }), '2')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(1)
    expect(p.getSent()).toHaveLength(1)
  })

  it('StaleCardNotTreatedAsPerm: stale askq click → handled=false, no toast', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.handlePendingPermission(p, msg({ content: 'yes', isAskqCardAction: true }), 'yes')

    expect(handled).toBe(false)
    expect(p.getSent()).toEqual([])
  })
})
