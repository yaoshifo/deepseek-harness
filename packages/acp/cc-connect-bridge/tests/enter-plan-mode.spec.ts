import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ENTER_PLAN_MODE, registerEnterPlanMode } from '../src/enter-plan-mode.js'

/** The tool shape registerEnterPlanMode hands to ctx.tools.register. */
interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: unknown, exec: { agent?: unknown }) => Promise<unknown>
}

function harness(): { ctx: Context; tools: CapturedTool[]; set: ReturnType<typeof vi.fn> } {
  const tools: CapturedTool[] = []
  const set = vi.fn()
  const child = {
    tools: { register: vi.fn((def: unknown) => { tools.push(def as CapturedTool) }) },
    planMode: { set },
  }
  const ctx = {
    ...child,
    inject: vi.fn((_deps: string[], cb: (c: typeof child) => () => void) => {
      cb(child)
      return () => {}
    }),
  }
  registerEnterPlanMode(ctx as unknown as Context)
  return { ctx: ctx as unknown as Context, tools, set }
}

describe('registerEnterPlanMode', () => {
  it('injects the planMode and tools services', () => {
    const { ctx } = harness()
    expect(ctx.inject).toHaveBeenCalledWith(['planMode', 'tools'], expect.any(Function))
  })

  it('registers one enter_plan_mode tool with guidance and no required parameters', () => {
    const { tools } = harness()
    expect(tools).toHaveLength(1)
    const tool = tools[0]!
    expect(tool.name).toBe(ENTER_PLAN_MODE)
    expect(tool.description).not.toBe('')
    expect(tool.description).toContain('plan mode')
    // defineTool normalizes an empty parameters object to its canonical schema.
    expect(tool.parameters).toEqual({ type: 'object', properties: {} })
    expect(tool.output.render({}, { entered: true }).length).toBeGreaterThan(0)
  })

  it('switches the calling agent into plan mode and reports entered', async () => {
    const { tools, set } = harness()
    const agent = { session: { events: [] } }
    const result = await tools[0]!.execute({}, { agent })
    expect(set).toHaveBeenCalledWith(agent, true)
    expect(result).toEqual({ entered: true })
  })

  it('throws without a calling agent', async () => {
    const { tools } = harness()
    await expect(tools[0]!.execute({}, {})).rejects.toThrow(ENTER_PLAN_MODE)
  })
})
