/**
 * Subtask orchestration tests ported 1:1 from cc-connect
 * core/engine_subtask_test.go (41 cases). Assertion semantics match the Go
 * stubs exactly; only the syntax changed — sync Go calls that now have async
 * delivery tails get a `settle()` tick before counting platform sends.
 *
 * @module dsh-feishu-bridge/tests-engine-subtask
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { Session } from '../../src/engine/session.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { WorktreeMode } from '../../src/engine/worktree.js'
import type { Agent, Message, Platform, RecentTurnsReader } from '../../src/core/types.js'
import {
  createNoOverwriteAgent,
  createStubAgent,
  createStubCardPlatformFull,
  createStubSpawnerPinPlatform,
  createStubSpawnerPlatform,
  createForkPreparerAgent,
  createWorkDirAgent,
  newStubMessage,
  type RecordedCard,
} from '../stubs/engine-stubs.js'

const execFileP = promisify(execFile)

/** One macrotask tick: flushes the microtask chain behind fire-and-forget sends. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function newSubtaskTestEngine(p: Platform, agent: Agent = createStubAgent()): Engine {
  return new Engine('test', agent, [p], '', 'en')
}

/** Engine whose agent's recent-turn window serves one assistant entry for 'child-agent'. */
function newReplyFallbackEngine(p: Platform, reply: string): Engine {
  const agent: Agent & RecentTurnsReader = {
    ...createStubAgent(),
    recentTurns: async (id: string) => id === 'child-agent'
      ? [{ role: 'assistant', content: reply, timestamp: '2026-01-01T00:00:00Z' }]
      : [],
  }
  return newSubtaskTestEngine(p, agent)
}

function msg(overrides: Partial<Message> = {}): Message {
  return { ...newStubMessage(), replyCtx: 'test-rctx', platform: 'test', userID: 'u1', ...overrides }
}

/** The markdown body of a recorded card (Go card.Elements[0].(CardMarkdown).Content). */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

/** Create a git repo with one commit and return its root (Go initTestRepo). */
async function initTestRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-subtask-repo-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  const run = (...args: string[]): Promise<string> =>
    execFileP('git', args, { cwd: root, env }).then(r => r.stdout)
  await run('init', '-b', 'main')
  await writeFile(join(root, 'README.md'), 'hello\n')
  await run('add', 'README.md')
  await run('commit', '-m', 'init')
  return root
}

describe('replyToParent', () => {
  it('delivers and wakes the parent', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'
    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setName('child task')
    child.setParentSessionKey(parentKey)

    expect(e.replyToParent(p, child, 'all done: 3 files changed')).toBe(true)

    // The result must be shown as a card in the parent chat.
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('all done')
  })

  it('returns false with no parent', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const orphan = e.sessions.getOrCreateActive('test:orphan-chat')
    expect(e.replyToParent(p, orphan, 'result')).toBe(false)
    expect(p.sentCards.length).toBe(0)
  })
})

describe('ReportSubtask', () => {
  it('falls back to the last reply', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newReplyFallbackEngine(p, 'fallback summary')

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setAgentSessionID('child-agent', 'stub')

    await expect(e.reportSubtask(childKey, '')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('fallback summary')
  })

  it('prefers the clean result over the narration blob', async () => {
    const p = createStubCardPlatformFull('test')
    // The window holds the full per-turn narration blob; lastResult holds
    // the clean SDK final result.
    const e = newReplyFallbackEngine(p, '我来使用... Now let me invoke... Let me search...')

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setAgentSessionID('child-agent', 'stub')
    child.setLastResult('回测完成：2026-06-05 触发 2 个实例')

    await expect(e.reportSubtask(childKey, '')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
    const body = cardBody(p.sentCards[0])
    expect(body).toContain('回测完成')
    expect(body).not.toContain('Let me search')
  })

  it('errors with no result and no history', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')

    await expect(e.reportSubtask(childKey, '')).rejects.toThrow('no result to report')
  })

  it('sets the reported flag', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setSubtaskDepth(1)

    await expect(e.reportSubtask(childKey, 'explicit result')).resolves.toBeUndefined()
    expect(child.getSubtaskReported()).toBe(true)
    await settle()
    expect(p.sentCards.length).toBe(1)
  })

  it('is idempotent after a first report', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setSubtaskDepth(1)

    // First report delivers exactly one card to the parent.
    await expect(e.reportSubtask(childKey, 'explicit result')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)

    // A model re-calling report must not re-inject: no duplicate card, no
    // error (idempotent).
    await expect(e.reportSubtask(childKey, 'explicit result again')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
  })

  it('no-report child is a no-op', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setSubtaskDepth(1)
    child.setSubtaskNoReport(true)

    await expect(e.reportSubtask(childKey, 'diagram sent')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(0)
    expect(child.getSubtaskReported()).toBe(false)
  })

  it('still delivers after suppress (silent-swallow regression)', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const childKey = 'test:child-chat'
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey('test:parent-chat:user-1')
    child.setSubtaskDepth(1)
    child.setSubtaskReported(false)

    // User stops the subtask group's first turn.
    e.suppressSubtaskAutoReport(childKey)
    expect(child.getSubtaskAutoReportSuppressed()).toBe(true)
    expect(child.getSubtaskReported()).toBe(false)

    // An explicit report after the stop must still deliver to the parent.
    await expect(e.reportSubtask(childKey, 'explicit result after stop')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(child.getSubtaskReported()).toBe(true)
  })
})

