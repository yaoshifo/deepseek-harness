/**
 * M3→B2 AskUserQuestion tests: the one-card multi-question rendering
 * (sendAskQuestionsCard platform variants) and routeAskResponse question
 * variants (single/multi/card-button/text/stale). The resolveAskQuestionAnswer
 * and buildAskQuestionResponse pure-logic suites moved to ask.spec.ts with
 * the B2 selected/custom split.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-askq
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubInlineButtonPlatform,
  createStubPlatform,
  testMultiQuestions,
  testQuestions,
} from '../stubs/engine-stubs.js'
import type { Message, UserQuestion } from '../../src/core/types.js'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
}

/** An armed questions ask: engine, card platform, and the pending decision. */
interface ArmedAsk {
  e: Engine
  p: ReturnType<typeof createStubCardPlatform>
  decision: Promise<{ answers?: Array<{ id: string; selected: string[]; custom?: string }> }>
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

/** Engine + state with a questions ask parked via askUser. */
async function armedAsk(
  questions = testQuestions(),
): Promise<ArmedAsk> {
  const e = newTestEngine()
  const p = createStubCardPlatform('feishu')
  const state = new InteractiveState()
  state.platform = p
  state.replyCtx = 'ctx'
  e.interactiveStates.set('test:chat:user1', state)
  const decision = e.askUser('test:chat:user1', { kind: 'questions', questions })
  await new Promise((r) => { setTimeout(r, 10) })
  return { e, p, decision }
}

describe('sendAskQuestionsCard', () => {
  it('CardPlatform: one blue-header card for the whole ask', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendAskQuestionsCard(p, 'ctx', testQuestions(), 'test:askq')

    expect(p.sentCards).toHaveLength(1)
  })

  it('CardPlatform_MultiQuestion_OneCard: both questions ride the same card', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendAskQuestionsCard(p, 'ctx', testMultiQuestions(), 'test:askq')

    expect(p.sentCards).toHaveLength(1)
    const card = p.sentCards[0] as { elements: Array<{ kind: string; content?: string }> }
    const headings = card.elements.filter(el => el.kind === 'markdown')
    expect(headings).toHaveLength(2)
  })

  it('InlineButtonPlatform: first question options as askq:0:N buttons', async () => {
    const e = newTestEngine()
    const p = createStubInlineButtonPlatform('telegram')

    await e.sendAskQuestionsCard(p, 'ctx', testQuestions(), 'test:askq')

    expect(p.buttonRows).toHaveLength(3)
    expect(p.buttonRows[0]![0]!.data).toBe('askq:0:1')
  })

  it('PlainPlatform: plain text with numbered options, no markdown', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('plain')

    await e.sendAskQuestionsCard(p, 'ctx', testQuestions(), 'test:askq')

    expect(p.getSent()).toHaveLength(1)
    const sentMsg = p.getSent()[0]!
    expect(sentMsg).toContain('Which database?')
    expect(sentMsg).toContain('1) PostgreSQL')
    expect(sentMsg).not.toContain('**')
  })

  it('AskQuestionCardShape: single-select renders list rows with number buttons addressed by askq:{q}:{n}', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendAskQuestionsCard(p, 'ctx', testQuestions(), 'test:askq')

    const card = p.sentCards[0] as { elements: Array<Record<string, unknown>> }
    expect(card.elements.length).toBe(4) // 1 markdown question + 3 list rows
    const q = card.elements[0] as { kind: string; content: string }
    expect(q.kind).toBe('markdown')
    expect(q.content).toBe('**Which database?**')
    for (let i = 0; i < 3; i++) {
      const row = card.elements[i + 1] as {
        kind: string
        text: string
        description: string
        btnText: string
        btnValue: string
      }
      expect(row.kind).toBe('listItem')
      expect(row.text).toContain(['PostgreSQL', 'SQLite', 'MySQL'][i])
      expect(row.description).toContain(i === 0 ? 'Recommended' : i === 1 ? 'Lightweight' : 'Popular')
      expect(row.btnText).toBe(String(i + 1))
      expect(row.btnValue).toBe(`askq:0:${i + 1}`)
    }
  })

  it('multi-select pre-checks recommended options in the checker form', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const questions: UserQuestion[] = [{
      question: 'Which fixes?',
      header: 'Follow-up',
      multiSelect: true,
      options: [
        { label: 'Fix leak', description: 'src/a.ts:12 — guards the retry loop', recommended: true },
        { label: 'Add test', description: 'tests/a.spec.ts — pins the retry contract' },
        { label: 'Skip for now', description: '' },
      ],
    }]

    await e.sendAskQuestionsCard(p, 'ctx', questions, 'test:askq')

    const card = p.sentCards[0] as { elements: Array<Record<string, unknown>> }
    // The one-card layout leads with the question heading; the checker follows.
    const check = card.elements.find(el => el['kind'] === 'checkOptions') as {
      kind: string
      options: Array<{ label: string; checked?: boolean }>
    }
    expect(check.kind).toBe('checkOptions')
    expect(check.options.map(o => [o.label, o.checked === true])).toEqual([
      ['Fix leak', true],
      ['Add test', false],
      ['Skip for now', false],
    ])
  })
})

