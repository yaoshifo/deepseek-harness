/**
 * Fork-at (rollback fork) wiring (Go agent/dsh/fork.go PrepareForkAtSession):
 * the adapter truncates the source transcript (live snapshot or persisted
 * log) to the turn the quoted message belongs to and stages the prefix
 * in memory; the engine starts the child with `__forkat__<newID>`, which
 * startSession consumes as a seeded `agents.create` — one native step, no
 * persisted pre-copy. Unlike the plain `__fork__` seed path, the source only
 * needs to exist in persistence, not live in the registry.
 */

import { describe, expect, it } from 'vitest'
import { ForkAtSessionPrefix } from '../../src/core/types.js'
import { DshAgentAdapter, type DshAgentLike } from '../../src/agent-dsh/adapter.js'
import type { DshContextLike, DshCreateOptionsLike } from '../../src/agent-dsh/adapter.js'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Structural slice of the sessionPersistence service the adapter consumes. */
interface FakePersistence {
  stored: Map<string, { meta: SessionHeader; events: SessionEvent[] }>
  creates: SessionHeader[]
  appends: { id: string; events: SessionEvent[] }[]
  inspect(id: unknown): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  create(meta: SessionHeader): Promise<void>
  append(id: unknown, events: readonly SessionEvent[]): Promise<void>
  list(signal?: AbortSignal): Promise<SessionHeader[]>
}

function fakePersistence(stored: Map<string, { meta: SessionHeader; events: SessionEvent[] }>): FakePersistence {
  const persistence: FakePersistence = {
    stored,
    creates: [],
    appends: [],
    inspect: async (id: unknown) => {
      const hit = stored.get(String(id))
      if (hit === undefined) throw new Error(`session "${String(id)}" not found`)
      return hit
    },
    create: async (meta: SessionHeader) => {
      if (stored.has(meta.id)) throw new Error(`session "${meta.id}" already exists`)
      persistence.creates.push(meta)
    },
    append: async (id: unknown, events: readonly SessionEvent[]) => {
      persistence.appends.push({ id: String(id), events: [...events] })
    },
    list: async () => [...stored.values()].map(hit => hit.meta),
  }
  return persistence
}

interface FakeAgent extends DshAgentLike {
  session: { events: SessionEvent[] }
}

function agentWith(events: SessionEvent[], id = ''): FakeAgent {
  return {
    id,
    status: 'idle',
    session: { events },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
}

function msgEv(type: string, seq: number, time: number, text: string): SessionEvent {
  const data = type === 'assistant/message'
    ? { message: { content: [{ type: 'text', text }] } }
    : { content: [{ type: 'text', text }] }
  return { type, seq, time, data } as SessionEvent
}

function ev(type: string, seq: number): SessionEvent {
  return { type, seq, time: seq, data: {} } as SessionEvent
}

/** A two-turn log whose first assistant message is the quoted one. */
function twoTurnLog(): SessionEvent[] {
  return [
    ev('turn/start', 0),
    msgEv('user/message', 1, 1000, 'fix the login bug'),
    msgEv('assistant/message', 2, 2000, 'the login bug is fixed'),
    ev('turn/end', 3),
    ev('turn/start', 4),
    msgEv('user/message', 5, 8000, 'now the logout'),
    msgEv('assistant/message', 6, 9000, 'logout fixed too'),
    ev('turn/end', 7),
  ]
}

function parentHeader(cwd: string): SessionHeader {
  return {
    version: 0,
    id: 'cc-20260822-100000-aaaa' as SessionHeader['id'],
    createdAt: 1724300000000,
    cwd,
  }
}

function createHarness(persistence: FakePersistence | undefined): {
  ctx: DshContextLike
  resumes: DshCreateOptionsLike[]
  creates: DshCreateOptionsLike[]
} {
  const resumes: DshCreateOptionsLike[] = []
  const creates: DshCreateOptionsLike[] = []
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        return { agent: agentWith([], typeof options.sessionId === 'string' ? options.sessionId : ''), dispose: async () => {} }
      },
      resume: async (options: DshCreateOptionsLike) => {
        resumes.push(options)
        const rid = options.resumeSessionId
        return { agent: agentWith([], typeof rid === 'string' ? rid : 'resumed'), dispose: async () => {} }
      },
      get: () => undefined,
    },
    on: () => () => {},
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  return { ctx, resumes, creates }
}