describe('lastResultOrReply', () => {
  it('prefers the clean result and falls back to the last assistant window entry', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newReplyFallbackEngine(p, 'narration blob with tool chatter')
    const sessionKey = 'test:child-chat'
    const s = e.sessions.getOrCreateActive(sessionKey)
    s.setAgentSessionID('child-agent', 'stub')

    // With no LastResult set, falls back to the window's last assistant entry.
    expect(await e.lastResultOrReply(sessionKey, s)).toBe('narration blob with tool chatter')

    // Once LastResult is set, it takes precedence.
    s.setLastResult('clean final summary')
    expect(await e.lastResultOrReply(sessionKey, s)).toBe('clean final summary')
  })
})

describe('subtaskDiffElements', () => {
  it('depth 0 returns nothing', async () => {
    const root = await initTestRepo()
    await writeFile(join(root, 'README.md'), 'changed\n')
    const e = newSubtaskTestEngine(createStubSpawnerPlatform())
    const s = new Session() // depth 0 = ordinary chat
    expect(await e.subtaskDiffElements(s, root)).toEqual([])
  })

  it('subtask with changes gets one element', async () => {
    const root = await initTestRepo()
    await writeFile(join(root, 'README.md'), 'hello\nworld\n')
    const e = newSubtaskTestEngine(createStubSpawnerPlatform())
    const s = new Session()
    s.setSubtaskDepth(1)
    const els = await e.subtaskDiffElements(s, root)
    expect(els.length).toBe(1)
    expect(els[0]?.content).toContain('insertion')
  })

  it('clean subtask returns nothing', async () => {
    const root = await initTestRepo()
    const e = newSubtaskTestEngine(createStubSpawnerPlatform())
    const s = new Session()
    s.setSubtaskDepth(1)
    expect(await e.subtaskDiffElements(s, root)).toEqual([])
  })
})

