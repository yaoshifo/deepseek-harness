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
