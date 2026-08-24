/**
 * M3→B2 permission tests: shouldSurfaceUnsolicitedPermission,
 * sendPermissionPrompt (3 platform variants), routeAskResponse stale/hint/
 * budget/deny variants, and the ask-resolution surface restart. The Go-era
 * respondPermission/approveAll/deny-message assertions moved with the B2
 * delegate: deny notes ride ApprovalAnswer (the native tools layer folds
 * them into the rejection text) and approveAll is gone.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-permission
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { registerSessionCommands } from '../../src/engine/commands.js'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubInlineButtonPlatform,
  createStubPlatform,
  newPendingAsk,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { AskRequest, Message, ProgressContent } from '../../src/core/types.js'
import { previewText } from '../stubs/preview-content.js'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
}

/** Full Message factory matching the Go struct-literal shape used in tests. */
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

const permRequest: AskRequest = { kind: 'permission', toolName: 'Bash', preview: 'ls' }

describe('shouldSurfaceUnsolicitedPermission', () => {
  const cases = [
    { name: 'ask question, genuine background', toolName: 'AskUserQuestion', isAskQuestion: true, stallRetried: false, autoApprove: false, want: true },
    { name: 'ask question, stall retried', toolName: 'AskUserQuestion', isAskQuestion: true, stallRetried: true, autoApprove: false, want: true },
    { name: 'bash, stall retried', toolName: 'Bash', isAskQuestion: false, stallRetried: true, autoApprove: false, want: true },
    { name: 'bash, genuine background', toolName: 'Bash', isAskQuestion: false, stallRetried: false, autoApprove: false, want: false },
    { name: 'empty tool, genuine background', toolName: '', isAskQuestion: false, stallRetried: false, autoApprove: false, want: false },
    { name: 'ask question, autoApprove', toolName: 'AskUserQuestion', isAskQuestion: true, stallRetried: false, autoApprove: true, want: false },
    { name: 'bash, autoApprove, stall retried', toolName: 'Bash', isAskQuestion: false, stallRetried: true, autoApprove: true, want: false },
  ] as const

  for (const c of cases) {
    it(c.name, () => {
      const e = newTestEngine()
      const got = e.shouldSurfaceUnsolicitedPermission(c.toolName, c.isAskQuestion, c.stallRetried, c.autoApprove)
      expect(got).toBe(c.want)
    })
  }
})

describe('sendPermissionPrompt', () => {
  it('CardPlatform sends card with red header and perm buttons', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')

    await e.sendPermissionPrompt(p, 'ctx', 'full prompt text', 'write_file', '/tmp/test.txt')

    expect(p.sentCards).toHaveLength(1)
    expect(p.getSent()).toEqual([])
  })

  it('InlineButtonPlatform sends buttons with perm:allow data', async () => {
    const e = newTestEngine()
    const p = createStubInlineButtonPlatform('telegram')

    await e.sendPermissionPrompt(p, 'ctx', 'full prompt text', 'write_file', '/tmp/test.txt')

    expect(p.buttonContent).toBe('full prompt text')
    expect(p.buttonRows.length).toBeGreaterThanOrEqual(2)
    expect(p.buttonRows[0]![0]!.data).toBe('perm:allow')
  })

  it('PlainPlatform falls back to plain text', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('plain')

    await e.sendPermissionPrompt(p, 'ctx', 'full prompt text', 'write_file', '/tmp/test.txt')

    expect(p.getSent()).toEqual(['full prompt text'])
  })
})

