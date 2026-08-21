/**
 * Consumer-surface tests for the `feishu_bridge_chatroom` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed), with the
 * chatroom engine functions replaced by spies: each action must route to
 * the correct orchestration primitive with the caller-agent-derived session
 * key (plan D4 — no env), malformed picks fail loud, and registration must
 * dispose cleanly (HMR safety).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine } from '../../src/engine/engine.js'
import { registerChatroomTool } from '../../src/tools/chatroom.js'
import type { SubtaskRoute } from '../../src/tools/subtask.js'
import { createStubAgent, createStubSpawnerPlatform } from '../stubs/engine-stubs.js'

const signal = new AbortController().signal
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

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
  readonly execute: (args: unknown, agent?: Agent) => Promise<ToolExecutionResult>
}

async function harness(route: (agent: unknown) => SubtaskRoute | undefined): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `chatroom-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerChatroomTool(ctx, route)
  const execute = (args: unknown, caller: Agent = agent): Promise<ToolExecutionResult> =>
    ctx.agents.withInitiator(caller, () => ctx.tools.execute({
      signal,
      callId: CallId(`call-${Math.random()}`),
      name: 'feishu_bridge_chatroom',
      arguments: args,
      agent: caller,
    }))
  return { ctx, agent, dispose, execute }
}

function newEngine(): Engine {
  return new Engine('chatroom-test', createStubAgent(), [createStubSpawnerPlatform()], '', 'zh')
}

function value(result: ToolExecutionResult): { status: string; message: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful value')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text content')
  expect(block.text).toBe((result.value as { message: string }).message)
  return result.value as { status: string; message: string }
}

function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected an error result')
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('feishu_bridge_chatroom registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    expect(test.ctx.tools.get('feishu_bridge_chatroom')?.name).toBe('feishu_bridge_chatroom')
    const schema = test.ctx.tools.get('feishu_bridge_chatroom')?.parameters as {
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.properties?.action?.enum).toEqual(
      ['start', 'ask', 'gather', 'pick-roles', 'pick-topic', 'ask-human', 'end', 'list', 'note'],
    )
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_chatroom')).toBeUndefined()
  })
})

describe('feishu_bridge_chatroom action routing', () => {
  it('start reaches startChatroom (fail-fast without configured roles)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'start', message: 'topic', roles: 'taleb,munger' })
    expect(res.isError).toBe(true)
    // The fail-fast unknown-role reply proves startChatroom ran with the
    // caller's session key (roles validated before any spawn).
    expect(errorText(res)).toContain('taleb')
    test.dispose()
  })

  it('gather/ask/note/ask-human fail loud when their preconditions miss (routing proof)', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))

    // gather without roles (no chatroom started under the caller's key).
    const gatherRes = await test.execute({ action: 'gather', message: 'q' })
    expect(gatherRes.isError).toBe(true)

    // ask with an unknown role.
    const askRes = await test.execute({ action: 'ask', role: 'ghost', message: 'q' })
    expect(askRes.isError).toBe(true)

    // note without a moderator dir.
    const noteRes = await test.execute({ action: 'note', message: '综述' })
    expect(noteRes.isError).toBe(true)
    expect(errorText(noteRes)).toContain('ledger')

    // ask-human on a non-role session.
    const humanRes = await test.execute({ action: 'ask-human', message: '截止日？' })
    expect(humanRes.isError).toBe(true)

    test.dispose()
  })

  it('rejects malformed picks JSON loudly', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'pick-roles', picks: 'not json' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('malformed')
    test.dispose()
  })

  it('fails loud for a foreign caller (no feishu-bridge engine)', async () => {
    const test = await harness(() => undefined)
    const res = await test.execute({ action: 'list' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('not owned')
    test.dispose()
  })

  it('lists roles from the engine roles dir', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const v = value(await test.execute({ action: 'list' }))
    expect(v.status).toBe('ok')
    expect(v.message).toContain('no roles configured')
    test.dispose()
  })

  it('pick-roles requires a live picker state', async () => {
    const engine = newEngine()
    const test = await harness(() => ({ engine, sessionKey: 'feishu:oc_hub:ou_1' }))
    const res = await test.execute({ action: 'pick-roles', picks: '[{"name":"taleb","recommended":true,"blurb":"why"}]' })
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('picker')
    test.dispose()
  })
})
