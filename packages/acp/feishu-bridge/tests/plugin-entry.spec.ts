import { describe, expect, it } from 'vitest'
import * as entry from '../src/index.js'

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
