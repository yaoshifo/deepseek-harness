import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CcConnectBridgeServer } from '../src/server.js'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

/** Minimal shape of the dsh Agent the server touches. */
interface FakeAgent {
  id: { toString(): string }
  session: { id: { toString(): string } }
  followup: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  status: string
}

function fakeAgent(id: string): FakeAgent {
  const sessionId = { toString: () => id }
  return { id: sessionId, session: { id: sessionId }, followup: vi.fn(), cancel: vi.fn(), status: 'idle' }
}

/** Minimal event handler shape the sink stores and dispatches. */
type SinkHandler = (...args: never[]) => unknown

/** Cordis event harness: store handlers, dispatch manually. */
class EventSink {
  private readonly handlers = new Map<string, SinkHandler[]>()

  on(event: string, handler: SinkHandler): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  async dispatch(event: string, ...args: unknown[]): Promise<unknown> {
    const list = this.handlers.get(event) ?? []
    const next = async (): Promise<unknown> => 'unavailable'
    let result: unknown
    for (const handler of [...list].reverse()) {
      result = await (handler as (...a: unknown[]) => Promise<unknown>)(...args, next)
    }
    return result
  }
}

interface FakeTransport {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
}

function makeServer(transport: FakeTransport = { request: vi.fn(async () => ({})), notify: vi.fn() }): {
  server: CcConnectBridgeServer
  ctx: Context
  events: EventSink
  transport: FakeTransport
  agents: Map<string, FakeAgent>
  registry: { create: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
  planMode: { set: ReturnType<typeof vi.fn> }
  approval: { setPolicy: ReturnType<typeof vi.fn> }
  userQuestions: { registerProvider: ReturnType<typeof vi.fn> }
  disposeHandles: ReturnType<typeof vi.fn>[]
} {
  const events = new EventSink()
  const agents = new Map<string, FakeAgent>()
  const disposeHandles: ReturnType<typeof vi.fn>[] = []
  const registry = {
    create: vi.fn(async ({ sessionId }: { sessionId: { toString(): string } }) => {
      const agent = fakeAgent(String(sessionId))
      agents.set(String(sessionId), agent)
      const dispose = vi.fn(async () => {})
      disposeHandles.push(dispose)
      return { agent, dispose }
    }),
    resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: { toString(): string } }) => {
      const agent = fakeAgent(String(resumeSessionId))
      agents.set(String(resumeSessionId), agent)
      const dispose = vi.fn(async () => {})
      disposeHandles.push(dispose)
      return { agent, dispose }
    }),
    get: vi.fn((id: { toString(): string }) => agents.get(String(id))),
  }
  const planMode = { set: vi.fn() }
  const approval = { setPolicy: vi.fn() }
  const userQuestions = { registerProvider: vi.fn(() => () => {}) }
  const ctx = {
    on: vi.fn((event: string, handler: SinkHandler) => events.on(event, handler)),
    get: vi.fn((name: string) => {
      if (name === 'planMode') return planMode
      if (name === 'approval') return approval
      if (name === 'userQuestions') return userQuestions
      return undefined
    }),
    agents: registry,
  } as unknown as Context
  const server = new CcConnectBridgeServer(ctx, transport as never)
  return { server, ctx, events, transport, agents, registry, planMode, approval, userQuestions, disposeHandles }
}

async function booted(transport?: FakeTransport) {
  const fixture = makeServer(transport)
  await fixture.server.initialize({ cwd: '/base', provider: 'prov', model: 'mdl' })
  return fixture
}

