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
    expect(names).toContain('codebase-design')
    const subtask = (await ctx.skills.list()).find(skill => skill.name === 'feishu-bridge-subtask')
    expect(subtask?.provider).toBe('feishu-bridge-skills')
    expect(subtask?.source).toBe('custom')
  })

  it('pins the subtask skill plan-mode guidance to the real tool name and an obligation, not a claimed gate', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const skill = await ctx.skills.get('feishu-bridge-subtask')
    // The dsh tool's registered name is exit_plan_mode; the Go-era
    // ExitPlanMode spelling must not come back (2026-09-12 audit #1).
    expect(skill?.content).not.toContain('ExitPlanMode')
    expect(skill?.content).toContain('exit_plan_mode')
    // Plan mode does not mechanically block execution spawns — the skill
    // states the obligation instead, with read-only exploration exempt
    // (2026-09-14 audit F2).
    expect(skill?.content).toContain('plan mode **不会**拦住它')
    expect(skill?.content).toContain('批准退出前不得派发改写型 child')
  })

  it('pins the tdd skill to dsh tool names and the synced tautology guard', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const skill = await ctx.skills.get('tdd')
    // The dsh tool is `skill` (lowercase); "the Skill tool" is another
    // agent's vocabulary and must not come back through skill syncs.
    expect(skill?.content).toContain('the `skill` tool')
    expect(skill?.content).not.toContain('the Skill tool')
    // The reference-only rewrite carries the tautological-test anti-pattern;
    // a regression to the pre-rewrite body loses it.
    expect(skill?.content).toContain('Tautological')
  })

  it('pins the grill description to the non-code trigger surface', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const skill = await ctx.skills.get('grill')
    // The catalog renders name plus description only; a description narrowed
    // back to code-shaped asks stops firing grill on non-code deliverables
    // (proposals, reports, plans, selections).
    expect(skill?.description).toContain('功能、方案、报告、策划、选型')
  })

  it('pins prototype as a deploy-side original the upstream skill must not overwrite', async () => {
    const ctx = await harness()
    mountBundledSkills(ctx)
    const skill = await ctx.skills.get('prototype')
    // The upstream skills repo ships an unrelated English "prototype"
    // (LOGIC.md/UI.md branches, capture-on-a-throwaway-branch rule 6);
    // this one is written for the deployment's grill → prototype →
    // tdd/diagnose flow with a delete-after-folding rule 6. A sync that
    // copies the upstream file over this deploy-side original fails here.
    expect(skill?.content).toContain('原型代码绝不迁移进产品')
    expect(skill?.content).not.toContain('LOGIC.md')
    expect(skill?.content).not.toContain('primary source')
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