describe('SpawnSubtask', () => {
  it('enforces the depth limit', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setSubtaskDepth(e.maxSubtaskDepth()) // child would exceed the cap

    await expect(
      e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'too deep', [], false),
    ).rejects.toThrow()
    expect(p.spawnCount).toBe(0)
  })

  it('records parent and depth', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'

    const { childName, childKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'do the thing', [], false)
    expect(p.spawnCount).toBe(1)
    expect(childName).toBe('do the thing')

    const child = e.sessions.getOrCreateActive(childKey)
    expect(child.getParentSessionKey()).toBe(parentKey)
    expect(child.getSubtaskDepth()).toBe(1)
    expect(child.getSpawnUserID()).toBe('user-1')
  })

  it('records the attended flag', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'

    // Attended spawn marks the child so it keeps the configured permission
    // mode instead of auto-elevating to bypassPermissions.
    const { childKey: attendedKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'attended task', [], true)
    expect(e.sessions.getOrCreateActive(attendedKey).getSubtaskAttended()).toBe(true)

    // Unattended spawn leaves the flag off.
    const { childKey: autoKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'auto task', [], false)
    expect(e.sessions.getOrCreateActive(autoKey).getSubtaskAttended()).toBe(false)
  })

  it('starts the child session in the --dir override (workdir switcher)', async () => {
    const p = createStubSpawnerPlatform()
    // A WorkDirSwitcher agent records the dir it was switched to when the
    // spawn-driven session start fires (Go applyWorkDirOverride semantics).
    const agent = createWorkDirAgent('/base/dir')
    const startedDirs: string[] = []
    const baseStart = agent.startSession.bind(agent)
    agent.startSession = async (id: string) => {
      startedDirs.push(agent.getWorkDir())
      return baseStart(id)
    }
    const e = newSubtaskTestEngine(p, agent)
    // The dir override lives in the project state store; without it the
    // engine has nothing to switch to.
    const store = new ProjectStateStore(join(tmpdir(), `fb-spawn-state-${Date.now()}.json`))
    e.setProjectStateStore(store)

    const parentKey = 'test:parent-chat:user-1'
    const dir = await mkdtemp(join(tmpdir(), 'fb-spawn-dir-'))
    await e.spawnSubtask(parentKey, dir, WorktreeMode.ForceOff, false, 'work in dir', [], false)
    await settle()

    expect(startedDirs).toContain(dir)
    // The override is temporary: the shared agent returns to its base dir.
    expect(agent.getWorkDir()).toBe('/base/dir')
  })

  it('seeds the fork sentinel', async () => {
    const p = createStubSpawnerPlatform()
    // Use the no-overwrite stub so the fork sentinel is not clobbered by the
    // async ReceiveMessage-driven session start before we read it.
    const e = newSubtaskTestEngine(p, createNoOverwriteAgent())

    const parentKey = 'test:parent-chat:user-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setAgentSessionID('real-parent-uuid', e.agent.name())

    const { childKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, true, 'continue from context', [], false)

    const child = e.sessions.getOrCreateActive(childKey)
    expect(child.getAgentSessionID()).toBe('__fork__real-parent-uuid')
  })

  it('fails without parent context for --fork', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'
    // Parent has no started conversation → fork must fail.
    await expect(
      e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, true, 'nothing to fork', [], false),
    ).rejects.toThrow()
    expect(p.spawnCount).toBe(0)
  })

  it('uses the stored user ID for a 2-segment key', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:shared-chat' // 2-segment, no userID
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setSpawnUserID('ou_captured')

    const { childKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'do it', [], false)
    expect(p.lastUserID).toBe('ou_captured')
    expect(e.sessions.getOrCreateActive(childKey).getSpawnUserID()).toBe('ou_captured')
  })

  it('does not misread a thread key as the user', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:chat-x:thread:tid-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setSpawnUserID('ou_real')

    await expect(e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'do it', [], false)).resolves.toBeDefined()
    expect(p.lastUserID).toBe('ou_real')
  })

  it('marks the first message IsSpawnedGroup (missing-pin regression)', async () => {
    const p = createStubSpawnerPinPlatform()
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'
    await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, 'do the thing', [], false)
    await e.stop()

    expect(p.returnedMsg).toBeDefined()
    expect(p.returnedMsg?.isSpawnedGroup).toBe(true)
  })

  it('fails fast when the fork source is unreachable', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'fb-fork-parent-'))
    const childDir = await mkdtemp(join(tmpdir(), 'fb-fork-child-'))

    const p = createStubSpawnerPlatform()
    const agent = createForkPreparerAgent(parentDir, new Error('fork source not found'))
    const e = new Engine('test', agent, [p], '', 'en')

    const parentKey = 'test:parent-chat:user-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setAgentSessionID('real-parent-uuid', agent.name())

    await expect(
      e.spawnSubtask(parentKey, childDir, WorktreeMode.ForceOff, true, 'continue from context', [], false),
    ).rejects.toThrow(/fork/)
    expect(p.spawnCount).toBe(0)
    expect(agent.prepared).toBe(true)
    expect(agent.gotOrigID).toBe('real-parent-uuid')
    // The guard checks source existence only — TS resolves fork sources
    // globally by id, so no workDir locality is passed through.
    expect(agent.gotParentWorkDir).toBe('')
    expect(agent.gotChildWorkDir).toBe('')
    await e.stop()
  })

  it('passes a same-workdir fork', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-fork-same-'))

    const p = createStubSpawnerPlatform()
    const agent = createForkPreparerAgent(dir, undefined) // reachable
    const e = new Engine('test', agent, [p], '', 'en')

    const parentKey = 'test:parent-chat:user-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setAgentSessionID('real-parent-uuid', agent.name())

    await expect(
      e.spawnSubtask(parentKey, dir, WorktreeMode.ForceOff, true, 'continue from context', [], false),
    ).resolves.toBeDefined()
    expect(p.spawnCount).toBe(1)
    await e.stop()
  })

  it('skips the reachability check for non-preparer agents', async () => {
    const p = createStubSpawnerPlatform()
    // stubAgent implements neither WorkDirSwitcher nor ForkSessionPreparer.
    const e = newSubtaskTestEngine(p)

    const parentKey = 'test:parent-chat:user-1'
    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setAgentSessionID('real-parent-uuid', e.agent.name())

    // --fork with a non-preparer agent: no panic, no check, group created.
    await expect(
      e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, true, 'continue from context', [], false),
    ).resolves.toBeDefined()
    expect(p.spawnCount).toBe(1)
    await e.stop()
  })

  it('idle spawn creates group+session without a first turn', async () => {
    const parentKey = 'test:parent-chat:user-1'

    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const { childName, childKey } = await e.spawnSubtask(parentKey, '', WorktreeMode.ForceOff, false, '', [], false)
    expect(childKey).not.toBe('')
    expect(childName).not.toBe('')
    // SpawnGroup called with empty firstMsg — no standby message posted.
    expect(p.lastFirst).toBe('')
    // Child session record exists with correct linkage + unattended.
    const child = e.sessions.getOrCreateActive(childKey)
    expect(child.getParentSessionKey()).toBe(parentKey)
    expect(child.getSubtaskDepth()).toBe(1)
    expect(child.getSubtaskAttended()).toBe(false)
    // No first turn: agent never started.
    expect(child.getAgentSessionID()).toBe('')
    await e.stop()
  })

  it('rejects worktree with idle spawn', async () => {
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    await expect(
      e.spawnSubtask(parentKey, '', WorktreeMode.ForceOn, false, '', [], false),
    ).rejects.toThrow()
  })

  it('does not mark research dispatch during pre-spawn', async () => {
    // afterChatroomStarted pre-spawns assistants BEFORE any gather arms
    // ResearchAwaitingAssistant — the awaiting gate must keep that spawn from
    // tripping the flag.
    const hubKey = 'test:hub-chat:user-1'
    const parentKey = 'test:role-chat:user-1'
    const p = createStubSpawnerPlatform()
    const e = newSubtaskTestEngine(p)

    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setChatroomHubKey(hubKey)
    // awaiting stays false (pre-spawn happens before the first gather)

    await expect(
      e.spawnSubtask(parentKey, await mkdtemp(join(tmpdir(), 'fb-prespawn-')), WorktreeMode.ForceOff, false, '', [], false),
    ).resolves.toBeDefined()
    expect(parent.getResearchDispatched()).toBe(false)
  })
})

