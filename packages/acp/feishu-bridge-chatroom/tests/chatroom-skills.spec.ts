/**
 * The package's bundled-skills mount: the `skills/` directory registers as
 * an isolated provider on the real skill registry through the plugin apply,
 * and disposing the plugin fiber unregisters it (the registry-contribution
 * HMR-safety rule).
 *
 * @module dsh-feishu-bridge-chatroom/tests-chatroom-skills
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FeishuBridgeService } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { apply, inject, name } from '../src/index.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A live context carrying the services the chatroom plugin needs. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FeishuBridgeService)
  ctx.get('feishuBridge')?.markReady()
  return ctx
}

describe('bundled chatroom skills', () => {
  it('exposes the packaged chatroom-moderator skill through the plugin apply', async () => {
    const ctx = await harness()
    await ctx.plugin({ name, inject, apply }, {})

    const skills = await ctx.skills.list()
    expect(skills.map(skill => skill.name)).toContain('feishu-bridge-chatroom-moderator')
    const skill = skills.find(entry => entry.name === 'feishu-bridge-chatroom-moderator')
    expect(skill?.provider).toBe('feishu-bridge-chatroom-skills')
    expect(skill?.source).toBe('custom')
  })

  it('unregisters the provider when the plugin fiber is disposed', async () => {
    const ctx = await harness()
    const fiber = await ctx.plugin({ name, inject, apply }, {})
    expect((await ctx.skills.list()).map(skill => skill.name)).toContain('feishu-bridge-chatroom-moderator')
    await fiber.dispose()
    expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('feishu-bridge-chatroom-moderator')
  })
})
