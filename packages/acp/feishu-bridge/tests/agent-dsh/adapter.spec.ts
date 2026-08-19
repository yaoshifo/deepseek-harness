import { describe, expect, it } from 'vitest'
import { ContinueSession } from '../../src/core/types.js'
import { DshAgentAdapter, DshAgentSession, stripModelAlias, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'

// DshAgentAdapter unit tests: ctx.agents create/resume, followup/cancel call
// sequences, provider routing, [1m] stripping, dispose+resume provider
// switching, and session-event projection into the engine Event stream.

interface RecordedAgent extends DshAgentLike {
  id: string
  followups: unknown[]
  cancels: Array<{ cause: { kind: string }; keepInbox?: boolean | undefined }>
  disposed: boolean
  emit(sessionId: string, event: Record<string, unknown>): void
}

function createFakeAgent(id: string, sink: (sessionId: string, event: Record<string, unknown>) => void): RecordedAgent {
  const agent: RecordedAgent & { status: 'idle' | 'running' } = {
    id,
    status: 'idle',
    followups: [] as unknown[],
    cancels: [] as Array<{ cause: { kind: string }; keepInbox?: boolean | undefined }>,
    disposed: false,
    followup(message: unknown): void {
      agent.followups.push(message)
      agent.status = 'running'
    },
    cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void {
      agent.cancels.push({ cause, ...(options?.keepInbox !== undefined ? { keepInbox: options.keepInbox } : {}) })
    },
    emit(sessionId: string, event: Record<string, unknown>): void {
      sink(sessionId, event)
    },
  }
  return agent
}

interface Harness {
  ctx: DshContextLike
  creates: DshCreateOptionsLike[]
  resumes: DshCreateOptionsLike[]
  agents: RecordedAgent[]
  emit(sessionId: string, event: { type: string } & Record<string, unknown>): void
  disposeAgent(agent: RecordedAgent): void
}

/** Text content block literal for assistant messages. */
function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/** Reasoning content block literal. */
function reasoningBlock(text: string): { type: 'reasoning'; text: string } {
  return { type: 'reasoning', text }
}

function createHarness(): Harness {
  const creates: DshCreateOptionsLike[] = []
  const resumes: DshCreateOptionsLike[] = []
  const agents: RecordedAgent[] = []
  const sessionListeners: Array<(session: { id: unknown }, event: Record<string, unknown>) => void> = []
  const disposedListeners: Array<(payload: { agent: DshAgentLike }) => void> = []

  // Real `session/event` payloads arrive as durable SessionEvent records
  // ({type, seq, time, data}); mirror that shape at the sink so the
  // projection under test reads fields exactly as production delivers them
  // (a flat shape once masked the payload-unwrap bug entirely).
  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of sessionListeners) l({ id: sessionId }, { type, seq: 0, time: 0, data })
  }
  const disposeAgent = (agent: RecordedAgent): void => {
    agent.disposed = true
    for (const l of disposedListeners) l({ agent })
  }

  const counter = { n: 0 }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        counter.n += 1
        const id = `agent-${counter.n}`
        const agent = createFakeAgent(id, (sid, ev) => { emit(sid, ev) })
        agents.push(agent)
        const handle: DshAgentHandleLike = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        return handle
      },
      resume: async (options: DshCreateOptionsLike) => {
        resumes.push(options)
        const rid = options.resumeSessionId
        const id = typeof rid === 'string' ? rid : ''
        const agent = createFakeAgent(id, (sid, ev) => { emit(sid, ev) })
        agents.push(agent)
        const handle: DshAgentHandleLike = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        return handle
      },
      get: (id: unknown) => agents.find(a => a.id === String(id) && !a.disposed),
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const typed = listener as unknown as (session: { id: unknown }, ev: Record<string, unknown>) => void
      const typedDisposed = listener as unknown as (payload: { agent: DshAgentLike }) => void
      if (event === 'session/event') sessionListeners.push(typed)
      if (event === 'agent/disposed') disposedListeners.push(typedDisposed)
      return () => {}
    },
    get: (_name: string) => undefined,
  }
  return { ctx, creates, resumes, agents, emit, disposeAgent }
}

function newAdapter(h: Harness) {
  return new DshAgentAdapter(h.ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [
      { name: 'glm', provider: 'glm-route', model: 'glm-5.3[1m]' },
      { name: 'turbo', provider: 'turbo-route', model: 'deepseek-v4-flash' },
    ],
    activeProvider: 'glm',
  })
}

describe('stripModelAlias', () => {
  it('strips the [1m] suffix', () => {
    expect(stripModelAlias('glm-5.3[1m]')).toBe('glm-5.3')
    expect(stripModelAlias('glm-5.3')).toBe('glm-5.3')
  })
})

