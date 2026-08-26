/**
 * Subtask orchestration tests ported 1:1 from cc-connect
 * core/engine_subtask_test.go (41 cases). Assertion semantics match the Go
 * stubs exactly; only the syntax changed — sync Go calls that now have async
 * delivery tails get a `settle()` tick before counting platform sends.
 *
 * @module dsh-feishu-bridge/tests-engine-subtask
 */

import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { Session } from '../../src/engine/session.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import { WorktreeMode } from '../../src/engine/worktree.js'
import type { Agent, ContinuableChildStart, ContinuableDelegator, Message, Platform, ProgressContent, RecentTurnsReader, TextPreviewContent } from '../../src/core/types.js'
import { SubtaskGather } from '../../src/engine/subtask.js'
import {
  createNoOverwriteAgent,
  createStubAgent,
  createStubCardPlatformFull,
  createStubSpawnerPinPlatform,
  createStubSpawnerPlatform,
  createForkPreparerAgent,
  createWorkDirAgent,
  newControllableSession,
  newQueuingSession,
  newStubMessage,
  type ControllableAgentSession,
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

  it('rejects an unknown child key loudly and mints no phantom session', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const before = e.sessions.allSessions().length

    // A model-transcribed key that dropped characters must fail with the
    // mistyped-key error (2026-08-25 oc_ac5db incident), not create a
    // parentless session whose empty link then misreports as "not your child".
    await expect(e.sendToSubtask(parentKey, 'test:child-cht', 'hi'))
      .rejects.toThrow('no subtask session test:child-cht')
    expect(e.sessions.allSessions().length).toBe(before)
  })

  it('resolves the "assistant" sentinel to the caller\'s pre-provisioned research assistant', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    const child = e.sessions.getOrCreateActive(childKey)
    child.setParentSessionKey(parentKey)
    child.setSubtaskDepth(1)
    e.sessions.getOrCreateActive(parentKey).setResearchAssistantKey(childKey)

    await expect(e.sendToSubtask(parentKey, 'assistant', 'research task')).resolves.toBeUndefined()
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('research task')
  })

  it('tells an unprovisioned caller to spawn an assistant first', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    await expect(e.sendToSubtask(parentKey, 'assistant', 'task'))
      .rejects.toThrow('no pre-provisioned assistant')
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

describe('buildSessionStartOptions', () => {
  it('injects the research assistant contract only for research assistants', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'test:assistant-chat'
    const sess = e.sessions.getOrCreateActive(key)
    sess.setSubtaskDepth(1)
    sess.setResearchAssistant(true)

    expect(e.buildSessionStartOptions(key, sess).subtask?.researchAssistant).toBe(true)

    sess.setResearchAssistant(false)
    expect(e.buildSessionStartOptions(key, sess).subtask?.researchAssistant).toBe(false)
  })

  it('binds the session key into the start options', () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)

    const key = 'feishu:oc_alias-chat'
    e.sessions.getOrCreateActive(key)

    const options = e.buildSessionStartOptions(key, e.sessions.getOrCreateActive(key))
    expect(options.sessionKey).toBe(key)
  })
})

// ── native continuable children (de-baggage B4) ───────────────────────────

/** Stub agent implementing the ContinuableDelegator seam, recording every call. */
function createDelegatorAgent(): Agent & ContinuableDelegator & {
  started: ContinuableChildStart[]
  followups: Array<{ parent: string; child: string; message: string }>
  interrupts: string[]
  reports: Array<{ child: string; content: string }>
  nextChildId: string
} {
  const agent = {
    ...createStubAgent(),
    started: [] as ContinuableChildStart[],
    followups: [] as Array<{ parent: string; child: string; message: string }>,
    interrupts: [] as string[],
    reports: [] as Array<{ child: string; content: string }>,
    nextChildId: 'native-child-1',
    async startContinuableChild(request: ContinuableChildStart): Promise<{ childId: string; label: string }> {
      agent.started.push(request)
      return { childId: agent.nextChildId, label: request.prompt.split('\n')[0] ?? '' }
    },
    async followupChild(parent: string, child: string, message: string): Promise<void> {
      agent.followups.push({ parent, child, message })
    },
    interruptChild(_parent: string, child: string): void {
      agent.interrupts.push(child)
    },
    async reportChildToNativeParent(child: string, content: string): Promise<void> {
      agent.reports.push({ child, content })
    },
  }
  return agent
}

