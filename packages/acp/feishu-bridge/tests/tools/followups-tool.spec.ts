/**
 * Consumer-surface tests for the `feishu_bridge_followups` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed): the caller
 * agent routes to its engine + session key, the tool synthesizes the
 * canonical closing-card questions ask (engine-owned constants — header,
 * multi-select, fixed question, stable id — with the model filling only the
 * options list) and delegates to engine.askUser, one test exercises the REAL
 * conversion branch end-to-end (pendingFollowups registered + deferred
 * sentence returned), unrouted callers and empty option lists fail loud, and
 * registration disposes cleanly (HMR safety).
 *
 * @module dsh-feishu-bridge/tests-tools-followups
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { FOLLOWUPS_ASK_HEADER } from '../../src/engine/ask.ts'
import { registerFollowupsTool } from '../../src/tools/followups.ts'
import type { SubtaskRoute } from '../../src/tools/subtask.ts'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.ts'

/** In-memory Inbox double for hand-built Agents; the concrete class is loop-internal. */
function stubInbox(): Inbox {
  type Message = Inbox['nextTurn'][number]
  const nextTurn: Message[] = []
  const nextStep: Message[] = []
  const list = (target: InboxTarget): Message[] => (target === 'next-turn' ? nextTurn : nextStep)
  return {
    nextTurn,
    nextStep,
    clear: () => {
      nextStep.length = 0
      nextTurn.length = 0
    },
    append: (target, message) => { list(target).push(message) },
    prepend: (target, message) => { list(target).unshift(message) },
    replace: (messageId, newMessage) => {
      for (const messages of [nextStep, nextTurn]) {
        const index = messages.findIndex(message => message.id === messageId)
        if (index !== -1) {
          messages[index] = newMessage
          return true
        }
      }
      return false
    },
    remove: (messageId: string) => {
      for (const messages of [nextStep, nextTurn]) {
        const index = messages.findIndex(message => message.id === messageId)
        if (index !== -1) messages.splice(index, 1)
      }
    },
    splice: (target, start, deleteCount, inserted) => list(target).splice(start, deleteCount, ...inserted),
  }
}

const signal = new AbortController().signal
const contexts: Context[] = []

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = stubInbox()
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

/** A real Engine whose askUser is spied (request-synthesis assertions). */
function newRoutedEngine(name: string): { engine: Engine; ask: ReturnType<typeof vi.spyOn> } {
  const engine = new Engine(name, createStubAgent(), [createStubPlatform()], '', 'en')
  const ask = vi.spyOn(engine, 'askUser')
    .mockResolvedValue({ answers: [{ id: 'followups', selected: [], custom: 'Registered 1 follow-up suggestions.' }] })
  return { engine, ask }
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
  const agent = stubAgent(ctx, `followups-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerFollowupsTool(ctx, route)
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
    name: 'feishu_bridge_followups',
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

describe('feishu_bridge_followups execution', () => {
  it('synthesizes the canonical closing-card ask and returns the deferred sentence', async () => {
    const r = newRoutedEngine('proj-x')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))
    const v = value(await execute(test, {
      options: [
        { label: '修持久化测试 flake', description: 'tests/feishu/card-action.spec.ts:1102 —— 改为轮询等落盘', recommended: true },
        { label: '补文档', description: 'README.md:12 —— 补充说明' },
      ],
    }))
    expect(r.ask).toHaveBeenCalledTimes(1)
    const [key, request] = r.ask.mock.calls[0] as [
      string,
      { kind: string; questions: unknown[] },
    ]
    expect(key).toBe('feishu:chat-9:u1')
    expect(request).toEqual({
      kind: 'questions',
      questions: [{
        id: 'followups',
        question: '以上发现后续如何处理？',
        header: FOLLOWUPS_ASK_HEADER,
        multiSelect: true,
        options: [
          { label: '修持久化测试 flake', description: 'tests/feishu/card-action.spec.ts:1102 —— 改为轮询等落盘', recommended: true },
          { label: '补文档', description: 'README.md:12 —— 补充说明' },
        ],
      }],
    })
    expect(v.status).toBe('ok')
    expect(v.message).toBe('Registered 1 follow-up suggestions.')
  })
})

describe('feishu_bridge_followups gating', () => {
  it('fails loud for a caller the bridge does not own', async () => {
    const r = newRoutedEngine('test')
    const test = await harness((agent) => {
      const id = (agent as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && id === 'foreign-agent' ? undefined : { engine: r.engine, sessionKey: 'test:p' }
    })
    const foreign = stubAgent(test.ctx, 'foreign-agent')
    test.ctx.agents.register(foreign)
    const result = await execute(test, { options: [{ label: 'x', description: 'y' }] }, foreign)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not owned')
    expect(r.ask).not.toHaveBeenCalled()
  })
  it('fails loud for an empty options list', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const result = await execute(test, { options: [] })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('at least one option')
    expect(r.ask).not.toHaveBeenCalled()
  })
})

describe('feishu_bridge_followups real conversion', () => {
  it('delegates into the real askUser closing-card branch: pendingFollowups registered, zh deferred sentence returned', async () => {
    const p = createStubPlatform()
    const engine = new Engine('test', createStubAgent(), [p], '', 'zh')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-1'
    engine.interactiveStates.set('test:p', state)
    const test = await harness(() => ({ engine, sessionKey: 'test:p' }))
    const v = value(await execute(test, {
      options: [{ label: '修 A', description: 'a.ts:1 —— 建议动作', recommended: true }],
    }))
    expect(state.pendingFollowups?.header).toBe(FOLLOWUPS_ASK_HEADER)
    expect(state.pendingFollowups?.multiSelect).toBe(true)
    expect(state.pendingFollowups?.question).toBe('以上发现后续如何处理？')
    expect(state.pendingFollowups?.options).toHaveLength(1)
    expect(v.message).toContain('已登记 1 项后续处理建议')
  })
})

describe('feishu_bridge_followups registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:chat' }))
    expect(test.ctx.tools.get('feishu_bridge_followups')?.name).toBe('feishu_bridge_followups')
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_followups')).toBeUndefined()
  })
})