describe('routeAskResponse stale/hint/budget', () => {
  it('StaleCardIgnored: no state → stale perm action handled (blocked)', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.routeAskResponse(p, msg({ content: 'allow', isPermissionAction: true }), 'allow')

    expect(handled).toBe(true)
  })

  it('StaleCardIgnored: state exists but no parked ask → stale perm blocked', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.routeAskResponse(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
  })

  it('StaleCardIgnored: regular user message with MessageID passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.routeAskResponse(p, msg({ messageID: 'om_xxx123', content: 'allow' }), 'allow')

    expect(handled).toBe(false)
  })

  it('HintCardNotTreatedAsExpired: "好" with no state passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.routeAskResponse(p, msg({ content: '好' }), '好')

    expect(handled).toBe(false)
    expect(p.getSent()).toEqual([])
  })

  it('HintCardNotTreatedAsExpired: "好" with state but no parked ask passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.routeAskResponse(p, msg({ content: '好' }), '好')

    expect(handled).toBe(false)
  })

  it('ResumesAbsoluteTurnBudget: approving resets the turn clock', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    state.lastEventAt = Date.now() - 25 * 60 * 1000
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const handled = e.routeAskResponse(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
    expect(Date.now() - state.lastEventAt).toBeLessThan(5000)
  })
})

describe('routeAskResponse deny variants', () => {
  it('DenyCardSkipsRedundantText: card deny sends no standalone text', async () => {
    const e = newTestEngine()
    const p = createStubCardPlatform('feishu')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const handled = e.routeAskResponse(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
    expect(p.getSent()).toEqual([])
  })

  it('DenyNoteRidesApprovalAnswer: the card note settles with the rejection', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const content = 'perm:deny\x00先补测试'
    void e.routeAskResponse(p, msg({ content, isPermissionAction: true }), content)

    await expect(decision).resolves.toEqual({ outcome: 'rejected', note: '先补测试' })
  })

  it('DenyTextKeepsFeedback: plain text deny sends standalone text', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const handled = e.routeAskResponse(p, msg({ content: 'deny' }), 'deny')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'rejected' })
    // Prompt fallback + denial notice.
    expect(p.getSent()).toHaveLength(2)
  })

  it('AllowNoteRidesTheDecision: an allow supplement settles as the note', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const content = 'perm:allow\x00also add tests'
    const handled = e.routeAskResponse(p, msg({ content, isPermissionAction: true }), content)

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once', note: 'also add tests' })
  })

  it('BareAllowCarriesNoNote', async () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)
    const decision = e.askUser('test:chat:user1', permRequest)
    await new Promise((r) => { setTimeout(r, 10) })

    const handled = e.routeAskResponse(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })
})

describe('AskSurfacesRestart', () => {
  it('resolving an ask finalizes the old preview card and starts a fresh one', async () => {
    // Go engine_events.go post-permission block: after the decision the
    // pre-interaction card is completed and detached, new surfaces are
    // created, and a fresh placeholder opens — post-approval execution must
    // not keep PATCHing the pre-interaction tool-progress card.
    const p = createStubPlatform()
    let nextID = 0
    const starts: string[] = []
    const updates: Array<{ handle: unknown; content: ProgressContent }> = []
    const preview = p as typeof p & {
      sendPreviewStart(rc: unknown, content: ProgressContent): Promise<unknown>
      updateMessage(handle: unknown, content: ProgressContent): Promise<void>
    }
    preview.sendPreviewStart = async (_rc, content) => {
      nextID++
      starts.push(`start:${previewText(content)}`)
      return `handle-${nextID}`
    }
    preview.updateMessage = async (handle, content) => {
      updates.push({ handle, content })
    }

    const engine = new Engine('test', createStubAgent(), [p], '', 'en')
    engine.setDisplayConfig({ thinkingMessages: false, toolProgress: true })
    const key = 'test:user4'
    engine.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    engine.interactiveStates.set(key, state)
    state.textParts = ['intro narration before the ask', 'done']

    const decision = engine.askUser(key, permRequest)
    await new Promise((r) => { setTimeout(r, 30) })
    engine.routeAskResponse(p, msg({ sessionKey: key, content: 'allow' }), 'allow')
    await decision
    await new Promise((r) => { setTimeout(r, 30) })

    // Turn-entry placeholder + post-ask placeholder: a fresh card, and the
    // turn's text accumulation reset so the reply is not re-sent.
    expect(starts.length).toBeGreaterThanOrEqual(1)
    expect(state.textParts).toEqual([])
    expect(state.segmentStart).toBe(0)
    // Preview active: the pre-ask text is not re-sent as a message.
    expect(p.getSent().join('\n')).not.toContain('intro narration')
  })
})

