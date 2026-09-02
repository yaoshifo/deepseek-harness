import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { ContinueSession, type AskDecision, type AskDelegate, type AskRequest, type Event } from '../../src/core/types.ts'
import { ctxBridgeDispatch, type BridgeDispatch } from '../../src/bridge-service.ts'
import type { SessionStartOptions } from '../../src/core/types.ts'
import { DshAgentAdapter, DshAgentSession, unattendedSubtaskBypassesPermissions, stripModelAlias, toolBackgroundOf, type DshAdapterConfig, type DshAgentHandleLike, type DshAgentLike, type DshAgentsRegistryLike, type DshCreateOptionsLike, type DshContextLike, type QuestionRouting } from '../../src/agent-dsh/adapter.ts'

// DshAgentAdapter unit tests: ctx.agents create/resume, followup/cancel call
// sequences, provider routing, [1m] stripping, dispose+resume provider
// switching, and session-event projection into the engine Event stream.

// Persona policy tests dispatch through a real Cordis context carrying the
// persona listener halves (the chatroom package's production listeners have
// the same shape and are covered in their own package); the contexts are
// disposed after each test.
const policyContexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(policyContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Adapter dispatch face wired with the persona permission/mode policy listeners. */
function personaPolicyFace(): BridgeDispatch {
  const ctx = new Context()
  policyContexts.push(ctx)
  ctx.on('feishuBridge/permission-policy', (payload: { options: SessionStartOptions | undefined }, next: () => boolean) =>
    next() || payload.options?.persona?.bypassPermissions === true)
  ctx.on('feishuBridge/mode-policy', (payload: { options: SessionStartOptions | undefined; mode: string }, next: () => string) => {
    // A persona that never implements must not stall on a plan approval
    // nobody needs to give: its forced mode overrides an inherited plan.
    const forced = payload.options?.persona?.forceMode
    return forced !== undefined && payload.mode === 'plan' ? forced : next()
  })
  return ctxBridgeDispatch(ctx)
}

interface RecordedAgent extends DshAgentLike {
  id: string
  followups: unknown[]
  steers: unknown[]
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
    steers: [] as unknown[],
    cancels: [] as Array<{ cause: { kind: string }; keepInbox?: boolean | undefined }>,
    disposed: false,
    followup(message: unknown): void {
      agent.followups.push(message)
      agent.status = 'running'
    },
    steer(message: unknown): void {
      agent.steers.push(message)
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
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
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

describe('toolBackgroundOf', () => {
  it('reads the declared key, tolerates key-style variants, and stays foreground on garbage', () => {
    expect(toolBackgroundOf('{"run_in_background": true}')).toEqual({ toolBackground: true })
    expect(toolBackgroundOf('{"runInBackground": true}')).toEqual({ toolBackground: true })
    expect(toolBackgroundOf('{"run_in_background": false}')).toEqual({})
    expect(toolBackgroundOf('not json')).toEqual({})
    expect(toolBackgroundOf('')).toEqual({})
    expect(toolBackgroundOf(null)).toEqual({})
  })
})

describe('DshAgentAdapter', () => {
  it('a closed session removes itself from the live maps (no zombie /list rows)', async () => {
    // /new rotation, provider switch, idle reaping, and user stop all close
    // single sessions; a closed session left in liveSessions leaks (with its
    // 100-turn recent window) and lists as an active row shadowing the
    // persisted one.
    const h = createHarness()
    const a = newAdapter(h)
    const session = (await a.startSession('', { sessionKey: 'feishu:oc_z:ou_z' })) as DshAgentSession
    const id = session.currentSessionID()
    expect((await a.listSessions()).some(s => s.id === id)).toBe(true)

    await session.close()

    expect((await a.listSessions()).some(s => s.id === id), 'closed session must not list as live').toBe(false)
  })

  it('an agent/disposed session removes itself from the live maps too', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = (await a.startSession('', { sessionKey: 'feishu:oc_z2:ou_z' })) as DshAgentSession
    const id = session.currentSessionID()

    h.disposeAgent(h.agents.find(ag => ag.id === id)!)

    expect((await a.listSessions()).some(s => s.id === id), 'vanished agent must not list as live').toBe(false)
  })

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

    const session = await a.startSession('', { sessionKey: 'feishu:oc_1:ou_9' })

    expect(h.creates).toHaveLength(1)
    // A new engine session must NOT reuse the engine key as the native
    // session id — that collides with the persisted log after /new.
    expect(String(h.creates[0]!.sessionId)).toMatch(/^cc-\d{8}-\d{6}-[0-9a-f]{12}$/)
    expect(h.creates[0]!.meta).toEqual({ cwd: '/workspace/project' })
    expect(session.currentSessionID()).toBe('agent-1')
  })

  it('a per-session workDir option reaches create without touching the global', async () => {
    const h = createHarness()
    const a = newAdapter(h)

    await a.startSession('', { sessionKey: 'feishu:oc_w:ou_9', workDir: '/tmp/cron-job-dir' })

    expect(h.creates[0]!.meta).toEqual({ cwd: '/tmp/cron-job-dir' })
    expect(a.getWorkDir(), 'the global stays for concurrent sessions').toBe('/workspace/project')
  })

  it('WorkDirSwitcher: setWorkDir changes the create cwd without touching the config', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    expect(a.getWorkDir()).toBe('/workspace/project')

    // The engine switches the dir around StartSession (per-chat --dir
    // override, Go applyWorkDirOverride) and restores it afterwards.
    a.setWorkDir('/tmp/child-dir')
    await a.startSession('', { sessionKey: 'feishu:oc_10:ou_9' })
    a.setWorkDir('/workspace/project')

    expect(h.creates[0]!.meta).toEqual({ cwd: '/tmp/child-dir' })
  })

  it('resumes a persisted session with the same id', async () => {
    const h = createHarness()
    const a = newAdapter(h)

    const session = await a.startSession('persisted-uuid', { sessionKey: 'feishu:oc_2:ou_9' })

    expect(h.resumes).toHaveLength(1)
    expect(String(h.resumes[0]!.resumeSessionId)).toBe('persisted-uuid')
    expect(session.currentSessionID()).toBe('persisted-uuid')
    expect(h.creates).toHaveLength(0)
  })

  it('ContinueSession sentinel creates a fresh session', async () => {
    const h = createHarness()
    const a = newAdapter(h)

    await a.startSession(ContinueSession, { sessionKey: 'feishu:oc_3:ou_9' })

    expect(h.creates).toHaveLength(1)
    expect(h.resumes).toHaveLength(0)
  })

  it('engineKeyForAgentID maps a live native agent id back to its engine key', async () => {
    const h = createHarness()
    const a = newAdapter(h)

    const session = await a.startSession('', { sessionKey: 'feishu:oc_4:ou_9' })

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
    const s1 = await a.startSession('', { sessionKey: 'k1' })
    const s2 = await a.startSession('', { sessionKey: 'k1' })
    expect(s2).toBe(s1)
    expect(h.creates).toHaveLength(1)
  })

  it('provider switch disposes the old agent and resumes the same session id', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const s1 = await a.startSession('', { sessionKey: 'k2' })
    const oldID = s1.currentSessionID()
    expect(s1.alive()).toBe(true)

    await s1.close()
    expect(h.agents[0]!.disposed).toBe(true)
    expect(s1.alive()).toBe(false)

    const s2 = await a.startSession(oldID, { sessionKey: 'k2' })
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
    const s2 = await a.startSession('', { sessionKey: 'other' })

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
    await a.startSession('', { sessionKey: 'kA' })
    await a.startSession('', { sessionKey: 'kB' })

    await a.stop()

    expect(h.agents.every(agent => agent.disposed)).toBe(true)
  })
})

