/**
 * Consumer-surface tests for the `feishu_bridge_cron` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed), with the
 * Engine's scheduler spied: each action must route to the correct
 * CronScheduler method with the caller-agent-derived project + session key
 * (plan D4 — no env), a foreign caller must fail loud, and registration
 * must dispose cleanly (HMR safety).
 *
 * @module dsh-feishu-bridge/tests-tools-cron
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine } from '../../src/engine/engine.js'
import { CronJob, CronScheduler, CronStore } from '../../src/engine/cron.js'
import { registerCronTool } from '../../src/tools/cron.js'
import type { SubtaskRoute } from '../../src/tools/subtask.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'

const signal = new AbortController().signal
const contexts: Context[] = []

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-crontool-'))
}

/** A real Engine whose scheduler methods are spies (routing assertions). */
function newRoutedEngine(name: string): {
  engine: Engine
  scheduler: CronScheduler
  store: CronStore
  addJob: ReturnType<typeof vi.fn>
  removeJob: ReturnType<typeof vi.fn>
  updateJob: ReturnType<typeof vi.fn>
} {
  const store = new CronStore(tempDir())
  const scheduler = new CronScheduler(store)
  const engine = new Engine(name, createStubAgent(), [createStubPlatform()], '', 'en')
  engine.cronScheduler = scheduler
  const addJob = vi.spyOn(scheduler, 'addJob')
  const removeJob = vi.spyOn(scheduler, 'removeJob')
  const updateJob = vi.spyOn(scheduler, 'updateJob')
  return { engine, scheduler, store, addJob, removeJob, updateJob }
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly dispose: () => void
}

async function harness(route: (agent: unknown) => SubtaskRoute | undefined): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `cron-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerCronTool(ctx, route)
  return { ctx, agent, dispose }
}

async function execute(
  test: Harness,
  args: unknown,
  agent: Agent = test.agent,
): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${Math.random()}`),
    name: 'feishu_bridge_cron',
    arguments: args,
    agent,
  }))
}

function value(result: ToolExecutionResult): { status: string; message: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful value')
  return result.value as { status: string; message: string }
}

function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected an error result')
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('feishu_bridge_cron registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:chat' }))
    expect(test.ctx.tools.get('feishu_bridge_cron')?.name).toBe('feishu_bridge_cron')
    const schema = test.ctx.tools.get('feishu_bridge_cron')?.parameters as {
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.properties?.action?.enum).toEqual(['add', 'list', 'info', 'edit', 'del'])
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_cron')).toBeUndefined()
  })
})