/** Engine with a live parent agent session on parentKey and a delegator agent. */
function newNativeEngine(p: Platform, parentKey: string): {
  e: Engine
  agent: ReturnType<typeof createDelegatorAgent>
} {
  const agent = createDelegatorAgent()
  const e = newSubtaskTestEngine(p, agent)
  e.setProjectStateStore(new ProjectStateStore(''))
  // A parent chat that spawned a native child always holds a session
  // record — deliverParentReply's non-creating lookup relies on it.
  e.sessions.getOrCreateActive(parentKey)
  const state = new InteractiveState()
  state.agentSession = newControllableSession('parent-native-1')
  state.platform = p
  state.replyCtx = 'parent-rctx'
  e.interactiveStates.set(parentKey, state)
  return { e, agent }
}

describe('spawnSubtaskNative', () => {
  it('routes through the delegator and records parentage in the project state', async () => {
    const p = createStubCardPlatformFull('test')
    const parentKey = 'test:parent-chat:u1'
    const { e, agent } = newNativeEngine(p, parentKey)

    const { childName, childKey } = await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'render the summary')

    expect(childKey).toBe('native-child-1')
    expect(childName).toBe('render the summary')
    expect(agent.started).toHaveLength(1)
    expect(agent.started[0]?.provider).toBe('spawn')
    expect(agent.started[0]?.prompt).toBe('render the summary')
    expect(agent.started[0]?.parentAgentSessionID).toBe('parent-native-1')
    const entry = e.nativeChildEntries()['native-child-1']
    expect(entry?.parent_key).toBe(parentKey)
    expect(entry?.parent_agent_session_id).toBe('parent-native-1')
    expect(entry?.label).toBe('render the summary')
    expect(entry?.reported).toBe(false)
  })

  it('routes fork=true through the fork provider and guards on a started parent', async () => {
    const p = createStubCardPlatformFull('test')
    const parentKey = 'test:p:u1'
    const { e, agent } = newNativeEngine(p, parentKey)

    // The parent's bridge session never started a conversation: fork refuses.
    await expect(e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, true, 'brief')).rejects.toThrow('--fork')
    expect(agent.started).toHaveLength(0)

    e.sessions.getOrCreateActive(parentKey).setAgentSessionID('orig-1', 'stub')
    await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, true, 'brief')
    expect(agent.started[0]?.provider).toBe('fork')
  })

  it('fails without a live parent agent session', async () => {
    const p = createStubCardPlatformFull('test')
    const parentKey = 'test:idle-parent:u1'
    const { e } = newNativeEngine(p, parentKey)
    e.interactiveStates.delete(parentKey)

    await expect(e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'brief')).rejects.toThrow('no live agent session')
  })

  it('isolates the child in a worktree and records its coordinates', async () => {
    const root = await initTestRepo()
    // macOS tmpdir symlinks (/var → /private/var): git reports real paths.
    const realRoot = await realpath(root)
    const p = createStubCardPlatformFull('test')
    const parentKey = 'test:wt-parent:u1'
    const { e, agent } = newNativeEngine(p, parentKey)

    await e.spawnSubtaskNative(parentKey, root, WorktreeMode.ForceOn, false, 'repo work')

    const cwd = agent.started[0]?.cwd ?? ''
    expect(cwd).not.toBe(realRoot)
    expect(cwd.startsWith(realRoot)).toBe(true)
    const entry = e.nativeChildEntries()['native-child-1']
    expect(entry?.worktree_path).toBe(cwd)
    expect(entry?.worktree_root).toBe(realRoot)
    expect(entry?.worktree_branch).not.toBe('')
  })
})

