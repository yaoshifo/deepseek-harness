/**
 * DshAgentAdapter.listSessions persisted-view tests: the session store is
 * exclusive to this daemon, so /sessions must survive a daemon restart by
 * listing persisted sessions (filtered to the project's directory tree and
 * top-level sessions), not only live ones.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-list
 */
import { describe, expect, it } from 'vitest'
import { DshAgentAdapter } from '../../src/agent-dsh/adapter.js'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

const PROJECT_DIR = '/home/hm/workspace/proj'

function header(over: Partial<SessionHeader> & Pick<SessionHeader, 'id' | 'createdAt'>): SessionHeader {
  return { version: 0, cwd: PROJECT_DIR, ...over }
}

function newAdapter(list: SessionHeader[]): DshAgentAdapter {
  return new DshAgentAdapter(
    {
      agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
      on: () => () => {},
      get: (name: string) => (name === 'sessionPersistence' ? { list: async () => list } : undefined),
    },
    { agentName: 'a', cwd: PROJECT_DIR, providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
  )
}

describe('DshAgentAdapter.listSessions persisted view', () => {
  it('lists persisted sessions under the project directory, newest first', async () => {
    const adapter = newAdapter([
      header({ id: 'old-1', createdAt: 1000 }),
      header({ id: 'new-1', createdAt: 3000 }),
      header({ id: 'mid-1', createdAt: 2000 }),
    ])
    const got = await adapter.listSessions()
    expect(got.map(s => s.id)).toEqual(['new-1', 'mid-1', 'old-1'])
    expect(got[0]?.modifiedAt).toBe(3000)
    expect(got[0]?.summary).toBe('')
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
