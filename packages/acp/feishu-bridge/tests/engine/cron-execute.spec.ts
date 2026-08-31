/**
 * Cron execution tests ported from cc-connect core/engine_test.go
 * (TestExecuteCronJob_ResolvesCronReplyTarget and
 * TestExecuteCronJob_WorkspacePrefixedSessionKey): a job run resolves the
 * platform's cron reply target, sends the start notice and the agent reply
 * through it, reuses the base session in reuse mode, and leaves the stored
 * session key untouched — including keys carrying a workspace prefix.
 *
 * @module dsh-feishu-bridge/tests-engine-cron-execute
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CronJob, CronScheduler, CronStore } from '../../src/engine/cron.ts'
import { Engine } from '../../src/engine/engine.ts'
import { createStubPlatform, newResultAgentSession, testQuestions } from '../stubs/engine-stubs.ts'
import type { Agent, Platform } from '../../src/core/types.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-cronexec-'))
}

function newJob(overrides: Partial<CronJob> & { id: string }): CronJob {
  const j = new CronJob()
  Object.assign(j, overrides)
  return j
}

/** Go stubCronReplyTargetPlatform: reconstructs ctx and redirects cron runs. */
function createStubCronReplyTargetPlatform(n: string): Platform & {
  resolvedSessionKey: string
  resolveTitle: string
  reconstructReplyCtx(sessionKey: string): Promise<unknown>
  resolveCronReplyTarget(sessionKey: string, title: string): Promise<[string, unknown]>
} {
  const base = createStubPlatform(n)
  const p = {
    ...base,
    resolvedSessionKey: '',
    resolveTitle: '',
    reconstructReplyCtx: async (sessionKey: string) => `reconstructed:${sessionKey}`,
    resolveCronReplyTarget: async (sessionKey: string, title: string): Promise<[string, unknown]> => {
      p.resolvedSessionKey = sessionKey
      p.resolveTitle = title
      return ['discord:thread-fresh', 'fresh-rctx']
    },
  }
  return p
}

function resultAgent(session: ReturnType<typeof newResultAgentSession>): Agent {
  return {
    name: () => 'stub',
    startSession: async () => session,
    listSessions: async () => [],
    stop: async () => {},
  }
}

describe('ExecuteCronJob_TimeoutCancellation', () => {
  it('an aborted signal cancels the running turn', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    const platform = createStubCronReplyTargetPlatform('discord')
    // A session whose send hangs until the interruption rejects it — the
    // real adapter settles send with an error when cancelTurn lands.
    const agentSession = newResultAgentSession('never delivered')
    let rejectSend!: (e: unknown) => void
    agentSession.send = () => new Promise<void>((_resolve, reject) => { rejectSend = reject })
    const cancelCalls: string[] = []
    agentSession.cancelTurn = () => { cancelCalls.push('cancel'); rejectSend(new Error('turn cancelled')) }
    const agent = resultAgent(agentSession)
    const e = new Engine('test', agent, [platform], '', 'en')
    e.cronScheduler = scheduler
    const job = newJob({ id: 'job-t', project: 'test', sessionKey: 'discord:channel-1:user-1', prompt: 'p' })
    store.add(job)

    const controller = new AbortController()
    const running = e.executeCronJob(job, controller.signal)
    await new Promise((r) => { setTimeout(r, 30) })
    controller.abort()
    await new Promise((r) => { setTimeout(r, 30) })

    expect(cancelCalls, 'the hung turn was interrupted through the signal').toEqual(['cancel'])
    await running
  })
})

describe('ExecuteCronJob_AbortSettlesParkedAsk', () => {
  it('an aborted new-per-run run settles a slot-parked ask instead of hanging the turn forever', async () => {
    // The 2026-08-31 cron-fbe6d268 production shape: the run's turn parks on
    // an ask_user_question promise under a `#cron:` slot; the scheduler's
    // timeout abort fired cancelTurn but nothing settled the parked ask, so
    // the turn (and the whole run) hung forever and the agent session leaked
    // live.
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    scheduler.setDefaultSessionMode('new_per_run')
    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('never delivered')
    let settleSend!: () => void
    agentSession.send = () => new Promise<void>((resolve) => { settleSend = resolve })
    agentSession.cancelTurn = () => {}
    const e = new Engine('test', resultAgent(agentSession), [platform], '', 'en')
    e.cronScheduler = scheduler
    const job = newJob({ id: 'job-ask', project: 'test', sessionKey: 'discord:channel-1:user-1', prompt: 'p' })
    store.add(job)

    const controller = new AbortController()
    const running = e.executeCronJob(job, controller.signal)
    await new Promise((r) => { setTimeout(r, 30) })

    // The run parked its state under a #cron: slot; arm the ask on it the
    // way the adapter's ask_user_question tool call would.
    const slot = [...e.interactiveStates.keys()].find(k => k.includes('#cron:'))
    expect(slot, 'the run parked a #cron: slot state').toBeDefined()
    const decision = e.askUser(slot!, { kind: 'questions', questions: testQuestions() })
    await new Promise((r) => { setTimeout(r, 10) })
    // The turn resolves only once the ask settles (the adapter's tool call
    // awaits the ask decision).
    void decision.then(() => { settleSend() })

    controller.abort()
    const outcome = await Promise.race([
      Promise.all([decision, running]).then(() => 'settled'),
      new Promise((r) => { setTimeout(() => { r('hung') }, 500) }),
    ])

    expect(outcome, 'the abort settled the parked ask and finished the run').toBe('settled')
    await expect(decision).resolves.toEqual({ outcome: 'cancelled' })
  })
})