describe('reportNativeChild', () => {
  const parentKey = 'test:parent-chat:u1'

  function armedEngine(p: Platform): ReturnType<typeof newNativeEngine> {
    const r = newNativeEngine(p, parentKey)
    r.e.projectState?.setNativeChild('native-child-1', {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: 'render the summary',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: false,
    })
    return r
  }

  it('delivers the result card to the engine parent and is idempotent', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = armedEngine(p)

    await e.reportNativeChild('native-child-1', 'all done')
    await e.reportNativeChild('native-child-1', 'duplicate')

    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('all done')
    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(true)
  })

  it('delivers the card without a wake and mints no phantom when the parent record is gone', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newSubtaskTestEngine(p)
    e.setProjectStateStore(new ProjectStateStore(''))
    e.projectState?.setNativeChild('native-child-1', {
      parent_key: 'test:ghost-parent:u1',
      parent_agent_session_id: '',
      label: 'orphaned work',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: false,
    })
    const before = e.sessions.allSessions().length

    await e.reportNativeChild('native-child-1', 'orphan result')

    await settle()
    // The user-visible card still lands; the parent agent is never woken
    // and no phantom parent session is minted for the dangling key.
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('orphan result')
    expect(e.sessions.allSessions().length).toBe(before)
    expect(e.interactiveStates.get('test:ghost-parent:u1')).toBeUndefined()
    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(true)
  })

  it('falls back to the child window when the message is empty', async () => {
    const p = createStubCardPlatformFull('test')
    const reader: Agent & RecentTurnsReader = {
      ...createStubAgent(),
      recentTurns: async (id: string) => id === 'native-child-1'
        ? [{ role: 'assistant', content: 'window answer', timestamp: '2026-01-01T00:00:00Z' }]
        : [],
    }
    const e = newSubtaskTestEngine(p, reader)
    e.setProjectStateStore(new ProjectStateStore(''))
    e.projectState?.setNativeChild('native-child-1', {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: 'render the summary',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: false,
    })

    await e.reportNativeChild('native-child-1', '')
    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('window answer')
  })

  it('routes to the native parent through the runtime report path', async () => {
    const p = createStubCardPlatformFull('test')
    const { e, agent } = armedEngine(p)
    e.projectState?.setNativeChild('native-parent-1', {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: 'parent native',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: true,
    })
    const withNativeParent = e.nativeChildEntries()['native-child-1']!
    e.projectState?.setNativeChild('native-child-1', { ...withNativeParent, parent_key: 'native-parent-1' })

    await e.reportNativeChild('native-child-1', 'result for native parent')

    expect(agent.reports).toEqual([{ child: 'native-child-1', content: 'result for native parent' }])
    expect(p.sentCards.length).toBe(0)
  })

  it('settleNativeChild delivers once and skips an already-reported child', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = armedEngine(p)

    e.settleNativeChild('native-child-1', 'settled output')
    e.settleNativeChild('native-child-1', 'second epoch output')
    await settle()

    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('settled output')
  })
})

