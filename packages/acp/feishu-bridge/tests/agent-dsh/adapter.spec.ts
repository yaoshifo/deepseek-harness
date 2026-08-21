import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContinueSession, type Event } from '../../src/core/types.js'
import { DshAgentAdapter, DshAgentSession, sessionBypassesPermissions, stripModelAlias, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'

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
    session: { events: [] },
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
  /** Services ctx.get resolves (e.g. the fake userQuestions service). */
  services: Record<string, unknown>
  /** All ctx.on listeners keyed by event name. */
  listeners: Map<string, Array<(...args: never[]) => unknown>>
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
  const services: Record<string, unknown> = {}
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()

  // Real `session/event` payloads arrive as durable SessionEvent records
  // ({type, seq, time, data}); mirror that shape at the sink so the
  // projection under test reads fields exactly as production delivers them
  // (a flat shape once masked the payload-unwrap bug entirely).
  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of listeners.get('session/event') ?? []) {
      ;(l as unknown as (session: { id: unknown }, ev: Record<string, unknown>) => void)({ id: sessionId }, { type, seq: 0, time: 0, data })
    }
  }
  const disposeAgent = (agent: RecordedAgent): void => {
    agent.disposed = true
    for (const l of listeners.get('agent/disposed') ?? []) {
      ;(l as unknown as (payload: { agent: DshAgentLike }) => void)({ agent })
    }
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
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    get: (name: string) => services[name],
  }
  return { ctx, creates, resumes, agents, services, listeners, emit, disposeAgent }
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
  it('getActiveProvider exposes the route context window (Go ProviderConfig.ContextWindow)', () => {
    const h = createHarness()
    const a = new DshAgentAdapter(h.ctx, {
      agentName: 'dsh',
      cwd: '/workspace/project',
      providers: [
        { name: 'glm', provider: 'glm-route', model: 'glm-5.3[1m]' },
        { name: 'turbo', provider: 'turbo-route', model: 'deepseek-v4-flash', contextWindow: 1_000_000 },
      ],
      activeProvider: 'glm',
    })
    expect(a.getActiveProvider()).toEqual({ name: 'glm' })
    expect(a.setActiveProvider('turbo')).toBe(true)
    expect(a.getActiveProvider()).toEqual({ name: 'turbo', contextWindow: 1_000_000 })
  })

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

  it('WorkDirSwitcher: setWorkDir changes the create cwd without touching the config', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_10:ou_9'])
    expect(a.getWorkDir()).toBe('/workspace/project')

    // The engine switches the dir around StartSession (per-chat --dir
    // override, Go applyWorkDirOverride) and restores it afterwards.
    a.setWorkDir('/tmp/child-dir')
    await a.startSession('')
    a.setWorkDir('/workspace/project')

    expect(h.creates[0]!.meta).toEqual({ cwd: '/tmp/child-dir' })
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

  it('engineKeyForAgentID maps a live native agent id back to its engine key', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_4:ou_9'])

    const session = await a.startSession('')

    expect(a.engineKeyForAgentID(session.currentSessionID())).toBe('feishu:oc_4:ou_9')
    expect(a.engineKeyForAgentID('agent-unknown')).toBeUndefined()
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

  it('send stages attachment bytes to disk and references their paths (#8)', async () => {
    const h = createHarness()
    // A real temp cwd: the Go dshSession.Send semantics stage image/file
    // bytes under <workDir>/.feishu-bridge/attachments and reference the paths.
    const workDir = mkdtempSync(join(tmpdir(), 'adapter-att-'))
    const a = new DshAgentAdapter(h.ctx, {
      agentName: 'dsh',
      cwd: workDir,
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3[1m]' }],
      activeProvider: 'glm',
    })
    const session = await a.startSession('')

    await session.send('hello world', [], [])
    await session.send('with file', [], [{ mimeType: 'text/plain', data: new TextEncoder().encode('F'), fileName: 'a.txt' }])
    await session.send('with image', [{ mimeType: 'image/png', data: new TextEncoder().encode('I') }], [])

    expect(h.agents[0]!.followups).toHaveLength(3)
    const first = h.agents[0]!.followups[0] as { content: Array<{ type: string; text: string }>; role: string }
    expect(first.role).toBe('user')
    expect(first.content[0]).toEqual({ type: 'text', text: 'hello world' })
    const second = h.agents[0]!.followups[1] as { content: Array<{ type: string; text: string }> }
    expect(second.content[0]!.text).toContain('with file')
    expect(second.content[0]!.text).toMatch(/\(Files saved locally, please read them: .*a\.txt\)/)
    const third = h.agents[0]!.followups[2] as { content: Array<{ type: string; text: string }> }
    expect(third.content[0]!.text).toMatch(/\(Images saved locally, please read them: .*\.png\)/)
    expect(existsSync(join(workDir, '.feishu-bridge', 'attachments', 'a.txt'))).toBe(true)
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

/** Fake userQuestions service capturing the adapter's provider (M3). */
interface FakeProvider {
  ask(req: Record<string, unknown>): Promise<unknown>
}

function createUserQuestionsHarness(): { h: Harness; adapter: DshAgentAdapter; providers: FakeProvider[] } {
  const h = createHarness()
  const providers: FakeProvider[] = []
  h.services.userQuestions = {
    registerProvider(p: FakeProvider): () => void {
      providers.push(p)
      return () => {}
    },
  }
  const adapter = newAdapter(h)
  return { h, adapter, providers }
}

/** Structural copy of dsh's plan-review question item (AskUserQuestionItem). */
function planReviewQuestion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# Fix spinner\n\n1. resolve asset path\n2. upload gif',
    options: [
      { label: 'Approve', description: 'Leave plan mode.' },
      { label: 'Keep planning', description: 'Stay in plan mode.' },
    ],
    intent: { kind: 'plan-review', approve: 'Approve' },
    ...overrides,
  }
}

/** Start a session (registering the provider) and return it plus the ask function. */
async function startedProvider(): Promise<{
  session: DshAgentSession
  ask: (req: Record<string, unknown>) => Promise<unknown>
}> {
  const { adapter, providers } = createUserQuestionsHarness()
  const session = (await adapter.startSession('')) as DshAgentSession
  const provider = providers[0]
  if (provider === undefined) throw new Error('userQuestions provider was not registered')
  return { session, ask: req => provider.ask(req) }
}

/** The next event on the session channel; fails the test when the channel is done. */
async function nextEvent(session: DshAgentSession): Promise<Record<string, unknown>> {
  const recv = await session.events().receive()
  if (recv.done) throw new Error('channel closed before the expected event')
  return recv.event as unknown as Record<string, unknown>
}

describe('DshAgentAdapter userQuestions provider', () => {
  it('registers the provider on first session creation', async () => {
    const { adapter, providers } = createUserQuestionsHarness()
    expect(providers).toHaveLength(0)
    await adapter.startSession('')
    expect(providers).toHaveLength(1)
  })

  it('plan-review ask emits an ExitPlanMode permission request with the plan heading', async () => {
    const { session, ask } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })

    const event = await nextEvent(session)
    expect(event.type).toBe('permission_request')
    expect(event.toolName).toBe('ExitPlanMode')
    // Go planReviewItem: the card heading is the first line of the plan.
    expect(event.toolInput).toBe('# Fix spinner')
    expect(event.toolInputRaw).toEqual({ plan: '# Fix spinner\n\n1. resolve asset path\n2. upload gif' })

    void session.respondPermission(String(event.requestID), { behavior: 'allow', updatedInput: { plan: 'x' } })
    await askPromise
  })

  it('a single-line plan falls back to the question as the card heading', async () => {
    const { session, ask } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion({ detail: '# One line plan' })],
      agent: { session: { id: session.currentSessionID() } },
    })

    const event = await nextEvent(session)
    expect(event.toolName).toBe('ExitPlanMode')
    // Go planReviewItem: no newline in the plan → the question is the heading.
    expect(event.toolInput).toBe('Approve this plan and leave plan mode?')

    void session.respondPermission(String(event.requestID), { behavior: 'allow', updatedInput: {} })
    await askPromise
  })

  it('approving the plan review answers with the intent approve label', async () => {
    const { session, ask } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    const event = await nextEvent(session)
    void session.respondPermission(String(event.requestID), { behavior: 'allow', updatedInput: {} })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
  })

  it('denying the plan review declines with the deny message as custom feedback', async () => {
    const { session, ask } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    const event = await nextEvent(session)
    void session.respondPermission(String(event.requestID), { behavior: 'deny', message: 'add tests first' })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: [], custom: 'add tests first' }],
    })
  })

  it('ordinary questions still emit AskUserQuestion and deliver collected answers', async () => {
    const { session, ask } = await startedProvider()

    const askPromise = ask({
      questions: [{ question: 'Which flavor?', options: [{ label: 'A' }, { label: 'B' }] }],
      agent: { session: { id: session.currentSessionID() } },
    })
    const event = await nextEvent(session)
    expect(event.toolName).toBe('AskUserQuestion')
    const questions = (event.toolInputRaw as { questions?: Array<{ question: string }> }).questions
    expect(questions?.[0]?.question).toBe('Which flavor?')

    void session.respondPermission(String(event.requestID), {
      behavior: 'allow',
      updatedInput: { answers: { 'Which flavor?': 'A' } },
    })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'Which flavor?', selected: ['A'] }],
    })
  })
})

