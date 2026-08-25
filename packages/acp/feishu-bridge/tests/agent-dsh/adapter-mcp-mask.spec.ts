/**
 * Per-project MCP tool visibility (ProjectConfig.mcpServers → adapter deny
 * mask): a project with an allowlist denies the `mcp__` tools of every other
 * server in each session it starts (setup-hook `tools.restrict`), forwards
 * the same deny list as the toolFilter of continuable subtask children
 * (children do not inherit the parent's restrictions), and leaves projects
 * without an allowlist untouched.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-mcp-mask
 */

import { describe, expect, it } from 'vitest'
import {
  DshAgentAdapter,
  mcpDenyList,
  type DshAgentHandleLike,
  type DshAgentLike,
  type DshCreateOptionsLike,
  type DshContextLike,
  type DshToolsLike,
} from '../../src/agent-dsh/adapter.js'

/** A fake agent enough of a handle for startSession/oneShotQuery paths. */
interface FakeAgent extends DshAgentLike {
  disposed: boolean
}

/** Recorded `tools.restrict` calls from scoped setup hooks. */
interface RecordedRestriction {
  allow?: readonly string[]
  deny?: readonly string[]
}

interface Harness {
  ctx: DshContextLike
  creates: DshCreateOptionsLike[]
  restricts: RecordedRestriction[]
  /** startContinuable requests recorded by the fake subagents service. */
  continuableSpecs: Array<{
    provider: string
    request: { prompt: Array<Record<string, unknown>>; toolFilter?: { deny?: readonly string[] } }
  }>
  tools: DshToolsLike
}

/** The live tool surface a real composition would expose. */
const toolNames = [
  'bash',
  'read',
  'skill',
  'mcp__srvA__add',
  'mcp__srvA__admin_reset_1a2b3c4d5e6f',
  'mcp__srvB__echo',
  'mcp__shared__lookup',
]

/**
 * One harness for all three masked funnels: agents.create invokes the setup
 * hook against a fake agent scope (its `tools` view is unrestricted — no
 * restriction exists yet, exactly the real setup-time view), the plain
 * context exposes the same tools service for the child-spawn deny
 * computation, and a fake subagents service records continuable requests.
 * The oneshot turn loop is scripted like adapter-oneshot's harness.
 */
function createHarness(scriptedReply?: string): Harness {
  const creates: DshCreateOptionsLike[] = []
  const restricts: RecordedRestriction[] = []
  const continuableSpecs: Harness['continuableSpecs'] = []
  const tools: DshToolsLike = {
    schemas: () => toolNames.map(name => ({ name })),
    get: name => toolNames.includes(name) ? { name } : undefined,
    restrict: (filter) => {
      restricts.push(filter)
      return () => {}
    },
  }
  const listeners = new Map<string, Array<(session: { id: unknown }, event: Record<string, unknown>) => void>>()
  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    const { type, ...data } = event
    for (const l of listeners.get('session/event') ?? []) {
      l({ id: sessionId }, { type, seq: 0, time: 0, data })
    }
  }
  const agents: FakeAgent[] = []
  const counter = { n: 0 }
  const agentCtx = {
    get: (name: string): unknown => name === 'tools' ? tools : undefined,
  }
  const ctx: DshContextLike = {
    agents: {
      create: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        counter.n += 1
        const id = `agent-${counter.n}`
        const agent: FakeAgent = {
          id,
          status: 'idle',
          session: { events: [] },
          disposed: false,
          followup: () => {
            if (scriptedReply === undefined) return
            void Promise.resolve().then(() => {
              emit(id, { type: 'assistant/message', message: { content: [{ type: 'text', text: scriptedReply }] } })
              emit(id, { type: 'turn/end', reason: { kind: 'stop' } })
            })
          },
          steer: () => {},
          cancel: () => {},
        }
        agents.push(agent)
        if (options.setup !== undefined) {
          void options.setup(agentCtx as unknown as Parameters<NonNullable<DshCreateOptionsLike['setup']>>[0])
        }
        const handle: DshAgentHandleLike = {
          agent,
          dispose: async () => { agent.disposed = true },
        }
        return handle
      },
      resume: async (options: DshCreateOptionsLike) => {
        creates.push(options)
        const rid = options.resumeSessionId
        const agent: FakeAgent = {
          id: typeof rid === 'string' ? rid : 'resumed',
          status: 'idle',
          session: { events: [] },
          disposed: false,
          followup: () => {},
          steer: () => {},
          cancel: () => {},
        }
        agents.push(agent)
        if (options.setup !== undefined) {
          void options.setup(agentCtx as unknown as Parameters<NonNullable<DshCreateOptionsLike['setup']>>[0])
        }
        return { agent, dispose: async () => { agent.disposed = true } }
      },
      get: (id: unknown) => agents.find(a => a.id === String(id) && !a.disposed),
    },
    on: (event: string, listener: (...args: never[]) => unknown) => {
      const list = listeners.get(event) ?? []
      list.push(listener as (session: { id: unknown }, event: Record<string, unknown>) => void)
      listeners.set(event, list)
      return () => {}
    },
    get: (name: string): unknown => {
      if (name === 'tools') return tools
      if (name === 'subagents') {
        return {
          startContinuable: async (spec: Harness['continuableSpecs'][number]) => {
            continuableSpecs.push(spec)
            return { childId: 'child-1' }
          },
          followup: async () => {},
          interrupt: () => {},
          reportFrom: async () => {},
        }
      }
      return undefined
    },
  }
  return { ctx, creates, restricts, continuableSpecs, tools }
}

