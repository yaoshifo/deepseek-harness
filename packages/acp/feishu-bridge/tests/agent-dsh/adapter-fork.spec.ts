/**
 * /fork wiring (Go agent/dsh/fork.go): a session id carrying the __fork__
 * sentinel creates a NEW native session seeded with the parent's balanced
 * completed-turn prefix — the child inherits the conversation context without
 * appending to the parent's log. The seed source resolves live-first, then
 * the persisted log (Go reads disk): a merely-persisted parent still forks.
 * A missing/unreadable source degrades to a fresh session, while
 * PrepareForkSession fails fast so the engine's guard fires before the group
 * is created.
 */

import { describe, expect, it } from 'vitest'
import { ForkSessionPrefix } from '../../src/core/types.js'
import { DshAgentAdapter, type DshAgentLike, type DshPersistenceLike } from '../../src/agent-dsh/adapter.js'
import type { DshCreateOptionsLike, DshContextLike } from '../../src/agent-dsh/adapter.js'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

interface FakeSession {
  events: SessionEvent[]
}

interface ParentAgent extends DshAgentLike {
  session: FakeSession
}

function ev(type: string, seq: number): SessionEvent {
  return { type, seq, time: seq, data: {} } as SessionEvent
}

/** A parent agent with the given durable events, registered in ctx.agents. */
function parentAgent(id: string, events: SessionEvent[]): ParentAgent {
  return {
    id,
    status: 'idle',
    session: { events },
    followup: () => {},
    cancel: () => {},
  }
}

/** A persisted source the seed path can fall back to (Go's on-disk transcript). */
function fakePersistence(stored: Map<string, SessionEvent[]>): DshPersistenceLike {
  return {
    inspect: async (id: unknown) => {
      const events = stored.get(String(id))
      if (events === undefined) throw new Error(`session "${String(id)}" not found`)
      const meta = { version: 0, id: String(id), createdAt: 0 } as SessionHeader
      return { meta, events }
    },
    create: async () => {},
    append: async () => {},
  }
}

function createHarness(parents: ParentAgent[] = [], persistence?: DshPersistenceLike): {
  ctx: DshContextLike
  creates: DshCreateOptionsLike[]
  resumes: DshCreateOptionsLike[]
} {
  const creates: DshCreateOptionsLike[] = []
  const resumes: DshCreateOptionsLike[] = []
  const counter = { n: 0 }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        counter.n += 1
        return {
          agent: parentAgent(`agent-${counter.n}`, []),
          dispose: async () => {},
        }
      },
      resume: async (options: DshCreateOptionsLike) => {
        resumes.push(options)
        const rid = options.resumeSessionId
        return {
          agent: parentAgent(typeof rid === 'string' ? rid : 'resumed', []),
          dispose: async () => {},
        }
      },
      get: (id: unknown) => parents.find(a => a.id === String(id)),
    },
    on: () => () => {},
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  return { ctx, creates, resumes }
}

function newAdapter(ctx: DshContextLike): DshAgentAdapter {
  return new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5' }],
    activeProvider: 'glm',
  })
}

/** One turn of durable events: turn/start, a message, turn/end. */
function turn(seq: number): SessionEvent[] {
  return [ev('turn/start', seq), ev('user/message', seq + 1), ev('assistant/message', seq + 2), ev('turn/end', seq + 3)]
}

