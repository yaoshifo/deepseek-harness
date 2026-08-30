/**
 * M3→B2 AskUserQuestion tests: the one-card multi-question rendering
 * (sendAskQuestionsCard platform variants) and routeAskResponse question
 * variants (single/multi/card-button/text/stale). The resolveAskQuestionAnswer
 * and buildAskQuestionResponse pure-logic suites moved to ask.spec.ts with
 * the B2 selected/custom split.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-askq
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(card.elements.length).toBe(5) // 1 markdown question + 3 list rows + 1 free-text note
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

describe('failed-start placeholder turn pairing', () => {
  it('the placeholder state begins a turn so the caller finally endTurn stays paired', async () => {
    // startSession throws → getOrCreateInteractiveStateWith returns a
    // placeholder without an agentSession; the caller still runs its
    // finally endTurn. Without a paired beginTurn the counter goes negative
    // and engine.stop's === 0 check misjudges in-flight turns.
    const p = createStubPlatform()
    const agent = { ...createStubAgent(), startSession: async () => { throw new Error('boom') } }
    const e = new Engine('test', agent, [p], '', 'en')
    const session = e.sessions.getOrCreateActive('test:chat:user1')
    const state = await e.getOrCreateInteractiveStateWith('test:chat:user1', p, 'ctx', session, '', 'test:chat:user1')
    expect(state.agentSession).toBeUndefined()
    expect(state.activeTurns, 'placeholder began a turn for the caller\'s finally to end').toBe(1)
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

  it('an out-of-range askq payload is consumed with a hint, never fed to the agent', async () => {
    // A stale card (the ask re-armed with fewer questions) names a qIdx that
    // no longer exists; returning false would queue the raw `askq:5:1` text
    // as the model's next prompt.
    const { e, p } = await armedAsk()
    const sent = p.getSent().length

    const handled = e.routeAskResponse(p, msg({ content: 'askq:5:1', isAskqCardAction: true }), 'askq:5:1')

    expect(handled).toBe(true)
    expect(p.getSent().length, 'a stale-card hint was sent').toBeGreaterThan(sent)
  })

  it('a free-text answer carrying attachments stages them instead of dropping', async () => {
    const { e, p } = await armedAsk()
    e.setBaseWorkDir(mkdtempSync(join(tmpdir(), 'fb-askq-wd-')))
    const state = e.interactiveStates.get('test:chat:user1')!

    const handled = e.routeAskResponse(p, msg({ content: '选这张图', images: [{ mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }] }), '选这张图')

    expect(handled).toBe(true)
    expect(state.pendingAttachments.length, 'the image landed in the staged attachments').toBe(1)
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

describe('interactive slot keys (cron new-per-run)', () => {
  it('parks, renders, and settles an ask under a #cron: slot key', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    // The slot the run's interactive state actually lives under; a click
    // arrives addressed by the same key (the render stamps it into the
    // card's callback values).
    const slot = 'feishu:oc_1:ou_1#cron:s20'
    e.interactiveStates.set(slot, state)
    const decision = e.askUser(slot, { kind: 'questions', questions: testQuestions() })
    await new Promise((r) => { setTimeout(r, 10) })

    expect(p.sentCards).toHaveLength(1)
    const handled = e.routeAskResponse(p, msg({ sessionKey: slot, content: '1' }), '1')
    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['PostgreSQL'] }],
    })
  })

  it('a bare-key askq card click routes to the #cron: slot parked ask (2026-08-31 deadlock)', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    const slot = 'feishu:oc_1:ou_1#cron:s20'
    e.interactiveStates.set(slot, state)
    const decision = e.askUser(slot, { kind: 'questions', questions: testQuestions() })
    await new Promise((r) => { setTimeout(r, 10) })

    expect(p.sentCards).toHaveLength(1)
    // The card's callback values carry the reply context's bare session
    // key, so the click dispatch arrives addressed by it — not the slot
    // the ask parked under.
    const bare = 'feishu:oc_1:ou_1'
    const handled = e.routeAskResponse(p, msg({ sessionKey: bare, content: 'askq:0:2', isAskqCardAction: true }), 'askq:0:2')

    expect(handled, 'the click reached the slot-parked ask').toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['SQLite'] }],
    })
  })

  it('a bare-key free-text reply is not consumed by a #cron: slot parked ask', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    const slot = 'feishu:oc_1:ou_1#cron:s20'
    e.interactiveStates.set(slot, state)
    const decision = e.askUser(slot, { kind: 'questions', questions: testQuestions() })
    await new Promise((r) => { setTimeout(r, 10) })

    // Ordinary chat traffic in the group must keep flowing to the agent;
    // only card actions claim the slot.
    const handled = e.routeAskResponse(p, msg({ sessionKey: 'feishu:oc_1:ou_1', content: '2' }), '2')

    expect(handled).toBe(false)
    const settled = await Promise.race([
      decision.then(() => 'settled'),
      new Promise((r) => { setTimeout(() => r('pending'), 50) }),
    ])
    expect(settled, 'the parked ask must not settle from a bare-key free-text reply').toBe('pending')
  })

  it('a bare-key permission card click routes to the #cron: slot parked permission', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    const slot = 'feishu:oc_1:ou_1#cron:s21'
    e.interactiveStates.set(slot, state)
    const decision = e.askUser(slot, { kind: 'permission', toolName: 'bash', preview: 'rm -rf /tmp/x' })
    await new Promise((r) => { setTimeout(r, 10) })

    const handled = e.routeAskResponse(
      p, msg({ sessionKey: 'feishu:oc_1:ou_1', content: 'perm:allow', isPermissionAction: true }), 'perm:allow',
    )

    expect(handled, 'the perm click reached the slot-parked permission').toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })

  it('a bare-key ask whose state sits under a #cron: slot answers unattended', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('feishu:oc_1:ou_1#cron:s20', state)

    // The documented 2026-08-26 cron-fbe6d268 failure shape: the asker
    // routed under the bare session key while the run's state was parked
    // under the suffixed slot — nobody could answer, so every question
    // settled empty with no card sent.
    await expect(e.askUser('feishu:oc_1:ou_1', { kind: 'questions', questions: testQuestions() }))
      .resolves.toEqual({ answers: [{ id: 'Which database?', selected: [] }] })
    expect(p.sentCards).toHaveLength(0)
  })
})