function newAdapter(harness: Harness, mcpServers?: readonly string[]): DshAgentAdapter {
  return new DshAgentAdapter(harness.ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
    activeProvider: 'glm',
    ...(mcpServers !== undefined ? { mcpServers } : {}),
  })
}

describe('mcpDenyList', () => {
  it('denies every mcp__ tool outside the allowlist, identity suffix included', () => {
    expect(mcpDenyList(toolNames, ['srvA'])).toEqual(['mcp__srvB__echo', 'mcp__shared__lookup'])
  })

  it('keeps first-party tools and returns empty when all mcp tools are allowed', () => {
    expect(mcpDenyList(toolNames, ['srvA', 'srvB', 'shared'])).toEqual([])
  })

  it('returns empty for an empty allowlist (unrestricted project)', () => {
    expect(mcpDenyList(toolNames, [])).toEqual([])
  })

  it('ignores non-mcp names regardless of the allowlist', () => {
    expect(mcpDenyList(['bash', 'read'], ['srvA'])).toEqual([])
  })
})

describe('adapter MCP mask', () => {
  it('a plain session denies other servers\' mcp tools in the setup hook', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness, ['srvA'])
    await adapter.startSession('')
    expect(harness.restricts).toEqual([{ deny: ['mcp__srvB__echo', 'mcp__shared__lookup'] }])
  })

  it('a resumed session recomputes the mask', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness, ['srvB'])
    await adapter.startSession('agent-9')
    expect(harness.restricts).toEqual([{ deny: ['mcp__srvA__add', 'mcp__srvA__admin_reset_1a2b3c4d5e6f', 'mcp__shared__lookup'] }])
  })

  it('a chatroom bare persona intersects the skill deny with the MCP mask', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness, ['shared'])
    await adapter.startSession('', {
      sessionKey: 'feishu:oc_1:ou_9',
      chatroom: { role: true, directRole: false, moderator: false, ledgerDir: '', research: false },
    })
    // Two independent restrictions on one scope intersect: the persona's
    // skill deny and the project's MCP deny coexist.
    expect(harness.restricts).toEqual([
      { deny: ['skill'] },
      { deny: ['mcp__srvA__add', 'mcp__srvA__admin_reset_1a2b3c4d5e6f', 'mcp__srvB__echo'] },
    ])
  })

  it('a project without an allowlist never restricts', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness)
    await adapter.startSession('')
    expect(harness.restricts).toEqual([])
  })

  it('a one-shot query session carries the same mask', async () => {
    const harness = createHarness('ok')
    const adapter = newAdapter(harness, ['srvA'])
    await adapter.lightweightQuery('hi', 'glm')
    expect(harness.restricts).toEqual([{ deny: ['mcp__srvB__echo', 'mcp__shared__lookup'] }])
  })

  it('a continuable subtask child forwards the deny list as its toolFilter', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness, ['srvA'])
    const parent = await adapter.startSession('')
    expect(harness.restricts).toHaveLength(1)
    harness.restricts.length = 0
    await adapter.startContinuableChild({
      provider: 'spawn',
      prompt: 'do work\nand report',
      cwd: '/workspace/project',
      workspace: undefined,
      maxDepth: 2,
      parentAgentSessionID: parent.currentSessionID(),
    })
    expect(harness.continuableSpecs).toHaveLength(1)
    expect(harness.continuableSpecs[0]?.request.toolFilter).toEqual({ deny: ['mcp__srvB__echo', 'mcp__shared__lookup'] })
  })

  it('a continuable child of an unrestricted project passes no toolFilter', async () => {
    const harness = createHarness()
    const adapter = newAdapter(harness)
    const parent = await adapter.startSession('')
    await adapter.startContinuableChild({
      provider: 'fork',
      prompt: 'side task',
      cwd: '/workspace/project',
      workspace: undefined,
      maxDepth: 2,
      parentAgentSessionID: parent.currentSessionID(),
    })
    expect(harness.continuableSpecs[0]?.request.toolFilter).toBeUndefined()
  })
})
