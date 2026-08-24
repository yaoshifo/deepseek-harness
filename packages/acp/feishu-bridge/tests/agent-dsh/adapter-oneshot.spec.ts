/**
 * One-shot side queries (Go agent/dsh/query.go LightweightQuery /
 * ForkQuery / ForkSessionWithProvider over oneShotQuery): a standalone
 * turn on a fresh native session — created with the named provider route
 * (lightweight adds reasoningEffort 'low'), seeded from a live parent's
 * completed turns when forking, driven for exactly one turn, then disposed.
 * The temp session never owns an engine key, so tool routing treats its
 * agent as a foreign caller.
 */

import { describe, expect, it } from 'vitest'
import { asForkQuerierWithProvider, asProviderSwitcher } from '../../src/core/types.js'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One scripted turn reply. */
interface ScriptedReply {
  text: string
  errorText?: string
}

/** A fake agent whose followup schedules the scripted turn reply. */
interface OneShotAgent extends DshAgentLike {
  followups: Array<{ content?: Array<{ type: string; text: string }> }>
  disposed: boolean
}

interface Harness {
  ctx: DshContextLike
  creates: DshCreateOptionsLike[]
  agents: OneShotAgent[]
  script: ScriptedReply[]
}

/** A live parent agent with the given durable events. */
function parentAgent(id: string, events: SessionEvent[]): DshAgentLike {
  return { id, status: 'idle', session: { events }, followup: () => {}, steer: () => {}, cancel: () => {} }
}

function createHarness(parents: DshAgentLike[] = []): Harness {
  const creates: DshCreateOptionsLike[] = []
  const agents: OneShotAgent[] = []
  const script: ScriptedReply[] = []
  const listeners = new Map<string, Array<(session: { id: unknown }, event: Record<string, unknown>) => void>>()

  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of listeners.get('session/event') ?? []) {
      l({ id: sessionId }, { type, seq: 0, time: 0, data })
    }
  }

  const counter = { n: 0 }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        counter.n += 1
        const id = `agent-${counter.n}`
        const agent: OneShotAgent = {
          id,
          status: 'idle',
          session: { events: [] },
          followups: [],
          disposed: false,
          followup(message: unknown): void {
            agent.followups.push(message as { content?: Array<{ type: string; text: string }> })
            ;(agent as { status: string }).status = 'running'
            // Fire the scripted reply one microtask later — after the
            // one-shot loop has started awaiting the event channel.
            void Promise.resolve().then(() => {
              const reply = script.shift()
              if (reply === undefined) return
              emit(id, { type: 'assistant/message', message: { content: [{ type: 'text', text: reply.text }] } })
              emit(id, {
                type: 'turn/end',
                ...(reply.errorText !== undefined
                  ? { reason: { kind: 'error', error: { message: reply.errorText } } }
                  : { reason: { kind: 'stop' } }),
              })
            })
          },
          steer(): void {},
          cancel(): void {},
        }
        agents.push(agent)
        const handle: DshAgentHandleLike = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        return handle
      },
      resume: async (options: DshCreateOptionsLike) => {
        const rid = options.resumeSessionId
        const id = typeof rid === 'string' ? rid : 'resumed'
        const agent: OneShotAgent = {
          id,
          status: 'idle',
          session: { events: [] },
          followups: [],
          disposed: false,
          followup(): void {},
          steer(): void {},
          cancel(): void {},
        }
        agents.push(agent)
        return { agent, dispose: async () => { agent.disposed = true } }
      },
      get: (id: unknown): DshAgentLike | undefined =>
        parents.find(p => p.id === String(id))
        ?? agents.find(a => a.id === String(id) && !a.disposed),
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener as (session: { id: unknown }, event: Record<string, unknown>) => void)
      listeners.set(event, list)
      return () => {}
    },
    get: () => undefined,
  }

  return { ctx, creates, agents, script }
}

function newAdapter(h: Harness): DshAgentAdapter {
  return new DshAgentAdapter(h.ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [
      { name: 'glm', provider: 'glm-route', model: 'glm-5.3' },
      { name: 'turbo', provider: 'turbo-route', model: 'turbo-5', reasoningEffort: 'high' },
    ],
    activeProvider: 'glm',
  })
}

function ev(type: string, seq: number): SessionEvent {
  return { type, seq, time: seq, data: {} } as SessionEvent
}

function turn(seq: number): SessionEvent[] {
  return [ev('turn/start', seq), ev('assistant/message', seq + 1), ev('turn/end', seq + 2)]
}

describe('lightweightQuery', () => {
  it('runs one turn on a fresh session with the named route at low effort, then disposes', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    h.script.push({ text: '续读最重要之事\nicon: book' })

    const answer = await a.lightweightQuery('起个群名', 'turbo')

    expect(answer).toBe('续读最重要之事\nicon: book')
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'turbo-route', model: 'turbo-5', reasoningEffort: 'low' })
    expect(h.creates[0]!.meta?.cwd).toBe('/workspace/project')
    const agent = h.agents[0]!
    expect(agent.followups).toHaveLength(1)
    expect(agent.followups[0]!.content?.[0]).toEqual({ type: 'text', text: '起个群名' })
    expect(agent.disposed).toBe(true)
    // The temp session never owns an engine key: tool routing must treat it
    // as a foreign caller.
    expect(a.engineKeyForAgentID('agent-1')).toBeUndefined()
  })

  it('falls back to the active route for an unknown provider name', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    h.script.push({ text: '名字' })

    await a.lightweightQuery('p', 'no-such-route')

    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'glm-route', model: 'glm-5.3', reasoningEffort: 'low' })
  })

  it('surfaces a failed turn as an error', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    h.script.push({ text: '部分文本', errorText: 'No API key for provider' })

    await expect(a.lightweightQuery('p', 'glm')).rejects.toThrow('No API key for provider')
    expect(h.agents[0]!.disposed).toBe(true)
  })

  it('activates the ForkQuerierWithProvider capability', () => {
    const h = createHarness()
    const a = newAdapter(h)
    expect(typeof asForkQuerierWithProvider(a)?.lightweightQuery).toBe('function')
  })
})