describe('routeAskResponse question variants', () => {
  it('SingleQuestion: "2" resolves with the option label', async () => {
    const { e, p, decision } = await armedAsk()

    const handled = e.routeAskResponse(p, msg({ content: '2' }), '2')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['SQLite'] }],
    })
  })

  it('MultiQuestion_OneCard: answers accumulate per question on the same parked ask', async () => {
    const { e, p, decision } = await armedAsk(testMultiQuestions())

    const handled = e.routeAskResponse(p, msg({ content: '1' }), '1')
    expect(handled).toBe(true)
    const handled2 = e.routeAskResponse(p, msg({ content: '2' }), '2')
    expect(handled2).toBe(true)

    await expect(decision).resolves.toEqual({
      answers: [
        { id: 'Which database?', selected: ['PostgreSQL'] },
        { id: 'Which framework?', selected: ['Echo'] },
      ],
    })
  })

  it('SkipsPermFlow: "allow" treated as free-text custom answer', async () => {
    const { e, p, decision } = await armedAsk()

    const handled = e.routeAskResponse(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: [], custom: 'allow' }],
    })
  })

  it('CardButtonSkipsReply_SingleQuestion: no standalone reply', async () => {
    const { e, p, decision } = await armedAsk()

    const handled = e.routeAskResponse(p, msg({ content: '2', isAskqCardAction: true }), '2')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['SQLite'] }],
    })
    expect(p.getSent()).toEqual([])
  })

  it('CardButton_MultiQuestion_Middle: no ✅ reply for card actions', async () => {
    const { e, p } = await armedAsk(testMultiQuestions())

    const handled = e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')

    expect(handled).toBe(true)
    for (const m of p.getSent()) {
      expect(m).not.toContain('✅ Which database?')
    }
  })

  it('TextAnswerKeepsFeedback: text answer sends ✅ feedback', async () => {
    const { e, p } = await armedAsk()

    const handled = e.routeAskResponse(p, msg({ content: '2' }), '2')

    expect(handled).toBe(true)
    expect(p.getSent()).toHaveLength(1)
  })

  it('StaleCardNotTreatedAsPerm: stale askq click → handled=false, no toast', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.routeAskResponse(p, msg({ content: 'yes', isAskqCardAction: true }), 'yes')

    expect(handled).toBe(false)
    expect(p.getSent()).toEqual([])
  })

  it('second card answer for the same question updates it instead of settling early', async () => {
    const { e, p, decision } = await armedAsk(testMultiQuestions())

    e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')
    e.routeAskResponse(p, msg({ content: 'askq:0:2', isAskqCardAction: true }), 'askq:0:2')
    e.routeAskResponse(p, msg({ content: 'askq:1:1', isAskqCardAction: true }), 'askq:1:1')

    await expect(decision).resolves.toEqual({
      answers: [
        { id: 'Which database?', selected: ['SQLite'] },
        { id: 'Which framework?', selected: ['Gin'] },
      ],
    })
  })
})
