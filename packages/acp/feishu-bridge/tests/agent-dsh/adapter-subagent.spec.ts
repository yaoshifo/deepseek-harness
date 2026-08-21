/**
 * Subagent lineage attribution tests: durable events from a delegated child
 * session project into the owning bridge session's EventChannel with
 * `fromSubagent`, namespaced tool ids, and running-count `subagent_status`
 * updates; sessions without a resolvable bridge ancestor stay invisible.
 *
 * @module dsh-feishu-bridge/tests-adapter-subagent
 */

import { describe, expect, it } from 'vitest'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'
import type { Event } from '../../src/core/types.js'

/** A session reference emitted through `session/event`, header included. */
interface SessionRef {
  id: string
  header?: { parentSession?: unknown }
}

/** A live agent the fake registry serves (bridge sessions and subagent children alike). */
interface FakeAgent extends DshAgentLike {
  sessionRef: SessionRef
}

function createAgent(id: string, parentSession?: string): FakeAgent {
  return {
    id,
    status: 'idle',
    session: { events: [], ...(parentSession !== undefined ? { header: { parentSession } } : {}) },
    sessionRef: { id, ...(parentSession !== undefined ? { header: { parentSession } } : {}) },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
}

function createHarness(): {
  ctx: DshContextLike
  agents: Map<string, FakeAgent>
  listeners: Map<string, Array<(...args: never[]) => unknown>>
  emitSession(ref: SessionRef, event: Record<string, unknown>): void
} {
  const agents = new Map<string, FakeAgent>()
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const emitSession = (ref: SessionRef, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of listeners.get('session/event') ?? []) {
      ;(l as unknown as (session: SessionRef, ev: Record<string, unknown>) => void)(ref, { type, seq: 0, time: 0, data })
    }
  }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        const id = `agent-${agents.size + 1}`
        const parent = options.meta?.parentSession
        const agent = createAgent(id, typeof parent === 'string' ? parent : undefined)
        agents.set(id, agent)
        const handle: DshAgentHandleLike = { agent, dispose: async () => {} }
        return handle
      },
      resume: async () => { throw new Error('resume not used in this suite') },
      get: (id: unknown) => agents.get(String(id)),
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    get: () => undefined,
  }
  return { ctx, agents, listeners, emitSession }
}

/** Collect the next n buffered channel events (emit before receiving). */
async function receiveN(events: { receive(): Promise<{ done: false; event: Event } | { done: true }> }, n: number): Promise<Event[]> {
  const out: Event[] = []
  for (let i = 0; i < n; i++) {
    const r = await events.receive()
    if (r.done) break
    out.push(r.event)
  }
  return out
}