// Go engine.go order: slash-command dispatch (guarded against askq card
// answers, commit 60e20ef6) runs BEFORE ask routing, so a registered command
// like /done still executes while a plan card is pending.
describe('handleMessage routing: slash commands vs parked ask', () => {
  /** Engine with session commands registered (commands.spec.ts newEngine shape). */
  function newRoutingEngine(): { e: Engine; p: StubPlatform; dispose: () => void } {
    const p = createStubPlatform('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const dispose = registerSessionCommands(e)
    return { e, p, dispose }
  }

  /** State with a parked ask installed, mirroring a live ask card. */
  function armPending(e: Engine, request: AskRequest): InteractiveState {
    const state = new InteractiveState()
    state.platform = e.platforms[0]
    state.replyCtx = 'ctx'
    state.pendingAsk = newPendingAsk({ request })
    e.interactiveStates.set('test:chat:user1', state)
    return state
  }

  it('/done during a pending plan card dispatches the command, not the hint', () => {
    const { e, p, dispose } = newRoutingEngine()
    try {
      const state = armPending(e, { kind: 'plan-review', heading: '# P', plan: '# P' })

      e.receiveMessage(p, msg({ content: '/done', chatType: 'p2p' }))

      const sent = p.getSent().join('\n')
      expect(sent).toContain('/done is only available in spawned group chats')
      expect(sent).not.toContain('Waiting for permission response')
      expect(state.pendingAsk).toBeDefined()
    } finally {
      dispose()
    }
  })

  it('askq card answer with a /-prefixed label resolves the question, never dispatches a command (Go 60e20ef6)', () => {
    const { e, p, dispose } = newRoutingEngine()
    try {
      const state = armPending(e, {
        kind: 'questions',
        questions: [{ id: 'q', question: 'Which database?', header: '', options: [{ label: '/chatroom 不带任何参数', description: '' }], multiSelect: false }],
      })

      e.receiveMessage(p, msg({ content: 'askq:0:1', isAskqCardAction: true }))

      expect(p.getSent().join('\n')).not.toContain('Waiting for permission response')
      const answer = state.pendingAsk?.answers.get(0)
      expect(answer?.selected).toEqual(['/chatroom 不带任何参数'])
    } finally {
      dispose()
    }
  })

  it('free-text answer to a pending question still resolves it (c86779ae21 motivation preserved)', () => {
    const { e, p, dispose } = newRoutingEngine()
    try {
      const state = armPending(e, {
        kind: 'questions',
        questions: [{ id: 'q', question: 'Which database?', header: '', options: [{ label: 'PostgreSQL', description: '' }, { label: 'SQLite', description: '' }], multiSelect: false }],
      })

      e.receiveMessage(p, msg({ content: '1' }))

      expect(p.getSent().join('\n')).toContain('✅ Which database?: **PostgreSQL**')
      expect(state.pendingAsk?.answers.get(0)?.selected).toEqual(['PostgreSQL'])
    } finally {
      dispose()
    }
  })

  it('non-keyword free text during a plain pending permission still gets the hint', () => {
    const { e, p, dispose } = newRoutingEngine()
    try {
      const state = armPending(e, permRequest)

      e.receiveMessage(p, msg({ content: '随便说说' }))

      expect(p.getSent().join('\n')).toContain('Waiting for permission response')
      expect(state.pendingAsk).toBeDefined()
    } finally {
      dispose()
    }
  })

  it('unregistered slash command falls through dispatch to the hint', () => {
    const { e, p, dispose } = newRoutingEngine()
    try {
      armPending(e, permRequest)

      e.receiveMessage(p, msg({ content: '/nope' }))

      expect(p.getSent().join('\n')).toContain('Waiting for permission response')
    } finally {
      dispose()
    }
  })
})