describe('subtaskQuiet', () => {
  const parentKey = 'test:parent-chat:u1'

  function armedQuietEngine(p: Platform, quiet: boolean): {
    e: Engine
    parentSession: ControllableAgentSession
  } {
    const { e, agent } = newNativeEngine(p, parentKey)
    const parentSession = newQueuingSession('parent-native-1')
    e.interactiveStates.get(parentKey)!.agentSession = parentSession
    // Message dispatch starts turns through agent.startSession; route the
    // parent's turns onto the recording session so wake prompts are captured.
    agent.startSession = async () => parentSession
    if (quiet) e.setSubtaskQuiet(true)
    e.projectState?.setNativeChild('native-child-1', {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: 'render the summary',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: false,
    })
    return { e, parentSession }
  }

  /** Poll the parent session's send calls until the wake prompt lands (bounded). */
  async function wakeArrived(s: { sendCalls: string[] }): Promise<boolean> {
    for (let i = 0; i < 100 && !s.sendCalls.some(c => c.includes('[子任务完成]')); i++) {
      await settle()
    }
    return s.sendCalls.some(c => c.includes('[子任务完成]'))
  }

  it('suppresses the native settlement card but still wakes the parent', async () => {
    const p = createStubCardPlatformFull('test')
    const { e, parentSession } = armedQuietEngine(p, true)

    await e.reportNativeChild('native-child-1', 'all done')

    const arrived = await wakeArrived(parentSession)
    expect(arrived).toBe(true)
    expect(parentSession.sendCalls.some(c => c.includes('all done'))).toBe(true)
    expect(p.sentCards.length).toBe(0)
    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(true)
  })

  it('keeps group-path replyToParent cards intact', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = armedQuietEngine(p, true)

    const child = e.sessions.getOrCreateActive('test:child-chat')
    child.setName('child task')
    child.setParentSessionKey(parentKey)

    expect(e.replyToParent(p, child, 'attended result')).toBe(true)

    await settle()
    expect(p.sentCards.length).toBe(1)
    expect(cardBody(p.sentCards[0])).toContain('attended result')
  })

  it('gathers silently: no cards, one combined wake', async () => {
    const p = createStubCardPlatformFull('test')
    const { e, parentSession } = armedQuietEngine(p, true)
    e.projectState?.setNativeChild('native-child-2', {
      parent_key: parentKey,
      parent_agent_session_id: 'parent-native-1',
      label: 'task two',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
      reported: false,
    })

    e.gatherSubtasks(parentKey)
    await e.reportNativeChild('native-child-1', 'first result')
    await e.reportNativeChild('native-child-2', 'second result')

    for (let i = 0; i < 100 && e.sessions.getOrCreateActive(parentKey).getPendingSubtaskGather() !== undefined; i++) {
      await settle()
    }
    expect(e.sessions.getOrCreateActive(parentKey).getPendingSubtaskGather()).toBeUndefined()
    for (let i = 0; i < 100 && !parentSession.sendCalls.some(c => c.includes('[子任务汇总]')); i++) {
      await settle()
    }
    expect(p.sentCards.length).toBe(0)
    expect(parentSession.sendCalls.some(c => c.includes('first result') && c.includes('second result'))).toBe(true)
  })
})

describe('SendToSubtask native children', () => {
  const parentKey = 'test:parent-chat:u1'

  it('queues through the delegator and re-arms the settlement fallback', async () => {
    const p = createStubCardPlatformFull('test')
    const { e, agent } = newNativeEngine(p, parentKey)
    await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'brief')
    const entry = e.nativeChildEntries()['native-child-1']!
    e.projectState?.setNativeChild('native-child-1', { ...entry, reported: true })

    await e.sendToSubtask(parentKey, 'native-child-1', 'show the full report')

    expect(agent.followups).toEqual([{ parent: 'parent-native-1', child: 'native-child-1', message: 'show the full report' }])
    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(false)
  })

  it('rejects a caller that is not the child parent', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = newNativeEngine(p, parentKey)
    await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'brief')

    await expect(e.sendToSubtask('test:other-chat:u1', 'native-child-1', 'hi')).rejects.toThrow()
  })

  it('interruptNativeChild routes through the delegator', async () => {
    const p = createStubCardPlatformFull('test')
    const { e, agent } = newNativeEngine(p, parentKey)
    await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'brief')

    e.interruptNativeChild('native-child-1')
    expect(agent.interrupts).toEqual(['native-child-1'])
  })
})

