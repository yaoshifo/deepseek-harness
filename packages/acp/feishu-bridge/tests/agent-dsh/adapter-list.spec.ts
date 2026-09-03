/**
 * DshAgentAdapter.listSessions persisted-view tests: the session store is
 * exclusive to this daemon, so /sessions must survive a daemon restart by
 * listing persisted sessions (filtered to the project's directory tree and
 * top-level sessions), not only live ones. Persisted recency is the JSONL
 * log file's mtime (SessionHeader has no updatedAt).
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-list
 */
import { describe, expect, it } from 'vitest'
import { DshAgentAdapter, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.ts'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

const PROJECT_DIR = '/home/hm/workspace/proj'

/** String ids in, branded header out: the brand is a type-level fact only. */
function header(over: Partial<Omit<SessionHeader, 'id' | 'parentSession'>> & {
  id: string
  createdAt: SessionHeader['createdAt']
  parentSession?: string
}): SessionHeader {
  const { id, parentSession, ...rest } = over
  return {
    version: 0,
    isSeeded: false,
    cwd: PROJECT_DIR,
    ...rest,
    id: SessionId(id),
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  }
}

function newAdapter(list: SessionHeader[]): DshAgentAdapter {
  return new DshAgentAdapter(
    {
      agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
      on: () => () => {},
      get: (name: string) => (name === 'sessionPersistence' ? { list: async () => list.map(header => ({ header })) } : undefined),
    },
    { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
  )
}

describe('DshAgentAdapter.listSessions persisted view', () => {
  it('orders persisted sessions by header createdAt, newest first', async () => {
    const adapter = newAdapter([
      header({ id: 'old-1', createdAt: 1000 }),
      header({ id: 'new-1', createdAt: 3000 }),
      header({ id: 'mid-1', createdAt: 2000 }),
    ])
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['new-1', 'mid-1', 'old-1'])
    expect(got[0]?.modifiedAt).toBe(3000)
  })

  it('keeps worktree descendants and drops other-project and child sessions', async () => {
    const adapter = newAdapter([
      header({ id: 'wt-1', createdAt: 1000, cwd: `${PROJECT_DIR}/.claude/worktrees/task-1` }),
      header({ id: 'other-1', createdAt: 2000, cwd: '/home/hm/workspace/other' }),
      header({ id: 'child-1', createdAt: 3000, parentSession: 'parent-1' }),
    ])
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['wt-1'])
  })

  it('filters the persisted view by the caller-supplied workDir (chat dir override)', async () => {
    // A chat whose /dir override points outside the configured project base
    // must see its own directory's sessions, not the base's.
    const adapter = newAdapter([
      header({ id: 'base-1', createdAt: 1000 }),
      header({ id: 'chat-1', createdAt: 2000, cwd: '/home/hm/workspace/other' }),
    ])
    const got = await adapter.listSessions('/home/hm/workspace/other')
    expect(got.map(s => s.id)).toEqual(['chat-1'])
  })

  it('filters the live view by the caller-supplied workDir (chat dir override)', async () => {
    // /list is scoped to the calling chat's effective directory: live
    // sessions recorded in other dirs (other chats' /dir overrides) stay
    // out; sessions without a recorded cwd stay visible (unknown ≠ foreign).
    const mkAgent = (id: string, cwd?: string): DshAgentLike => ({
      id,
      status: 'idle',
      session: { snapshotEvents: () => [], ...(cwd !== undefined ? { header: { cwd } } : {}) },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
    })
    const queue = [mkAgent('live-base', PROJECT_DIR), mkAgent('live-other', '/home/hm/workspace/other'), mkAgent('live-unknown')]
    const adapter = new DshAgentAdapter(
      {
        agents: {
          create: async () => ({ agent: queue.shift()!, dispose: async () => {} }),
          resume: async () => { throw new Error('unused') },
          get: () => undefined,
        },
        on: () => () => {},
        get: () => undefined,
      },
      { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    const s1 = await adapter.startSession('', { sessionKey: 'feishu:oc_1:ou_1' })
    const s2 = await adapter.startSession('', { sessionKey: 'feishu:oc_2:ou_2' })
    const s3 = await adapter.startSession('', { sessionKey: 'feishu:oc_3:ou_3' })

    expect((await adapter.listSessions()).map(s => s.id).sort()).toEqual(['live-base', 'live-unknown'])
    expect((await adapter.listSessions('/home/hm/workspace/other')).map(s => s.id).sort()).toEqual(['live-other', 'live-unknown'])

    await s1.close()
    await s2.close()
    await s3.close()
  })

  it('drops one-shot side-query sessions (origin oneshot) from the persisted view', async () => {
    // Group naming, predict-next, and turn-summary run on origin:'oneshot'
    // sessions whose logs land in the project cwd — user-visible /list must
    // not surface them.
    const adapter = newAdapter([
      header({ id: 'real-1', createdAt: 1000 }),
      header({ id: 'side-1', createdAt: 2000, origin: 'oneshot' }),
    ])
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['real-1'])
  })

  it('excludes an in-flight one-shot side query from the live view', async () => {
    // A never-answering agent parks the one-shot query mid-flight: exactly
    // the window where a concurrent /list from another chat would see it.
    let created = false
    const ctx: DshContextLike = {
      agents: {
        create: async () => {
          created = true
          return {
            agent: {
              id: 'one-shot-live',
              status: 'running',
              session: { snapshotEvents: () => [], header: { origin: 'oneshot' } },
              followup: () => {},
              steer: () => {},
              cancel: () => {},
            },
            dispose: async () => {},
          }
        },
        resume: async () => { throw new Error('unused') },
        get: () => undefined,
      },
      on: () => () => {},
      get: () => undefined,
    }
    const adapter = new DshAgentAdapter(
      ctx,
      { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    const ctl = new AbortController()
    const query = adapter.lightweightQuery('q', 'r', ctl.signal)
    // One macrotask drains the create continuation, so the one-shot session
    // is registered in the live view before /list looks.
    await new Promise((r) => { setTimeout(r, 0) })
    expect(created).toBe(true)
    expect((await adapter.listSessions()).map(s => s.id)).toEqual([])
    ctl.abort()
    await expect(query).rejects.toThrow('aborted by caller')
  })

  it('falls back to live-only when no persistence service is present', async () => {
    const adapter = new DshAgentAdapter(
      {
        agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
        on: () => () => {},
        get: () => undefined,
      },
      { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  /**
   * Harness for the seeded side-query paths (forkQuery /
   * forkSessionWithProvider over oneShotQuery): a live parent feeds the seed,
   * the created side agent parks mid-turn until the test fires its scripted
   * answer, and the create meta's origin lands in the session header the way
   * core/session copies it (session.spec "attaches oneshot origin from meta
   * to the header") — so isOneshot sees what production would persist.
   */
  function forkSideHarness(parentEvents: SessionEvent[]): {
    ctx: DshContextLike
    creates: DshCreateOptionsLike[]
    answer: (text: string) => void
  } {
    const creates: DshCreateOptionsLike[] = []
    const listeners: Array<(session: { id: unknown }, event: Record<string, unknown>) => void> = []
    const parent: DshAgentLike = {
      id: 'cc-parent-1',
      status: 'idle',
      session: { snapshotEvents: () => parentEvents },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
    }
    const ctx: DshContextLike = {
      agents: {
        create: async (options: DshCreateOptionsLike) => {
          creates.push(options)
          return {
            agent: {
              id: 'fork-side-1',
              status: 'running',
              session: { snapshotEvents: () => [], header: { origin: options.meta?.origin } },
              followup: () => {},
              steer: () => {},
              cancel: () => {},
            },
            dispose: async () => {},
          }
        },
        resume: async () => { throw new Error('unused') },
        get: (id: unknown) => (String(id) === parent.id ? parent : undefined),
      },
      on: (event: string, listener: (...args: never[]) => unknown) => {
        if (event === 'session/event') {
          listeners.push(listener as (session: { id: unknown }, event: Record<string, unknown>) => void)
        }
        return () => {}
      },
      get: () => undefined,
    }
    const answer = (text: string): void => {
      for (const l of listeners) {
        l({ id: 'fork-side-1' }, { type: 'assistant/message', seq: 0, time: 0, data: { message: { content: [{ type: 'text', text }] } } })
        l({ id: 'fork-side-1' }, { type: 'turn/end', seq: 1, time: 0, data: { reason: { kind: 'stop' } } })
      }
    }
    return { ctx, creates, answer }
  }

  /** One completed parent turn (turn/start, assistant/message, turn/end). */
  function turn(seq: number): SessionEvent[] {
    return [
      { type: 'turn/start', seq, time: seq, data: {} } as SessionEvent,
      { type: 'assistant/message', seq: seq + 1, time: seq + 1, data: {} } as SessionEvent,
      { type: 'turn/end', seq: seq + 2, time: seq + 2, data: {} } as SessionEvent,
    ]
  }

  it('excludes an in-flight forkQuery side session from the live view', async () => {
    // forkQuery is a bypass side query like lightweightQuery (Go ForkQuery):
    // its session must carry origin 'oneshot' so neither the in-flight
    // session nor its persisted log surfaces in /list.
    const h = forkSideHarness([...turn(0), ...turn(3)])
    const adapter = new DshAgentAdapter(
      h.ctx,
      { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    const query = adapter.forkQuery('cc-parent-1', '问题', PROJECT_DIR)
    // One macrotask drains the create continuation, so the side session is
    // registered in the live view before /list looks.
    await new Promise((r) => { setTimeout(r, 0) })
    expect((await adapter.listSessions()).map(s => s.id)).toEqual([])
    // The origin marker changes only the persisted identity: the fork seed
    // still rides the create, and the answer still flows back to the caller.
    expect(h.creates[0]?.seed?.length).toBeGreaterThan(0)
    h.answer('答')
    await expect(query).resolves.toBe('答')
  })

  it('excludes an in-flight forkSessionWithProvider side session from the live view', async () => {
    const h = forkSideHarness(turn(0))
    const adapter = new DshAgentAdapter(
      h.ctx,
      { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    const query = adapter.forkSessionWithProvider('cc-parent-1', '问题', 'r', PROJECT_DIR)
    await new Promise((r) => { setTimeout(r, 0) })
    expect((await adapter.listSessions()).map(s => s.id)).toEqual([])
    h.answer('答')
    await expect(query).resolves.toBe('答')
  })
})