describe('initialize', () => {
  it('returns server identity', async () => {
    const { server } = await booted()
    const result = await server.initialize({ cwd: '/tmp/x', provider: 'p', model: 'm' })
    expect(result.serverInfo.name).toBe('dsh-cc-connect-bridge')
  })

  it('rejects a non-positive maxTokens', async () => {
    const { server } = await booted()
    await expect(server.initialize({ cwd: '/x', provider: 'p', model: 'm', maxTokens: 0 }))
      .rejects.toThrow(TypeError)
  })

  it('keeps the built-in default route when initialize supplies empty provider/model', async () => {
    const { server, registry } = makeServer()
    await server.initialize({ cwd: '/base', provider: '', model: '' })
    await server.createSession({ sessionId: 's1' })
    const args = registry.create.mock.calls[0]![0]
    expect(args.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })
})

describe('session/create', () => {
  it('creates a fresh session with resolved meta and agent options', async () => {
    const { server, registry } = await booted()
    await server.initialize({ cwd: '/base', provider: 'prov', model: 'mdl', maxTokens: 4096 })
    const result = await server.createSession({ sessionId: 's1', cwd: '/work' })
    expect(result.sessionId).toBe('s1')
    const args = registry.create.mock.calls[0]![0]
    expect(String(args.sessionId)).toBe('s1')
    expect(args.meta.cwd).toBe('/work')
    expect(args.agentOptions).toEqual({ provider: 'prov', model: 'mdl', maxTokens: 4096 })
  })

  it('resumes a persisted session when resumeSessionId is set', async () => {
    const { server, registry } = await booted()
    await server.createSession({ sessionId: 'live', resumeSessionId: 'persisted-1' })
    const args = registry.resume.mock.calls[0]![0]
    expect(String(args.resumeSessionId)).toBe('persisted-1')
  })

  it('is idempotent per sessionId', async () => {
    const { server, registry } = await booted()
    await server.createSession({ sessionId: 's1' })
    await server.createSession({ sessionId: 's1' })
    expect(registry.create).toHaveBeenCalledTimes(1)
  })

  it('applies planMode and approvalPolicy overrides after creation', async () => {
    const { server, agents, planMode, approval } = await booted()
    await server.createSession({ sessionId: 's1', planMode: true, approvalPolicy: 'never' })
    const agent = agents.get('s1')!
    expect(planMode.set).toHaveBeenCalledWith(agent, true)
    expect(approval.setPolicy).toHaveBeenCalledWith(agent, 'never')
  })

  it('requires a non-empty sessionId', async () => {
    const { server } = await booted()
    await expect(server.createSession({ sessionId: '' })).rejects.toThrow(TypeError)
  })
})

describe('session/prompt and cancel', () => {
  it('forwards content blocks via followup', async () => {
    const { server, agents } = await booted()
    await server.createSession({ sessionId: 's1' })
    const result = await server.prompt({ sessionId: 's1', contentBlocks: [{ type: 'text', text: 'hi' }] as never })
    expect(result.messageId).toBeTruthy()
    const agent = agents.get('s1')!
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]![0] as {
      content: { type: string; text: string }[]
      source: { kind: string }
    }
    expect(message.content[0]).toEqual({ type: 'text', text: 'hi' })
    expect(message.source.kind).toBe('user')
  })

  it('prompts reject on an unknown session', async () => {
    const { server } = await booted()
    await expect(server.prompt({ sessionId: 'ghost', contentBlocks: [] as never }))
      .rejects.toThrow('unknown bridge session')
  })

  it('cancel passes user cause and keepInbox', async () => {
    const { server, agents } = await booted()
    await server.createSession({ sessionId: 's1' })
    await server.cancel({ sessionId: 's1', keepInbox: true })
    expect(agents.get('s1')!.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  })
})

describe('session/configure', () => {
  it('switches plan mode and approval policy', async () => {
    const { server, agents, planMode, approval } = await booted()
    await server.createSession({ sessionId: 's1' })
    await server.configure({ sessionId: 's1', planMode: false, approvalPolicy: 'ask' })
    const agent = agents.get('s1')!
    expect(planMode.set).toHaveBeenLastCalledWith(agent, false)
    expect(approval.setPolicy).toHaveBeenLastCalledWith(agent, 'ask')
  })

  it('rejects an unknown session', async () => {
    const { server } = await booted()
    await expect(server.configure({ sessionId: 'ghost', planMode: true })).rejects.toThrow('unknown bridge session')
  })
})

describe('approval bridge', () => {
  it('forwards approval requests as approval/ask and returns the outcome', async () => {
    const transport = { request: vi.fn(async () => ({ outcome: 'allowed-once' })), notify: vi.fn() }
    const { server, events, agents, transport: t } = await booted(transport)
    await server.createSession({ sessionId: 's1' })
    const agent = agents.get('s1')!
    const outcome = await events.dispatch('approval/request', {
      agent,
      toolName: 'bash',
      callId: { toString: () => 'call-7' },
      reason: 'write outside workspace',
    }) as ApprovalOutcome
    expect(outcome).toBe('allowed-once')
    const [method, params] = t.request.mock.calls[0] as [string, Record<string, unknown>]
    expect(method).toBe('approval/ask')
    expect(params.sessionId).toBe('s1')
    expect(params.toolName).toBe('bash')
    expect(params.callId).toBe('call-7')
    expect(params.reason).toBe('write outside workspace')
    expect(typeof params.id).toBe('string')
  })

  it('omits callId/reason when absent', async () => {
    const transport = { request: vi.fn(async () => ({ outcome: 'rejected' })), notify: vi.fn() }
    const { server, events, agents, transport: t } = await booted(transport)
    await server.createSession({ sessionId: 's1' })
    await events.dispatch('approval/request', { agent: agents.get('s1')!, toolName: 'bash' })
    const params = t.request.mock.calls[0]![1] as Record<string, unknown>
    expect('callId' in params).toBe(false)
    expect('reason' in params).toBe(false)
  })

  it('fails closed when the client cannot answer', async () => {
    const transport = { request: vi.fn(async () => { throw new Error('closed') }), notify: vi.fn() }
    const { server, events, agents } = await booted(transport)
    await server.createSession({ sessionId: 's1' })
    const outcome = await events.dispatch('approval/request', { agent: agents.get('s1')!, toolName: 'bash' }) as ApprovalOutcome
    expect(outcome).toBe('unavailable')
  })
})

describe('user-questions bridge', () => {
  it('registers a provider that forwards questions and returns answers', async () => {
    const transport = {
      request: vi.fn(async () => ({ answers: [{ id: 'q1', selected: ['Approve'] }] })),
      notify: vi.fn(),
    }
    const { server, userQuestions, agents, transport: t } = await booted(transport)
    await server.createSession({ sessionId: 's1' })
    const provider = userQuestions.registerProvider.mock.calls[0]![0] as {
      ask: (request: unknown) => Promise<{ answers: { id: string; selected: string[] }[] }>
    }
    const answer = await provider.ask({
      questions: [{ id: 'q1', question: 'ok?', detail: 'plan body', intent: { kind: 'plan-review', approve: 'Approve' } }],
      agent: agents.get('s1')!,
    })
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['Approve'] }])
    const [method, params] = t.request.mock.calls[0] as [string, { sessionId: string; questions: { id: string }[] }]
    expect(method).toBe('question/ask')
    expect(params.sessionId).toBe('s1')
    expect(params.questions[0]!.id).toBe('q1')
  })

  it('uses empty sessionId for agentless asks', async () => {
    const transport = { request: vi.fn(async () => ({ answers: [] })), notify: vi.fn() }
    const { server, userQuestions, transport: t } = await booted(transport)
    void server
    const provider = userQuestions.registerProvider.mock.calls[0]![0] as {
      ask: (request: unknown) => Promise<{ answers: unknown[] }>
    }
    await provider.ask({ questions: [{ id: 'q1', question: 'q' }] })
    const params = t.request.mock.calls[0]![1] as { sessionId: string }
    expect(params.sessionId).toBe('')
  })
})

