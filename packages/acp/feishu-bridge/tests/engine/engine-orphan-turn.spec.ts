import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import {
  createControllableAgent,
  createStubPlatform,
  newBlockingSendSession,
  newControllableSession,
  type ControllableAgentSession,
  type StubPlatform,
} from '../stubs/engine-stubs.js'
import type { Agent, Platform } from '../../src/core/types.js'

// Engine-woken turns (background job completion, background subagent report)
// start with no user message in flight, so no message-path event pump is
// alive. The orphan watch must pick their events off the channel and deliver
// them to the platform exactly like a message-driven turn (2026-08-23
// oc_9956 incident: three turns and an exit_plan_mode review were silently
// dropped, then reaped as disposed).

function newEngine(agent?: Agent, p?: Platform): { e: Engine; p: StubPlatform } {
  const platform = p ?? createStubPlatform()
  const engine = new Engine('test', agent ?? createControllableAgent(), [platform], '', 'en')
  return { e: engine, p: platform as StubPlatform }
}

function msg(overrides: Partial<Parameters<Engine['receiveMessage']>[1]> = {}) {
  return {
    sessionKey: 'test:user1',
    platform: 'test',
    messageID: '',
    userID: '',
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

/** Poll a predicate until it holds or the deadline passes (pump timing). */
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 10) })
  }
}

/** A session whose send immediately completes the turn with a result event. */
function resultSession(id: string, result: string): ControllableAgentSession {
  const s = newControllableSession(id)
  s.send = async () => {
    s.sendCalls.push('sent')
    s.channel.push({ type: 'result', content: result, done: true })
  }
  return s
}