describe('DshAgentAdapter approval answerer', () => {
  it('resolves the engine decision to the dsh approval outcome', async () => {
    const h = createUserQuestionsHarness()
    const session = await h.adapter.startSession('')
    const listener = h.h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')

    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-1',
      reason: 'rm -rf /tmp/x',
    })
    void session.respondPermission('call-1', { behavior: 'allow' })

    await expect(outcome).resolves.toBe('allowed-once')
  })
})

it('tool/result with tool-result blocks projects the inner text as toolResult', async () => {
  // Live dsh sessions wrap tool output in {type:'tool-result', content:[text]}
  // blocks — not bare text blocks (observed on the real machine: the tool
  // progress card rendered blank result sections).
  const h = createHarness()
  const a = newAdapter(h)
  a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_tr:ou_9'])
  const sess = await a.startSession('')
  const channel = sess.events()
  const agentID = sess.currentSessionID()

  h.emit(agentID, {
    type: 'tool/call',
    turn: 1,
    step: 1,
    callId: 'call-9',
    name: 'read',
    arguments: '{"file_path":"/x/header.md"}',
  })
  h.emit(agentID, {
    type: 'tool/result',
    turn: 1,
    step: 1,
    message: {
      content: [{
        type: 'tool-result',
        toolCallId: 'call-9',
        content: [textBlock('file header content')],
        isError: false,
      }],
    },
  })
  h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

  let toolResultEvent: { toolResult?: string } | undefined
  for (;;) {
    const got = await channel.receive()
    if (got.done) break
    if (got.event.type === 'tool_result') toolResultEvent = got.event
    if (got.event.type === 'result') break
  }
  expect(toolResultEvent?.toolResult).toBe('file header content')
})

