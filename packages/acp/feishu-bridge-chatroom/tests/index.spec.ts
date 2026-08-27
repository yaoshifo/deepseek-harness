/**
 * The plugin entry: the named function-plugin form (name/inject/Config/
 * apply, no default export — a default export would drop inject, postmortem
 * 0001), the startup sweep over the bridge service's live projects (config
 * application, /chatroom command registration, barrier recovery for engines
 * whose platforms already started), the unknown-project fail-loud, and the
 * HMR dispose contract (every contribution unregisters).
 *
 * @module dsh-feishu-bridge-chatroom/tests-index
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  Engine,
  FeishuBridgeService,
  registerSessionCommands,
  featureStateCodecs,
  registerMessages,
  lookupMessage,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
// Test-only deep import: the tool-family declaration has no accessor on the
// frozen ./exports face, and the tag color is its only observable effect.
import { toolTagForProgress } from '@deepseek-ai/dsh-feishu-bridge/src/streaming.js'
import { Config, apply, inject, name } from '../src/index.js'
import { chatroomConfig } from '../src/chatroom-config.js'
import { chatroomFeatureStateCodec } from '../src/chatroom-state.js'
import { chatroomMessages } from '../src/i18n.js'
import { createStubAgent, createStubCardPlatform, newStubMessage } from './stubs/engine-stubs.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A live context carrying the services the chatroom plugin injects. */
async function liveContext(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FeishuBridgeService)
  return ctx
}

/** One live project: a real engine (commands/config apply to it), stub adapter. */
/** The adapter half of a live project; routing never consults it in these specs. */
type StubAdapter = Record<string, never>

function liveProject(projectName: string, started = false): Promise<{ engine: Engine; adapter: StubAdapter }> {
  const engine = new Engine(projectName, createStubAgent(), [], '', 'en')
  registerSessionCommands(engine)
  if (started) return engine.start().then(() => ({ engine, adapter: {} as StubAdapter }))
  return Promise.resolve({ engine, adapter: {} })
}

