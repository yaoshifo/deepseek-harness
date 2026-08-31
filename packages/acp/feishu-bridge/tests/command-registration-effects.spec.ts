/**
 * Registrations-are-effects wiring test: every register*Commands call in
 * buildProjectAssembly must run through ctx.effect, so disposing the fiber
 * unregisters the commands (HMR/plugin reload) instead of leaving a dead
 * engine's command table live.
 *
 * @module dsh-feishu-bridge/tests-command-registration-effects
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, type FeishuBridgeConfig } from '../src/index.js'
import { Engine } from '../src/engine/engine.js'

function config(): FeishuBridgeConfig {
  return {
    projects: [
      {
        name: 'smoke-project',
        workdir: '/workspace/project',
        feishu: { appId: 'cli_test', appSecret: 'sec' },
        monitor: { enabled: true },
      },
    ],
    providers: { 'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' } },
    // The shared scheduler/manager sections gate the conditional cron/relay
    // command registrations; without them only the per-project tables mount.
    cron: {},
    relay: {},
    dataDir: mkdtempSync(join(tmpdir(), 'fb-cmd-effects-')),
  }
}

describe('command registrations are effects', () => {
  it('fiber.dispose() unregisters the engine commands mounted by apply()', async () => {
    const startSpy = vi.spyOn(Engine.prototype, 'start').mockResolvedValue(undefined)
    const stopSpy = vi.spyOn(Engine.prototype, 'stop').mockResolvedValue(undefined)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)

      await apply(ctx, config())
      const bridge = ctx.get('feishuBridge')
      if (bridge === undefined) throw new Error('feishuBridge service missing after apply()')
      const engine = bridge.projects[0]?.engine
      if (engine === undefined) throw new Error('project engine missing after apply()')
      // The full command table is mounted: session base, one registerCommand
      // migration per family, and the conditional cron/relay pair.
      expect(engine.commandHandlers?.has('new')).toBe(true)
      expect(engine.commandHandlers?.has('reload')).toBe(true)
      expect(engine.commandHandlers?.has('board')).toBe(true)
      expect(engine.commandHandlers?.has('cron')).toBe(true)
      expect(engine.commandHandlers?.has('bind')).toBe(true)
      expect(engine.commandHandlers?.has('monitor')).toBe(true)

      await ctx.fiber.dispose()

      expect(engine.commandHandlers).toBeUndefined()
      expect(engine.commandResolver).toBeUndefined()
    } finally {
      startSpy.mockRestore()
      stopSpy.mockRestore()
    }
  })
})