describe('CronScheduler_OverlapGuard', () => {
  it('a job still running from its previous fire is not fired again', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('slow')
    agentSession.send = () => new Promise<void>(() => {})
    // Keep the hung first fire from failing the suite at teardown.
    const settleFirst = () => { agentSession.cancelTurn?.() }
    agentSession.cancelTurn = () => { agentSession.channel.close() }
    const e = new Engine('test', resultAgent(agentSession), [platform], '', 'en')
    e.cronScheduler = scheduler
    let execCalls = 0
    const origExec = e.executeCronJob.bind(e)
    e.executeCronJob = async (job: CronJob) => { execCalls++; return origExec(job) }
    scheduler.registerEngine('test', e)
    const job = newJob({ id: 'job-o', project: 'test', sessionKey: 'discord:channel-1:user-1', prompt: 'p', cronExpr: '* * * * *', enabled: true })
    store.add(job)
    scheduler.start()

    const fire = (id: string): Promise<void> => (scheduler as unknown as { executeJob(jobID: string): Promise<void> }).executeJob(id)
    void fire('job-o')
    await new Promise((r) => { setTimeout(r, 20) })
    // The previous fire is still hung on send — the second fire must skip.
    await fire('job-o')
    expect(execCalls, 'the overlapping fire skipped the still-running job').toBe(1)
    settleFirst()
    scheduler.stop()
  })
})

describe('ExecuteCronJob_WorkDir_NoGlobalSwitch', () => {
  it('a job work_dir does not touch the shared agent workDir', async () => {
    // The Go-era global switch leaked the cron dir into every concurrent
    // session started while the job ran (up to 30 minutes). The job dir
    // rides the session-start options instead.
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('done')
    let dir = '/workspace/project'
    const seenWorkDirs: Array<string | undefined> = []
    let switched = false
    const agent = {
      ...resultAgent(agentSession),
      getWorkDir: () => dir,
      setWorkDir: (d: string) => { switched = true; dir = d },
      startSession: async (_id: string, options?: { workDir?: string }) => {
        seenWorkDirs.push(options?.workDir)
        return agentSession
      },
    }
    const e = new Engine('test', agent, [platform], '', 'en')
    e.cronScheduler = scheduler
    const job = newJob({ id: 'job-w', project: 'test', sessionKey: 'discord:channel-1:user-1', prompt: 'p', workDir: '/tmp/cron-dir' })
    store.add(job)

    await e.executeCronJob(job)

    expect(seenWorkDirs, "the job dir rides the session's start options").toEqual(['/tmp/cron-dir'])
    expect(switched, 'the shared workDir was never switched').toBe(false)
  })
})

describe('ExecuteCronJob_ResolvesCronReplyTarget', () => {
  it('runs the prompt in the base session with the resolved reply context', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)

    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('cron complete')
    const e = new Engine('test', resultAgent(agentSession), [platform], '', 'en')
    e.cronScheduler = scheduler

    const job = newJob({
      id: 'job-1',
      sessionKey: 'discord:channel-1:user-1',
      prompt: 'summarize activity',
      description: 'Daily summary',
    })
    store.add(job)

    await e.executeCronJob(job)
    expect(platform.resolvedSessionKey).toBe('discord:channel-1:user-1')
    expect(platform.resolveTitle).toBe('Daily summary')

    const sent = (platform as unknown as { getSent(): string[] }).getSent()
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe('⏰ Daily summary')
    expect(sent[1]).toBe('cron complete')

    // Reuse mode: no fresh session under the resolved thread key, exactly
    // one under the base key.
    expect(e.sessions.listSessions('discord:thread-fresh')).toHaveLength(0)
    expect(e.sessions.listSessions('discord:channel-1:user-1')).toHaveLength(1)
    expect(job.sessionKey).toBe('discord:channel-1:user-1')
    expect(store.get('job-1')?.sessionKey).toBe('discord:channel-1:user-1')

    expect(agentSession.sendCalls).toHaveLength(1)
    expect(agentSession.sendCalls[0]).toContain('summarize activity')
  })
})