describe('gather with native children', () => {
  const parentKey = 'test:parent-chat:u1'

  it('banks native reports and wakes once with a combined summary', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = newNativeEngine(p, parentKey)
    for (const id of ['native-child-1', 'native-child-2']) {
      e.projectState?.setNativeChild(id, {
        parent_key: parentKey,
        parent_agent_session_id: 'parent-native-1',
        label: `task ${id}`,
        worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
        reported: false,
      })
    }

    e.gatherSubtasks(parentKey)
    const parent = e.sessions.getOrCreateActive(parentKey)
    expect(parent.getPendingSubtaskGather()?.expected.size).toBe(2)

    await e.reportNativeChild('native-child-1', 'first result')
    await settle()
    expect(parent.getPendingSubtaskGather()).toBeDefined() // banked, not woken

    await e.reportNativeChild('native-child-2', 'second result')
    await settle()
    expect(parent.getPendingSubtaskGather()).toBeUndefined() // barrier fired and cleared
    const bodies = p.sentCards.map(cardBody).join('\n')
    expect(bodies).toContain('first result')
    expect(bodies).toContain('second result')
  })
})

describe('pending native children visibility', () => {
  const parentKey = 'test:parent-chat:u1'

  /** Card platform recording every preview content send/PATCH. */
  function createPreviewRecorderPlatform() {
    const base = createStubCardPlatformFull('test')
    const contents: ProgressContent[] = []
    return Object.assign(base, {
      contents,
      async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
        contents.push(content)
        return 'preview-handle'
      },
      async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
        contents.push(content)
      },
    })
  }

  /** Seed one native child record per reported flag under the parent chat. */
  function armNativeChildren(e: Engine, reported: boolean[]): void {
    reported.forEach((rep, i) => {
      e.projectState?.setNativeChild(`native-child-${i + 1}`, {
        parent_key: parentKey,
        parent_agent_session_id: 'parent-native-1',
        label: `task ${i + 1}`,
        worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
        reported: rep,
      })
    })
  }

  /** Drive one tool-bearing turn to completion through the event pump. */
  async function runTurn(e: Engine, state: InteractiveState, session: Session): Promise<void> {
    const agentSession = state.agentSession as ControllableAgentSession
    agentSession.channel.push({ type: 'tool_use', toolName: 'feishu_bridge_subtask', toolInput: 'spawn', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'tool_result', toolResult: 'spawned', toolID: 'call-1', content: '', done: false })
    agentSession.channel.push({ type: 'result', content: 'dispatched', done: true })
    await e.processInteractiveEvents(state, session, e.sessions, parentKey, 'm1', undefined, state.replyCtx)
  }

  it('settles the card with the pending count in the status and the hint in the body', async () => {
    const p = createPreviewRecorderPlatform()
    const { e } = newNativeEngine(p, parentKey)
    e.setDisplayConfig({ toolProgress: true })
    armNativeChildren(e, [false, false, true])

    const session = e.sessions.getOrCreateActive(parentKey)
    const state = e.interactiveStates.get(parentKey) as InteractiveState
    await runTurn(e, state, session)

    const terminal = [...p.contents].reverse()
      .find(c => c.kind === 'text' && c.status?.state === 'completed') as TextPreviewContent | undefined
    expect(terminal?.status?.pendingSubtasks).toBe(2)
    expect(terminal?.text).toContain('🤖 2 subtask(s) running')
  })

  it('settles without the pending signal when every child reported', async () => {
    const p = createPreviewRecorderPlatform()
    const { e } = newNativeEngine(p, parentKey)
    e.setDisplayConfig({ toolProgress: true })
    armNativeChildren(e, [true, true])

    const session = e.sessions.getOrCreateActive(parentKey)
    const state = e.interactiveStates.get(parentKey) as InteractiveState
    await runTurn(e, state, session)

    const terminal = [...p.contents].reverse()
      .find(c => c.kind === 'text' && c.status?.state === 'completed') as TextPreviewContent | undefined
    expect(terminal?.status?.pendingSubtasks).toBeUndefined()
    expect(terminal?.text).not.toContain('subtask(s) running')
  })

  it('interruptNativeChild settles the record so the pending count drops', async () => {
    const p = createStubCardPlatformFull('test')
    const { e } = newNativeEngine(p, parentKey)
    await e.spawnSubtaskNative(parentKey, '', WorktreeMode.ForceOff, false, 'brief')
    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(false)

    e.interruptNativeChild('native-child-1')

    expect(e.nativeChildEntries()['native-child-1']?.reported).toBe(true)
  })
})

