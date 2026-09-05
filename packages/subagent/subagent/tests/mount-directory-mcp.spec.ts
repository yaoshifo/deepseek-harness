import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/** A context stub whose `get` answers with the given service table. */
function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** Fresh module import so the once-per-process warn flag starts unspent. */
async function freshMountDirectoryMcp(): Promise<
  typeof import('../src/child-agent.ts')['mountDirectoryMcp']
> {
  vi.resetModules()
  return (await import('../src/child-agent.ts')).mountDirectoryMcp
}

describe('mountDirectoryMcp', () => {
  let warn: MockInstance<typeof console.warn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.resetModules()
  })

  it('warns exactly once when the mcp-workspace service is absent, then stays silent', async () => {
    const mountDirectoryMcp = await freshMountDirectoryMcp()
    await mountDirectoryMcp(ctxWith({}))
    await mountDirectoryMcp(ctxWith({}))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/mcp-workspace service is not mounted/)
  })

  it('mounts through the service and never warns when it is present', async () => {
    const mountDirectoryMcp = await freshMountDirectoryMcp()
    const mount = vi.fn().mockResolvedValue(undefined)
    const childCtx = ctxWith({ mcpWorkspace: { mount } })
    await mountDirectoryMcp(childCtx)
    expect(mount).toHaveBeenCalledExactlyOnceWith(childCtx)
    expect(warn).not.toHaveBeenCalled()
  })
})
