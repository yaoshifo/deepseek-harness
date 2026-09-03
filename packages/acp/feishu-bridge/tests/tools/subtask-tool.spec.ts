/**
 * Consumer-surface tests for the `feishu_bridge_subtask` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed), with the
 * Engine replaced by spies: each action must route to the correct Engine
 * method with the caller-agent-derived session key (plan D4 — no env), a
 * foreign caller must fail loud, and registration must dispose cleanly
 * (HMR safety).
 */

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
import { Engine } from '../../src/engine/engine.ts'
import { agentIDOf, registerSubtaskTool, type SubtaskRoute } from '../../src/tools/subtask.ts'
import { createStubAgent, createStubSpawnerPlatform } from '../stubs/engine-stubs.ts'
import { WorktreeMode } from '../../src/engine/worktree.ts'

const signal = new AbortController().signal
const contexts: Context[] = []

/** A real Engine whose subtask methods are spies (routing assertions). */
interface RoutedEngine {
  readonly engine: Engine
  readonly spawn: ReturnType<typeof vi.fn>
  readonly report: ReturnType<typeof vi.fn>
  readonly reportNative: ReturnType<typeof vi.fn>
  readonly send: ReturnType<typeof vi.fn>
  readonly gather: ReturnType<typeof vi.fn>
  readonly gatherBlocking: ReturnType<typeof vi.fn>
  readonly interrupt: ReturnType<typeof vi.fn>
}

