/**
 * M3→B2 concurrency/boundary tests: permission asks render while the prompt
 * send is still blocked, reapIdle skips ask-waiting sessions, /ps blocked on
 * an ask routes to the queue, questions asks are surfaced (not auto-denied),
 * and compact progress coalesces thinking and tool use. The channel-pushed
 * permission_request events are gone: asks arrive through the engine's
 * askUser delegate while the event loop stays parked on its receive.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-concurrency
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
  newQueuingSession,
  newPendingAsk,
  testQuestions,
} from '../stubs/engine-stubs.js'
import type { Agent, Message, Platform } from '../../src/core/types.js'

function newEngine(agent?: Agent, p?: Platform): { e: Engine } {
  const platform = p ?? createStubPlatform()
  const engine = new Engine('test', agent ?? createStubAgent(), [platform], '', 'en')
  return { e: engine }
}

describe('AskWhileSendBlocked', () => {
  it('the ask card renders while Send is still blocked', async () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const sess = newControllableSession('blk-perm')
    const key = 'test:user1'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    // The prompt send never settles; the ask delegate renders regardless —
    // it does not queue behind the event loop.
    let unblock!: () => void
    const blockedSend = new Promise<unknown>((resolve) => { unblock = () => { resolve(undefined) } })
    const loopDone = e.processInteractiveEvents(state, session, e.sessions, key, 'm1', blockedSend, 'ctx')

    const decision = e.askUser(key, { kind: 'permission', toolName: 'write_file', preview: '/tmp/x' })
    await new Promise((r) => { setTimeout(r, 30) })

    expect(p.getSent().length).toBeGreaterThan(0)
    expect(state.pendingAsk).toBeDefined()

    state.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await decision
    unblock()
    sess.channel.close()
    await Promise.race([
      loopDone,
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 3000) }),
    ])
  })
})

describe('ReapIdle_SkipsAskWait', () => {
  it('idle reaper does not close a session waiting on an ask', () => {
    const { e } = newEngine()
    e.setInteractiveIdleTimeout(50)
    const p = createStubPlatform()
    const sess = newControllableSession('perm-wait')
    const key = 'test:user2'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.pendingAsk = newPendingAsk({ request: { kind: 'permission', toolName: 'Bash', preview: '' } })
    state.lastActivity = Date.now() - 10_000
    e.interactiveStates.set(key, state)

    e.reapIdleInteractiveStates()

    expect(sess.aliveFlag, 'session should not be closed').toBe(true)
    expect(e.interactiveStates.has(key), 'state should still exist').toBe(true)
  })
})

describe('Ps_BlockedOnAsk_RoutesToQueue', () => {
  it('message queues (not stdin) while an ask is pending', () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const sess = newQueuingSession('ps-blocked')
    const key = 'test:user1'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx1'
    state.pendingAsk = newPendingAsk({ request: { kind: 'permission', toolName: 'Bash', preview: '' } })
    state.activeTurns = 1
    e.interactiveStates.set(key, state)

    const msg: Message = {
      sessionKey: key,
      platform: 'test',
      messageID: '',
      userID: 'user1',
      userName: '',
      chatName: '',
      chatType: '',
      content: 'look at the logs',
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
    }
    const ok = e.queueMessageForBusySession(p, msg, key)

    expect(ok).toBe(true)
    expect(sess.sendCalls, 'blocked → queued, not stdin').toEqual([])
    expect(state.pendingMessages).toHaveLength(1)
    expect(state.pendingMessages[0]!.content).toBe('look at the logs')
  })
})

describe('ForegroundAskSurfaces_Bash', () => {
  it('a foreground Bash ask surfaces a card (Go engine_events.go ~4106)', async () => {
    // Go auto-denies a genuine-background Bash only in runUnsolicitedReader;
    // TS has no background reader, so every foreground ask surfaces (the
    // gate itself stays covered by the pure-function table tests).
    const { e } = newEngine()
    const p = createStubPlatform()
    const key = 'test:perm:u1'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'permission', toolName: 'Bash', preview: 'ls' })
    await new Promise((r) => { setTimeout(r, 30) })

    expect(state.pendingAsk?.request.kind).toBe('permission')
    expect(p.getSent().join('\n')).toContain('Bash')

    state.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await expect(decision).resolves.toEqual({ outcome: 'allowed-once' })
  })
})

describe('QuestionsAsk_SurfacedNotDenied', () => {
  it('a questions ask is surfaced (parked), not auto-denied', async () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const key = 'feishu:oc_askq'
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-askq'
    e.interactiveStates.set(key, state)

    const decision = e.askUser(key, { kind: 'questions', questions: testQuestions() })
    await new Promise((r) => { setTimeout(r, 30) })

    expect(state.pendingAsk, 'ask should be parked for questions').toBeDefined()
    expect(p.getSent().join('\n')).toContain('Which database?')

    state.pendingAsk?.resolve({ answers: [{ id: 'Which database?', selected: ['PostgreSQL'] }] })
    await expect(decision).resolves.toEqual({
      answers: [{ id: 'Which database?', selected: ['PostgreSQL'] }],
    })
  })
})

describe('CompactProgressCoalescesThinkingAndToolUse', () => {
  it('thinking and tool_use coalesce into one preview, result is separate', async () => {
    const { e } = newEngine()
    e.setDisplayConfig({ thinkingMessages: false, toolProgress: true })
    const p = createStubPlatform()
    const key = 'feishu:user1'
    const session = e.sessions.getOrCreateActive(key)
    const sess = newControllableSession('s1')
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx-compact'
    e.interactiveStates.set(key, state)

    sess.channel.push({ type: 'thinking', content: 'Thinking about command', done: false })
    sess.channel.push({ type: 'tool_use', toolName: 'Bash', toolInput: 'pwd', content: '', done: false })
    sess.channel.push({ type: 'text', content: 'done', done: false })
    sess.channel.push({ type: 'result', content: 'done', done: true })

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), state.replyCtx),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 3000) }),
    ])

    const sent = p.getSent()
    expect(sent).toEqual(['done'])
  })
})