describe('forkQuery / forkSessionWithProvider', () => {
  it('seeds the side query from the live parent completed-turn prefix', async () => {
    const h = createHarness([parentAgent('cc-parent-1', [...turn(0), ...turn(3)])])
    const a = newAdapter(h)
    h.script.push({ text: '答' })

    const answer = await a.forkQuery('cc-parent-1', '问题', '/workspace/child')

    expect(answer).toBe('答')
    expect(h.creates[0]!.seed?.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(h.creates[0]!.meta?.cwd).toBe('/workspace/child')
  })

  it('forkSessionWithProvider routes the query onto the named provider', async () => {
    const h = createHarness([parentAgent('cc-parent-1', turn(0))])
    const a = newAdapter(h)
    h.script.push({ text: '答' })

    await a.forkSessionWithProvider('cc-parent-1', '问题', 'turbo', '')

    // No lightweight override here: the query inherits the route's
    // configured effort when one exists.
    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'turbo-route', model: 'turbo-5', reasoningEffort: 'high' })
    expect(h.creates[0]!.seed?.map(e => e.seq)).toEqual([0, 1, 2])
  })
})

describe('ProviderSwitcher (naming fallback source)', () => {
  it('exposes the active provider and switches by name', () => {
    const h = createHarness()
    const a = newAdapter(h)

    expect(asProviderSwitcher(a)?.getActiveProvider()).toEqual({ name: 'glm' })
    expect(asProviderSwitcher(a)?.listProviders()).toEqual([{ name: 'glm' }, { name: 'turbo' }])
    expect(asProviderSwitcher(a)?.setActiveProvider('turbo')).toBe(true)
    expect(asProviderSwitcher(a)?.getActiveProvider()).toEqual({ name: 'turbo' })
    expect(asProviderSwitcher(a)?.setActiveProvider('nope')).toBe(false)
    // The switch took effect on route resolution.
    h.script.push({ text: '名' })
    void a.lightweightQuery('p', 'turbo')
  })

  it('rebuilds provider membership while retaining route detail', () => {
    const h = createHarness()
    const a = newAdapter(h)
    const sw = asProviderSwitcher(a)

    sw?.setProviders([{ name: 'turbo' }, { name: 'fresh' }])
    expect(sw?.listProviders()).toEqual([{ name: 'turbo' }, { name: 'fresh' }])
    // glm dropped → the active pointer resets to the first entry.
    expect(sw?.getActiveProvider()).toEqual({ name: 'turbo' })

    // A known name kept its route detail; an unknown one has none.
    h.script.push({ text: '名' })
    void a.lightweightQuery('p', 'turbo')
    h.script.push({ text: '名' })
    void a.lightweightQuery('p', 'fresh')
    return Promise.resolve().then(() => {
      expect(h.creates[0]?.agentOptions).toMatchObject({ provider: 'turbo-route' })
      expect(h.creates[1]?.agentOptions).toMatchObject({ provider: '' })
    })
  })
})

describe('renderQuery (Go dsh RenderQuery)', () => {
  it('runs a fresh session on the named route at the mapped effort with a complete-replacement system prompt', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    a.setRenderEffort('max')
    h.script.push({ text: '片段已写入：/tmp/x.html' })

    const answer = await a.renderQuery('render prompt', 'turbo', 'render system prompt')

    expect(answer).toBe('片段已写入：/tmp/x.html')
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'turbo-route', model: 'turbo-5', reasoningEffort: 'high' })
    // The complete system prompt rides the setup hook as a complete:true
    // section (the D3 bare-persona mechanism).
    const setup = h.creates[0]!.setup as ((agentCtx: unknown) => void) | undefined
    expect(setup).toBeTypeOf('function')
    const sections: Array<{ name: string; order: number; text: string; complete?: boolean }> = []
    setup?.({
      get: () => ({
        section: (sec: { name: string; order: number; text: string; complete?: boolean }) => { sections.push(sec) },
      }),
    })
    expect(sections).toEqual([{ name: 'feishu-bridge-render-session', order: 0, text: 'render system prompt', complete: true }])
    expect(h.agents[0]!.disposed).toBe(true)
  })

  it('defaults to low effort when no render effort is configured', async () => {
    const h = createHarness()
    const a = newAdapter(h)
    h.script.push({ text: 'ok' })

    await a.renderQuery('p', 'glm', 'sp')

    expect(h.creates[0]!.agentOptions).toEqual({ provider: 'glm-route', model: 'glm-5.3', reasoningEffort: 'low' })
  })
})

describe('renderReasoningLevel', () => {
  it('maps claudecode-style effort aliases onto dsh reasoning levels', async () => {
    const { renderReasoningLevel } = await import('../../src/agent-dsh/adapter.js')
    expect(renderReasoningLevel('')).toBe('low')
    expect(renderReasoningLevel('low')).toBe('low')
    expect(renderReasoningLevel('minimal')).toBe('low')
    expect(renderReasoningLevel('medium')).toBe('medium')
    expect(renderReasoningLevel('med')).toBe('medium')
    expect(renderReasoningLevel('high')).toBe('high')
    expect(renderReasoningLevel('max')).toBe('high')
    expect(renderReasoningLevel('off')).toBe('off')
    expect(renderReasoningLevel('none')).toBe('off')
    expect(renderReasoningLevel(' HIGH ')).toBe('high')
  })
})