function newAdapter(ctx: DshContextLike): DshAgentAdapter {
  return new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5' }],
    activeProvider: 'glm',
  })
}

describe('prepareForkAtSession', () => {
  it('stages the truncated seed in memory without persisting a copy', async () => {
    const persistence = fakePersistence(new Map([
      ['cc-parent', { meta: parentHeader('/workspace/project'), events: twoTurnLog() }],
    ]))
    const { ctx, creates } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    const newID = await adapter.prepareForkAtSession(
      'cc-parent', '/workspace/child', 'the login bug is fixed', 'app', 2000,
    )

    expect(newID).not.toBe('cc-parent')
    expect(newID).toMatch(/^cc-\d{8}-\d{6}-/)
    // no persisted pre-copy: the child's own log is written by its session
    expect(persistence.creates).toHaveLength(0)
    expect(persistence.appends).toHaveLength(0)
    expect(creates).toHaveLength(0)
  })

  it('seeds the child from the staged prefix on the __forkat__ sentinel', async () => {
    const persistence = fakePersistence(new Map([
      ['cc-parent', { meta: parentHeader('/workspace/project'), events: twoTurnLog() }],
    ]))
    const { ctx, resumes, creates } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    const newID = await adapter.prepareForkAtSession(
      'cc-parent', '/workspace/child', 'the login bug is fixed', 'app', 2000,
    )
    const session = await adapter.startSession(`${ForkAtSessionPrefix}${newID}`)

    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(1)
    expect(creates[0]?.sessionId).toBe(newID)
    expect(creates[0]?.meta?.cwd).toBe('/workspace/child')
    expect(creates[0]?.meta?.parentSession).toBe('cc-parent')
    // truncated at the FIRST turn/end — the logout turn is rolled back
    expect((creates[0]?.seed as SessionEvent[]).map(e => e.seq)).toEqual([0, 1, 2, 3])
    // the whole inherited prefix is marked as seed
    expect(creates[0]?.meta?.seedLength).toBe(4)
    expect(session.currentSessionID()).toBe(newID)
  })

  it('works for a cold parent absent from the live registry', async () => {
    const persistence = fakePersistence(new Map([
      ['cc-cold', { meta: parentHeader('/workspace/project'), events: twoTurnLog() }],
    ]))
    const { ctx, creates } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    // the parent is not in ctx.agents — only in persistence
    const newID = await adapter.prepareForkAtSession('cc-cold', '/workspace/project', '', 'app', 2000)
    expect(newID).not.toBe('')
    expect(creates).toHaveLength(0)
  })

  it('rejects when the source session is not in persistence', async () => {
    const persistence = fakePersistence(new Map())
    const { ctx } = createHarness(persistence)
    const adapter = newAdapter(ctx)
    await expect(adapter.prepareForkAtSession('cc-missing', '/w', 'text', 'app', 1000))
      .rejects.toThrow('not found')
  })

  it('rejects when the quoted message cannot be located', async () => {
    const persistence = fakePersistence(new Map([
      ['cc-parent', { meta: parentHeader('/w'), events: twoTurnLog() }],
    ]))
    const { ctx } = createHarness(persistence)
    const adapter = newAdapter(ctx)
    await expect(adapter.prepareForkAtSession('cc-parent', '/w', 'text', 'app', 1724309999000))
      .rejects.toThrow('within window')
    expect(persistence.creates).toHaveLength(0)
  })

  it('rejects when the sessionPersistence service is unavailable', async () => {
    const { ctx } = createHarness(undefined)
    const adapter = newAdapter(ctx)
    await expect(adapter.prepareForkAtSession('cc-parent', '/w', 'text', 'app', 1000))
      .rejects.toThrow('sessionPersistence')
  })
})

describe('startSession __forkat__ sentinel', () => {
  it('degrades to a fresh session when the staged seed is gone (daemon restart)', async () => {
    const persistence = fakePersistence(new Map())
    const { ctx, resumes, creates } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    const session = await adapter.startSession(`${ForkAtSessionPrefix}cc-lost`)
    expect(resumes).toHaveLength(0)
    expect(creates).toHaveLength(1)
    expect(creates[0]?.seed).toBeUndefined()
    expect(session.currentSessionID()).toBe('cc-lost')
  })
})