describe('reportSubtaskTimeout', () => {
  it('skips a monitor parent', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    e.monitor.enabled = true
    e.monitor.setChats('oc_monitor')

    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setParentSessionKey('test:oc_monitor:user-1')
    child.setSubtaskDepth(1)
    child.setSubtaskReported(false)

    e.reportSubtaskTimeout('test:child-chat')
    await settle()

    expect(p.sentCards.length).toBe(0)
    expect(child.getSubtaskReported()).toBe(false)
  })

  it('reports to a normal parent', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setParentSessionKey('test:oc_parent:user-1')
    child.setSubtaskDepth(1)
    child.setSubtaskReported(false)

    e.reportSubtaskTimeout('test:child-chat')
    await settle()

    expect(p.sentCards.length).toBe(1)
    expect(child.getSubtaskReported()).toBe(true)
  })
})

describe('maybeAutoReportSubtask', () => {
  function newChild(e: Engine, depth: number, reported: boolean): Session {
    const s = e.sessions.getOrCreateActive('test:child-chat')
    s.setParentSessionKey('test:parent-chat:user-1')
    s.setSubtaskDepth(depth)
    s.setSubtaskReported(reported)
    return s
  }

  it('fires on first turn', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = newChild(e, 1, false)
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, s, 'the result', false)
    await settle()
    expect(s.getSubtaskReported()).toBe(true)
    expect(p.sentCards.length).toBe(1)
  })

  it('skips when already reported', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = newChild(e, 1, true)
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, s, 'the result', false)
    await settle()
    expect(p.sentCards.length).toBe(0)
  })

  it('skips a silent turn', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = newChild(e, 1, false)
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, s, 'the result', true)
    expect(p.sentCards.length).toBe(0)
    expect(s.getSubtaskReported()).toBe(false)
  })

  it('skips a non-subtask session', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = newChild(e, 0, false) // depth 0 = not a subtask
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, s, 'the result', false)
    await settle()
    expect(p.sentCards.length).toBe(0)
  })
})

