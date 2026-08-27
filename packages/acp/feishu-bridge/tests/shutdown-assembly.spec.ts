/**
 * Shutdown wiring test: the per-engine effect disposer must hand
 * `engine.stop()`'s promise back to Cordis so `fiber.dispose()` awaits the
 * stop notices and terminal-card PATCHes before the process exits. The
 * 2026-08-23 fb-envfix restart froze a running chatroom card in 思考中
 * because the disposer was `void engine.stop()` — `profile-boot.ts` exited
 * once the (all-synchronous) dispose chain drained, killing the in-flight
 * cleanup awaits.
 *
 * @module dsh-feishu-bridge/tests-shutdown-assembly
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

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-shutdown-'))
}

function config(): FeishuBridgeConfig {
  return {
    projects: [
      { name: 'smoke-project', workdir: '/workspace/project', feishu: { appId: 'cli_test', appSecret: 'sec' } },
    ],
    providers: { 'mify-dsh': { route: 'mify-dsh', model: 'glm-5.2' } },
    dataDir: tempDir(),
  }
}

describe('apply() engine shutdown wiring', () => {
  it('fiber.dispose() awaits engine.stop() so stop notices and terminal cards land before process exit', async () => {
    const startSpy = vi.spyOn(Engine.prototype, 'start').mockResolvedValue(undefined)
    let settleStop!: () => void
    const stopPromise = new Promise<void>((resolve) => { settleStop = resolve })
    const stopSpy = vi.spyOn(Engine.prototype, 'stop').mockReturnValue(stopPromise)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime)

      await apply(ctx, config())

      let disposed = false
      const disposing = ctx.fiber.dispose().then(() => { disposed = true })
      // The dispose chain runs the disposer synchronously; with the awaited
      // contract it must still be pending while engine.stop() is unsettled.
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(stopSpy).toHaveBeenCalledTimes(1)
      expect(disposed).toBe(false)

      settleStop()
      await disposing
      expect(disposed).toBe(true)
    } finally {
      startSpy.mockRestore()
      stopSpy.mockRestore()
    }
  })
})
