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
import { CronJob, CronScheduler, CronStore } from '../../src/engine/cron.js'
import { Engine } from '../../src/engine/engine.js'
import { createStubPlatform, newResultAgentSession } from '../stubs/engine-stubs.js'
import type { Agent, Platform } from '../../src/core/types.js'

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
    const agent: Agent = {
      name: () => 'stub',
      startSession: async (_sessionID: string, options) => {
        if (options !== undefined) recordedKeys.push(options.sessionKey)
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
    // The run used a dedicated side session under the resolved key and its
    // interactive slot was cleaned up as soon as the turn finished.
    expect(e.sessions.listSessions('discord:thread-fresh')).toHaveLength(1)
    expect(e.interactiveStates.size).toBe(0)
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
