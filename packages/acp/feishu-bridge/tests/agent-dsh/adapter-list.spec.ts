/**
 * DshAgentAdapter.listSessions persisted-view tests: the session store is
 * exclusive to this daemon, so /sessions must survive a daemon restart by
 * listing persisted sessions (filtered to the project's directory tree and
 * top-level sessions), not only live ones. Persisted recency is the JSONL
 * log file's mtime (SessionHeader has no updatedAt).
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-list
 */
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshAgentAdapter, type DshContextLike } from '../../src/agent-dsh/adapter.js'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'

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
    cwd: PROJECT_DIR,
    ...rest,
    id: SessionId(id),
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  }
}

function newAdapter(list: SessionHeader[], locate?: (meta: SessionHeader) => { path: string }): DshAgentAdapter {
  return new DshAgentAdapter(
    {
      agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
      on: () => () => {},
      get: (name: string) => (name === 'sessionPersistence' ? { list: async () => list, ...(locate !== undefined ? { locate } : {}) } : undefined),
    },
    { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
  )
}

describe('DshAgentAdapter.listSessions persisted view', () => {
  it('orders persisted sessions by log-file mtime, newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-adapter-list-'))
    const oldLog = join(dir, 'old.jsonl')
    const newLog = join(dir, 'new.jsonl')
    const midLog = join(dir, 'mid.jsonl')
    await Promise.all([writeFile(oldLog, 'x\n', 'utf8'), writeFile(newLog, 'x\n', 'utf8'), writeFile(midLog, 'x\n', 'utf8')])
    // Created in the opposite order of their mtimes: mtime, not createdAt, orders the list.
    await utimes(oldLog, new Date(4000), new Date(4000))
    await utimes(newLog, new Date(9000), new Date(9000))
    await utimes(midLog, new Date(6500), new Date(6500))
    const adapter = newAdapter([
      header({ id: 'old-1', createdAt: 3000 }),
      header({ id: 'new-1', createdAt: 1000 }),
      header({ id: 'mid-1', createdAt: 2000 }),
    ], meta => ({ path: join(dir, `${String(meta.id).split('-')[0]}.jsonl`) }))

    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['new-1', 'mid-1', 'old-1'])
    expect(got[0]?.modifiedAt).toBe(9000)
    expect(got[0]?.summary).toBe('')
  })

  it('falls back to createdAt when the backend cannot locate the log', async () => {
    const adapter = newAdapter([
      header({ id: 'old-1', createdAt: 1000 }),
      header({ id: 'new-1', createdAt: 3000 }),
      header({ id: 'mid-1', createdAt: 2000 }),
    ])
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['new-1', 'mid-1', 'old-1'])
    expect(got[0]?.modifiedAt).toBe(3000)
  })

  it('falls back to createdAt when the located log is not on disk', async () => {
    const adapter = newAdapter([
      header({ id: 'missing-1', createdAt: 2500 }),
    ], () => ({ path: '/nonexistent/root/missing-1/session.jsonl' }))
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['missing-1'])
    expect(got[0]?.modifiedAt).toBe(2500)
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
              session: { events: [], header: { origin: 'oneshot' } },
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
})