describe('drainNativeDescendants', () => {
  it('interrupts and clears native descendants of the root, keeping records of others', async () => {
    const p = createStubCardPlatformFull('test')
    const parentKey = 'test:parent-chat:u1'
    const { e, agent } = newNativeEngine(p, parentKey)
    e.projectState?.setNativeChild('native-child-1', {
      parent_key: parentKey, parent_agent_session_id: 'parent-native-1', label: 'a',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '', reported: false,
    })
    e.projectState?.setNativeChild('native-grandchild-1', {
      parent_key: 'native-child-1', parent_agent_session_id: 'native-child-1', label: 'g',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '', reported: false,
    })
    e.projectState?.setNativeChild('foreign-child', {
      parent_key: 'test:elsewhere:u1', parent_agent_session_id: 'x', label: 'f',
      worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '', reported: false,
    })

    await e.drainNativeDescendants([parentKey])

    expect(agent.interrupts.sort()).toEqual(['native-child-1', 'native-grandchild-1'])
    expect(e.nativeChildEntries()['native-child-1']).toBeUndefined()
    expect(e.nativeChildEntries()['native-grandchild-1']).toBeUndefined()
    expect(e.nativeChildEntries()['foreign-child']).toBeDefined()
  })
})

describe('SubtaskGather (direct)', () => {
  it('wakes exactly once when every expected child reports', () => {
    const g = new SubtaskGather()
    expect(g.addExpected('a', 'A')).toBe(true)
    expect(g.addExpected('b', 'B')).toBe(true)

    const first = g.accumulate('a', 'A', 'result a')
    expect(first.done).toBe(false)
    const second = g.accumulate('b', 'B', 'result b')
    expect(second.done).toBe(true)
    expect(second.summary).toContain('【A】result a')
    expect(second.summary).toContain('【B】result b')

    // Post-wake reports fall through with alreadyWoken; the timeout is inert.
    const late = g.accumulate('a', 'A', 'late')
    expect(late).toEqual({ done: false, summary: '', alreadyWoken: true })
    expect(g.timeoutFire().done).toBe(false)
  })

  it('records a late child outside the expected set without deferring the wake', () => {
    const g = new SubtaskGather()
    g.addExpected('a', 'A')
    const late = g.accumulate('late-child', 'L', 'late result')
    expect(late.done).toBe(false)
    const done = g.accumulate('a', 'A', 'result a')
    expect(done.done).toBe(true)
    expect(done.summary).toContain('【L】late result')
  })

  it('addExpected after the wake is refused', () => {
    const g = new SubtaskGather()
    g.addExpected('a', 'A')
    g.accumulate('a', 'A', 'done')
    expect(g.addExpected('b', 'B')).toBe(false)
  })

  it('timeoutFire wakes with the partial summary and names the missing children', () => {
    const g = new SubtaskGather()
    g.addExpected('a', 'A')
    g.addExpected('b', 'B')
    g.accumulate('a', 'A', 'result a')
    const fired = g.timeoutFire()
    expect(fired.done).toBe(true)
    expect(fired.summary).toContain('1 个子任务超时未回报')
    expect(fired.summary).toContain('B')
    expect(fired.summary).toContain('result a')
  })

  it('an empty report still counts as reported', () => {
    const g = new SubtaskGather()
    g.addExpected('a', 'A')
    const done = g.accumulate('a', 'A', '')
    expect(done.done).toBe(true)
    expect(done.summary).toContain('（无内容 / NO_REPLY）')
  })
})