describe('prompt recovery after out-of-band agent disposal', () => {
  // A Cordis HMR loop-only reload (profile cordis.patch.yml edit) disposes the
  // loop's agents while the bridge's session record survives. prompt must
  // transparently resume the persisted session on the live registry instead
  // of erroring.
  it('resumes the disposed session and delivers the prompt to the recovered agent', async () => {
    const { server, registry, agents } = await booted()
    await server.createSession({ sessionId: 's1' })
    agents.delete('s1')
    const result = await server.prompt({ sessionId: 's1', contentBlocks: [{ type: 'text', text: 'hi' }] as never })
    expect(result.messageId).toBeTruthy()
    expect(registry.resume).toHaveBeenCalledTimes(1)
    expect(String(registry.resume.mock.calls[0]![0].resumeSessionId)).toBe('s1')
    const recovered = agents.get('s1')!
    expect(recovered.followup).toHaveBeenCalledTimes(1)
  })

  it('replays the last-known overrides onto the recovered agent', async () => {
    const { server, agents, planMode } = await booted()
    await server.createSession({ sessionId: 's1', planMode: true })
    planMode.set.mockClear()
    agents.delete('s1')
    await server.prompt({ sessionId: 's1', contentBlocks: [] as never })
    const recovered = agents.get('s1')!
    expect(planMode.set).toHaveBeenCalledWith(recovered, true)
  })

  it('shares one in-flight recovery across concurrent prompts', async () => {
    const { server, registry, agents } = await booted()
    await server.createSession({ sessionId: 's1' })
    agents.delete('s1')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = registry.resume.getMockImplementation()! as (args: unknown) => Promise<unknown>
    registry.resume.mockImplementationOnce(async (args: unknown) => {
      await gate
      return original(args)
    })
    const first = server.prompt({ sessionId: 's1', contentBlocks: [] as never })
    const second = server.prompt({ sessionId: 's1', contentBlocks: [] as never })
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.messageId).toBeTruthy()
    expect(b.messageId).toBeTruthy()
    expect(registry.resume).toHaveBeenCalledTimes(1)
    const recovered = agents.get('s1')!
    expect(recovered.followup).toHaveBeenCalledTimes(2)
  })

  it('propagates a failed recovery to the caller', async () => {
    const { server, registry, agents } = await booted()
    await server.createSession({ sessionId: 's1' })
    agents.delete('s1')
    registry.resume.mockRejectedValueOnce(new Error('transcript unreadable'))
    await expect(server.prompt({ sessionId: 's1', contentBlocks: [] as never })).rejects.toThrow('s1')
  })

  it('configure recovers the agent before applying overrides', async () => {
    const { server, registry, agents, planMode } = await booted()
    await server.createSession({ sessionId: 's1', planMode: true })
    agents.delete('s1')
    await server.configure({ sessionId: 's1', planMode: false })
    expect(registry.resume).toHaveBeenCalledTimes(1)
    const recovered = agents.get('s1')!
    expect(planMode.set).toHaveBeenLastCalledWith(recovered, false)
  })
})

