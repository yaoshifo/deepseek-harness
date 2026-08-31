/**
 * M6 assembly wiring tests: the cron/relay config blocks must reach the
 * process-wide scheduler/manager (Go main wiring — cfg.Cron defaults,
 * cfg.Relay timeout, engines registered into both) and buildProjectAssembly
 * must attach them plus the /cron and /bind command families without
 * disturbing the session commands. Applies over a real Cordis Context so
 * the tool registrations and scheduler lifecycle are exercised end to end.
 *
 * @module dsh-feishu-bridge/tests-cron-relay-assembly
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig, type SharedProcessServices } from '../src/index.js'
import { CronJob, CronScheduler, CronStore, generateCronID } from '../src/engine/cron.js'
import { RelayManager } from '../src/engine/relay.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-cronasm-'))
}

function stubContext(): Context {
  return {
    agents: {},
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {} },
    // Cordis runs the effect body immediately; mirror that so command
    // registrations mounted through ctx.effect actually mount.
    effect: (fn: () => unknown) => { void fn(); return () => {} },
  } as unknown as Context
}

function baseConfig(): FeishuBridgeConfig {
  return {
    projects: [],
    providers: {
      'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' },
    },
  }
}

function project(): ProjectConfig {
  return {
    name: 'smoke-project',
    workdir: '/workspace/project',
    feishu: { appId: 'cli_test', appSecret: 'sec' },
  }
}

describe('buildProjectAssembly cron/relay wiring', () => {
  it('registers the engine into the shared scheduler/manager and adds /cron + /bind without dropping /new', () => {
    const root = tempDir()
    const scheduler = new CronScheduler(new CronStore(root))
    const relayManager = new RelayManager(root)
    const shared: SharedProcessServices = { cronScheduler: scheduler, relayManager }

    const { engine } = buildProjectAssembly(stubContext(), baseConfig(), project(), root, undefined, shared)
    expect(engine.cronScheduler).toBe(scheduler)
    expect(engine.relayManager).toBe(relayManager)
    expect(engine.commandHandlers?.get('cron')).toBeDefined()
    expect(engine.commandHandlers?.get('bind')).toBeDefined()
    expect(engine.commandHandlers?.get('new')).toBeDefined()
  })

  it('wires nothing when no shared services are passed', () => {
    const { engine } = buildProjectAssembly(stubContext(), baseConfig(), project(), tempDir())
    expect(engine.cronScheduler).toBeUndefined()
    expect(engine.relayManager).toBeUndefined()
    expect(engine.commandHandlers?.get('cron')).toBeUndefined()
    expect(engine.commandHandlers?.get('bind')).toBeUndefined()
  })
})

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('apply() process-wide wiring', () => {
  it('creates the shared stores, applies config defaults, starts the scheduler, registers the tools, and stops on dispose', async () => {
    const silentSpy = vi.spyOn(CronScheduler.prototype, 'setDefaultSilent')
    const modeSpy = vi.spyOn(CronScheduler.prototype, 'setDefaultSessionMode')
    const startSpy = vi.spyOn(CronScheduler.prototype, 'start')
    const stopSpy = vi.spyOn(CronScheduler.prototype, 'stop')
    const timeoutSpy = vi.spyOn(RelayManager.prototype, 'setTimeoutMs')
    try {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)

      await apply(ctx, {
        ...baseConfig(),
        dataDir: tempDir(),
        cron: { silent: true, sessionMode: 'new_per_run' },
        relay: { timeoutSecs: 5 },
      })

      expect(silentSpy).toHaveBeenCalledWith(true)
      expect(modeSpy).toHaveBeenCalledWith('new_per_run')
      expect(timeoutSpy).toHaveBeenCalledWith(5000)
      expect(startSpy).toHaveBeenCalled()

      expect(ctx.tools.get('feishu_bridge_cron')?.name).toBe('feishu_bridge_cron')
      expect(ctx.tools.get('feishu_bridge_relay')?.name).toBe('feishu_bridge_relay')

      await ctx.fiber.dispose()
      expect(stopSpy).toHaveBeenCalled()
    } finally {
      silentSpy.mockRestore()
      modeSpy.mockRestore()
      startSpy.mockRestore()
      stopSpy.mockRestore()
      timeoutSpy.mockRestore()
    }
  })

  it('applies the Go defaults when the cron/relay blocks are absent', async () => {
    const silentSpy = vi.spyOn(CronScheduler.prototype, 'setDefaultSilent')
    const modeSpy = vi.spyOn(CronScheduler.prototype, 'setDefaultSessionMode')
    const timeoutSpy = vi.spyOn(RelayManager.prototype, 'setTimeoutMs')
    try {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)

      await apply(ctx, { ...baseConfig(), dataDir: tempDir() })
      expect(silentSpy).not.toHaveBeenCalled()
      expect(modeSpy).not.toHaveBeenCalled()
      expect(timeoutSpy).not.toHaveBeenCalled()
    } finally {
      silentSpy.mockRestore()
      modeSpy.mockRestore()
      timeoutSpy.mockRestore()
    }
  })
})

describe('disk format compatibility', () => {
  it('cron jobs land in <dataDir>/crons/jobs.json with the Go snake_case keys', () => {
    const root = tempDir()
    const scheduler = new CronScheduler(new CronStore(root))
    const job = new CronJob()
    job.id = generateCronID()
    job.project = 'smoke-project'
    job.sessionKey = 'feishu:chat-1:u1'
    job.cronExpr = '0 6 * * *'
    job.prompt = 'daily report'
    job.enabled = true
    job.createdAt = new Date().toISOString()
    scheduler.addJob(job)

    const raw = JSON.parse(readFileSync(join(root, 'crons', 'jobs.json'), 'utf8')) as Array<Record<string, unknown>>
    expect(raw).toHaveLength(1)
    expect(raw[0]?.id).toBe(job.id)
    expect(raw[0]?.project).toBe('smoke-project')
    expect(raw[0]?.session_key).toBe('feishu:chat-1:u1')
    expect(raw[0]?.cron_expr).toBe('0 6 * * *')
    expect(raw[0]?.prompt).toBe('daily report')
    expect(raw[0]?.enabled).toBe(true)
    expect(raw[0]?.created_at).toBe(job.createdAt)
  })

  it('relay bindings land in <dataDir>/relay_bindings.json with the Go keys', () => {
    const root = tempDir()
    const rm = new RelayManager(root)
    rm.bind('feishu', 'oc_chat1', { 'proj-a': 'A Bot', 'proj-b': 'B Bot' })

    const raw = JSON.parse(readFileSync(join(root, 'relay_bindings.json'), 'utf8')) as Record<string, { platform: string; chat_id: string; bots: Record<string, string> }>
    expect(raw.oc_chat1?.platform).toBe('feishu')
    expect(raw.oc_chat1?.chat_id).toBe('oc_chat1')
    expect(raw.oc_chat1?.bots).toEqual({ 'proj-a': 'A Bot', 'proj-b': 'B Bot' })
  })
})