it('tool/result projects the durable callId as toolID so the engine can close tool intervals', async () => {
  // The engine's token-rate thinking time subtracts tool windows keyed by
  // toolID; without it every window stays open until turn end and the rate
  // explodes (observed live: a 60 t/s turn rendered as 225 t/s).
  const h = createHarness()
  const a = newAdapter(h)
  a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_tr:ou_9'])
  const sess = await a.startSession('')
  const channel = sess.events()
  const agentID = sess.currentSessionID()

  h.emit(agentID, {
    type: 'tool/call',
    turn: 1,
    step: 1,
    callId: 'call-9',
    name: 'read',
    arguments: '{"file_path":"/x/header.md"}',
  })
  h.emit(agentID, {
    type: 'tool/result',
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', callId: 'call-9' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-9',
        content: [textBlock('file header content')],
        isError: false,
      }],
    },
  })
  h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

  let toolResultEvent: { toolID?: string } | undefined
  for (;;) {
    const got = await channel.receive()
    if (got.done) break
    if (got.event.type === 'tool_result') toolResultEvent = got.event
    if (got.event.type === 'result') break
  }
  expect(toolResultEvent?.toolID).toBe('call-9')
})

it('result carries the turn-wide usage sum and step count (Go accumulateUsage)', async () => {
  // The token rate and ctx/hit footer lines divide or label by the whole
  // turn's tokens; the last assistant/message alone undercounts multi-step
  // turns and numTurns never projected (ctx "N api" read 0).
  const h = createHarness()
  const a = newAdapter(h)
  a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_tr:ou_9'])
  const sess = await a.startSession('')
  const channel = sess.events()
  const agentID = sess.currentSessionID()

  const emitUsage = (step: number, usage: Record<string, number>): void => {
    h.emit(agentID, { type: 'assistant/message', turn: 1, step, message: { content: [textBlock('x')] }, usage })
  }
  emitUsage(1, { inputTokens: 100, cacheReadTokens: 30, outputTokens: 50 })
  emitUsage(2, { inputTokens: 60, cacheCreationTokens: 10, outputTokens: 90 })
  h.emit(agentID, { type: 'turn/end', turn: 1, reason: 'end_turn' })

  const results: Event[] = []
  for (;;) {
    const got = await channel.receive()
    if (got.done) break
    if (got.event.type === 'result') {
      results.push(got.event)
      break
    }
  }
  expect(results[0]?.outputTokens).toBe(140)
  expect(results[0]?.inputTokens).toBe(160)
  expect(results[0]?.totalInputTokens).toBe(200)
  expect(results[0]?.numTurns).toBe(2)

  // The next turn starts from zero, not from the previous turn's sum.
  emitUsage(1, { inputTokens: 5, outputTokens: 7 })
  h.emit(agentID, { type: 'turn/end', turn: 2, reason: 'end_turn' })
  let next: Event | undefined
  for (;;) {
    const got = await channel.receive()
    if (got.done) break
    if (got.event.type === 'result') {
      next = got.event
      break
    }
  }
  if (next === undefined) throw new Error('expected a second result event')
  expect(next.outputTokens).toBe(7)
  expect(next.inputTokens).toBe(5)
  expect(next.numTurns).toBe(1)
})