describe('suppressSubtaskAutoReport', () => {
  it('disarms auto-report for a subtask session', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = e.sessions.getOrCreateActive('test:child-chat')
    s.setParentSessionKey('test:parent-chat:user-1')
    s.setSubtaskDepth(1)
    s.setSubtaskReported(false)

    e.suppressSubtaskAutoReport('test:child-chat')
    expect(s.getSubtaskAutoReportSuppressed()).toBe(true)

    // A later (user-driven) turn must not auto-report.
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, s, 'user-driven result', false)
    await settle()
    expect(p.sentCards.length).toBe(0)
  })

  it('leaves a non-subtask session untouched', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const s = e.sessions.getOrCreateActive('test:child-chat')
    s.setSubtaskDepth(0) // depth 0 = ordinary /spawn group
    s.setSubtaskReported(false)

    e.suppressSubtaskAutoReport('test:child-chat')
    expect(s.getSubtaskAutoReportSuppressed()).toBe(false)
  })
})

describe('SendToSubtask', () => {
  const parentKey = 'test:parent-chat:user-1'
  const childKey = 'test:child-chat'

  it('re-arms a reported child and accepts the follow-up', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // already reported once

    await expect(e.sendToSubtask(parentKey, childKey, 'paste the full report')).resolves.toBeUndefined()
    expect(child.getSubtaskReported()).toBe(false)
    // The follow-up must be posted as a visible card in the child group.
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('paste the full report')
  })

  it('rejects a group that is not the caller\'s child', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const other = e.sessions.getOrCreateActive('test:someone-elses-chat')
    other.setParentSessionKey('test:different-parent:user-9')

    await expect(e.sendToSubtask(parentKey, 'test:someone-elses-chat', 'hi')).rejects.toThrow()
  })

  it('requires a non-empty message', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)

    await expect(e.sendToSubtask(parentKey, childKey, '   ')).rejects.toThrow()
  })

  it('marks research dispatched on a successful send', async () => {
    const hubKey = 'test:hub-chat:user-1'
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const parent = e.sessions.getOrCreateActive(parentKey)
    parent.setChatroomHubKey(hubKey)
    parent.setResearchAwaitingAssistant(true)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)

    // Dispatch turn: a successful send marks the role as dispatched.
    await expect(e.sendToSubtask(parentKey, childKey, 'fetch the data')).resolves.toBeUndefined()
    expect(parent.getResearchDispatched()).toBe(true)

    // Outside the dispatch turn (awaiting cleared): no marking. Use a fresh
    // child — the first send's injected message started the old child's
    // turn (busy).
    parent.setResearchDispatched(false)
    parent.setResearchAwaitingAssistant(false)
    const child2 = e.sessions.getOrCreateActive('test:child-chat-2')
    child2.setParentSessionKey(parentKey)
    child2.setSubtaskDepth(1)
    await expect(e.sendToSubtask(parentKey, 'test:child-chat-2', 'one more dataset')).resolves.toBeUndefined()
    expect(parent.getResearchDispatched()).toBe(false)
  })

  it('rejects a busy child', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // a prior turn already reported

    // Simulate the assistant mid-turn (busy).
    expect(child.tryLock()).toBe(true)

    await expect(e.sendToSubtask(parentKey, childKey, 'follow-up while busy')).rejects.toThrow()
    // Must NOT re-arm: the in-flight turn's auto-report still owns the flag.
    expect(child.getSubtaskReported()).toBe(true)
    // No follow-up card posted to the busy child group.
    await settle()
    expect(p.sentCards.length).toBe(0)

    child.unlock()
  })
})