describe('event forwarding', () => {
  it('notifies session.event and session.status', async () => {
    const { server: s, events, transport } = await booted()
    void s
    await events.dispatch('session/event', { id: { toString: () => 's1' } }, { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } })
    expect(transport.notify).toHaveBeenCalledWith('session.event', {
      sessionId: 's1',
      event: { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
    })
    await events.dispatch('agent/status', { agent: { session: { id: { toString: () => 's1' } } }, status: 'running' })
    expect(transport.notify).toHaveBeenCalledWith('session.status', { sessionId: 's1', status: 'running' })
  })
})

describe('shutdown', () => {
  it('disposes sessions and refuses further creation', async () => {
    const { server, disposeHandles } = await booted()
    await server.createSession({ sessionId: 's1' })
    await server.shutdown()
    expect(disposeHandles[0]).toHaveBeenCalled()
    await expect(server.createSession({ sessionId: 's2' })).rejects.toThrow('shutting down')
  })
})

describe('handleRequest dispatch', () => {
  it('routes methods and rejects unknown ones', async () => {
    const { server } = await booted()
    await expect(server.handleRequest('initialize', { cwd: '/b', provider: 'p', model: 'm' })).resolves.toBeTruthy()
    await expect(server.handleRequest('nope', {})).rejects.toThrow('unknown cc-connect bridge method')
  })
})