describe('orphan turn pump', () => {
  it('delivers an engine-woken turn after the message pump exited', async () => {
    const agentSession = resultSession('s1', 'turn 1 done')
    const agent = createControllableAgent(agentSession)
    const { e, p } = newEngine(agent)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)

    e.receiveMessage(p, msg({ content: 'go', sessionKey }))
    await waitFor(() => session.lastResult === 'turn 1 done')
    expect(session.lastResult).toBe('turn 1 done')
    p.clearSent()

    agentSession.channel.push({ type: 'result', content: 'subagent report summary', done: true })
    await waitFor(() => p.getSent().some(t => t.includes('subagent report summary')))

    expect(p.getSent().some(t => t.includes('subagent report summary'))).toBe(true)
    expect(session.lastResult).toBe('subagent report summary')
  })

  it('bridges an orphan turn ask and shields it from the reaper', async () => {
    const agentSession = resultSession('s1', 'turn 1 done')
    const agent = createControllableAgent(agentSession)
    const { e, p } = newEngine(agent)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)

    e.receiveMessage(p, msg({ content: 'go', sessionKey }))
    await waitFor(() => session.lastResult === 'turn 1 done')
    expect(session.lastResult).toBe('turn 1 done')
    p.clearSent()

    // The parked approval (oc_9956 incident): the native answerer asks while
    // no message pump is alive; the delegate must surface it as a parked ask,
    // not drop it silently.
    const decision = e.askUser(sessionKey, { kind: 'permission', toolName: 'write', preview: '/tmp/x' })
    await waitFor(() => e.interactiveStates.get(sessionKey)?.pendingAsk !== undefined)

    const state = e.interactiveStates.get(sessionKey)
    expect(state?.pendingAsk?.request.kind).toBe('permission')
    expect(p.getSent().join('\n')).toContain('write')

    // The parked ask must not be reaped away with the session.
    e.interactiveIdleTimeout = 1
    await new Promise((r) => { setTimeout(r, 20) })
    e.reapIdleInteractiveStates()
    expect(e.interactiveStates.get(sessionKey)).toBeDefined()

    // The decision settles; the turn continues and its result still reaches
    // the chat through the orphan watch.
    state?.pendingAsk?.resolve({ outcome: 'allowed-once' })
    await decision
    agentSession.channel.push({ type: 'result', content: 'post-approval reply', done: true })
    await waitFor(() => session.lastResult === 'post-approval reply')
  })

  it('hands an orphan event back to a running message pump instead of racing it', async () => {
    // Turn 1 completes synchronously and leaves the orphan watch armed.
    const first = resultSession('s1', 'turn 1 done')
    const agent = createControllableAgent(first)
    const { e, p } = newEngine(agent)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    e.receiveMessage(p, msg({ content: 'go', sessionKey }))
    await waitFor(() => session.lastResult === 'turn 1 done')
    p.clearSent()

    // Turn 2 blocks inside send, so its message-path pump is alive and holds
    // the session lock when the orphan event arrives. Same session id, so the
    // interactive state (and its armed watch) carries over.
    const second = newBlockingSendSession('s1')
    e.interactiveStates.get(sessionKey)!.agentSession = second
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      e.receiveMessage(p, msg({ content: 'second', sessionKey }))
      await second.sendStarted
      // Orphan event while the message pump owns the session: the watch
      // re-pushes it for the message pump — no second pump may start.
      second.channel.push({ type: 'text', content: 'orphan during turn 2', done: false })
      second.unblock()
      second.channel.push({ type: 'result', content: 'turn 2 done', done: true })
      await waitFor(() => session.lastResult === 'turn 2 done')
      expect(p.getSent().some(t => t.includes('turn 2 done'))).toBe(true)
      expect(infoSpy.mock.calls.some(c => String(c[0]).includes('orphan turn pump started'))).toBe(false)
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('delivers cascading orphan turns one pump at a time', async () => {
    const agentSession = resultSession('s1', 'turn 1 done')
    const agent = createControllableAgent(agentSession)
    const { e, p } = newEngine(agent)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    e.receiveMessage(p, msg({ content: 'go', sessionKey }))
    await waitFor(() => session.lastResult === 'turn 1 done')
    p.clearSent()

    // Two background reports land back to back (job completion, then
    // subagent report): the first orphan pump runs to completion and re-arms
    // before the second turn's events are consumed.
    agentSession.channel.push({ type: 'result', content: 'first report', done: true })
    await waitFor(() => session.lastResult === 'first report')
    agentSession.channel.push({ type: 'result', content: 'second report', done: true })
    await waitFor(() => session.lastResult === 'second report')

    expect(p.getSent().some(t => t.includes('first report'))).toBe(true)
    expect(p.getSent().some(t => t.includes('second report'))).toBe(true)
  })

  it('queues a user message arriving while an orphan pump owns the session', async () => {
    const agentSession = resultSession('s1', 'turn 1 done')
    const agent = createControllableAgent(agentSession)
    const { e, p } = newEngine(agent)
    const sessionKey = 'test:user1'
    const session = e.sessions.getOrCreateActive(sessionKey)
    e.receiveMessage(p, msg({ content: 'go', sessionKey }))
    await waitFor(() => session.lastResult === 'turn 1 done')
    p.clearSent()

    // The orphan pump consumes a tool event and parks awaiting the next one;
    // the session lock stays taken for the whole orphan turn.
    agentSession.channel.push({ type: 'tool_use', toolName: 'bash', toolInput: 'pytest', toolID: 'c1', content: '', done: false })
    await waitFor(() => e.interactiveStates.get(sessionKey)?.activeToolCalls === 1)

    e.receiveMessage(p, msg({ content: 'follow-up', sessionKey }))
    await waitFor(() => p.getSent().some(t => t.includes('Message received')))
    const state = e.interactiveStates.get(sessionKey)
    expect(p.getSent().some(t => t.includes('follow-up'))).toBe(false)
    expect(state?.pendingMessages.some(m => m.content === 'follow-up')).toBe(true)

    // The orphan turn ends; the queued message takes over through the normal
    // drain path.
    agentSession.send = async (prompt: string) => {
      agentSession.sendCalls.push(prompt)
      agentSession.channel.push({ type: 'result', content: 'queued turn reply', done: true })
    }
    agentSession.channel.push({ type: 'result', content: 'orphan done', done: true })
    // The orphan turn's result and the queued takeover follow each other
    // within one pump, so only the final reply is stably observable.
    await waitFor(() => session.lastResult === 'queued turn reply')
    expect(agentSession.sendCalls.some(c => c.includes('follow-up'))).toBe(true)
  })
})