describe('collectSubtree', () => {
  it('returns the whole descendant tree, deepest-first', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    // Build: root → A, B ; A → A1 ; A1 → A1a
    const mk = (key: string, parent: string): void => {
      const s = e.sessions.getOrCreateActive(key)
      if (parent !== '') s.setParentSessionKey(parent)
    }
    mk('test:root', '')
    mk('test:A', 'test:root')
    mk('test:B', 'test:root')
    mk('test:A1', 'test:A')
    mk('test:A1a', 'test:A1')
    mk('test:unrelated', 'test:other') // not under root

    const got = e.collectSubtree('test:root')

    // Must contain exactly the 4 descendants, not root, not unrelated.
    expect([...got].sort()).toEqual(['test:A', 'test:A1', 'test:A1a', 'test:B'].sort())

    // Deepest-first: A1a before A1, A1 before A.
    const pos = new Map(got.map((k, i) => [k, i]))
    expect((pos.get('test:A1a') ?? 99)).toBeLessThan(pos.get('test:A1') ?? -1)
    expect((pos.get('test:A1') ?? 99)).toBeLessThan(pos.get('test:A') ?? -1)
  })

  it('tolerates a parent cycle without looping', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const a = e.sessions.getOrCreateActive('test:cyc-a')
    const b = e.sessions.getOrCreateActive('test:cyc-b')
    a.setParentSessionKey('test:cyc-b')
    b.setParentSessionKey('test:cyc-a') // cycle

    const got = e.collectSubtree('test:cyc-a')
    // b is a child of a; a is a child of b but already visited → bounded.
    expect(got.length).toBeLessThanOrEqual(2)
  })
})

describe('rearmSubtaskReportOnHumanTurn', () => {
  const parentKey = 'test:parent-chat:user-1'
  const childKey = 'test:child-chat'

  it('resets on a real human message', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // stale flag from a prior report cycle

    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: childKey, userID: 'u1', userName: 'human' }), child, e.sessions)

    expect(child.getSubtaskReported()).toBe(false)
  })

  it('skips synthetic injections (empty userID)', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true)

    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: childKey, userID: '', userName: '[父任务追问]' }), child, e.sessions)

    expect(child.getSubtaskReported()).toBe(true)
  })

  it('skips non-subtask and already-unreported', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const depth0 = e.sessions.getOrCreateActive('test:depth0')
    depth0.setSubtaskDepth(0)
    depth0.setSubtaskReported(true)
    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: 'test:depth0', userID: 'u1' }), depth0, e.sessions)
    expect(depth0.getSubtaskReported()).toBe(true)

    const unreported = e.sessions.getOrCreateActive('test:unreported')
    unreported.setSubtaskDepth(1)
    unreported.setSubtaskReported(false)
    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: 'test:unreported', userID: 'u1' }), unreported, e.sessions)
    expect(unreported.getSubtaskReported()).toBe(false)
  })

  it('delivers instead of skipping after a re-arm', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // stale flag from prior cycle

    // Human resumes the subtask group → re-arm.
    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: childKey, userID: 'u1' }), child, e.sessions)

    // Agent reports its new result — must deliver, not skip.
    await expect(e.reportSubtask(childKey, 'new result')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
  })

  it('keeps within-turn dedup after a re-arm', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true)

    e.rearmSubtaskReportOnHumanTurn(msg({ sessionKey: childKey, userID: 'u1' }), child, e.sessions)
    expect(child.getSubtaskReported()).toBe(false)

    // Explicit report mid-turn delivers and re-sets the flag.
    await expect(e.reportSubtask(childKey, 'result')).resolves.toBeUndefined()
    await settle()
    const delivered = p.sentCards.length

    // Turn-end auto-report must be deduped (flag now true again).
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, child, 'result', false)
    await settle()
    expect(p.sentCards.length - delivered).toBe(0)
  })
})

describe('rearmSubtaskReportOnDrain', () => {
  const parentKey = 'test:parent-chat:user-1'
  const childKey = 'test:child-chat'

  it('re-arms a reported subtask child', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // consumed by the busy turn's auto-report

    e.rearmSubtaskReportOnDrain(child, e.sessions)

    expect(child.getSubtaskReported()).toBe(false)
  })

  it('skips non-subtask and already-unreported', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const depth0 = e.sessions.getOrCreateActive('test:depth0')
    depth0.setSubtaskDepth(0)
    depth0.setSubtaskReported(true)
    e.rearmSubtaskReportOnDrain(depth0, e.sessions)
    expect(depth0.getSubtaskReported()).toBe(true)

    const unreported = e.sessions.getOrCreateActive('test:unreported')
    unreported.setSubtaskDepth(1)
    unreported.setSubtaskReported(false)
    e.rearmSubtaskReportOnDrain(unreported, e.sessions)
    expect(unreported.getSubtaskReported()).toBe(false)
  })

  it('fires the drained turn\'s auto-report after a re-arm', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    child.setSubtaskReported(true) // busy turn consumed the re-arm

    // Queued follow-up is drained → re-arm.
    e.rearmSubtaskReportOnDrain(child, e.sessions)
    expect(child.getSubtaskReported()).toBe(false)

    // The drained follow-up turn ends → auto-report must now fire.
    const st = new InteractiveState()
    st.platform = p
    e.maybeAutoReportSubtask(st, child, 'follow-up answer', false)
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(child.getSubtaskReported()).toBe(true)
  })
})

