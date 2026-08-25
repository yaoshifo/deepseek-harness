/**
 * /fork rollback (Go engine_cmd_session.go cmdFork quoted-message branch):
 * replying to a historical message and running /fork truncates the child's
 * transcript to the quoted turn via the agent's prepareForkAtSession and
 * plants a `__forkat__<newID>` sentinel. Without a quote (or with --worktree,
 * whose path is only known inside spawnGroupCommon) it stays a whole-session
 * fork; prepare failures reply and abort before any group is created.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine } from '../../src/engine/engine.js'
import { cmdFork, registerSessionCommands } from '../../src/engine/commands.js'
import type { Agent, Message } from '../../src/core/types.js'
import {
  createStubAgent,
  createStubChatroomSpawner,
  type StubChatroomSpawner,
} from '../stubs/engine-stubs.js'

interface ForkAtCall {
  origID: string
  childWorkDir: string
  quotedText: string
  quotedSenderType: string
  quotedTimeMs: number
}

/** Agent with a recording prepareForkAtSession (the ForkAtPreparer capability). */
function forkAtAgent(newID: string, err?: Error): Agent & { calls: ForkAtCall[] } {
  const calls: ForkAtCall[] = []
  const agent = {
    ...createStubAgent(),
    prepareForkAtSession: async (
      origID: string,
      childWorkDir: string,
      quotedText: string,
      quotedSenderType: string,
      quotedTimeMs: number,
    ): Promise<string> => {
      calls.push({ origID, childWorkDir, quotedText, quotedSenderType, quotedTimeMs })
      if (err !== undefined) throw err
      return newID
    },
  }
  return Object.assign(agent, { calls })
}

function quotedMsg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'test:oc_parent:ou_u',
    platform: 'test',
    messageID: 'm1',
    userID: 'user1',
    userName: '',
    chatName: 'parent',
    chatType: 'group',
    content: '/fork',
    originalContent: '/fork',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: 'om_quoted',
    quotedText: 'the login bug is fixed',
    quotedSenderType: 'app',
    quotedUpdateTimeMs: 1724300002000,
    ...overrides,
  }
}

interface ForkHarness {
  e: Engine
  p: StubChatroomSpawner
  dispose: () => void
}

function newHarness(agent: Agent, baseWorkDir = '/w/parent'): ForkHarness {
  const p = createStubChatroomSpawner('test')
  const e = new Engine('test', agent, [p], '', 'en')
  e.setBaseWorkDir(baseWorkDir)
  const dispose = registerSessionCommands(e)
  e.sessions.getOrCreateActive('test:oc_parent:ou_u').setAgentSessionID('real-parent-id', 'test')
  return { e, p, dispose }
}

async function waitForSent(p: StubChatroomSpawner, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (p.sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
}

describe('cmdFork quoted-message rollback', () => {
  it('prepares a truncated copy and plants the __forkat__ sentinel', async () => {
    const agent = forkAtAgent('cc-truncated')
    const { e, p, dispose } = newHarness(agent)
    try {
      await cmdFork(e, p, quotedMsg(), [])

      expect(agent.calls).toEqual([{
        origID: 'real-parent-id',
        childWorkDir: '/w/parent',
        quotedText: 'the login bug is fixed',
        quotedSenderType: 'app',
        quotedTimeMs: 1724300002000,
      }])
      // the child group's session carries the rollback sentinel
      const child = e.sessions.getOrCreateActive('test:role-1')
      expect(child.getAgentSessionID()).toBe('__forkat__cc-truncated')
      expect(p.sent).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('stays a whole-session fork without a quoted message', async () => {
    const agent = forkAtAgent('cc-truncated')
    const { e, p, dispose } = newHarness(agent)
    try {
      await cmdFork(e, p, quotedMsg({ parentMessageID: '', quotedText: '' }), [])
      expect(agent.calls).toHaveLength(0)
      expect(e.sessions.getOrCreateActive('test:role-1').getAgentSessionID()).toBe('__fork__real-parent-id')
    } finally {
      dispose()
    }
  })

  // Real git init + worktree add takes ~2s serial; the 5s default times out
  // under full-suite parallel load.
  it('skips the rollback when --worktree is requested', { timeout: 20_000 }, async () => {
    const agent = forkAtAgent('cc-truncated')
    // A real git repo so the -w worktree creation succeeds and the flow
    // reaches the sentinel plant.
    const repo = await mkdtemp(join(tmpdir(), 'fb-forkat-wt-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    const { e, p, dispose } = newHarness(agent, repo)
    try {
      // The worktree path is only known inside spawnGroupCommon, so cmdFork
      // cannot place the truncated copy ahead of time (Go parity)
      await cmdFork(e, p, quotedMsg(), ['-w'])
      expect(agent.calls).toHaveLength(0)
      expect(e.sessions.getOrCreateActive('test:role-1').getAgentSessionID()).toBe('__fork__real-parent-id')
    } finally {
      dispose()
    }
  })

  it('skips the rollback when the quote carries no update time', async () => {
    const agent = forkAtAgent('cc-truncated')
    const { e, p, dispose } = newHarness(agent)
    try {
      await cmdFork(e, p, quotedMsg({ quotedUpdateTimeMs: 0 }), [])
      expect(agent.calls).toHaveLength(0)
      expect(e.sessions.getOrCreateActive('test:role-1').getAgentSessionID()).toBe('__fork__real-parent-id')
    } finally {
      dispose()
    }
  })

  it('replies and aborts when truncation fails', async () => {
    const agent = forkAtAgent('cc-truncated', new Error('no message within window'))
    const { e, p, dispose } = newHarness(agent)
    try {
      await cmdFork(e, p, quotedMsg(), [])
      await waitForSent(p)
      expect(p.sent[0]).toContain('Rollback fork failed')
      // no group was created
      expect(e.sessions.getOrCreateActive('test:role-1').getAgentSessionID()).toBe('')
      expect(p.count).toBe(0)
    } finally {
      dispose()
    }
  })

  it('replies and aborts when the agent lacks the capability', async () => {
    const { e, p, dispose } = newHarness(createStubAgent())
    try {
      await cmdFork(e, p, quotedMsg(), [])
      await waitForSent(p)
      expect(p.sent[0]).toContain('not supported')
      expect(p.count).toBe(0)
    } finally {
      dispose()
    }
  })
})
