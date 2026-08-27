/**
 * FeishuBridgeService unit tests: the live-project registry, caller
 * routing, and the dispatch delegation to the Cordis event bus.
 *
 * @module dsh-feishu-bridge/tests-bridge-service
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FeishuBridgeService, bareBridgeDispatch, ctxBridgeDispatch } from '../src/bridge-service.js'
import { registerChatroomPolicyListeners } from '../src/engine/chatroom-policy.js'
import type { DshAgentAdapter } from '../src/agent-dsh/adapter.js'
import { Engine } from '../src/engine/engine.js'
import { createStubAgent } from './stubs/engine-stubs.js'
import type { PendingAsk } from '../src/core/types.js'
import { unattendedSubtaskBypassesPermissions } from '../src/agent-dsh/adapter.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A minimal live-project entry: stub engine/adapter pairs routed by id. */
function liveProject(name: string, agentKey: string | undefined): { engine: Engine; adapter: DshAgentAdapter } {
  const engine = { name, ownsNativeChild: (id: string): boolean => id === `${name}-native` } as unknown as Engine
  const adapter = { engineKeyForAgentID: (id: string): string | undefined => (id === `${name}-agent` ? agentKey : undefined) } as unknown as DshAgentAdapter
  return { engine, adapter }
}

async function mountedService(): Promise<{ ctx: Context; service: FeishuBridgeService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FeishuBridgeService)
  const service = ctx.get('feishuBridge')
  if (service === undefined) throw new Error('feishuBridge service failed to mount')
  return { ctx, service }
}

describe('FeishuBridgeService', () => {
  it('mounts under ctx.feishuBridge and registers live projects', async () => {
    const { service } = await mountedService()
    expect(service.projects).toHaveLength(0)
    const entry = liveProject('p1', 'feishu:oc_1:ou_9')
    const dispose = service.registerProject(entry)
    expect(service.projects).toEqual([entry])
    dispose()
    expect(service.projects).toHaveLength(0)
  })

  it('routes a caller agent to its engine session (plan D4)', async () => {
    const { service } = await mountedService()
    service.registerProject(liveProject('p1', 'feishu:oc_1:ou_9'))
    service.registerProject(liveProject('p2', 'feishu:oc_2:ou_9'))

    expect(service.route({ id: 'p2-agent' })).toMatchObject({ sessionKey: 'feishu:oc_2:ou_9' })
    expect(service.route({ id: 'unknown-agent' })).toBeUndefined()
    expect(service.route({})).toBeUndefined()
  })

  it('routes native continuable children to the owning engine (de-baggage B4)', async () => {
    const { service } = await mountedService()
    const entry = liveProject('p1', undefined)
    service.registerProject(entry)

    const native = service.nativeRoute({ id: 'p1-native' })
    expect(native).toMatchObject({ engine: entry.engine, sessionKey: 'p1-native', nativeChildId: 'p1-native' })
    expect(service.nativeRoute({ id: 'p1-agent' })).toBeUndefined()
    expect(service.nativeRoute({ id: '' })).toBeUndefined()
  })

  it('whenReady resolves waiters at markReady and immediately afterwards', async () => {
    const { service } = await mountedService()
    let resolved = false
    void service.whenReady().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved, 'waiter registered before readiness pends').toBe(false)
    service.markReady()
    await Promise.resolve()
    expect(resolved).toBe(true)
    // Idempotent: later waiters (and repeat calls) resolve immediately.
    await expect(service.whenReady()).resolves.toBeUndefined()
    service.markReady()
  })

  it('delegates emit/waterfall/serial to the Cordis event bus', async () => {
    const { ctx, service } = await mountedService()
    const seen: string[] = []
    ctx.on('feishuBridge/platforms-ready', (payload) => { seen.push(`emit:${payload.engine.name}`) })
    service.emit('feishuBridge/platforms-ready', { engine: { name: 'e1' } as unknown as Engine })

    const bypass = service.waterfall('feishuBridge/permission-policy', { options: undefined }, () => unattendedSubtaskBypassesPermissions(undefined))
    expect(bypass).toBe(false)
    expect(seen).toEqual(['emit:e1'])

    const settled = await service.serial('feishuBridge/turn-start', { engine: {} as Engine, session: {} as never, metadata: undefined })
    expect(settled).toBeUndefined()
  })
})