describe('markUserInterjectedOnHumanTurn', () => {
  const roleKey = 'test:role-chat'
  const childKey = 'test:child-chat'

  it('flips on a human message into a subtask group', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setSubtaskDepth(1)

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: childKey, userID: 'u1', userName: 'human' }), child, e.sessions)

    expect(child.getUserInterjected()).toBe(true)
  })

  it('flips on a human message into a chatroom role', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const role = e.sessions.getOrCreateActive(roleKey)
    role.setChatroomHubKey('test:hub:user-1')

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: roleKey, userID: 'u1', userName: 'human' }), role, e.sessions)

    expect(role.getUserInterjected()).toBe(true)
  })

  it('skips synthetic injections (empty userID)', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setSubtaskDepth(1)

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: childKey, userID: '', userName: '[父任务追问]' }), child, e.sessions)

    expect(child.getUserInterjected()).toBe(false)
  })

  it('skips the spawn first synthetic (IsSpawnedGroup)', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setSubtaskDepth(1)

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: childKey, userID: 'u1', isSpawnedGroup: true }), child, e.sessions)

    expect(child.getUserInterjected()).toBe(false)
  })

  it('skips a non-background session', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const top = e.sessions.getOrCreateActive('test:top-level')

    e.markUserInterjectedOnHumanTurn(msg({ sessionKey: 'test:top-level', userID: 'u1' }), top, e.sessions)

    expect(top.getUserInterjected()).toBe(false)
  })

  it('is idempotent on repeat', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setSubtaskDepth(1)

    const m = msg({ sessionKey: childKey, userID: 'u1' })
    e.markUserInterjectedOnHumanTurn(m, child, e.sessions)
    e.markUserInterjectedOnHumanTurn(m, child, e.sessions)

    expect(child.getUserInterjected()).toBe(true)
  })
})

describe('buildSessionEnv', () => {
  it('injects the research assistant key + scrub-safe alias', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const hubKey = 'test:hub-chat:user-1'
    const roleKey = 'test:role-chat:user-1'
    const hub = e.sessions.getOrCreateActive(hubKey)
    hub.setChatroomResearch(true)

    const role = e.sessions.getOrCreateActive(roleKey)
    role.setChatroomHubKey(hubKey)
    role.setResearchAssistantKey('test:assistant-chat')

    const env = e.buildSessionEnv(roleKey, role)
    // The CHILD alias is what role prompts reference: dsh's credential-shaped
    // env scrub strips any *KEY* name from Bash-tool children.
    expect(env).toContain('CC_RESEARCH_ASSISTANT_KEY=test:assistant-chat')
    expect(env).toContain('CC_RESEARCH_ASSISTANT_CHILD=test:assistant-chat')
  })

  it('injects CC_RESEARCH_ASSISTANT only for research assistants', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'test:assistant-chat'
    const sess = e.sessions.getOrCreateActive(key)
    sess.setResearchAssistant(true)

    expect(e.buildSessionEnv(key, sess)).toContain('CC_RESEARCH_ASSISTANT=1')

    sess.setResearchAssistant(false)
    expect(e.buildSessionEnv(key, sess)).not.toContain('CC_RESEARCH_ASSISTANT=1')
  })

  it('injects the CC_SESSION alias alongside CC_SESSION_KEY', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'feishu:oc_alias-chat'
    e.sessions.getOrCreateActive(key)

    const env = e.buildSessionEnv(key, e.sessions.getOrCreateActive(key))
    expect(env).toContain(`CC_SESSION_KEY=${key}`)
    expect(env).toContain(`CC_SESSION=${key}`)
  })
})