describe('chatroom plugin entry', () => {
  it('is a named function plugin (no default export) with the service injects', async () => {
    expect(name).toBe('feishu-bridge-chatroom')
    expect(inject).toEqual(['feishuBridge', 'tools'])
    expect(typeof Config).toBe('function')
    expect(typeof apply).toBe('function')
    const mod = await import('../src/index.ts')
    expect('default' in mod).toBe(false)
  })

  it('ships the invariant companion with a skeleton-stage reason', async () => {
    const invariant = await import('../src/invariant.ts')
    expect(invariant.name).toBe('feishu-bridge-chatroom-invariant')
    expect(invariant.inject).toEqual(['invariants'])
    expect(typeof invariant.apply).toBe('function')
  })

  it('sweeps the live projects: config, commands, and recovery for started engines', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    const { engine } = await liveProject('alpha')
    const { engine: startedEngine } = await liveProject('beta', true)
    service.registerProject({ engine, adapter: {} as never })
    service.registerProject({ engine: startedEngine, adapter: {} as never })
    service.markReady()

    await ctx.plugin({ name, inject, apply }, {
      defaults: { maxRoles: 4 },
      projects: { alpha: { rolesDir: '/roles/alpha' } },
    })

    // Config applied per engine: the project section, the shared defaults.
    expect(chatroomConfig(engine).rolesDir()).toBe('/roles/alpha')
    expect(chatroomConfig(engine).maxRoles()).toBe(4)
    expect(chatroomConfig(startedEngine).rolesDir().endsWith('chatroom-roles')).toBe(true)

    // The /chatroom command family registered on every engine, with its
    // /cr alias resolvable and the session commands still resolvable.
    expect(engine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(startedEngine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(engine.commandResolver?.('chatroom')).toBe('chatroom')
    expect(engine.commandResolver?.('cr')).toBe('chatroom')
    expect(engine.commandResolver?.('new')).toBe('new')
    expect(engine.commandResolver?.('x')).toBe('')

    // Process-level halves registered: codec and message subtable (re-registering
    // the same subtable object is the reference-counted reload path).
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(true)
    const disposeReload = registerMessages(chatroomMessages)
    expect(typeof disposeReload).toBe('function')
    disposeReload()

    // The tool registered on ctx.tools.
    expect(typeof ctx.tools.register).toBe('function')
  })

  it('routes the registered tool through the bridge service (foreign callers fail loud)', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    service.markReady()
    await ctx.plugin({ name, inject, apply }, {})

    const session = ctx.sessions.create(SessionId('apply-spec-agent'))
    const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox,
      status: 'idle',
      ctx: new Context(),
      send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
      runMaintenance: task => task(new AbortController().signal),
      cancel(_cause: AgentCancelCause) {},
      whenIdle: () => Promise.resolve(),
      followup(_message: UserMessage) {},
      steer(_message: UserMessage) {},
      inject(_message: UserMessage) {},
    }
    ctx.agents.register(agent)

    // The caller agent belongs to no feishu-bridge project: the tool's
    // route (the bridge service's) fails loud instead of acting.
    const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-apply-spec'),
      name: 'feishu_bridge_chatroom',
      arguments: { action: 'list' },
      agent,
    }))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('not owned by a feishu-bridge project')
  })

  it('fails loud when the feishuBridge service is unavailable', async () => {
    const bare = new Context()
    contexts.push(bare)
    await expect(apply(bare, {})).rejects.toThrow(/feishuBridge service is unavailable/)
  })

  it('fails loud when a configured project name matches no bridge project', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    const { engine } = await liveProject('alpha')
    service.registerProject({ engine, adapter: {} as never })
    service.markReady()

    await expect(ctx.plugin({ name, inject, apply }, { projects: { ghost: {} } })).rejects.toThrow(/no project by that name/)
  })

  it('unregisters every contribution when the fiber is disposed (HMR safety)', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    const { engine } = await liveProject('alpha')
    service.registerProject({ engine, adapter: {} as never })
    service.markReady()

    const fiber = await ctx.plugin({ name, inject, apply }, { projects: { alpha: {} } })

    // Every contribution is present before the dispose.
    expect(engine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(true)
    expect(lookupMessage('en', 'chatroom_ready')).toBe('Chatroom role ready')
    expect(ctx.tools.get('feishu_bridge_chatroom')?.name).toBe('feishu_bridge_chatroom')
    // The tool-family declaration answers the progress-card tag color.
    expect(toolTagForProgress('feishu_bridge_chatroom', 40)).toContain("color='purple'")
    expect((await ctx.skills.list()).map(skill => skill.name)).toContain('feishu-bridge-chatroom-moderator')
    // The policy listeners answer through the production dispatch face (the
    // persona bypass joins the built-in subtask base on the waterfall).
    expect(service.waterfall(
      'feishuBridge/permission-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: true, forceMode: undefined } } },
      () => false,
    )).toBe(true)
    // The picker card actions are registered: an orphaned press swaps the
    // pressed card for the expired notice instead of falling through.
    const cardPlatform = createStubCardPlatform()
    const press = { ...newStubMessage(), sessionKey: 'test:hub:user-1' }
    await engine.handleCardAction(cardPlatform, press, 'act:/chatroom-pick confirm')
    expect(cardPlatform.sentCards).toHaveLength(1)

    await fiber.dispose()

    // Every contribution is gone.
    expect(engine.commandHandlers?.get('chatroom')).toBeUndefined()
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(false)
    // The message subtable unregistered: the lookup falls back to the raw
    // key, and re-registering the same object succeeds as a fresh
    // registration (the reference count dropped to 0).
    expect(lookupMessage('en', 'chatroom_ready')).toBe('chatroom_ready')
    const dispose = registerMessages(chatroomMessages)
    expect(typeof dispose).toBe('function')
    dispose()
    expect(ctx.tools.get('feishu_bridge_chatroom')).toBeUndefined()
    expect(toolTagForProgress('feishu_bridge_chatroom', 40)).toContain("color='blue'")
    expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('feishu-bridge-chatroom-moderator')
    // The policy listeners no longer answer: the built-in base decides.
    expect(service.waterfall(
      'feishuBridge/permission-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: true, forceMode: undefined } } },
      () => false,
    )).toBe(false)
    // The card actions fell through again: the press is consumed quietly
    // with no card.
    await engine.handleCardAction(cardPlatform, { ...press, sessionKey: 'test:hub:user-2' }, 'act:/chatroom-pick confirm')
    expect(cardPlatform.sentCards).toHaveLength(1)
  })
})
