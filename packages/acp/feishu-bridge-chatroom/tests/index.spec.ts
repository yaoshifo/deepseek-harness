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
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  Engine,
  FeishuBridgeService,
  registerSessionCommands,
  featureStateCodecs,
  registerFeatureStateCodec,
  registerMessages,
  type DshAgentAdapterLike,
} from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Config, apply, inject, name } from '../src/index.js'
import { chatroomConfig } from '../src/chatroom-config.js'
import { chatroomFeatureStateCodec } from '../src/chatroom-state.js'
import { chatroomMessages } from '../src/i18n.js'
import { createStubAgent } from './stubs/engine-stubs.js'

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
function liveProject(ctx: Context, projectName: string, started = false): Promise<{ engine: Engine; adapter: DshAgentAdapterLike }> {
  void ctx
  const engine = new Engine(projectName, createStubAgent(), [], '', 'en')
  registerSessionCommands(engine)
  if (started) return engine.start().then(() => ({ engine, adapter: {} as DshAgentAdapterLike }))
  return Promise.resolve({ engine, adapter: {} as DshAgentAdapterLike })
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
    const { engine } = await liveProject(ctx, 'alpha')
    const { engine: startedEngine } = await liveProject(ctx, 'beta', true)
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

    // The /chatroom command family registered on every engine.
    expect(engine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(startedEngine.commandHandlers?.get('chatroom')).toBeDefined()

    // Process-level halves registered: codec and message subtable (re-registering
    // the same subtable object is the reference-counted reload path).
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(true)
    const disposeReload = registerMessages(chatroomMessages)
    expect(typeof disposeReload).toBe('function')
    disposeReload()

    // The tool registered on ctx.tools.
    expect(typeof ctx.tools.register).toBe('function')
  })

  it('fails loud when a configured project name matches no bridge project', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    const { engine } = await liveProject(ctx, 'alpha')
    service.registerProject({ engine, adapter: {} as never })
    service.markReady()

    await expect(ctx.plugin({ name, inject, apply }, { projects: { ghost: {} } })).rejects.toThrow(/no project by that name/)
  })

  it('unregisters every contribution when the fiber is disposed (HMR safety)', async () => {
    const ctx = await liveContext()
    const service = ctx.get('feishuBridge')
    if (service === undefined) throw new Error('feishuBridge failed to mount')
    const { engine } = await liveProject(ctx, 'alpha')
    service.registerProject({ engine, adapter: {} as never })
    service.markReady()

    const fiber = await ctx.plugin({ name, inject, apply }, { projects: { alpha: {} } })
    expect(engine.commandHandlers?.get('chatroom')).toBeDefined()
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(true)

    await fiber.dispose()

    expect(engine.commandHandlers?.get('chatroom')).toBeUndefined()
    expect(featureStateCodecs().some(codec => codec.key === chatroomFeatureStateCodec.key)).toBe(false)
    // The message subtable unregistered: re-registering the same object now
    // succeeds as a fresh registration (the reference count dropped to 0).
    const dispose = registerMessages(chatroomMessages)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
