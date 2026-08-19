/**
 * Consumer-surface tests for the `feishu_bridge_relay` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed), with the
 * Engine's relay manager spied: send must route to RelayManager.send with
 * the caller's engine as `from` and the routed session key, bind/binding
 * manage the chat's binding, a foreign caller fails loud, and registration
 * disposes cleanly (HMR safety).
 *
 * @module dsh-feishu-bridge/tests-tools-relay
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { RelayManager, type RelayRequest } from '../../src/engine/relay.js'
import { registerRelayTool } from '../../src/tools/relay.js'
import type { SubtaskRoute } from '../../src/tools/subtask.js'
import { createStubAgent, createStubPlatform } from '../stubs/engine-stubs.js'

const signal = new AbortController().signal
const contexts: Context[] = []

/** A real Engine whose relay manager's send is a spy. */
function newRoutedEngine(name: string): {
  engine: Engine
  rm: RelayManager
  send: ReturnType<typeof vi.fn>
} {
  const rm = new RelayManager('')
  const engine = new Engine(name, createStubAgent(), [createStubPlatform()], '', 'en')
  engine.relayManager = rm
  const send = vi.spyOn(rm, 'send')
  return { engine, rm, send }
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
  const agent = stubAgent(ctx, `relay-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerRelayTool(ctx, route)
  return { ctx, agent, dispose }
}

async function execute(
  test: Harness,
  args: unknown,
  agent: Agent = test.agent,
): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    signal,
    callId: CallId(`call-${Math.random()}`),
    name: 'feishu_bridge_relay',
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

describe('feishu_bridge_relay registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:chat' }))
    expect(test.ctx.tools.get('feishu_bridge_relay')?.name).toBe('feishu_bridge_relay')
    const schema = test.ctx.tools.get('feishu_bridge_relay')?.parameters as {
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.properties?.action?.enum).toEqual(['send', 'bind', 'binding'])
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_relay')).toBeUndefined()
  })
})

describe('feishu_bridge_relay action routing', () => {
  it('send routes to RelayManager.send with the caller engine as from', async () => {
    const r = newRoutedEngine('proj-a')
    r.send.mockResolvedValue({ response: 'the other bot answered' })
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))
    const v = value(await execute(test, { action: 'send', to: 'proj-b', message: 'status?' }))
    expect(r.send).toHaveBeenCalledTimes(1)
    const req = r.send.mock.calls[0]?.[0] as RelayRequest
    expect(req.from).toBe('proj-a')
    expect(req.to).toBe('proj-b')
    expect(req.sessionKey).toBe('feishu:chat-9:u1')
    expect(req.message).toBe('status?')
    expect(v.message).toBe('the other bot answered')
  })

  it('send requires to and message', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    expect((await execute(test, { action: 'send', message: 'hi' })).isError).toBe(true)
    expect((await execute(test, { action: 'send', to: 'x' })).isError).toBe(true)
    expect(r.send).not.toHaveBeenCalled()
  })

  it('bind creates the binding for the routed chat and binding reports it', async () => {
    const r = newRoutedEngine('proj-a')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))

    const v = value(await execute(test, { action: 'bind', bots: 'proj-a, proj-b' }))
    expect(v.message).toContain('proj-a ↔ proj-b')
    expect(r.rm.getBinding('chat-9')?.bots).toEqual({ 'proj-a': 'proj-a', 'proj-b': 'proj-b' })

    const b = value(await execute(test, { action: 'binding' }))
    expect(b.message).toContain('proj-a ↔ proj-b')

    // An unbound chat reports the /bind hint.
    const r2 = newRoutedEngine('proj-c')
    const test2 = await harness(() => ({ engine: r2.engine, sessionKey: 'feishu:chat-none:u1' }))
    const none = value(await execute(test2, { action: 'binding' }))
    expect(none.message).toContain('/bind')
  })

  it('bind requires at least two bots', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const result = await execute(test, { action: 'bind', bots: 'only-me' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('at least 2')
  })

  it('surfaces manager failures to the model', async () => {
    const r = newRoutedEngine('proj-a')
    r.send.mockRejectedValue(new Error('relay: no binding for this chat. Use /bind <project> first'))
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))
    const result = await execute(test, { action: 'send', to: 'proj-b', message: 'hi' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('no binding')
  })
})

describe('feishu_bridge_relay caller routing', () => {
  it('fails loud for a caller the bridge does not own', async () => {
    const r = newRoutedEngine('test')
    const test = await harness((agent) => {
      const id = (agent as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && id === 'foreign-agent' ? undefined : { engine: r.engine, sessionKey: 'test:p' }
    })
    const foreign = stubAgent(test.ctx, 'foreign-agent')
    test.ctx.agents.register(foreign)
    const result = await execute(test, { action: 'binding' }, foreign)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not owned')
  })

  it('fails loud when the engine has no relay manager attached', async () => {
    const engine = new Engine('bare', createStubAgent(), [createStubPlatform()], '', 'en')
    const test = await harness(() => ({ engine, sessionKey: 'bare:p' }))
    const result = await execute(test, { action: 'binding' })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not available')
  })
})