function newRoutedEngine(name: string): RoutedEngine {
  const engine = new Engine(name, createStubAgent(), [createStubSpawnerPlatform()], '', 'en')
  const spawn = vi.spyOn(engine, 'spawnSubtaskNative')
    .mockResolvedValue({ childName: `${name} 任务`, childKey: `${name}:child-1` })
  const report = vi.spyOn(engine, 'reportSubtask').mockResolvedValue(undefined)
  const reportNative = vi.spyOn(engine, 'reportNativeChild').mockResolvedValue(undefined)
  const send = vi.spyOn(engine, 'sendToSubtask').mockResolvedValue(undefined)
  const gather = vi.spyOn(engine, 'gatherSubtasks').mockReturnValue(undefined)
  const gatherBlocking = vi.spyOn(engine, 'gatherSubtasksBlocking')
    .mockResolvedValue('[子任务汇总] combined summary')
  const interrupt = vi.spyOn(engine, 'interruptNativeChild').mockReturnValue(undefined)
  return { engine, spawn, report, reportNative, send, gather, gatherBlocking, interrupt }
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

/** Boot the tool over a real registry; the router maps agent ids to engines. */
async function harness(
  route?: (agent: unknown) => SubtaskRoute | undefined,
  nativeRoute?: (agent: unknown) => SubtaskRoute | undefined,
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `subtask-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerSubtaskTool(ctx, route ?? (() => undefined), nativeRoute)
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
    name: 'feishu_bridge_subtask',
    arguments: args,
    agent,
  }))
}

function value(result: ToolExecutionResult): unknown {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful value')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text content')
  // The render is the value's message sentence, not a JSON round-trip.
  expect(block.text).toBe((result.value as { message: string }).message)
  return result.value
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

describe('feishu_bridge_subtask registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent' }))
    expect(test.ctx.tools.get('feishu_bridge_subtask')?.name).toBe('feishu_bridge_subtask')
    const schema = test.ctx.tools.get('feishu_bridge_subtask')?.parameters as {
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.properties?.action?.enum).toEqual(['spawn', 'report', 'send', 'gather', 'interrupt'])
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_subtask')).toBeUndefined()
  })

  it('states the cross-directory delegation contract in the model-facing wording', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent' }))
    const tool = test.ctx.tools.get('feishu_bridge_subtask')
    expect(tool?.description).toContain('different directory')
    const dir = (tool?.parameters as {
      properties?: { dir?: { description?: string } }
    }).properties?.dir?.description
    expect(dir).toContain('different project')
    expect(dir).toContain('instruction files')
  })

  it('states the approved-plan execution boundary in the model-facing wording', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent' }))
    const description = test.ctx.tools.get('feishu_bridge_subtask')?.description ?? ''
    expect(description).toContain('begin executing an approved plan')
    expect(description).toContain('spawn them together in one message instead of implementing them serially yourself')
    expect(description).toContain('Judge independence by whether the groups span disjoint subsystems or directions')
  })

  it('describes fork, send, and the assistant literal as the code behaves', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent' }))
    const description = test.ctx.tools.get('feishu_bridge_subtask')?.description ?? ''
    const params = test.ctx.tools.get('feishu_bridge_subtask')?.parameters as {
      properties?: {
        fork?: { description?: string }
        child?: { description?: string }
      }
    }
    // Cross-directory forks work (the fork provider carries cwdOverride); the
    // stale M4-era prohibition is gone.
    expect(params.properties?.fork?.description).not.toContain('cannot cross')
    expect(description).not.toContain('unsupported across')
    // send queues only native subtasks; attended group children busy-reject.
    expect(description).toContain('busy rejects it')
    // interrupt addresses native child ids only; group children stop from
    // their own chat — the tool description states the limit.
    expect(description).toContain('native subtasks\' current turn')
    expect(description).toContain('stopped from their own chat')
    expect(params.properties?.child?.description).toContain('interrupt accepts native subtask ids only')
    // The "assistant" literal routes through send's alias waterfall; interrupt
    // resolves no alias and addresses native child ids only.
    expect(params.properties?.child?.description).toContain('send also accepts the literal "assistant"')
  })
})

describe('feishu_bridge_subtask action routing', () => {
  it('spawn routes to SpawnSubtask with the caller session and flags', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent-chat' }))
    const v = value(await execute(test, {
      action: 'spawn',
      message: '迁移 project A 的 schema',
      dir: '/abs/project-a',
      worktree: 'on',
      fork: true,
    })) as { status: string; message: string }
    expect(r.spawn).toHaveBeenCalledWith(
      'test:parent-chat', '/abs/project-a', WorktreeMode.ForceOn, true, '迁移 project A 的 schema',
    )
    expect(v.status).toBe('ok')
    expect(v.message).toContain('test 任务')
    expect(v.message).toContain('test:child-1')
    expect(v.message).toContain('runs in parallel')
  })

  it('spawn defaults worktree to auto and fork off', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    await execute(test, { action: 'spawn', message: 'brief' })
    expect(r.spawn).toHaveBeenCalledWith('test:p', '', WorktreeMode.Auto, false, 'brief')
  })

  it('spawn without a brief fails', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const result = await execute(test, { action: 'spawn', message: '  ' })
    expect(result.isError).toBe(true)
    expect(r.spawn).not.toHaveBeenCalled()
  })

  it('report routes to ReportSubtask with the message', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:child-chat' }))
    const v = value(await execute(test, { action: 'report', message: 'schema 已迁移' })) as { message: string }
    expect(r.report).toHaveBeenCalledWith('test:child-chat', 'schema 已迁移')
    expect(v.message).toContain('Reported result back to the parent conversation')
  })

  it('report with no message passes an empty result (engine falls back to the last reply)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:child-chat' }))
    await execute(test, { action: 'report' })
    expect(r.report).toHaveBeenCalledWith('test:child-chat', '')
  })

  it('report from a native child routes to reportNativeChild with the native id', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(undefined, () => ({ engine: r.engine, sessionKey: 'child-native-1', nativeChildId: 'child-native-1' }))
    const v = value(await execute(test, { action: 'report', message: '结果' })) as { message: string }
    expect(r.reportNative).toHaveBeenCalledWith('child-native-1', '结果')
    expect(r.report).not.toHaveBeenCalled()
    expect(v.message).toContain('Reported result back to the parent conversation')
  })

  it('interrupt routes to interruptNativeChild with the child key and the caller session', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent-chat' }))
    const v = value(await execute(test, { action: 'interrupt', child: 'test:child-1' })) as { message: string }
    expect(r.interrupt).toHaveBeenCalledWith('test:child-1', 'test:parent-chat')
    expect(v.message).toContain('Interrupt requested')
  })

  it('gather from a native child explains the per-report wake instead of arming a barrier', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(undefined, () => ({ engine: r.engine, sessionKey: 'child-native-1', nativeChildId: 'child-native-1' }))
    const v = value(await execute(test, { action: 'gather' })) as { message: string }
    expect(r.gather).not.toHaveBeenCalled()
    expect(v.message).toContain('No barrier armed')
  })

  it('send routes to SendToSubtask with parent key, child key, and message', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent-chat' }))
    const v = value(await execute(test, {
      action: 'send',
      child: 'test:child-1',
      message: '把完整报告贴出来',
    })) as { message: string }
    expect(r.send).toHaveBeenCalledWith('test:parent-chat', 'test:child-1', '把完整报告贴出来')
    expect(v.message).toContain('test:child-1')
  })

  it('send without child or message fails', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    expect((await execute(test, { action: 'send', message: 'hi' })).isError).toBe(true)
    expect((await execute(test, { action: 'send', child: 'test:c' })).isError).toBe(true)
    expect(r.send).not.toHaveBeenCalled()
  })

  it('gather routes to the blocking gather and returns the summary as the tool result', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:parent-chat' }))
    const v = value(await execute(test, { action: 'gather' })) as { message: string }
    expect(r.gatherBlocking).toHaveBeenCalledWith('test:parent-chat', signal)
    expect(v.message).toContain('combined summary')
  })
})

describe('feishu_bridge_subtask caller routing', () => {
  it('routes two caller agents to their own engines', async () => {
    const r1 = newRoutedEngine('proj-a')
    const r2 = newRoutedEngine('proj-b')
    const route = (agent: unknown): SubtaskRoute => {
      const id = agentIDOf(agent)
      return id === 'bridge-a' ? { engine: r1.engine, sessionKey: 'a:chat' } : { engine: r2.engine, sessionKey: 'b:chat' }
    }
    const test = await harness(route)
    const agentA = stubAgent(test.ctx, 'bridge-a')
    const agentB = stubAgent(test.ctx, 'bridge-b')
    test.ctx.agents.register(agentA)
    test.ctx.agents.register(agentB)

    await execute(test, { action: 'gather' }, agentA)
    await execute(test, { action: 'gather' }, agentB)

    expect(r1.gatherBlocking).toHaveBeenCalledWith('a:chat', signal)
    expect(r2.gatherBlocking).toHaveBeenCalledWith('b:chat', signal)
  })

  it('fails loud for a caller the bridge does not own', async () => {
    const r = newRoutedEngine('test')
    const test = await harness((agent) => {
      const id = agentIDOf(agent)
      return id === 'foreign-agent' ? undefined : { engine: r.engine, sessionKey: 'test:p' }
    })
    const foreign = stubAgent(test.ctx, 'foreign-agent')
    test.ctx.agents.register(foreign)
    const result = await execute(test, { action: 'gather' }, foreign)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not owned')
    expect(r.gatherBlocking).not.toHaveBeenCalled()
  })

  it('surfaces engine failures to the model', async () => {
    const r = newRoutedEngine('test')
    r.gatherBlocking.mockRejectedValue(new Error('subtask: a gather is already in progress on this session'))
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const result = await execute(test, { action: 'gather' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('already in progress')
  })
})