it('defaultMode plan activates plan mode on every startSession (Go agent options mode=plan)', async () => {
  const h = createHarness()
  const planSets: boolean[] = []
  h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
  const a = newAdapter(h)
  a.setDefaultMode('plan')

  // Distinct engine keys: a live session with the same key short-circuits
  // startSession before the mode application.
  for (const key of ['feishu:oc_m1:ou_9', 'feishu:oc_m2:ou_9']) {
    a.setSessionEnv([`CC_SESSION_KEY=${key}`])
    await a.startSession('')
  }
  expect(planSets).toEqual([true, true])

  // An explicit one-shot override wins once, then the default resumes.
  a.setSessionMode('default')
  a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_m3:ou_9'])
  await a.startSession('')
  a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_m4:ou_9'])
  await a.startSession('')
  expect(planSets).toEqual([true, true, false, true])
})

describe('sessionBypassesPermissions (Go effectiveMode → bypassPermissions)', () => {
  it('elevates unattended subtasks and chatroom roles, not attended ones or moderators', () => {
    expect(sessionBypassesPermissions(['CC_SUBTASK=1'])).toBe(true)
    expect(sessionBypassesPermissions(['CC_SUBTASK=1', 'CC_SUBTASK_ATTENDED=1'])).toBe(false)
    expect(sessionBypassesPermissions(['CC_CHATROOM_ROLE=1'])).toBe(true)
    expect(sessionBypassesPermissions(['CC_CHATROOM_DIRECT_ROLE=1'])).toBe(true)
    expect(sessionBypassesPermissions(['CC_CHATROOM_MODERATOR=1'])).toBe(false)
    expect(sessionBypassesPermissions(['CC_SESSION_KEY=feishu:oc_1:ou_9'])).toBe(false)
    expect(sessionBypassesPermissions([])).toBe(false)
  })
})

describe('effectiveMode bypass wiring', () => {
  it('an unattended subtask session auto-approves tool permissions without a card', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:child:ou_9', 'CC_SUBTASK=1', 'CC_SUBTASK_DEPTH=1'])
    const session = await a.startSession('')
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')

    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-1',
      reason: 'rm -rf /tmp/x',
    })
    // Settles with no respondPermission call: the answerer short-circuited
    // before emitting any permission_request toward the engine.
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('a chatroom role session auto-approves too', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:role:ou_9', 'CC_CHATROOM_ROLE=1'])
    const session = await a.startSession('')
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-2',
    })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('an attended subtask keeps the normal approval card path', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:child:ou_9', 'CC_SUBTASK=1', 'CC_SUBTASK_ATTENDED=1'])
    const session = await a.startSession('')
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-3',
    })
    // Still waiting for the engine decision until respondPermission fires.
    const probe = await Promise.race([outcome.then(() => 'settled'), new Promise((r) => { setTimeout(() => { r('pending') }, 30) })])
    expect(probe).toBe('pending')
    void session.respondPermission('call-3', { behavior: 'allow' })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('bypass overrides the plan default so subtask children never enter plan mode', async () => {
    const h = createHarness()
    const planSets: boolean[] = []
    h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
    const a = newAdapter(h)
    a.setDefaultMode('plan')
    a.setSessionEnv(['CC_SESSION_KEY=feishu:child:ou_9', 'CC_SUBTASK=1'])
    await a.startSession('')
    expect(planSets).toEqual([false])
  })
})
