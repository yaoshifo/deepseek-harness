import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/** A context stub whose `get` answers with the given service table. */
function ctxWith(services: Record<string, unknown>, logger: { warn: MockInstance }): Context {
  return { get: (name: string) => services[name], logger } as unknown as Context
}

/** Fresh module import so the once-per-process warn flag starts unspent. */
async function freshMountDirectoryMcp(): Promise<
  typeof import('../src/child-agent.ts')['mountDirectoryMcp']
> {
  vi.resetModules()
  return (await import('../src/child-agent.ts')).mountDirectoryMcp
}

describe('mountDirectoryMcp', () => {
  let consoleWarn: MockInstance<typeof console.warn>

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarn.mockRestore()
    vi.resetModules()
  })

  it('warns exactly once through the structured logger when the mcp-workspace service is absent, keeping process stderr clean', async () => {
    const mountDirectoryMcp = await freshMountDirectoryMcp()
    const warn = vi.fn()
    await mountDirectoryMcp(ctxWith({}, { warn }), undefined as never)
    await mountDirectoryMcp(ctxWith({}, { warn }), undefined as never)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/mcp-workspace service is not mounted/)
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('mounts through the service and never warns when it is present', async () => {
    const mountDirectoryMcp = await freshMountDirectoryMcp()
    const mount = vi.fn().mockResolvedValue(undefined)
    const warn = vi.fn()
    const childCtx = ctxWith({ mcpWorkspace: { mount } }, { warn })
    const child = undefined as never
    await mountDirectoryMcp(childCtx, child)
    expect(mount).toHaveBeenCalledExactlyOnceWith(childCtx, child)
    expect(warn).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })
})
