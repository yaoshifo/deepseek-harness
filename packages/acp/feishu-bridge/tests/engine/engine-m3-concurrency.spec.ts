/**
 * M3 concurrency/boundary tests ported from cc-connect core/engine_test.go:
 * permission-while-send-blocked, reapIdle skips permission-waiting session,
 * /ps blocked on permission routes to queue, unsolicited reader permission
 * deny, unsolicited reader AskUserQuestion surfaced not denied, and compact
 * progress coalesces thinking and tool use.
 *
 * Red phase: the engine methods (handlePendingPermission with unsolicited
 * reader, shouldSurfaceUnsolicitedPermission) do not exist yet — these tests
 * fail until the M3 implementation lands.
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
  newPendingPermission,
} from '../stubs/engine-stubs.js'
import type { Agent, Platform } from '../../src/core/types.js'

function newEngine(agent?: Agent, p?: Platform): { e: Engine } {
  const platform = p ?? createStubPlatform()
  const engine = new Engine('test', agent ?? createStubAgent(), [platform], '', 'en')
  return { e: engine }
}

describe('PermissionWhileSendBlocked', () => {
  it('permission prompt is sent while Send is blocked', async () => {
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

    sess.channel.push({
      type: 'permission_request',
      requestID: 'req-blocked-send',
      toolName: 'write_file',
      toolInput: '/tmp/x',
      content: '',
      done: false,
    })
    sess.channel.push({ type: 'result', content: 'ok', done: true })

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, 'm1', Promise.resolve(undefined), 'ctx'),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 3000) }),
    ])

    const sent = p.getSent()
    expect(sent.length).toBeGreaterThan(0)
  })
})

describe('ReapIdle_SkipsPermissionWait', () => {
  it('idle reaper does not close a session waiting for permission', () => {
    const { e } = newEngine()
    e.setInteractiveIdleTimeout(50)
    const p = createStubPlatform()
    const sess = newControllableSession('perm-wait')
    const key = 'test:user2'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.pending = newPendingPermission({ requestID: 'req-1' })
    state.lastActivity = Date.now() - 10_000
    e.interactiveStates.set(key, state)

    e.reapIdleInteractiveStates()

    expect(sess.aliveFlag, 'session should not be closed').toBe(true)
    expect(e.interactiveStates.has(key), 'state should still exist').toBe(true)
  })
})

describe('Ps_BlockedOnPermission_RoutesToQueue', () => {
  it('message queues (not stdin) while permission is pending', () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const sess = newQueuingSession('ps-blocked')
    const key = 'test:user1'
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx1'
    state.pending = newPendingPermission({ requestID: 'req1' })
    state.activeTurns = 1
    e.interactiveStates.set(key, state)

    const ok = e.queueMessageForBusySession(p, {
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
      parentMessageID: '',
      quotedText: '',
    }, key)

    expect(ok).toBe(true)
    expect(sess.sendCalls, 'blocked → queued, not stdin').toEqual([])
    expect(state.pendingMessages).toHaveLength(1)
    expect(state.pendingMessages[0]!.content).toBe('look at the logs')
  })
})

describe('UnsolicitedReader_PermissionDeny', () => {
  it('genuine background Bash is auto-denied', async () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const sess = newControllableSession('unsol-perm')
    const key = 'test:perm:u1'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx'
    state.approveAll = false
    e.interactiveStates.set(key, state)

    sess.channel.push({
      type: 'permission_request',
      requestID: 'req-1',
      toolName: 'Bash',
      content: '',
      done: false,
    })
    sess.channel.close()

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, 'ctx'),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 3000) }),
    ])

    expect(sess.permResponses.length).toBeGreaterThanOrEqual(1)
    expect(sess.permResponses[0]!.result.behavior).toBe('deny')
  })
})

describe('UnsolicitedReader_AskUserQuestion_SurfacedNotDenied', () => {
  it('AskUserQuestion is surfaced (pending set), not auto-denied', async () => {
    const { e } = newEngine()
    const p = createStubPlatform()
    const sess = newControllableSession('s-askq')
    const key = 'feishu:oc_askq'
    const session = e.sessions.getOrCreateActive(key)
    const state = new InteractiveState()
    state.agentSession = sess
    state.platform = p
    state.replyCtx = 'ctx-askq'
    e.interactiveStates.set(key, state)

    sess.channel.push({
      type: 'permission_request',
      requestID: 'req-askq-1',
      toolName: 'AskUserQuestion',
      content: '',
      done: false,
    })
    sess.channel.close()

    await Promise.race([
      e.processInteractiveEvents(state, session, e.sessions, key, '', undefined, 'ctx'),
      new Promise((_, reject) => { setTimeout(() => { reject(new Error('timeout')) }, 3000) }),
    ])

    expect(state.pending, 'pending should be set for AskUserQuestion').toBeDefined()
    expect(state.pending?.requestID).toBe('req-askq-1')
    expect(sess.permResponses).toEqual([])
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
