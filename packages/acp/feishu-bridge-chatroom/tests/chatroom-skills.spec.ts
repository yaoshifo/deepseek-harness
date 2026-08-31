/**
 * The package's bundled-skills mount: the `skills/` directory registers as
 * an isolated, cwd-scoped provider on the real skill registry through the
 * plugin apply (visible only under the enabled projects' base workdirs), and
 * disposing the plugin fiber unregisters it (the registry-contribution
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
import { Engine, FeishuBridgeService, registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { apply, inject, name } from '../src/index.ts'
import { createStubAgent } from './stubs/engine-stubs.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A live context with one enabled project (workdir /workspace/chatroom-skills). */
async function harness(): Promise<{ ctx: Context; workdir: string }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FeishuBridgeService)
  const workdir = '/workspace/chatroom-skills'
  const engine = new Engine('skills-project', createStubAgent(), [], '', 'en')
  engine.setBaseWorkDir(workdir)
  registerSessionCommands(engine)
  ctx.get('feishuBridge')?.registerProject({ engine, adapter: {} as never })
  ctx.get('feishuBridge')?.markReady()
  return { ctx, workdir }
}

function namesAt(ctx: Context, cwd: string): Promise<string[]> {
  return ctx.skills.list({ cwd }).then(skills => skills.map(skill => skill.name))
}

describe('bundled chatroom skills', () => {
  it('exposes the packaged chatroom-moderator skill under the enabled project\'s workdir', async () => {
    const { ctx, workdir } = await harness()
    await ctx.plugin({ name, inject, apply }, {})

    const names = await namesAt(ctx, workdir)
    expect(names).toContain('feishu-bridge-chatroom-moderator')
    const skill = (await ctx.skills.list({ cwd: workdir })).find(entry => entry.name === 'feishu-bridge-chatroom-moderator')
    expect(skill?.provider).toBe('feishu-bridge-chatroom-skills')
    expect(skill?.source).toBe('custom')
    // A session outside the enabled workdir sees no entry at all.
    expect(await namesAt(ctx, '/workspace/elsewhere')).not.toContain('feishu-bridge-chatroom-moderator')
  })

  it('unregisters the provider when the plugin fiber is disposed', async () => {
    const { ctx, workdir } = await harness()
    const fiber = await ctx.plugin({ name, inject, apply }, {})
    expect(await namesAt(ctx, workdir)).toContain('feishu-bridge-chatroom-moderator')
    await fiber.dispose()
    expect(await namesAt(ctx, workdir)).not.toContain('feishu-bridge-chatroom-moderator')
  })
})
