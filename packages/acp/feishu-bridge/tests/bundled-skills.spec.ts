/**
 * Bundled-skills auto-mount tests: the package's `skills/` directory must
 * register as an isolated provider on the real skill registry without any
 * profile wiring, and disposing the mounted fiber must unregister it (the
 * registry-contribution HMR-safety rule).
 *
 * @module dsh-feishu-bridge/tests-bundled-skills
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { mountBundledSkills } from '../src/index.ts'

const contexts: Context[] = []

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  return ctx
}

function skillNames(ctx: Context): Promise<string[]> {
  return ctx.skills.list().then(skills => skills.map(skill => skill.name))
}

describe('mountBundledSkills', () => {
  it('exposes the packaged skills through the isolated provider', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const names = await skillNames(ctx)
    expect(names).toContain('feishu-bridge-subtask')
    expect(names).toContain('tdd')
    const subtask = (await ctx.skills.list()).find(skill => skill.name === 'feishu-bridge-subtask')
    expect(subtask?.provider).toBe('feishu-bridge-skills')
    expect(subtask?.source).toBe('custom')
  })

  it('unregisters the provider when the mounted fiber is disposed', async () => {
    const ctx = await harness()
    const fiber = mountBundledSkills(ctx)
    expect(await skillNames(ctx)).toContain('feishu-bridge-subtask')
    await fiber.dispose()
    expect(await skillNames(ctx)).not.toContain('feishu-bridge-subtask')
  })

  it('lets a same-name project skill override the bundled entry', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const original = await ctx.skills.get('tdd')
    expect(original?.path).toContain('skills')
    // Same-name runtime registration (rank 250) wins over the custom root
    // (rank 300) within one layer, mirroring project overrides.
    const dispose = ctx.skills.register({
      name: 'tdd',
      description: 'override probe',
      source: 'runtime',
      content: 'overridden',
    })
    const overridden = await ctx.skills.get('tdd')
    expect(overridden?.source).toBe('runtime')
    dispose()
  })
})

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})
