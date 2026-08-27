import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as entry from '../src/index.js'
import { apply } from '../src/index.js'

describe('plugin entry declaration', () => {
  it('declares the agents service inject (ctx.agents access requires it)', () => {
    // Cordis refuses ctx.agents without the declaration; this regressed live
    // on the M1 记账驴 cut-over ("cannot get property 'agents' without inject").
    expect(entry.inject).toContain('agents')
  })

  it('exports the plugin name matching the bundle row id', () => {
    expect(entry.name).toBe('feishu-bridge')
  })
})

describe('config schema defaults (loader resolveConfig path)', () => {
  const projectRow = (extras: Record<string, unknown> = {}) => ({
    name: 'p',
    workdir: '/tmp',
    feishu: { appId: 'app', appSecret: 'secret' },
    ...extras,
  })

  type Validated = { projects: Array<{ interactiveIdleTimeoutMins?: number }> }

  const validate = (config: unknown): Validated => {
    const result = entry.Config['~standard'].validate(config)
    if ('then' in result) throw new TypeError('unexpected async validation')
    if (result.issues) throw new Error(`validation issues: ${JSON.stringify(result.issues)}`)
    return result.value as Validated
  }

  it('fills interactiveIdleTimeoutMins with 120 when absent', () => {
    expect(validate({ projects: [projectRow()] }).projects[0]?.interactiveIdleTimeoutMins).toBe(120)
  })

  it('keeps an explicit interactiveIdleTimeoutMins, including 0', () => {
    expect(validate({ projects: [projectRow({ interactiveIdleTimeoutMins: 30 })] }).projects[0]?.interactiveIdleTimeoutMins).toBe(30)
    expect(validate({ projects: [projectRow({ interactiveIdleTimeoutMins: 0 })] }).projects[0]?.interactiveIdleTimeoutMins).toBe(0)
  })
})

describe('chatroom config residue guard (moved to the chatroom plugin)', () => {
  /** A minimal live context the bridge apply can boot on. */
  async function liveContext(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  it('keeps the chatroom key through schema validation so apply can fail loud', () => {
    // Schema.any keeps the value instead of stripping it like an unknown
    // key — the residue detection below depends on this.
    const validate = (config: unknown): Record<string, unknown> => {
      const result = entry.Config['~standard'].validate(config)
      if ('then' in result) throw new TypeError('unexpected async validation')
      if (result.issues) throw new Error(`validation issues: ${JSON.stringify(result.issues)}`)
      return result.value as Record<string, unknown>
    }
    const kept = validate({
      projects: [{ name: 'p', workdir: '/tmp', feishu: { appId: 'app', appSecret: 'secret' }, chatroom: { rolesDir: '/roles' } }],
      providers: {},
      chatroom: { rolesDir: '/roles' },
    })
    expect((kept.projects as Array<Record<string, unknown>>)[0]?.chatroom).toEqual({ rolesDir: '/roles' })
    expect(kept.chatroom).toEqual({ rolesDir: '/roles' })
  })

  it('apply fails loud on a top-level chatroom section', async () => {
    const ctx = await liveContext()
    try {
      await expect(apply(ctx, {
        projects: [],
        providers: {},
        chatroom: { rolesDir: '/roles' },
      })).rejects.toThrow(/chatroom config moved to the chatroom plugin/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('apply fails loud on a per-project chatroom section', async () => {
    const ctx = await liveContext()
    try {
      await expect(apply(ctx, {
        projects: [{ name: 'p', workdir: '/tmp', feishu: { appId: 'app', appSecret: 'secret' }, chatroom: { rolesDir: '/roles' } }],
        providers: {},
      })).rejects.toThrow(/still carries a chatroom section/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
