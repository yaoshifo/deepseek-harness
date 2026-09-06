/**
 * The adapter's mcp-workspace absent notice rides the context's scoped
 * logger — the structured channel the entry composition points and the
 * subagent child-agent path already use — not raw console.warn: a legal
 * mcp-workspace-less deployment keeps process stderr clean, warn-once per
 * process with unchanged text.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-mcp-absent-warn
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DshAgentAdapter,
  type DshAgentHandleLike,
  type DshAgentLike,
  type DshContextLike,
} from '../../src/agent-dsh/adapter.ts'

const warnText = 'agent-dsh: the mcp-workspace service is not mounted; directory .mcp.json discovery is inactive (add the mcp-workspace plugin row to enable it)'

interface Harness {
  ctx: DshContextLike
  loggerWarn: ReturnType<typeof vi.fn>
  wraps: number
}

/** Minimal adapter harness: fresh creates only, an optional mcpWorkspace row. */
function createHarness(mcpWorkspace?: unknown): Harness {
  const loggerWarn = vi.fn()
  const wraps = { n: 0 }
  const agent: DshAgentLike = {
    id: 'a1',
    status: 'idle',
    session: { snapshotEvents: () => [] },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
  const handle: DshAgentHandleLike = { agent, dispose: async () => {} }
  const ctx: DshContextLike = {
    agents: {
      create: async () => handle,
      resume: async () => handle,
      get: () => undefined,
    },
    on: () => () => {},
    get: (name: string) => (name === 'mcpWorkspace' ? mcpWorkspace : undefined),
    logger: { warn: loggerWarn },
  }
  return {
    ctx,
    loggerWarn,
    get wraps() { return wraps.n },
    set wraps(n: number) { wraps.n = n },
  }
}

function newAdapter(harness: Harness): DshAgentAdapter {
  return new DshAgentAdapter(harness.ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
    activeProvider: 'glm',
  })
}

describe('mcp-workspace absent notice channel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once per process through the scoped logger when the service is absent', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = createHarness(undefined)
    await newAdapter(first).startSession('')
    const second = createHarness(undefined)
    await newAdapter(second).startSession('')
    expect(first.loggerWarn).toHaveBeenCalledTimes(1)
    expect(first.loggerWarn).toHaveBeenCalledWith(warnText)
    expect(second.loggerWarn).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('stays silent and wraps when the service is mounted', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let wraps = 0
    const harness = createHarness({ wrap: (setup: unknown) => { wraps += 1; return setup } })
    await newAdapter(harness).startSession('')
    expect(harness.loggerWarn).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(wraps).toBe(1)
  })
})