describe('dispatch faces', () => {
  it('ctxBridgeDispatch reaches listeners registered on the context', () => {
    const ctx = new Context()
    contexts.push(ctx)
    registerChatroomPolicyListeners(ctx)
    const face = ctxBridgeDispatch(ctx)
    // The chatroom listener joins the built-in subtask base on the waterfall.
    expect(face.waterfall(
      'feishuBridge/permission-policy',
      { options: { sessionKey: 'k', persona: { prompt: 'p', bypassPermissions: true, forceMode: undefined } } },
      () => false,
    )).toBe(true)
    expect(face.waterfall('feishuBridge/permission-policy', { options: undefined }, () => false)).toBe(false)

    // Emit reaches a plain listener (platforms-ready carries a chatroom
    // recovery listener that needs a real engine; assert with a stub one).
    const plain = new Context()
    contexts.push(plain)
    const seen: string[] = []
    plain.on('feishuBridge/platforms-ready', (payload) => { seen.push(payload.engine.name) })
    ctxBridgeDispatch(plain).emit('feishuBridge/platforms-ready', { engine: { name: 'e1' } as unknown as Engine })
    expect(seen).toEqual(['e1'])
  })

  it('bareBridgeDispatch runs the built-in base with no listener and drops emits', async () => {
    const face = bareBridgeDispatch()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(face.waterfall('feishuBridge/mode-policy', { options: undefined, mode: 'plan' }, () => 'plan')).toBe('plan')
      expect(face.waterfall('feishuBridge/rename-exemption', { session: {} as never }, () => false)).toBe(false)
      face.emit('feishuBridge/platforms-ready', { engine: {} as Engine })
      expect(await face.serial('feishuBridge/turn-start', { engine: {} as Engine, session: {} as never, metadata: undefined })).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('chatroom seam events', () => {
  /** A parked questions ask stub the auto-default timer arms on. */
  function parkedAsk(): PendingAsk {
    return { request: { kind: 'questions', questions: [] }, answers: new Map(), resolve: () => {} }
  }

  it('ask-parked arms the research-manual timer only on a manual research moderator hub', () => {
    const ctx = new Context()
    contexts.push(ctx)
    registerChatroomPolicyListeners(ctx)
    const face = ctxBridgeDispatch(ctx)
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const hub = e.sessions.getOrCreateActive('test:hub:user-1')
    hub.setChatroomModerator(true)
    hub.setChatroomResearch(true)
    hub.setChatroomResearchMode('manual')
    const armed = parkedAsk()
    face.emit('feishuBridge/ask-parked', { engine: e, platform: undefined as never, sessionKey: 'test:hub:user-1', replyCtx: 'ctx', pending: armed })
    expect(armed.autoTimer).toBeDefined()
    clearTimeout(armed.autoTimer)

    // Not a research-manual hub: nothing arms.
    const plain = parkedAsk()
    face.emit('feishuBridge/ask-parked', { engine: e, platform: undefined as never, sessionKey: 'test:plain:user-1', replyCtx: 'ctx', pending: plain })
    expect(plain.autoTimer).toBeUndefined()

    // Bare base: the emit drops.
    const bare = parkedAsk()
    bareBridgeDispatch().emit('feishuBridge/ask-parked', { engine: e, platform: undefined as never, sessionKey: 'test:hub:user-1', replyCtx: 'ctx', pending: bare })
    expect(bare.autoTimer).toBeUndefined()
  })

  it('subtask-dispatched marks an awaiting research role, and only that', () => {
    const ctx = new Context()
    contexts.push(ctx)
    registerChatroomPolicyListeners(ctx)
    const face = ctxBridgeDispatch(ctx)
    const e = new Engine('test', createStubAgent(), [], '', 'en')

    const role = e.sessions.getOrCreateActive('test:role:user-1')
    role.setChatroomHubKey('test:hub:user-1')
    role.setResearchAwaitingAssistant(true)
    face.emit('feishuBridge/subtask-dispatched', { engine: e, parentSessionKey: 'test:role:user-1' })
    expect(role.getResearchDispatched()).toBe(true)

    // No awaiting assistant: the dispatch is not recorded.
    const idle = e.sessions.getOrCreateActive('test:idle:user-1')
    idle.setChatroomHubKey('test:hub:user-1')
    face.emit('feishuBridge/subtask-dispatched', { engine: e, parentSessionKey: 'test:idle:user-1' })
    expect(idle.getResearchDispatched()).toBe(false)

    // Bare base: the emit drops and nothing is marked.
    const bareRole = e.sessions.getOrCreateActive('test:bare:user-1')
    bareRole.setChatroomHubKey('test:hub:user-1')
    bareRole.setResearchAwaitingAssistant(true)
    bareBridgeDispatch().emit('feishuBridge/subtask-dispatched', { engine: e, parentSessionKey: 'test:bare:user-1' })
    expect(bareRole.getResearchDispatched()).toBe(false)
  })
})
