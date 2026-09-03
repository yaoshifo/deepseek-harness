/**
 * M7-c assembly wiring tests: the provider/predict/session-misc config
 * blocks (predict_next #33, turn_summary, reset_on_idle, auto_compress,
 * filter_external_sessions, provider_shortcuts, /provider persistence)
 * forward from the plugin Config into the engine and adapter.
 *
 * @module dsh-feishu-bridge/tests-assembly-misc
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { buildProjectAssembly, type FeishuBridgeConfig, type ProjectConfig } from '../src/index.ts'
import { createStubCardPlatform, newStubMessage } from './stubs/engine-stubs.ts'

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
      turbo: { route: 'turbo-route', model: 'zhipuai/glm-5.3' },
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

function assemble(cfg: FeishuBridgeConfig, proj: ProjectConfig = project(), root = '/tmp/fb-root') {
  return buildProjectAssembly(stubContext(), cfg, proj, root)
}

describe('predict-next / turn-summary wiring', () => {
  it('predict_next forwards enabled/provider/model/timeout/prompt/mode (Go wirePredictNext)', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      predictNext: { enabled: true, provider: 'turbo', timeoutSec: 90, prompt: 'P', mode: 'resume' },
    })
    expect(engine.predictNextEnabled).toBe(true)
    expect(engine.predictNextProvider).toBe('turbo')
    expect(engine.predictNextModel).toBe('zhipuai/glm-5.3') // resolved from the provider table
    expect(engine.predictNextTimeout).toBe(90_000)
    expect(engine.predictNextPrompt).toBe('P')
    expect(engine.predictNextResume).toBe(true)
  })

  it('predict_next defaults to a 120s timeout and lightweight mode', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      predictNext: { enabled: true, provider: 'turbo' },
    })
    expect(engine.predictNextTimeout).toBe(120_000)
    expect(engine.predictNextResume).toBe(false)
  })

  it('predict_next disabled by default', () => {
    expect(assemble(baseConfig()).engine.predictNextEnabled).toBe(false)
  })

  it('turn_summary forwards enabled/provider/timeout/prompt (Go wireTurnSummary)', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      turnSummary: { enabled: true, provider: 'turbo', timeoutSec: 45, prompt: 'S' },
    })
    expect(engine.turnSummaryEnabled).toBe(true)
    expect(engine.turnSummaryProvider).toBe('turbo')
    expect(engine.turnSummaryTimeout).toBe(45_000)
    expect(engine.turnSummaryPrompt).toBe('S')
  })

  it('turn_summary defaults to a 30s timeout', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      turnSummary: { enabled: true },
    })
    expect(engine.turnSummaryTimeout).toBe(30_000)
  })
})

describe('session misc wiring', () => {
  it('reset_on_idle_mins forwards as milliseconds', () => {
    const { engine } = assemble(baseConfig(), { ...project(), resetOnIdleMins: 90 })
    expect(engine.resetOnIdle).toBe(90 * 60_000)
  })

  it('auto_compress forwards enabled/max_tokens/min_gap (Go wireAutoCompress)', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      autoCompress: { enabled: true, maxTokens: 80_000, minGapMins: 60 },
    })
    expect(engine.autoCompressEnabled).toBe(true)
    expect(engine.autoCompressMaxTokens).toBe(80_000)
    expect(engine.autoCompressMinGap).toBe(60 * 60_000)
  })
})

describe('provider wiring', () => {
  it('provider_shortcuts register on the engine (Go SetProviderShortcuts)', () => {
    const { engine } = assemble(baseConfig(), {
      ...project(),
      providerShortcuts: { strong: 'mify-dsh', weak: 'turbo' },
    })
    expect(engine.providerShortcuts).toEqual({ strong: 'mify-dsh', weak: 'turbo' })
  })

  it('the /provider family, /btw and /compress commands are registered', () => {
    const { engine } = assemble(baseConfig())
    expect(engine.commandResolver?.('provider')).toBe('provider')
    expect(engine.commandResolver?.('btw')).toBe('btw')
    expect(engine.commandResolver?.('compress')).toBe('compress')
  })

  it('a provider-card action pins the assembled adapter route for that chat (Go executeCardAction "/provider")', async () => {
    // Isolated root: the card action persists the switch into the project
    // state, which must not leak into the shared-default-root assemblies.
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-provider-card-'))
    const { engine, adapter } = assemble(baseConfig(), project(), root)
    expect(adapter.getActiveProvider()?.name).toBe('mify-dsh')
    const p = createStubCardPlatform('test')
    await engine.handleCardAction(p, {
      ...newStubMessage(),
      sessionKey: 'smoke-project:chat1',
      replyCtx: 'ctx',
    }, 'act:/provider turbo')
    expect(adapter.getActiveProvider('smoke-project:chat1')?.name).toBe('turbo')
    // Other chats and the project default keep the configured route.
    expect(adapter.getActiveProvider('smoke-project:chat2')?.name).toBe('mify-dsh')
    expect(adapter.getActiveProvider()?.name).toBe('mify-dsh')
    // The pressed card is replaced by the re-rendered provider card.
    expect(p.sentCards).toHaveLength(1)
    expect(JSON.stringify(p.sentCards[0])).toContain('turbo')
  })

  it('a provider-card hot action keeps the agent session id (Go --resume semantics)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-provider-hot-'))
    const { engine, adapter } = assemble(baseConfig(), project(), root)
    const p = createStubCardPlatform('test')
    const s = engine.sessions.getOrCreateActive('smoke-project:chat1')
    s.setAgentSessionID('agent-sid-9', 'dsh')
    await engine.handleCardAction(p, {
      ...newStubMessage(),
      sessionKey: 'smoke-project:chat1',
      replyCtx: 'ctx',
    }, 'act:/provider turbo -r')
    expect(adapter.getActiveProvider('smoke-project:chat1')?.name).toBe('turbo')
    expect(s.getAgentSessionID()).toBe('agent-sid-9')
  })

  it('a persisted per-chat provider override survives assembly; unset chats fall back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fb-assembly-provider-'))
    const proj = { ...project(), agent: { provider: 'mify-dsh' } }
    const first = assemble(baseConfig(), proj, root)
    first.engine.providerSaveFunc?.('smoke-project:chat1', 'turbo')
    // The save hook persisted the override to the project state store.
    const second = assemble(baseConfig(), proj, root)
    expect(second.adapter.getActiveProvider('smoke-project:chat1')?.name).toBe('turbo')
    expect(second.adapter.getActiveProvider('smoke-project:chat2')?.name).toBe('mify-dsh')
  })
})
