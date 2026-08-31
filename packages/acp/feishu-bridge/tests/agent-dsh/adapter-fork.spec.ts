/**
 * /fork wiring (Go agent/dsh/fork.go): a session id carrying the __fork__
 * sentinel creates a NEW native session seeded with the parent's balanced
 * seedable prefix — completed turns plus the flying turn cut at its last
 * balanced point and closed synthetically — so the child inherits the
 * conversation context without appending to the parent's log. The seed source
 * resolves live-first, then the persisted log (Go reads disk): a
 * merely-persisted parent still forks. A missing/unreadable source degrades
 * to a fresh session, while PrepareForkSession fails fast so the engine's
 * guard fires before the group is created.
 */

import { describe, expect, it } from 'vitest'
import { ForkSessionPrefix } from '../../src/core/types.ts'
import { DshAgentAdapter, type DshAgentLike, type DshPersistenceLike } from '../../src/agent-dsh/adapter.ts'
import type { DshCreateOptionsLike, DshContextLike } from '../../src/agent-dsh/adapter.ts'
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
    steer: () => {},
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
    list: async () => [],
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
    // both complete turns plus the open turn's user message, closed with a
    // synthetic turn/end (seq 10) — the flying input is no longer dropped
    expect(opts.meta?.seedLength).toBe(11)
    expect((opts.seed ?? []).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const closer = opts.seed!.at(-1)! as SessionEvent<'turn/end'>
    expect(closer.type).toBe('turn/end')
    expect(closer.data).toEqual({ turn: 0, reason: { kind: 'interrupted' } })
    expect(session.currentSessionID()).not.toBe('cc-parent-1')
  })

  it('settles a dangling ask_user_question in the open step of a live parent', async () => {
    // the ask-blocked incident shape: the flying turn's open step carries an
    // assistant message and a tool call with no result
    const events = [
      ...turn(0),
      ev('turn/start', 4), ev('user/message', 5), ev('step/start', 6), ev('assistant/message', 7),
      { type: 'tool/call', seq: 8, time: 8, data: { callId: 'call-ask', name: 'ask_user_question' } } as SessionEvent,
      ev('agent/inbox/spliced', 9),
    ]
    const h = createHarness([parentAgent('cc-parent-ask', events)])
    const adapter = newAdapter(h.ctx)

    await adapter.startSession(`${ForkSessionPrefix}cc-parent-ask`)

    const opts = h.creates[0]!
    const seed = opts.seed ?? []
    // the dangling call is settled (seq 9), the step closed (10), the turn closed (11);
    // the trailing splice stays out — the child gets its own first message
    expect(seed.map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'assistant/message', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'tool/call',
      'tool/result', 'step/end', 'turn/end',
    ])
    const settled = seed[9]! as SessionEvent<'tool/result'>
    expect(settled.data.message).toMatchObject({
      source: { kind: 'tool', callId: 'call-ask' },
      role: 'user',
    })
    expect(settled.data.message.content[0]).toMatchObject({ type: 'tool-result', isError: true })
    expect((seed[11]! as SessionEvent<'turn/end'>).data.reason).toEqual({ kind: 'interrupted' })
    expect(opts.meta?.seedLength).toBe(12)
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
    // the persisted view cuts and closes the flying turn the same way
    expect((opts.seed ?? []).map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect((opts.seed!.at(-1)! as SessionEvent<'turn/end'>).data).toEqual({ turn: 0, reason: { kind: 'interrupted' } })
    expect(String(opts.meta?.parentSession)).toBe('cc-cold')
    expect(opts.meta?.seedLength).toBe(11)
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