describe('feishu_bridge_cron action routing', () => {
  it('add routes to scheduler.addJob with the caller project and session key', async () => {
    const r = newRoutedEngine('proj-x')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))
    const v = value(await execute(test, {
      action: 'add',
      cronExpr: '0 9 * * 1-5',
      prompt: 'morning digest',
      description: '工作日早报',
      sessionMode: 'new_per_run',
      timeoutMins: 10,
    }))
    expect(r.addJob).toHaveBeenCalledTimes(1)
    const job = r.addJob.mock.calls[0]?.[0] as CronJob
    expect(job.project).toBe('proj-x')
    expect(job.sessionKey).toBe('feishu:chat-9:u1')
    expect(job.cronExpr).toBe('0 9 * * 1-5')
    expect(job.prompt).toBe('morning digest')
    expect(job.description).toBe('工作日早报')
    expect(job.sessionMode).toBe('new_per_run')
    expect(job.timeoutMins).toBe(10)
    expect(job.enabled).toBe(true)
    expect(v.message).toContain('Cron job created')
    expect(v.message).toContain('0 9 * * 1-5')
    expect(v.message).toContain(job.id)
  })

  it('add validates cron expr and the prompt/exec exclusivity', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    expect((await execute(test, { action: 'add', prompt: 'hi' })).isError).toBe(true)
    expect((await execute(test, { action: 'add', cronExpr: '0 9 * * *', prompt: 'a', exec: 'b' })).isError).toBe(true)
    expect(r.addJob).not.toHaveBeenCalled()
    // An invalid expression reaches the scheduler and its error surfaces.
    const bad = await execute(test, { action: 'add', cronExpr: 'not cron', prompt: 'hi' })
    expect(bad.isError).toBe(true)
    expect(errorText(bad)).toContain('invalid cron expression')
  })

  it('list reports the project jobs and del removes by id', async () => {
    const r = newRoutedEngine('proj-x')
    const job = new CronJob()
    job.id = 'abc12345'
    job.project = 'proj-x'
    job.sessionKey = 'feishu:chat-9:u1'
    job.cronExpr = '*/30 * * * *'
    job.prompt = 'half-hour check'
    job.enabled = true
    r.store.add(job)
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))

    const v = value(await execute(test, { action: 'list' }))
    expect(v.message).toContain('abc12345')
    expect(v.message).toContain('*/30 * * * *')
    expect(v.message).toContain('half-hour check')

    const d = value(await execute(test, { action: 'del', id: 'abc12345' }))
    expect(r.removeJob).toHaveBeenCalledWith('abc12345')
    expect(d.message).toContain('deleted')
  })

  it('info returns the serialized job and unknown ids fail loud', async () => {
    const r = newRoutedEngine('proj-x')
    const job = new CronJob()
    job.id = 'inf00001'
    job.project = 'proj-x'
    job.sessionKey = 'feishu:chat-9:u1'
    job.cronExpr = '0 6 * * *'
    job.prompt = 'task'
    job.enabled = true
    r.store.add(job)
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))

    const v = value(await execute(test, { action: 'info', id: 'inf00001' }))
    expect(v.message).toContain('"cron_expr":"0 6 * * *"')

    const err = await execute(test, { action: 'info', id: 'missing' })
    expect(err.isError).toBe(true)
    expect(errorText(err)).toContain('not found')
  })

  it('edit converts typed values and routes to scheduler.updateJob', async () => {
    const r = newRoutedEngine('proj-x')
    const job = new CronJob()
    job.id = 'edt00001'
    job.project = 'proj-x'
    job.sessionKey = 'feishu:chat-9:u1'
    job.cronExpr = '0 6 * * *'
    job.prompt = 'task'
    job.enabled = true
    r.store.add(job)
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))

    await execute(test, { action: 'edit', id: 'edt00001', field: 'enabled', value: 'false' })
    expect(r.updateJob).toHaveBeenCalledWith('edt00001', 'enabled', false)
    await execute(test, { action: 'edit', id: 'edt00001', field: 'timeout_mins', value: '45' })
    expect(r.updateJob).toHaveBeenCalledWith('edt00001', 'timeout_mins', 45)
    await execute(test, { action: 'edit', id: 'edt00001', field: 'prompt', value: 'new prompt' })
    expect(r.updateJob).toHaveBeenCalledWith('edt00001', 'prompt', 'new prompt')

    expect((await execute(test, { action: 'edit', id: 'edt00001', field: 'enabled', value: 'yes' })).isError).toBe(true)
  })
})

describe('feishu_bridge_cron caller routing', () => {
  it('fails loud for a caller the bridge does not own', async () => {
    const r = newRoutedEngine('test')
    const test = await harness((agent) => {
      const id = (agent as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && id === 'foreign-agent' ? undefined : { engine: r.engine, sessionKey: 'test:p' }
    })
    const foreign = stubAgent(test.ctx, 'foreign-agent')
    test.ctx.agents.register(foreign)
    const result = await execute(test, { action: 'list' }, foreign)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not owned')
  })

  it('fails loud when the engine has no scheduler attached', async () => {
    const engine = new Engine('bare', createStubAgent(), [createStubPlatform()], '', 'en')
    const test = await harness(() => ({ engine, sessionKey: 'bare:p' }))
    const result = await execute(test, { action: 'list' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not available')
  })
})
