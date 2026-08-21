/**
 * M3 permission tests ported from cc-connect core/engine_test.go:
 * shouldSurfaceUnsolicitedPermission, sendPermissionPrompt (3 platform
 * variants), handlePendingPermission (stale/hint/budget/deny variants),
 * and deny-message-matches-native.
 *
 * Red phase: the engine methods (sendPermissionPrompt, handlePendingPermission,
 * shouldSurfaceUnsolicitedPermission) do not exist yet — these tests fail
 * until the M3 implementation lands.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-permission
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubInlineButtonPlatform,
  createStubPlatform,
  createRecordingAgentSession,
  newControllableSession,
  newPendingPermission,
} from '../stubs/engine-stubs.js'
import type { Message } from '../../src/core/types.js'

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

describe('handlePendingPermission stale/hint/budget', () => {
  it('StaleCardIgnored: no state → stale perm action handled (blocked)', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.handlePendingPermission(p, msg({ content: 'allow', isPermissionAction: true }), 'allow')

    expect(handled).toBe(true)
  })

  it('StaleCardIgnored: state exists but pending nil → stale perm blocked', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
  })

  it('StaleCardIgnored: regular user message with MessageID passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ messageID: 'om_xxx123', content: 'allow' }), 'allow')

    expect(handled).toBe(false)
  })

  it('HintCardNotTreatedAsExpired: "好" with no state passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')

    const handled = e.handlePendingPermission(p, msg({ content: '好' }), '好')

    expect(handled).toBe(false)
    expect(p.getSent()).toEqual([])
  })

  it('HintCardNotTreatedAsExpired: "好" with state but no pending passes through', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: '好' }), '好')

    expect(handled).toBe(false)
  })

  it('ResetsAbsoluteTurnBudget: approving resets turn clock', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    state.lastEventAt = Date.now() - 25 * 60 * 1000
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    expect(Date.now() - state.lastEventAt).toBeLessThan(5000)
  })
})

describe('handlePendingPermission deny variants', () => {
  it('DenyCardSkipsRedundantText: ExitPlanMode card deny sends no text', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
    expect(rec.calls).toBe(1)
    expect(rec.lastResult?.behavior).toBe('deny')
    expect(p.getSent()).toEqual([])
    expect(state.approveAll).toBe(false)
  })

  it('DenyCardSkipsRedundantText: ordinary tool card deny sends no text', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
    expect(rec.lastResult?.behavior).toBe('deny')
    expect(p.getSent()).toEqual([])
  })

  it('DenyMessageMatchesNative: with reason', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const content = 'deny\x00先补测试'
    void e.handlePendingPermission(p, msg({ content, isPermissionAction: true }), content)

    const expectedPreamble = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
    expect(rec.lastResult?.message).toBe(`${expectedPreamble} To tell you how to proceed, the user said:\n\n先补测试`)
  })

  it('DenyMessageMatchesNative: no reason', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    void e.handlePendingPermission(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    const expectedPreamble = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
    expect(rec.lastResult?.message).toBe(`${expectedPreamble} STOP what you are doing and wait for the user to tell you how to proceed.`)
  })

  it('DenyTextKeepsFeedback: plain text deny sends standalone text', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny' }), 'deny')

    expect(handled).toBe(true)
    expect(rec.lastResult?.behavior).toBe('deny')
    expect(p.getSent()).toHaveLength(1)
  })

  it('ExitPlanModeDenyResetsApproveAll: pre-armed approveAll is torn down', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    state.approveAll = true
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny' }), 'deny')

    expect(handled).toBe(true)
    expect(state.approveAll).toBe(false)
    expect(rec.lastResult?.behavior).toBe('deny')
  })
})

describe('handlePendingPermission deny reason steer', () => {
  it('steers an ordinary-tool deny note next to the rejection', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const content = 'deny\x00use git clean instead'
    const handled = e.handlePendingPermission(p, msg({ content, isPermissionAction: true }), content)

    expect(handled).toBe(true)
    // The wrapped native message still rides the permission result...
    expect(rec.lastResult?.behavior).toBe('deny')
    expect(rec.lastResult?.message).toContain('use git clean instead')
    // ...and the raw note is steered verbatim as a user message.
    expect(rec.steerCalls).toEqual(['use git clean instead'])
  })

  it('does not steer an ExitPlanMode deny note (custom feedback already delivers it)', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const content = 'deny\x00narrow the scope'
    const handled = e.handlePendingPermission(p, msg({ content, isPermissionAction: true }), content)

    expect(handled).toBe(true)
    expect(rec.lastResult?.behavior).toBe('deny')
    expect(rec.steerCalls).toEqual([])
  })

  it('steers nothing on a bare deny', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'deny', isPermissionAction: true }), 'deny')

    expect(handled).toBe(true)
    expect(rec.steerCalls).toEqual([])
  })
})

describe('handlePendingPermission ExitPlanMode approval', () => {
  const cases = [
    { name: 'exitplan_allow_sets_approveAll', tool: 'ExitPlanMode', content: 'allow', wantAll: true },
    { name: 'exitplan_allow_all_sets_approveAll', tool: 'ExitPlanMode', content: 'allow all', wantAll: true },
    { name: 'ordinary_tool_allow_keeps_approAll_off', tool: 'Bash', content: 'allow', wantAll: false },
  ] as const

  for (const c of cases) {
    it(c.name, () => {
      const e = newTestEngine()
      const p = createStubPlatform('test')
      const rec = createRecordingAgentSession()
      const state = new InteractiveState()
      state.agentSession = rec
      state.platform = p
      state.replyCtx = 'ctx'
      state.pending = newPendingPermission({
        requestID: 'req-1',
        toolName: c.tool,
        toolInput: {},
      })
      e.interactiveStates.set('test:chat:user1', state)

      const handled = e.handlePendingPermission(p, msg({ content: c.content }), c.content)

      expect(handled).toBe(true)
      expect(rec.calls).toBe(1)
      expect(rec.lastResult?.behavior).toBe('allow')
      expect(state.approveAll).toBe(c.wantAll)
    })
  }
})

describe('handlePendingPermission allow supplement', () => {
  const cases = [
    { name: 'exitplan_allow_note_becomes_message', tool: 'ExitPlanMode', content: 'allow', note: 'also add tests' },
    { name: 'exitplan_allow_all_note_becomes_message', tool: 'ExitPlanMode', content: 'allow all', note: 'also add tests' },
    { name: 'ordinary_tool_allow_note_becomes_message', tool: 'Bash', content: 'allow', note: 'also add tests' },
  ] as const

  for (const c of cases) {
    it(c.name, () => {
      const e = newTestEngine()
      const p = createStubPlatform('test')
      const rec = createRecordingAgentSession()
      const state = new InteractiveState()
      state.agentSession = rec
      state.platform = p
      state.replyCtx = 'ctx'
      state.pending = newPendingPermission({
        requestID: 'req-1',
        toolName: c.tool,
        toolInput: {},
      })
      e.interactiveStates.set('test:chat:user1', state)

      const content = `${c.content}\x00${c.note}`
      const handled = e.handlePendingPermission(p, msg({ content, isPermissionAction: true }), content)

      expect(handled).toBe(true)
      expect(rec.lastResult?.behavior).toBe('allow')
      // The supplement rides as the raw note (unwrapped); only the deny path
      // wraps it with the native rejection preamble.
      expect(rec.lastResult?.message).toBe(c.note)
    })
  }

  it('bare allow carries no message', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: {},
    })
    e.interactiveStates.set('test:chat:user1', state)

    const handled = e.handlePendingPermission(p, msg({ content: 'allow' }), 'allow')

    expect(handled).toBe(true)
    expect(rec.lastResult?.behavior).toBe('allow')
    expect(rec.lastResult?.message).toBeUndefined()
  })
})

describe('ForegroundPermissionSurfaces', () => {
  it('a foreground write-tool permission sends a card and parks (not auto-denied)', async () => {
    // Go's foreground reply loop creates pendingPermission for EVERY
    // EventPermissionRequest after the auto-approve branch (engine_events.go
    // ~4106); the shouldSurfaceUnsolicitedPermission gate belongs to the
    // background unsolicited reader only. The TS port wrongly applied the
    // background gate in processInteractiveEvents, so sandbox-escalation
    // approvals auto-denied on the real machine.
    const p = createStubPlatform()
    const engine = new Engine('test', createStubAgent(), [p], '', 'en')
    const sess = newControllableSession('fg-perm')
    const key = 'test:user3'
    const session = engine.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    engine.interactiveStates.set(key, state)

    sess.channel.push({
      type: 'permission_request',
      requestID: 'req-fg',
      toolName: 'write',
      toolInput: '/Users/hm/Desktop/x.txt',
      content: '',
      done: false,
    })
    sess.channel.close()
    const loop = engine.processInteractiveEvents(state, session, engine.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
    await new Promise((r) => { setTimeout(r, 50) })

    expect(state.permissionPending).toBe(true)
    expect(state.pending?.requestID).toBe('req-fg')
    expect(state.pending?.toolName).toBe('write')
    const sent = p.getSent().join('\n')
    expect(sent).toContain('write')

    // Resolve the pending to unblock the parked loop.
    state.pending?.resolve()
    await loop
    expect(state.permissionPending).toBe(false)
  })
})

describe('PostPermissionCardRestart', () => {
  it('resolving a permission finalizes the old preview card and starts a fresh one', async () => {
    // Go engine_events.go post-permission block: after user interaction the
    // pre-interaction card is completed and detached, new sp/cp are created,
    // and a fresh placeholder opens — post-approval execution must not keep
    // PATCHing the pre-interaction tool-progress card.
    const p = createStubPlatform()
    let nextID = 0
    const starts: string[] = []
    const updates: Array<{ handle: unknown; content: string }> = []
    const preview = p as typeof p & {
      sendPreviewStart(rc: unknown, content: string): Promise<unknown>
      updateMessage(handle: unknown, content: string): Promise<void>
    }
    preview.sendPreviewStart = async (_rc, content) => {
      nextID++
      starts.push(`start:${content}`)
      return `handle-${nextID}`
    }
    preview.updateMessage = async (handle, content) => {
      updates.push({ handle, content })
    }

    const engine = new Engine('test', createStubAgent(), [p], '', 'en')
    engine.setDisplayConfig({ thinkingMessages: false, toolProgress: true })
    const sess = newControllableSession('perm-restart')
    const key = 'test:user4'
    const session = engine.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    engine.interactiveStates.set(key, state)

    sess.channel.push({ type: 'text', content: 'intro narration before the plan', done: false })
    sess.channel.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'ls', content: '', done: false })
    sess.channel.push({ type: 'permission_request', requestID: 'req-r', toolName: 'write', toolInput: '/tmp/x', content: '', done: false })
    sess.channel.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'cat /tmp/x', content: '', done: false })
    sess.channel.push({ type: 'text', content: 'done', done: false })
    sess.channel.push({ type: 'result', content: 'done', done: true })

    const loop = engine.processInteractiveEvents(state, session, engine.sessions, key, 'm1', Promise.resolve(undefined), 'ctx')
    for (let i = 0; i < 100 && state.pending === undefined; i++) {
      await new Promise((r) => { setTimeout(r, 10) })
    }
    expect(state.pending?.requestID).toBe('req-r')
    // Pre-card detach (Go engine_events.go ~4192-4225): the live card is
    // finalized BEFORE the user answers, so its updates stop at permission
    // time; the accumulated text stays on the card (preview active) instead
    // of being re-sent as a plain message.
    const oldCardUpdates = updates.filter(u => u.handle === 'handle-1').length
    expect(oldCardUpdates).toBeGreaterThan(0)
    state.pending?.resolve()
    await loop
    await new Promise((r) => { setTimeout(r, 50) })

    // Turn-entry placeholder + post-approval placeholder: a fresh card.
    expect(starts.length).toBe(2)
    // The post-approval tool progress lands on the NEW card only.
    expect(updates.some(u => u.handle === 'handle-2')).toBe(true)
    expect(updates.every(u => u.handle !== 'handle-1' || !u.content.includes('cat /tmp/x'))).toBe(true)
    // The old card is never touched again after the permission card went out.
    expect(updates.filter(u => u.handle === 'handle-1').length).toBe(oldCardUpdates)
    // Preview active: the pre-interaction text is not re-sent as a message.
    expect(p.getSent().join('\n')).not.toContain('intro narration')
  })
})