describe('DshAgentAdapter', () => {
  it('creates a fresh native session keyed by the engine session key', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_1:ou_9', 'CC_PROJECT=test'])

    const session = await a.startSession('')

    expect(h.creates).toHaveLength(1)
    // A new engine session must NOT reuse the engine key as the native
    // session id — that collides with the persisted log after /new.
    expect(String(h.creates[0]!.sessionId)).toMatch(/^cc-\d{8}-\d{6}-[0-9a-f]{12}$/)
    expect(h.creates[0]!.meta).toEqual({ cwd: '/workspace/project' })
    expect(session.currentSessionID()).toBe('agent-1')
  })

  it('resumes a persisted session with the same id', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_2:ou_9'])

    const session = await a.startSession('persisted-uuid')

    expect(h.resumes).toHaveLength(1)
    expect(String(h.resumes[0]!.resumeSessionId)).toBe('persisted-uuid')
    expect(session.currentSessionID()).toBe('persisted-uuid')
    expect(h.creates).toHaveLength(0)
  })

  it('ContinueSession sentinel creates a fresh session', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_3:ou_9'])

    await a.startSession(ContinueSession)

    expect(h.creates).toHaveLength(1)
    expect(h.resumes).toHaveLength(0)
  })

  it('routes agentOptions through the active provider with [1m] stripped', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    await a.startSession('')
    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'glm-route', model: 'glm-5.3' })

    const b = new DshAgentAdapter(h.ctx, {
      agentName: 'dsh',
      cwd: '/x',
      providers: [
        { name: 'glm', provider: 'glm-route', model: 'glm-5.3[1m]' },
        { name: 'turbo', provider: 'turbo-route', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      ],
      activeProvider: 'turbo',
    })
    await b.startSession('')
    const last = h.creates[h.creates.length - 1]!
    expect(last.agentOptions).toEqual({ provider: 'turbo-route', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  })

  it('reuses the live session for the same key', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=k1'])
    const s1 = await a.startSession('')
    a.setSessionEnv(['CC_SESSION_KEY=k1'])
    const s2 = await a.startSession('')
    expect(s2).toBe(s1)
    expect(h.creates).toHaveLength(1)
  })

  it('provider switch disposes the old agent and resumes the same session id', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=k2'])
    const s1 = await a.startSession('')
    const oldID = s1.currentSessionID()
    expect(s1.alive()).toBe(true)

    await s1.close()
    expect(h.agents[0]!.disposed).toBe(true)
    expect(s1.alive()).toBe(false)

    a.setSessionEnv(['CC_SESSION_KEY=k2'])
    const s2 = await a.startSession(oldID)
    expect(h.resumes).toHaveLength(1)
    expect(String(h.resumes[0]!.resumeSessionId)).toBe(oldID)
    expect(s2.currentSessionID()).toBe(oldID)
  })

  it('send posts followup user messages and records prompts', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')

    await session.send('hello world', [], [])
    await session.send('with file', [], [{ mimeType: 'text/plain', data: new Uint8Array([1]), fileName: 'a.txt' }])

    expect(h.agents[0]!.followups).toHaveLength(2)
    const first = h.agents[0]!.followups[0] as { content: Array<{ type: string; text: string }>; role: string }
    expect(first.role).toBe('user')
    expect(first.content[0]).toEqual({ type: 'text', text: 'hello world' })
    const second = h.agents[0]!.followups[1] as { content: Array<{ type: string; text: string }> }
    expect(second.content[0]!.text).toContain('attachments: a.txt')
  })

  it('cancelTurn cancels the in-flight turn as a user stop', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = (await a.startSession('')) as DshAgentSession
    session.cancelTurn()
    void a
    expect(h.agents[0]!.cancels).toEqual([{ cause: { kind: 'user' }, keepInbox: false }])
  })

  it('projects session events into the Event stream', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')
    const channel = session.events()
    void a

    const agentID = session.currentSessionID()
    h.emit(agentID, { type: 'turn/start', turn: 1 })
    h.emit(agentID, {
      type: 'assistant/message',
      turn: 1,
      step: 1,
      message: { content: [reasoningBlock('hmm')] },
    })
    h.emit(agentID, {
      type: 'assistant/message',
      turn: 1,
      step: 2,
      message: { content: [textBlock('partial')] },
    })
    h.emit(agentID, {
      type: 'tool/call',
      turn: 1,
      step: 2,
      callId: 'call-1',
      name: 'Bash',
      arguments: '{"command":"ls"}',
    })
    h.emit(agentID, {
      type: 'tool/result',
      turn: 1,
      step: 2,
      message: { content: [textBlock('file list')] },
    })
    h.emit(agentID, {
      type: 'assistant/message',
      turn: 1,
      step: 3,
      message: { content: [textBlock('final answer')] },
      usage: { inputTokens: 120, cacheReadTokens: 30, cacheCreationTokens: 10, outputTokens: 45 },
    })
    h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

    const collected: Array<{ type: string; content?: string }> = []
    for (;;) {
      const got = await channel.receive()
      if (got.done) throw new Error('channel closed before result')
      collected.push({ type: got.event.type, content: got.event.content })
      if (got.event.type === 'result') break
    }
    expect(collected.map(e => e.type)).toEqual([
      'thinking', 'text', 'tool_use', 'tool_result', 'text', 'result',
    ])
    expect(collected[4]!.content).toBe('final answer')
    const result = collected[5]!
    expect(result.content).toBe('final answer')
  })

  it('carries turn usage into the result event', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')
    const channel = session.events()
    const agentID = session.currentSessionID()

    h.emit(agentID, { type: 'turn/start', turn: 1 })
    h.emit(agentID, {
      type: 'assistant/message',
      turn: 1,
      step: 1,
      message: { content: [textBlock('done')] },
      usage: { inputTokens: 200, cacheReadTokens: 50, cacheCreationTokens: 0, outputTokens: 10 },
    })
    h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

    type ResultEvent = {
      done: false
      event: { type: string; content: string; inputTokens?: number; totalInputTokens?: number; outputTokens?: number }
    }
    let result: ResultEvent | undefined
    for (;;) {
      const got = await channel.receive()
      if (got.done) throw new Error('channel closed before result')
      if (got.event.type === 'result') {
        result = got
        break
      }
    }
    if (result === undefined) throw new Error('no result event')
    expect(result.done).toBe(false)
    expect(result.event.type).toBe('result')
    expect(result.event.inputTokens).toBe(200)
    expect(result.event.totalInputTokens).toBe(250)
    expect(result.event.outputTokens).toBe(10)
  })

  it('surfaces an error-reasoned turn/end as errorText on the result', async () => {
    // Live regression (M1 记账驴 cut-over): a "No API key for provider" turn
    // error arrived as an empty result and the engine degraded it to the
    // silent-reply hint instead of reporting the failure.
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')
    const channel = session.events()
    const agentID = session.currentSessionID()

    h.emit(agentID, { type: 'turn/start', turn: 1 })
    h.emit(agentID, {
      type: 'turn/end',
      turn: 1,
      reason: { kind: 'error', error: { message: 'No API key for provider: glm', code: 'PI_AI_ERROR' } },
    })

    let result: { done: false; event: { type: string; content: string; errorText?: string } } | undefined
    for (;;) {
      const got = await channel.receive()
      if (got.done) throw new Error('channel closed before result')
      if (got.event.type === 'result') {
        result = got
        break
      }
    }
    if (result === undefined) throw new Error('no result event')
    expect(result.event.content).toBe('')
    expect(result.event.errorText).toBe('No API key for provider: glm')
  })


  it('generates a fresh native session id per new engine session (no persisted-log collision)', async () => {
    // Live regression (M2 real-device): after /new, the next message tried
    // ctx.agents.create under the engine key and collided with the persisted
    // log of the chat's earlier session. New sessions must use generated
    // cc-* ids, mirroring the Go backend.
    const h = createHarness()
    const a = newAdapter(h)
    const first = await a.startSession('')
    await first.close()
    await a.startSession('')
    const ids = h.creates.map(c => String(c.sessionId))
    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^cc-\d{8}-\d{6}-[0-9a-f]{12}$/)
    expect(ids[1]).toMatch(/^cc-\d{8}-\d{6}-[0-9a-f]{12}$/)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('error-text absent on a normal turn/end', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')
    const channel = session.events()
    const agentID = session.currentSessionID()

    h.emit(agentID, { type: 'turn/start', turn: 1 })
    h.emit(agentID, {
      type: 'assistant/message',
      turn: 1,
      step: 1,
      message: { content: [textBlock('ok')] },
    })
    h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

    let result: { event: { type: string; content: string; errorText?: string } } | undefined
    for (;;) {
      const got = await channel.receive()
      if (got.done) throw new Error('channel closed before result')
      if (got.event.type === 'result') {
        result = got
        break
      }
    }
    if (result === undefined) throw new Error('no result event')
    expect(result.event.content).toBe('ok')
    expect(result.event.errorText).toBeUndefined()
  })

  it('agent/disposed closes the channel (process-exit path)', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('')
    const channel = session.events()

    h.disposeAgent(h.agents[0]!)

    expect(session.alive()).toBe(false)
    const got = await channel.receive()
    expect(got.done).toBe(true)
  })

  it('events for other sessions do not cross wires', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const s1 = await a.startSession('')
    a.setSessionEnv(['CC_SESSION_KEY=other'])
    const s2 = await a.startSession('')

    h.emit(s2.currentSessionID(), { type: 'turn/start', turn: 1 })
    h.emit(s2.currentSessionID(), {
      type: 'assistant/message',
      message: { content: [textBlock('for s2')] },
    })

    const ch1 = s1.events()
    h.emit(s1.currentSessionID(), { type: 'turn/start', turn: 1 })
    h.emit(s1.currentSessionID(), {
      type: 'assistant/message',
      message: { content: [textBlock('for s1')] },
    })

    const got1 = await ch1.receive()
    expect(got1.done).toBe(false)
    if (got1.done) throw new Error('unexpected close')
    expect(got1.event.type).toBe('text')
    expect(got1.event.content).toBe('for s1')
  })

  it('stop disposes every live agent', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=kA'])
    await a.startSession('')
    a.setSessionEnv(['CC_SESSION_KEY=kB'])
    await a.startSession('')

    await a.stop()

    expect(h.agents.every(agent => agent.disposed)).toBe(true)
  })
})
