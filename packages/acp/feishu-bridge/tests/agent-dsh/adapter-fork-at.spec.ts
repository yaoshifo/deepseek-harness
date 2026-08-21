/**
 * Fork-at (rollback fork) wiring (Go agent/dsh/fork.go PrepareForkAtSession):
 * the adapter copies the parent's persisted transcript through the
 * sessionPersistence service, truncated to the turn the quoted message belongs
 * to, under a fresh id whose header records the child's workDir. The engine
 * starts the child with `__forkat__<newID>`, which startSession resumes
 * directly — no create, no seed. Unlike the plain `__fork__` seed path, the
 * source only needs to exist in persistence, not live in the registry.
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
        return { agent: agentWith([]), dispose: async () => {} }
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
  it('persists a truncated copy under a fresh id with the child cwd', async () => {
    const persistence = fakePersistence(new Map([
      ['cc-parent', { meta: parentHeader('/workspace/project'), events: twoTurnLog() }],
    ]))
    const { ctx } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    const newID = await adapter.prepareForkAtSession(
      'cc-parent', '/workspace/child', 'the login bug is fixed', 'app', 2000,
    )

    expect(newID).not.toBe('cc-parent')
    expect(newID).toMatch(/^cc-\d{8}-\d{6}-/)
    expect(persistence.creates).toHaveLength(1)
    expect(persistence.creates[0]?.id).toBe(newID)
    expect(persistence.creates[0]?.cwd).toBe('/workspace/child')
    // immutable lineage fields survive the copy (Go rewrites only id + cwd)
    expect(persistence.creates[0]?.createdAt).toBe(1724300000000)
    expect(persistence.creates[0]?.version).toBe(0)
    expect(persistence.appends).toHaveLength(1)
    expect(persistence.appends[0]?.id).toBe(newID)
    // truncated at the FIRST turn/end — the logout turn is rolled back
    expect(persistence.appends[0]?.events.map(e => e.seq)).toEqual([0, 1, 2, 3])
    // the whole copied log is inherited history: the seed boundary marks it
    expect(persistence.creates[0]?.seedLength).toBe(4)
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
  it('resumes the truncated copy directly without creating or seeding', async () => {
    const persistence = fakePersistence(new Map())
    const { ctx, resumes, creates } = createHarness(persistence)
    const adapter = newAdapter(ctx)

    const session = await adapter.startSession(`${ForkAtSessionPrefix}cc-truncated`)
    expect(resumes).toHaveLength(1)
    expect(resumes[0]?.resumeSessionId).toBe('cc-truncated')
    expect(creates).toHaveLength(0)
    expect(session.currentSessionID()).toBe('cc-truncated')
  })
})