describe('fork session seed', () => {
  it('seeds the child with the parent completed-turn prefix via agents.create', async () => {
    const events = [...turn(0), ...turn(4), ev('turn/start', 8), ev('user/message', 9)] // open last turn
    const h = createHarness([parentAgent('cc-parent-1', events)])
    const adapter = newAdapter(h.ctx)

    const session = await adapter.startSession(`${ForkSessionPrefix}cc-parent-1`)

    expect(h.resumes).toEqual([]) // a fork creates, never resumes the parent's id
    expect(h.creates).toHaveLength(1)
    const opts = h.creates[0]!
    expect(String(opts.sessionId)).not.toBe('cc-parent-1')
    expect(opts.meta?.cwd).toBe('/workspace/project')
    expect(String(opts.meta?.parentSession)).toBe('cc-parent-1')
    expect(opts.meta?.seedLength).toBe(8) // both complete turns, open turn excluded
    expect((opts.seed ?? []).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(session.currentSessionID()).not.toBe('cc-parent-1')
  })

  it('creates without a seed when the parent has no completed turn', async () => {
    const h = createHarness([parentAgent('cc-parent-2', [ev('turn/start', 0)])])
    const adapter = newAdapter(h.ctx)

    await adapter.startSession(`${ForkSessionPrefix}cc-parent-2`)

    const opts = h.creates[0]!
    expect(opts.seed).toBeUndefined()
    // Fork lineage is recorded even with nothing to inherit.
    expect(String(opts.meta?.parentSession)).toBe('cc-parent-2')
    expect(opts.meta?.seedLength).toBe(0)
  })

  it('degrades to a fresh session when the source is not live', async () => {
    const h = createHarness([]) // no parent anywhere
    const adapter = newAdapter(h.ctx)

    const session = await adapter.startSession(`${ForkSessionPrefix}cc-gone`)

    expect(h.resumes).toEqual([])
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]!.seed).toBeUndefined()
    expect(session.alive()).toBe(true)
  })

  it('seeds from the persisted log when the parent is not live', async () => {
    // daemon restarted / idle-reaped: the parent exists only in persistence
    const events = [...turn(0), ...turn(4), ev('turn/start', 8), ev('user/message', 9)] // open last turn
    const h = createHarness([], fakePersistence(new Map([['cc-cold', events]])))
    const adapter = newAdapter(h.ctx)

    await adapter.startSession(`${ForkSessionPrefix}cc-cold`)

    const opts = h.creates[0]!
    expect((opts.seed ?? []).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(String(opts.meta?.parentSession)).toBe('cc-cold')
    expect(opts.meta?.seedLength).toBe(8)
  })

  it('prefers the live parent over the stale persisted log', async () => {
    // write-behind lag: persistence is missing the parent's latest turn
    const persisted = [...turn(0)]
    const live = [...turn(0), ...turn(4)]
    const h = createHarness([parentAgent('cc-parent-3', live)], fakePersistence(new Map([['cc-parent-3', persisted]])))
    const adapter = newAdapter(h.ctx)

    await adapter.startSession(`${ForkSessionPrefix}cc-parent-3`)

    const opts = h.creates[0]!
    expect((opts.seed ?? []).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('degrades to a fresh session when the source is nowhere, persistence present', async () => {
    const h = createHarness([], fakePersistence(new Map()))
    const adapter = newAdapter(h.ctx)

    const session = await adapter.startSession(`${ForkSessionPrefix}cc-gone`)

    expect(h.creates[0]!.seed).toBeUndefined()
    expect(session.alive()).toBe(true)
  })
})

describe('prepareForkSession (ForkSessionPreparer)', () => {
  it('resolves when the fork source session is live', async () => {
    const h = createHarness([parentAgent('cc-parent-1', turn(0))])
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-parent-1', '/workspace/project', '/workspace/child'))
      .resolves.toBeUndefined()
  })

  it('resolves when the fork source is merely persisted', async () => {
    const h = createHarness([], fakePersistence(new Map([['cc-cold', turn(0)]])))
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-cold', '/workspace/project', '/workspace/child'))
      .resolves.toBeUndefined()
  })

  it('fails fast when the fork source session is not found', async () => {
    const h = createHarness([])
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-gone', '/workspace/project', '/workspace/child'))
      .rejects.toThrow('not found')
  })

  it('fails fast when the source is nowhere, persistence present', async () => {
    const h = createHarness([], fakePersistence(new Map()))
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-gone', '/workspace/project', '/workspace/child'))
      .rejects.toThrow('not found')
  })
})