describe('ExecuteCronJob_NewSessionPerRun', () => {
  it('runs on a side session whose session key carries no #cron suffix (Go ccSessionKey vs interactiveKey split)', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)
    scheduler.setDefaultSessionMode('new_per_run')

    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('fresh run done')
    const recordedKeys: string[] = []
    const recordedSlots: string[] = []
    const agent: Agent = {
      name: () => 'stub',
      startSession: async (_sessionID: string, options) => {
        if (options !== undefined) {
          recordedKeys.push(options.sessionKey)
          if (options.interactiveSlotKey !== undefined) recordedSlots.push(options.interactiveSlotKey)
        }
        return agentSession
      },
      listSessions: async () => [],
      stop: async () => {},
    }
    const e = new Engine('test', agent, [platform], '', 'en')
    e.cronScheduler = scheduler

    const job = newJob({
      id: 'npr1',
      sessionKey: 'discord:channel-1:user-1',
      cronExpr: '0 6 * * *',
      prompt: 'fresh run',
    })
    store.add(job)

    await e.executeCronJob(job)
    // The resolver redirected the run target, so the session key is the
    // resolved key (Go passes runSessionKey as ccSessionKey) — never the
    // slot suffix.
    expect(recordedKeys).toContain('discord:thread-fresh')
    expect(recordedKeys.join('\n')).not.toContain('#cron:')
    // The run's interactive state parks under a `#cron:` slot the bare key
    // cannot find: the start options must also carry that slot so ask
    // surfaces (permission/ask cards) route to it instead of answering
    // unattended (2026-08-26 cron-fbe6d268 incident).
    expect(recordedSlots).toHaveLength(1)
    expect(recordedSlots[0]).toMatch(/^discord:thread-fresh#cron:/)
    // The run used a dedicated side session under the resolved key and its
    // interactive slot was cleaned up as soon as the turn finished.
    expect(e.sessions.listSessions('discord:thread-fresh')).toHaveLength(1)
    expect(e.interactiveStates.size).toBe(0)
  })
})

describe('ExecuteCronJob_UnattendedModeDefault', () => {
  it("defaults an unset job mode to 'default' instead of inheriting the project mode", async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)

    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('run done')
    const recordedModes: string[] = []
    const agent: Agent & { setSessionMode(mode: string): void } = {
      name: () => 'stub',
      startSession: async () => agentSession,
      listSessions: async () => [],
      stop: async () => {},
      setSessionMode: (mode: string) => { recordedModes.push(mode) },
    }
    const e = new Engine('test', agent, [platform], '', 'en')
    e.cronScheduler = scheduler

    const job = newJob({
      id: 'um1',
      sessionKey: 'discord:channel-1:user-1',
      cronExpr: '0 6 * * *',
      prompt: 'unattended check',
      sessionMode: 'new_per_run',
    })
    store.add(job)

    await e.executeCronJob(job)
    // An unattended cron run cannot approve an ExitPlanMode card, so an
    // unset job mode must not fall back to the project default (plan in
    // production): the run starts in 'default' instead.
    expect(recordedModes).toEqual(['default'])
  })

  it('passes an explicit job mode through verbatim', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)

    const platform = createStubCronReplyTargetPlatform('discord')
    const agentSession = newResultAgentSession('run done')
    const recordedModes: string[] = []
    const agent: Agent & { setSessionMode(mode: string): void } = {
      name: () => 'stub',
      startSession: async () => agentSession,
      listSessions: async () => [],
      stop: async () => {},
      setSessionMode: (mode: string) => { recordedModes.push(mode) },
    }
    const e = new Engine('test', agent, [platform], '', 'en')
    e.cronScheduler = scheduler

    const job = newJob({
      id: 'um2',
      sessionKey: 'discord:channel-1:user-1',
      cronExpr: '0 6 * * *',
      prompt: 'unattended check',
      sessionMode: 'new_per_run',
      mode: 'bypassPermissions',
    })
    store.add(job)

    await e.executeCronJob(job)
    expect(recordedModes).toEqual(['bypassPermissions'])
  })
})

describe('ExecuteCronJob_WorkspacePrefixedSessionKey', () => {
  it('strips a workspace prefix by locating the platform name and keeps the stored key', async () => {
    const store = new CronStore(tempDir())
    const scheduler = new CronScheduler(store)

    const platform = createStubCronReplyTargetPlatform('slack')
    const agentSession = newResultAgentSession('done')
    const e = new Engine('test', resultAgent(agentSession), [platform], '', 'en')
    e.cronScheduler = scheduler

    // A session key stored with a workspace prefix (multi-workspace mode).
    const prefixedKey = '/home/user/workspace/myproject:slack:C123:U456'
    const job = newJob({
      id: 'job-ws',
      sessionKey: prefixedKey,
      prompt: 'daily standup',
      description: 'Standup',
    })
    store.add(job)

    await e.executeCronJob(job)

    // The platform received the cron start notice and the agent reply.
    const sent = (platform as unknown as { getSent(): string[] }).getSent()
    expect(sent.length).toBeGreaterThanOrEqual(1)

    // The stored session key must remain unchanged.
    expect(job.sessionKey).toBe(prefixedKey)
  })
})