/** Drive the adapter-registered user-questions answerer as the real service's waterfall would. */
function userQuestionsAsk(h: Harness): (req: Record<string, unknown>) => Promise<unknown> {
  return (req) => {
    const listeners = h.listeners.get('user-questions/request') ?? []
    if (listeners.length === 0) throw new Error('user-questions answerer was not registered')
    // The real service's no-answerer fallback rejects with NO_PROVIDER.
    const noAnswerer = () => Promise.reject(new Error('no user-questions answerer accepted the request'))
    return (listeners[0] as unknown as (req: unknown, next: () => Promise<unknown>) => Promise<unknown>)(req, noAnswerer)
  }
}

function createUserQuestionsHarness(): { h: Harness; adapter: DshAgentAdapter; ask: (req: Record<string, unknown>) => Promise<unknown> } {
  const h = createHarness()
  const adapter = newAdapter(h)
  return { h, adapter, ask: userQuestionsAsk(h) }
}
/** Recording ask delegate: captures delegated asks and settles them by hand (B2). */
function recordingDelegate(): AskDelegate & {
  calls: Array<{ sessionKey: string; request: AskRequest }>
  settle(decision: AskDecision): void
} {
  const calls: Array<{ sessionKey: string; request: AskRequest }> = []
  let resolveCurrent: ((d: AskDecision) => void) | undefined
  const d = {
    calls,
    settle(decision: AskDecision): void {
      resolveCurrent?.(decision)
    },
    askUser(sessionKey: string, request: AskRequest): Promise<AskDecision> {
      calls.push({ sessionKey, request })
      return new Promise<AskDecision>((resolve) => { resolveCurrent = resolve })
    },
  }
  return d
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

/** Adapter with the delegate wired plus a started session and the ask function. */
async function startedProvider(): Promise<{
  session: DshAgentSession
  ask: (req: Record<string, unknown>) => Promise<unknown>
  agent: RecordedAgent
  adapter: DshAgentAdapter
  delegate: ReturnType<typeof recordingDelegate>
}> {
  const { h, adapter, ask } = createUserQuestionsHarness()
  const delegate = recordingDelegate()
  adapter.setAskDelegate(delegate)
  const session = (await adapter.startSession('')) as DshAgentSession
  return { session, ask, agent: h.agents[0]!, adapter, delegate }
}

describe('DshAgentAdapter userQuestions answerer', () => {

  it('answers a real UserQuestionService ask through the engine ask delegate', async () => {
    // 2026-08-29 regression (oc_cd00410d): the adapter still called the
    // removed registerProvider API, so registration crashed on the first
    // session and every later ask rejected with NO_PROVIDER — follow-up
    // cards never rendered. Compose the real service and registry.
    const ctx = new Context()
    policyContexts.push(ctx)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const agents: Array<RecordedAgent & { session: { id: string; events: never[] } }> = []
    let n = 0
    const registry: DshAgentsRegistryLike = {
      create: async () => {
        n += 1
        const agent = {
          id: `agent-${n}`,
          status: 'idle' as const,
          session: { id: `agent-${n}`, events: [] as never[] },
          followups: [] as unknown[],
          steers: [] as unknown[],
          cancels: [] as Array<{ cause: { kind: string }; keepInbox?: boolean | undefined }>,
          disposed: false,
          followup(message: unknown): void {
            agent.followups.push(message)
          },
          steer(message: unknown): void {
            agent.steers.push(message)
          },
          cancel(cause: { kind: string }): void {
            agent.cancels.push({ cause })
          },
          emit(): void {},
        }
        agents.push(agent)
        return { agent, dispose: async () => { agent.disposed = true } }
      },
      resume: async () => { throw new Error('resume not used') },
      get: (id: unknown) => agents.find(a => a.id === String(id) && !a.disposed),
    }
    const adapterCtx: DshContextLike = {
      agents: registry,
      on: (event, listener) => ctx.on(event as never, listener as never),
      get: name => ctx.get(name) as unknown,
    }
    const adapter = new DshAgentAdapter(adapterCtx, {
      agentName: 'dsh',
      cwd: '/workspace/project',
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
      activeProvider: 'glm',
    })
    const delegate = recordingDelegate()
    adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('')) as DshAgentSession
    ctx.agents.enter(agents[0] as unknown as Agent, undefined)

    const askPromise = ctx.userQuestions.ask({
      questions: [{ id: 'followup', question: 'Proceed?', options: [{ label: 'Yes' }] }],
      agent: agents[0] as unknown as Agent,
    })
    await new Promise((r) => { setTimeout(r, 10) })

    expect(delegate.calls[0]?.sessionKey).toBe(session.sessionKey())
    delegate.settle({ answers: [{ id: 'followup', selected: ['Yes'] }] })
    await expect(askPromise).resolves.toEqual({ answers: [{ id: 'followup', selected: ['Yes'] }] })
  })

  it('two adapters sharing question routing register one listener and route asks across adapters', async () => {
    const h = createHarness()
    const routing: QuestionRouting = { adapters: [], registered: false }
    const cfg = (base: Partial<DshAdapterConfig> = {}): DshAdapterConfig => ({
      agentName: 'dsh',
      cwd: '/workspace/project',
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
      activeProvider: 'glm',
      questionRouting: routing,
      ...base,
    })
    const da = recordingDelegate()
    const db = recordingDelegate()
    const a = new DshAgentAdapter(h.ctx, cfg())
    a.setAskDelegate(da)
    const b = new DshAgentAdapter(h.ctx, cfg())
    b.setAskDelegate(db)
    await a.startSession('')
    expect(h.listeners.get('user-questions/request')).toHaveLength(1)
    // Shared routing holds a's one listener: b's first session must not
    // register a second one (multi-project deployment).
    const sb = (await b.startSession('')) as DshAgentSession
    expect(h.listeners.get('user-questions/request')).toHaveLength(1)
    // b's session questions route through the shared listener to b's delegate.
    const askPromise = userQuestionsAsk(h)({
      questions: [planReviewQuestion()],
      agent: { session: { id: sb.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    expect(db.calls).toHaveLength(1)
    db.settle({ outcome: 'allowed-once' })
    await askPromise
  })

  it('disposing the first sharing adapter keeps the shared answerer for the others', async () => {
    const h = createHarness()
    const routing: QuestionRouting = { adapters: [], registered: false }
    const cfg = (): DshAdapterConfig => ({
      agentName: 'dsh',
      cwd: '/workspace/project',
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
      activeProvider: 'glm',
      questionRouting: routing,
    })
    const da = recordingDelegate()
    const db = recordingDelegate()
    const a = new DshAgentAdapter(h.ctx, cfg())
    a.setAskDelegate(da)
    const b = new DshAgentAdapter(h.ctx, cfg())
    b.setAskDelegate(db)
    await a.startSession('')
    const sb = (await b.startSession('')) as DshAgentSession
    a.dispose()
    expect(h.listeners.get('user-questions/request')).toHaveLength(1)

    const askPromise = userQuestionsAsk(h)({
      questions: [{ id: 'followup', question: 'Still there?', options: [{ label: 'Yes' }] }],
      agent: { session: { id: sb.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    expect(db.calls).toHaveLength(1)
    db.settle({ answers: [{ id: 'followup', selected: ['Yes'] }] })
    await askPromise
  })

  it('registers the answerer listener on first session creation', async () => {
    const { h, adapter } = createUserQuestionsHarness()
    expect(h.listeners.get('user-questions/request') ?? []).toHaveLength(0)
    await adapter.startSession('')
    expect(h.listeners.get('user-questions/request')).toHaveLength(1)
  })

  it('a cron slot key routes questions under the interactive slot while sessionKey stays bare', async () => {
    const { adapter, ask } = createUserQuestionsHarness()
    const delegate = recordingDelegate()
    adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('', {
      sessionKey: 'riskai:oc_1:ou_1',
      interactiveSlotKey: 'riskai:oc_1:ou_1#cron:s20',
    })) as DshAgentSession

    expect(session.sessionKey()).toBe('riskai:oc_1:ou_1')
    expect(session.askSlotKey()).toBe('riskai:oc_1:ou_1#cron:s20')

    const askPromise = ask({
      questions: [{ id: 'followup', question: 'Process findings?', options: [{ label: 'Yes' }] }],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })

    // The card must render and route under the slot key: the bare key has
    // no interactive state during a cron new-per-run turn, and an ask
    // routed there silently answers empty (2026-08-26 cron-fbe6d268).
    expect(delegate.calls[0]?.sessionKey).toBe('riskai:oc_1:ou_1#cron:s20')
    delegate.settle({ answers: [{ id: 'followup', selected: ['Yes'] }] })
    await askPromise
  })

  it('plan-review delegates the heading and plan for the plan card', async () => {
    const { session, ask, delegate } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })

    expect(delegate.calls[0]?.sessionKey).toBe(session.sessionKey())
    expect(delegate.calls[0]?.request).toEqual({
      kind: 'plan-review',
      heading: '# Fix spinner',
      plan: '# Fix spinner\n\n1. resolve asset path\n2. upload gif',
    })
    delegate.settle({ outcome: 'allowed-once' })
    await askPromise
  })

  it('a single-line plan falls back to the question as the card heading', async () => {
    const { session, ask, delegate } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion({ detail: '# One line plan' })],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    expect((delegate.calls[0]?.request as { heading?: string }).heading)
      .toBe('Approve this plan and leave plan mode?')

    delegate.settle({ outcome: 'allowed-once' })
    await askPromise
  })

  it('approving the plan review answers with the intent approve label', async () => {
    const { session, ask, delegate } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once' })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
  })

  it('denying the plan review declines with the note as custom feedback', async () => {
    const { session, ask, delegate, agent } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'rejected', note: 'add tests first' })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: [], custom: 'add tests first' }],
    })
    expect(agent.steers).toHaveLength(0)
  })

  it('a cancelled plan review declines without feedback and steers nothing', async () => {
    const { session, ask, delegate, agent } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'cancelled' })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: [], custom: '' }],
    })
    expect(agent.steers).toHaveLength(0)
  })

  it('approving with a supplement steers it as a user message next to the approval', async () => {
    const { session, ask, delegate, agent } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once', note: 'also update the README' })

    // The answer stays selected-only: plan-mode treats any custom as
    // keep-planning feedback, so the supplement cannot ride in the answer.
    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    })
    expect(agent.steers).toHaveLength(1)
    const steered = agent.steers[0] as { content: Array<{ type: string; text: string }> }
    expect(steered.content).toEqual([{ type: 'text', text: 'also update the README' }])
  })

  it('approving without a supplement steers nothing', async () => {
    const { session, ask, delegate, agent } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once' })

    await askPromise
    expect(agent.steers).toHaveLength(0)
  })

  it('approving with a whitespace-only supplement steers nothing', async () => {
    const { session, ask, delegate, agent } = await startedProvider()

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once', note: '   ' })

    await askPromise
    expect(agent.steers).toHaveLength(0)
  })

  it('ordinary questions delegate one ask and return the decision answers verbatim', async () => {
    const { session, ask, delegate } = await startedProvider()

    const askPromise = ask({
      questions: [{ question: 'Which flavor?', options: [{ label: 'A' }, { label: 'B' }] }],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    const request = delegate.calls[0]?.request
    expect(request?.kind).toBe('questions')
    expect((request as { questions?: Array<{ question: string }> }).questions?.[0]?.question).toBe('Which flavor?')

    delegate.settle({ answers: [{ id: 'Which flavor?', selected: ['A'] }] })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'Which flavor?', selected: ['A'] }],
    })
  })

  it('the decision answers keep the selected/custom split', async () => {
    const { session, ask, delegate } = await startedProvider()

    const askPromise = ask({
      questions: [{ id: 'next-step', question: 'Which flavor?', options: [{ label: 'A' }] }],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ answers: [{ id: 'next-step', selected: [], custom: 'both, actually' }] })

    await expect(askPromise).resolves.toEqual({
      answers: [{ id: 'next-step', selected: [], custom: 'both, actually' }],
    })
  })

  it('without a delegate the ask fails safe with empty answers', async () => {
    const { adapter, ask } = createUserQuestionsHarness()
    // No setAskDelegate call.
    const session = await adapter.startSession('')
    const askPromise = ask({
      questions: [{ question: 'Which flavor?' }],
      agent: { session: { id: session.currentSessionID() } },
    })
    await expect(askPromise).resolves.toEqual({ answers: [] })
  })
})

