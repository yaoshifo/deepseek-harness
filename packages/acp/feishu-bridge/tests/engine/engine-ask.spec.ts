/**
 * B2 engine ask-delegate tests: askUser renders one card per ask and returns
 * the user's decision as the native structure (allowed-always for allow-all,
 * rejected+note for a deny with card input), routeAskResponse settles it
 * from card payloads and free text, and questions ride one card with the
 * selected/custom split.
 *
 * @module dsh-feishu-bridge/tests-engine-ask
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubPlatform,
  testMultiQuestions,
  testQuestions,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { Message } from '../../src/core/types.js'

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

describe('askUser permission kind', () => {
  it('renders one perm card and resolves allow as allowed-once', async () => {
    const p = createStubCardPlatform('feishu')
    const { e, state } = armedState(p)

    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'write', preview: '/tmp/x' })
    await tick()
    expect(p.sentCards).toHaveLength(1)

    const handled = e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')
    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    // The decided path restarts ask surfaces so post-decision execution
    // lands on a fresh preview.
    expect(state.preview).toBeDefined()
  })

  it('perm:allow_all resolves allowed-always (the native standing grant)', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'rm -rf /tmp' })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'perm:allow_all', isPermissionAction: true }), 'perm:allow_all'))
      .toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-always' })
  })

  it('perm:deny with a card note resolves rejected carrying the note', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'rm -rf /tmp' })
    await tick()

    const content = 'perm:deny\x00use git clean instead'
    expect(e.routeAskResponse(p, msg({ content, isPermissionAction: true }), content)).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected', note: 'use git clean instead' })
  })

  it('free-text keywords still decide without a card payload', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: '允许' }), '允许')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })

  it('a plain-text deny sends the denial notice', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'deny' }), 'deny')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
    // The plain-text prompt fallback went out first; the denial notice is last.
    expect(p.getSent()).toHaveLength(2)
  })

  it('non-verdict free text gets the permission hint and keeps waiting', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: '随便说说' }), '随便说说')).toBe(true)
    expect(p.getSent().join('\n')).toContain('Waiting for permission response')
    expect(state.pendingAsk).toBeDefined()

    state.pendingAsk?.resolve({ outcome: 'cancelled' })
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
  })

  it('a session without an interactive state auto-allows (relay/cron semantics)', async () => {
    const e = newTestEngine()
    await expect(e.askUser('relay:a:b', { kind: 'permission', toolName: 'Bash', preview: '' }))
      .resolves.toEqual({ outcome: 'allowed-once' })
  })

  it('an aborted ask settles cancelled without restarting ask surfaces', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const ac = new AbortController()
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: '' }, ac.signal)
    await tick()

    ac.abort()
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
    // No fresh preview for a turn that is being aborted: restartAskSurfaces
    // would leave a running placeholder card nobody finalizes.
    expect(state.preview).toBeUndefined()
  })

  it('a stopped session settles the ask cancelled without restarting ask surfaces', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'permission', toolName: 'Bash', preview: '' })
    await tick()

    state.markStopped()
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
    // /done-style teardown must not mint a new preview for the dying state
    // (2026-08-25 oc_d22d incident: stray 执行中 card after /done).
    expect(state.preview).toBeUndefined()
  })
})

describe('askUser questions kind', () => {
  it('renders ALL questions on one card', async () => {
    const p = createStubCardPlatform('feishu')
    const { e } = armedState(p)

    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testMultiQuestions() })
    await tick()

    expect(p.sentCards).toHaveLength(1)
    abandon(decision)
  })

  it('button answers accumulate per question and settle once all are answered', async () => {
    const p = createStubPlatform('test')
    const { e, state } = armedState(p)
    const decision = e.askUser('test:chat:user1', {
      kind: 'questions',
      questions: testMultiQuestions().map((q, i) => ({ ...q, id: `q${i}` })),
    })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')).toBe(true)
    expect(state.pendingAsk).toBeDefined()
    expect(e.routeAskResponse(p, msg({ content: 'askq:1:2', isAskqCardAction: true }), 'askq:1:2')).toBe(true)

    await expect(decision).resolves.toEqual({
      answers: [
        { id: 'q0', selected: ['PostgreSQL'] },
        { id: 'q1', selected: ['Echo'] },
      ],
    })
    expect(state.pendingAsk).toBeUndefined()
  })

  it('free text answers the first unanswered question: numeric → selected, words → custom', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: '2' }), '2')).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['SQLite'] }],
    })
    expect(p.getSent().join('\n')).toContain('✅ Which database?: **SQLite**')
  })

  it('non-numeric free text lands in custom with an empty selection', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'Redis' }), 'Redis')).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: [], custom: 'Redis' }],
    })
  })

  it('a multi-select payload answers its own question with every label', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const questions = [{ ...testQuestions()[0]!, multiSelect: true }]
    const decision = e.askUser('test:chat:user1', { kind: 'questions', questions })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'askq:0:1,3', isAskqCardAction: true }), 'askq:0:1,3')).toBe(true)
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['PostgreSQL', 'MySQL'] }],
    })
  })

  it('settlePendingAskDefaults applies the first-option default to unanswered questions', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', {
      kind: 'questions',
      questions: testMultiQuestions(),
    })
    await tick()

    expect(e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')).toBe(true)
    expect(e.settlePendingAskDefaults('test:chat:user1')).toBe(true)

    await expect(decision).resolves.toEqual({
      answers: [
        { id: 'Which database?', selected: ['PostgreSQL'] },
        { id: 'Which framework?', selected: ['Gin'] },
      ],
    })
  })

  it('a text answer that is an attachment-only message is not consumed', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    void e.askUser('test:chat:user1', { kind: 'questions', questions: testQuestions() })
    await tick()

    const withImage = msg({ content: '', images: [{ mimeType: 'image/png', data: Buffer.from([]) }] })
    expect(e.routeAskResponse(p, withImage, '')).toBe(false)
  })
})

describe('askUser plan-review kind', () => {
  it('sends the plan card before the permission card and resolves the approval', async () => {
    const p = createStubCardPlatform('feishu')
    const { e } = armedState(p)

    const decision = e.askUser('test:chat:user1', {
      kind: 'plan-review',
      heading: '# Fix spinner',
      plan: '# Fix spinner\n\n1. resolve asset path\n2. upload gif',
    })
    await tick()

    // Plan card + permission card, in that order.
    expect(p.sentCards.length).toBeGreaterThanOrEqual(2)
    const planCard = p.sentCards[0] as { elements: Array<{ kind: string; content?: string }> }
    expect(planCard.elements.some(el => el.content?.includes('resolve asset path'))).toBe(true)

    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })

  it('a deny resolves rejected with the note', async () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)
    const decision = e.askUser('test:chat:user1', { kind: 'plan-review', heading: '# P', plan: '# P' })
    await tick()

    const content = 'perm:deny\x00narrow the scope'
    expect(e.routeAskResponse(p, msg({ content, isPermissionAction: true }), content)).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected', note: 'narrow the scope' })
  })
})

describe('routeAskResponse stale handling', () => {
  it('a stale perm action with no state replies permission-expired and consumes the message', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    expect(e.routeAskResponse(p, msg({ content: 'perm:allow', isPermissionAction: true }), 'perm:allow')).toBe(true)
    expect(p.getSent().join('\n')).toContain('expired')
  })

  it('a state with no pending ask lets a stale perm action through as expired', () => {
    const p = createStubPlatform('test')
    const { e } = armedState(p)

    expect(e.routeAskResponse(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')).toBe(true)
  })

  it('a stale askq card click passes through untouched', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    expect(e.routeAskResponse(p, msg({ content: 'askq:0:1', isAskqCardAction: true }), 'askq:0:1')).toBe(false)
    expect(p.getSent()).toEqual([])
  })

  it('plain text without a pending ask passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    expect(e.routeAskResponse(p, msg({ content: '好' }), '好')).toBe(false)
  })
})

/** Silence an unhandled-decision promise the test deliberately abandons. */
function abandon(decision: Promise<unknown>): void {
  void decision.catch(() => {})
}