describe('DshAgentAdapter subagent lineage attribution', () => {
  it('projects a direct child session tool events into the parent channel with fromSubagent and namespaced ids', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    h.agents.set('child-1', createAgent('child-1', bridgeID))

    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'tool/call', callId: 'c1', name: 'bash', arguments: 'ls' })
    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'tool/result', message: { callId: 'c1', content: [{ type: 'text', text: 'file-a' }] } })

    const got = await receiveN(bridge.events(), 2)
    expect(got[0]).toMatchObject({ type: 'tool_use', toolName: 'bash', toolInput: 'ls', toolID: 'child-1:c1', fromSubagent: true })
    expect(got[1]).toMatchObject({ type: 'tool_result', toolResult: 'file-a', toolID: 'child-1:c1', fromSubagent: true })
  })

  it('emits the cumulative count on first turn edges and stays quiet for other child events', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    const childRef: SessionRef = { id: 'child-1', header: { parentSession: bridgeID } }
    h.agents.set('child-1', createAgent('child-1', bridgeID))

    h.emitSession(childRef, { type: 'assistant/message', message: { content: [{ type: 'text', text: 'thinking aloud' }] } })
    h.emitSession(childRef, { type: 'turn/start' })
    h.emitSession(childRef, { type: 'tool/call', callId: 'c1', name: 'bash', arguments: 'ls' })
    h.emitSession(childRef, { type: 'turn/end', reason: { kind: 'end' } })
    // A second turn of the same child adds nothing: one child ran, count stays 1.
    h.emitSession(childRef, { type: 'turn/start' })

    // The assistant message and turn edges beyond the first project nothing.
    const got = await receiveN(bridge.events(), 2)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
    expect(got[1]).toMatchObject({ type: 'tool_use', fromSubagent: true })
  })

  it('counts each distinct child once and attributes a grandchild through the lineage chain', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    h.agents.set('child-1', createAgent('child-1', bridgeID))
    h.agents.set('child-2', createAgent('child-2', bridgeID))
    h.agents.set('grandchild-1', createAgent('grandchild-1', 'child-2'))

    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'turn/start' })
    h.emitSession({ id: 'child-2', header: { parentSession: bridgeID } }, { type: 'turn/start' })
    h.emitSession({ id: 'grandchild-1', header: { parentSession: 'child-2' } }, { type: 'tool/call', callId: 'g1', name: 'read', arguments: '/tmp/x' })

    const got = await receiveN(bridge.events(), 3)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
    expect(got[1]).toMatchObject({ type: 'subagent_status', content: '2' })
    expect(got[2]).toMatchObject({ type: 'tool_use', toolID: 'grandchild-1:g1', toolName: 'read', fromSubagent: true })
  })

  it('drops events from sessions with no parentSession lineage', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()

    h.emitSession({ id: 'stranger-1' }, { type: 'tool/call', callId: 'c1', name: 'bash', arguments: 'ls' })
    // Positive control: a real child event still arrives, and only it.
    h.agents.set('child-1', createAgent('child-1', bridgeID))
    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'turn/start' })

    const got = await receiveN(bridge.events(), 1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
  })

  it('drops events when the lineage chain breaks before a live bridge session', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    // grandchild-1's parent child-9 is not live anywhere: chain breaks.
    h.emitSession({ id: 'grandchild-1', header: { parentSession: 'child-9' } }, { type: 'tool/call', callId: 'g1', name: 'bash', arguments: 'ls' })

    // Positive control: a valid child chain still projects exactly one event.
    h.agents.set('child-1', createAgent('child-1', bridgeID))
    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'turn/start' })
    const got = await receiveN(bridge.events(), 1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
  })

  it('ignores duplicate turn edges, dataless events, and results without callId', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    const childRef: SessionRef = { id: 'child-1', header: { parentSession: bridgeID } }
    h.agents.set('child-1', createAgent('child-1', bridgeID))

    h.emitSession(childRef, { type: 'turn/start' })
    h.emitSession(childRef, { type: 'turn/start' }) // duplicate: no count change
    h.emitSession(childRef, { type: 'turn/end', reason: { kind: 'end' } }) // cumulative: no count change
    h.emitSession(childRef, { type: 'tool/call' }) // no data payload
    h.emitSession(childRef, { type: 'tool/result', message: { content: [{ type: 'text', text: 'no-callid' }] } })
    // A raw durable event with no `data` key at all exercises the payload-unwrap fallback.
    for (const l of h.listeners.get('session/event') ?? []) {
      ;(l as unknown as (session: SessionRef, ev: Record<string, unknown>) => void)(
        childRef, { type: 'turn/end', seq: 0, time: 0 },
      )
    }

    // Exactly: status 1, dataless tool_use, callid-less tool_result.
    const got = await receiveN(bridge.events(), 3)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
    expect(got[1]).toMatchObject({ type: 'tool_use', toolName: '', fromSubagent: true })
    expect(got[2]).toMatchObject({ type: 'tool_result', toolResult: 'no-callid', fromSubagent: true })
    expect(got[2]?.toolID).toBeUndefined()
  })

  it('gives up after the lineage depth cap instead of looping forever', async () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, { agentName: 'dsh', cwd: '/w', providers: [], activeProvider: '' })
    const bridge = await a.startSession('')
    const bridgeID = bridge.currentSessionID()
    // A 9-link chain of live-but-not-bridge agents: deeper than the 8-hop cap,
    // and it never reaches the bridge session (which sits at the same id as
    // the top link's parent is deliberately absent).
    let prev = 'a-0'
    for (let i = 1; i <= 9; i++) {
      h.agents.set(`a-${i}`, createAgent(`a-${i}`, prev))
      prev = `a-${i}`
    }
    h.emitSession({ id: 'deep-child', header: { parentSession: 'a-9' } }, { type: 'tool/call', callId: 'd1', name: 'bash', arguments: 'ls' })

    // Positive control: the capped walk dropped the event; a direct child still projects.
    h.agents.set('child-1', createAgent('child-1', bridgeID))
    h.emitSession({ id: 'child-1', header: { parentSession: bridgeID } }, { type: 'turn/start' })
    const got = await receiveN(bridge.events(), 1)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'subagent_status', content: '1' })
  })
})