describe('DshAgentAdapter plan-approval permission preset', () => {
  /**
   * Provider over the plan-review ask path with a configured preset and a
   * preset service under test: a recording fake by default, an explicit
   * replacement via {@link PresetProviderOpts.presets}, or none at all via
   * {@link PresetProviderOpts.noPresets} (a composition without the
   * permission-presets plugin resolves ctx.get to undefined).
   */
  interface PresetProviderOpts {
    preset?: string
    presets?: unknown
    noPresets?: boolean
  }

  async function presetProvider(opts: PresetProviderOpts = {}): Promise<{
    session: DshAgentSession
    ask: (req: Record<string, unknown>) => Promise<unknown>
    delegate: ReturnType<typeof recordingDelegate>
    agent: RecordedAgent
    presetCalls: Array<{ session: unknown; name: string }>
  }> {
    const h = createHarness()
    const presetCalls: Array<{ session: unknown; name: string }> = []
    if (opts.noPresets !== true) {
      h.services.permissionPresets = opts.presets ?? {
        set(session: unknown, name: string): void { presetCalls.push({ session, name }) },
      }
    }
    const adapter = new DshAgentAdapter(h.ctx, {
      agentName: 'dsh',
      cwd: '/workspace/project',
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
      activeProvider: 'glm',
      ...opts.preset !== undefined ? { planApprovalPreset: opts.preset } : {},
    })
    const delegate = recordingDelegate()
    adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('')) as DshAgentSession
    return { session, ask: userQuestionsAsk(h), delegate, agent: h.agents[0]!, presetCalls }
  }

  it('approving the plan review switches the configured permission preset onto the native session', async () => {
    const { session, ask, delegate, agent, presetCalls } = await presetProvider({ preset: 'danger-full-access' })

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once' })
    await askPromise

    expect(presetCalls).toEqual([{ session: agent.session, name: 'danger-full-access' }])
  })

  it('denying the plan review leaves permissions untouched', async () => {
    const { session, ask, delegate, presetCalls } = await presetProvider({ preset: 'danger-full-access' })

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'rejected', note: 'add tests first' })
    await askPromise

    expect(presetCalls).toEqual([])
  })

  it('approving with allow-always applies the same preset switch', async () => {
    const { session, ask, delegate, agent, presetCalls } = await presetProvider({ preset: 'danger-full-access' })

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-always' })
    await askPromise

    expect(presetCalls).toEqual([{ session: agent.session, name: 'danger-full-access' }])
  })

  it('approving without a configured preset leaves permissions untouched', async () => {
    const { session, ask, delegate, presetCalls } = await presetProvider({})

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once' })
    await askPromise

    expect(presetCalls).toEqual([])
  })

  it('approving with an empty configured preset leaves permissions untouched', async () => {
    const { session, ask, delegate, presetCalls } = await presetProvider({ preset: '' })

    const askPromise = ask({
      questions: [planReviewQuestion()],
      agent: { session: { id: session.currentSessionID() } },
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-once' })
    await askPromise

    expect(presetCalls).toEqual([])
  })

  it('a missing permissionPresets service degrades safe: approval completes with an error log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // presetProvider injects a service unless one is given; a null service
      // models a composition without the permission-presets plugin.
      const { session, ask, delegate } = await presetProvider({ preset: 'danger-full-access', noPresets: true })

      const askPromise = ask({
        questions: [planReviewQuestion()],
        agent: { session: { id: session.currentSessionID() } },
      })
      await new Promise((r) => { setTimeout(r, 10) })
      delegate.settle({ outcome: 'allowed-once' })

      await expect(askPromise).resolves.toEqual({
        answers: [{ id: 'plan-review', selected: ['Approve'] }],
      })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('permissionPresets is not composed')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a throwing preset switch degrades safe: approval completes with an error log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const throwing = { set(): void { throw new Error('permission: unknown preset "typo"') } }
      const { session, ask, delegate } = await presetProvider({ preset: 'typo', presets: throwing })

      const askPromise = ask({
        questions: [planReviewQuestion()],
        agent: { session: { id: session.currentSessionID() } },
      })
      await new Promise((r) => { setTimeout(r, 10) })
      delegate.settle({ outcome: 'allowed-once' })

      await expect(askPromise).resolves.toEqual({
        answers: [{ id: 'plan-review', selected: ['Approve'] }],
      })
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('unknown preset')
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('DshAgentAdapter approval answerer', () => {
  /** Started session plus the registered approval/request listener. */
  async function startedAnswerer(delegate?: AskDelegate): Promise<{
    h: Harness
    listener: (req: Record<string, unknown>) => Promise<unknown>
    session: DshAgentSession
  }> {
    const h = createHarness()
    const adapter = newAdapter(h)
    if (delegate !== undefined) adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('')) as DshAgentSession
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    return { h, listener: listener as unknown as (req: Record<string, unknown>) => Promise<unknown>, session }
  }

  it('delegates a permission ask and resolves the decision to the outcome', async () => {
    const delegate = recordingDelegate()
    const { listener, session } = await startedAnswerer(delegate)

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-1',
      reason: 'rm -rf /tmp/x',
    })
    await new Promise((r) => { setTimeout(r, 10) })
    expect(delegate.calls[0]?.request).toEqual({ kind: 'permission', toolName: 'Bash', preview: 'rm -rf /tmp/x' })
    delegate.settle({ outcome: 'allowed-once' })

    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('ApprovalRequest.toolInput wins over reason as the card preview', async () => {
    const delegate = recordingDelegate()
    const { listener, session } = await startedAnswerer(delegate)

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'write',
      callId: 'call-2',
      reason: 'write file',
      toolInput: '{"file_path":"/tmp/a.txt","content":"x"}',
    })
    await new Promise((r) => { setTimeout(r, 10) })
    expect((delegate.calls[0]?.request as { preview?: string }).preview)
      .toBe('{"file_path":"/tmp/a.txt","content":"x"}')
    delegate.settle({ outcome: 'allowed-once' })
    await outcome
  })

  it('a rejected decision returns ApprovalAnswer with the note', async () => {
    const delegate = recordingDelegate()
    const { listener, session } = await startedAnswerer(delegate)

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-3',
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'rejected', note: 'use git clean instead' })

    await expect(outcome).resolves.toEqual({ outcome: 'rejected', note: 'use git clean instead' })
  })

  it('allowed-always returns the standing-grant outcome', async () => {
    const delegate = recordingDelegate()
    const { listener, session } = await startedAnswerer(delegate)

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-4',
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'allowed-always' })

    await expect(outcome).resolves.toBe('allowed-always')
  })

  it('a cancelled decision returns cancelled', async () => {
    const delegate = recordingDelegate()
    const { listener, session } = await startedAnswerer(delegate)

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-5',
    })
    await new Promise((r) => { setTimeout(r, 10) })
    delegate.settle({ outcome: 'cancelled' })

    await expect(outcome).resolves.toBe('cancelled')
  })

  it('an unattended chatroom-role session approves without delegating', async () => {
    const delegate = recordingDelegate()
    const h = createHarness()
    const adapter = newAdapter(h)
    adapter.setBridgeEvents(personaPolicyFace())
    adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('', {
      sessionKey: 'feishu:oc_b:ou_1',
      persona: { prompt: 'bare persona prompt', bypassPermissions: true, forceMode: undefined },
    })) as DshAgentSession
    const listener = h.listeners.get('approval/request')?.[0] as unknown as (req: Record<string, unknown>) => Promise<unknown>

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-6',
    })
    await new Promise((r) => { setTimeout(r, 10) })

    // Settles with no delegation: the answerer short-circuited.
    await expect(outcome).resolves.toBe('allowed-once')
    expect(delegate.calls).toHaveLength(0)
  })

  it('an unknown session fails closed as unavailable', async () => {
    const delegate = recordingDelegate()
    const { listener } = await startedAnswerer(delegate)

    await expect(listener({
      agent: { session: { id: 'no-such-session' } },
      toolName: 'Bash',
    })).resolves.toBe('unavailable')
  })

  it('a session owned by a later adapter is delegated down the waterfall, not vetoed', async () => {
    // Multi-project deployment: two adapters share one plugin ctx, so their
    // approval listeners stack in registration order. A request for the
    // second adapter's session must reach the second listener instead of the
    // first one failing the whole chain closed (2026-08-22 userQuestions
    // collision class).
    const h = createHarness()
    const adapterA = newAdapter(h)
    const delegateA = recordingDelegate()
    adapterA.setAskDelegate(delegateA)
    const adapterB = newAdapter(h)
    const delegateB = recordingDelegate()
    adapterB.setAskDelegate(delegateB)
    const sessionB = (await adapterB.startSession('')) as DshAgentSession
    const [listenerA, listenerB] = h.listeners.get('approval/request') ?? []
    if (listenerA === undefined || listenerB === undefined) throw new Error('approval/request listeners were not registered')

    // The production waterfall shape: adapterA's next chains to adapterB
    // (cordis binds the original event args into next, so the manual chain
    // closes over the same request), whose next ends at the base listener
    // ('unavailable', fail-closed).
    type WaterfallListener = (req: Record<string, unknown>, next: () => Promise<string>) => Promise<string>
    const request = {
      agent: { session: { id: sessionB.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-chain',
    }
    const base = async (): Promise<string> => 'unavailable'
    const callB = (): Promise<string> =>
      (listenerB as unknown as WaterfallListener)(request, base)
    const outcome = (listenerA as unknown as WaterfallListener)(request, callB)
    await new Promise((r) => { setTimeout(r, 10) })

    expect(delegateA.calls, 'adapterA must not answer another project\'s session').toHaveLength(0)
    expect(delegateB.calls[0]?.request).toEqual({ kind: 'permission', toolName: 'Bash', preview: '' })
    delegateB.settle({ outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('without a delegate the answerer fails closed as unavailable', async () => {
    const { listener, session } = await startedAnswerer()

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
    })
    await expect(outcome).resolves.toBe('unavailable')
  })

  it('a cron slot session delegates its permission ask under the slot key', async () => {
    const delegate = recordingDelegate()
    const h = createHarness()
    const adapter = newAdapter(h)
    adapter.setAskDelegate(delegate)
    const session = (await adapter.startSession('', {
      sessionKey: 'riskai:oc_1:ou_1',
      interactiveSlotKey: 'riskai:oc_1:ou_1#cron:s20',
    })) as DshAgentSession
    const listener = h.listeners.get('approval/request')?.[0] as unknown as (req: Record<string, unknown>) => Promise<unknown>

    const outcome = listener({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-slot',
    })
    await new Promise((r) => { setTimeout(r, 10) })

    expect(delegate.calls[0]?.sessionKey).toBe('riskai:oc_1:ou_1#cron:s20')
    expect(delegate.calls[0]?.request.kind).toBe('permission')
    delegate.settle({ outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
  })
})

it('tool/result with tool-result blocks projects the inner text as toolResult', async () => {
  // Live dsh sessions wrap tool output in {type:'tool-result', content:[text]}
  // blocks — not bare text blocks (observed on the real machine: the tool
  // progress card rendered blank result sections).
  const h = createHarness()
  const a = newAdapter(h)
  const sess = await a.startSession('', { sessionKey: 'feishu:oc_tr:ou_9' })
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
  const sess = await a.startSession('', { sessionKey: 'feishu:oc_tr:ou_9' })
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
  const sess = await a.startSession('', { sessionKey: 'feishu:oc_tr:ou_9' })
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
    await a.startSession('', { sessionKey: key })
  }
  expect(planSets).toEqual([true, true])

  // An explicit one-shot override wins once, then the default resumes.
  a.setSessionMode('default')
  await a.startSession('', { sessionKey: 'feishu:oc_m3:ou_9' })
  await a.startSession('', { sessionKey: 'feishu:oc_m4:ou_9' })
  expect(planSets).toEqual([true, true, false, true])
})

it('a chatroom moderator never enters plan mode (an inherited plan default is downgraded)', async () => {
  const h = createHarness()
  const planSets: boolean[] = []
  h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
  const a = newAdapter(h)
  a.setBridgeEvents(personaPolicyFace())
  a.setDefaultMode('plan')
  await a.startSession('', {
    sessionKey: 'feishu:hub:ou_9',
    persona: { prompt: 'moderator persona prompt', bypassPermissions: false, forceMode: 'default' },
  })
  expect(planSets).toEqual([false])
})

it('a chatroom moderator downgrades an explicit plan override too (one rule: moderators never plan)', async () => {
  const h = createHarness()
  const planSets: boolean[] = []
  h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
  const a = newAdapter(h)
  a.setBridgeEvents(personaPolicyFace())
  a.setSessionMode('plan')
  await a.startSession('', {
    sessionKey: 'feishu:hub:ou_9',
    persona: { prompt: 'moderator persona prompt', bypassPermissions: false, forceMode: 'default' },
  })
  expect(planSets).toEqual([false])
})

it('spawnMode pins the mode between one-shot overrides and the project default', async () => {
  const h = createHarness()
  const planSets: boolean[] = []
  h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
  const a = newAdapter(h)

  // A pinned non-plan mode overrides the plan project default and persists
  // across sessions (unlike the one-shot override, it is not consumed).
  await a.startSession('', { sessionKey: 'feishu:oc_m1:ou_9', spawnMode: 'default' })
  await a.startSession('', { sessionKey: 'feishu:oc_m2:ou_9', spawnMode: 'default' })
  expect(planSets).toEqual([false, false])

  // A pinned plan overrides a non-plan project default.
  const b = newAdapter(h)
  b.setDefaultMode('default')
  await b.startSession('', { sessionKey: 'feishu:oc_m3:ou_9', spawnMode: 'plan' })
  expect(planSets).toEqual([false, false, true])

  // A one-shot override outranks the pin once; the pin resumes after it.
  b.setSessionMode('default')
  await b.startSession('', { sessionKey: 'feishu:oc_m4:ou_9', spawnMode: 'plan' })
  await b.startSession('', { sessionKey: 'feishu:oc_m5:ou_9', spawnMode: 'plan' })
  expect(planSets).toEqual([false, false, true, false, true])

  // The unattended-subtask bypass outranks any pin.
  await a.startSession('', {
    sessionKey: 'feishu:oc_m6:ou_9',
    spawnMode: 'plan',
    subtask: { attended: false, noReport: false, researchAssistant: false },
  })
  expect(planSets).toEqual([false, false, true, false, true, false])
})

describe('unattendedSubtaskBypassesPermissions (the permission-policy built-in base)', () => {
  it('elevates unattended subtasks only; chatroom personas join via the policy listener', () => {
    expect(unattendedSubtaskBypassesPermissions({ sessionKey: 'k', subtask: { attended: false, noReport: false, researchAssistant: false } })).toBe(true)
    expect(unattendedSubtaskBypassesPermissions({ sessionKey: 'k', subtask: { attended: true, noReport: false, researchAssistant: false } })).toBe(false)
    expect(unattendedSubtaskBypassesPermissions({ sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: true, forceMode: undefined } })).toBe(false)
    expect(unattendedSubtaskBypassesPermissions({ sessionKey: 'feishu:oc_1:ou_9' })).toBe(false)
    expect(unattendedSubtaskBypassesPermissions(undefined)).toBe(false)
  })
})

describe('effectiveMode bypass wiring', () => {
  it('an unattended subtask session auto-approves tool permissions without a card', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    const session = await a.startSession('', {
      sessionKey: 'feishu:child:ou_9',
      subtask: { attended: false, noReport: false, researchAssistant: false },
    })
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
    a.setBridgeEvents(personaPolicyFace())
    const session = await a.startSession('', {
      sessionKey: 'feishu:role:ou_9',
      persona: { prompt: 'bare persona prompt', bypassPermissions: true, forceMode: undefined },
    })
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
    const delegate = recordingDelegate()
    const h = createHarness()
    const a = newAdapter(h)
    a.setAskDelegate(delegate)
    const session = await a.startSession('', {
      sessionKey: 'feishu:child:ou_9',
      subtask: { attended: true, noReport: false, researchAssistant: false },
    })
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-3',
    })
    // Still waiting for the engine decision until the delegate settles.
    const probe = await Promise.race([outcome.then(() => 'settled'), new Promise((r) => { setTimeout(() => { r('pending') }, 30) })])
    expect(probe).toBe('pending')
    delegate.settle({ outcome: 'allowed-once' })
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('bypass overrides the plan default so subtask children never enter plan mode', async () => {
    const h = createHarness()
    const planSets: boolean[] = []
    h.services['planMode'] = { set: (_agent: unknown, active: boolean) => { planSets.push(active); return '' } }
    const a = newAdapter(h)
    a.setDefaultMode('plan')
    await a.startSession('', {
      sessionKey: 'feishu:child:ou_9',
      subtask: { attended: false, noReport: false, researchAssistant: false },
    })
    expect(planSets).toEqual([false])
  })

  it('a bypassPermissions mode override auto-approves tool permissions without a card (cron job.mode)', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    // The cron path: startAgentLocked arms a one-shot mode override before
    // the session starts. 'bypassPermissions' must mean the same
    // auto-approval the unattended base grants, not just "plan off".
    a.setSessionMode('bypassPermissions')
    const session = await a.startSession('', { sessionKey: 'feishu:cron:ou_9' })
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-4',
    })
    // No ask delegate is wired: without the bypass the answerer would fail
    // closed as 'unavailable' instead of granting.
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('a bypassPermissions project default auto-approves tool permissions too', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setDefaultMode('bypassPermissions')
    const session = await a.startSession('', { sessionKey: 'feishu:default:ou_9' })
    const listener = h.listeners.get('approval/request')?.[0]
    if (listener === undefined) throw new Error('approval/request listener was not registered')
    const outcome = (listener as unknown as (req: Record<string, unknown>) => Promise<string>)({
      agent: { session: { id: session.currentSessionID() } },
      toolName: 'Bash',
      callId: 'call-5',
    })
    await expect(outcome).resolves.toBe('allowed-once')
  })
})
