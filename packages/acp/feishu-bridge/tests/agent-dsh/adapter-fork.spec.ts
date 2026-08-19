/**
 * /fork wiring (Go agent/dsh/fork.go): a session id carrying the __fork__
 * sentinel creates a NEW native session seeded with the parent's balanced
 * completed-turn prefix — the child inherits the conversation context without
 * appending to the parent's log. A missing/unreadable source degrades to a
 * fresh session (Go behavior), while PrepareForkSession fails fast so the
 * engine's cross-workdir guard fires before the group is created.
 */

import { describe, expect, it } from 'vitest'
import { ForkSessionPrefix } from '../../src/core/types.js'
import { DshAgentAdapter, type DshAgentLike } from '../../src/agent-dsh/adapter.js'
import type { DshCreateOptionsLike, DshContextLike } from '../../src/agent-dsh/adapter.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

function createHarness(parents: ParentAgent[] = []): {
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
    get: () => undefined,
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
})

describe('prepareForkSession (ForkSessionPreparer)', () => {
  it('resolves when the fork source session is live', async () => {
    const h = createHarness([parentAgent('cc-parent-1', turn(0))])
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-parent-1', '/workspace/project', '/workspace/child'))
      .resolves.toBeUndefined()
  })

  it('fails fast when the fork source session is not found', async () => {
    const h = createHarness([])
    const adapter = newAdapter(h.ctx)
    await expect(adapter.prepareForkSession('cc-gone', '/workspace/project', '/workspace/child'))
      .rejects.toThrow('not found')
  })
})
