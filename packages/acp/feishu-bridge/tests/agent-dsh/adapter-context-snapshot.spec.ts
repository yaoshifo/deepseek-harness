/**
 * DshAgentAdapter.contextSnapshot tests: the ContextSnapshotReader capability
 * reads one consistent projection cut off a live native session — the
 * dsh-context timeline/headers keys and token-meter's
 * pressure/breakdown/usage keys — and yields undefined for an empty id, a
 * session without a live agent, or a host without the projection registry.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-context-snapshot
 */

import { describe, expect, it } from 'vitest'
import { DshAgentAdapter } from '../../src/agent-dsh/adapter.ts'
import type { DshAgentLike, DshAgentHandleLike } from '../../src/agent-dsh/adapter.ts'
import type { ContextSnapshotValues } from '../../src/context/types.ts'

/**
 * A fake live agent whose session object carries the registry-cut values it
 * should serve (the fake registry below reads them back off the session it
 * receives — the real registry folds the session's own log).
 */
function fakeAgent(id: string, values: Record<string, unknown>): DshAgentLike {
  const session = { events: [], values } as unknown as DshAgentLike['session']
  return {
    id,
    status: 'idle',
    session,
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
}

/**
 * An adapter over a fake ctx: `sessionProjections` (absent when
 * `registry: false`) serves the values stashed on the live agent's session.
 */
function adapterWith(agents: Record<string, DshAgentLike>, opts: { registry?: boolean } = {}): DshAgentAdapter {
  return new DshAgentAdapter(
    {
      agents: {
        create: async (): Promise<DshAgentHandleLike> => { throw new Error('unused') },
        resume: async (): Promise<DshAgentHandleLike> => { throw new Error('unused') },
        get: (id: unknown) => agents[String(id)],
      },
      on: () => () => {},
      get: (name: string) => {
        if (name !== 'sessionProjections' || opts.registry === false) return undefined
        return {
          snapshot: (session: { values?: Record<string, unknown> }): { values: Record<string, unknown> } =>
            ({ values: session.values ?? {} }),
        }
      },
    },
    { agentName: 'a', cwd: '/w', providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
  )
}

/** The wire-shaped values one fake registry cut serves. */
function fakeValues(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contextTimeline: {
      current: { system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 0, total: 10 },
      requests: [],
      events: [],
      contextWindow: 128_000,
    },
    contextPressure: { pressureTokens: 90_000, projectedTokens: 95_000, contextWindow: 128_000 },
    ...over,
  }
}

describe('DshAgentAdapter.contextSnapshot', () => {
  it('picks the five projection keys off a live session as one snapshot', () => {
    const values = fakeValues({
      contextHeaders: { headers: [{ seq: 1, time: 0, tools: [{ name: 'bash', tokens: 1_200 }] }] },
      contextBreakdown: { systemTokens: 1, toolsTokens: 2, messageTokens: 3 },
      tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    })
    const adapter = adapterWith({ 'cc-live-1': fakeAgent('cc-live-1', values) })
    // The wire keys rename onto the snapshot's camelCase fields, verbatim.
    expect(adapter.contextSnapshot('cc-live-1')).toEqual({
      timeline: values.contextTimeline,
      headers: values.contextHeaders,
      pressure: values.contextPressure,
      breakdown: values.contextBreakdown,
      usage: values.tokenUsage,
    } as ContextSnapshotValues)
  })

  it('omits absent keys instead of carrying undefined fields', () => {
    const adapter = adapterWith({
      'cc-live-1': fakeAgent('cc-live-1', { contextPressure: fakeValues().contextPressure }),
    })
    expect(adapter.contextSnapshot('cc-live-1')).toEqual({ pressure: fakeValues().contextPressure })
  })

  it('yields an all-absent snapshot for a live session whose host registered no context units', () => {
    const adapter = adapterWith({ 'cc-live-1': fakeAgent('cc-live-1', {}) })
    expect(adapter.contextSnapshot('cc-live-1')).toEqual({})
  })

  it('yields undefined for an empty id, a session without a live agent, or an unmounted registry', () => {
    expect(adapterWith({ 'cc-live-1': fakeAgent('cc-live-1', fakeValues()) }).contextSnapshot('')).toBeUndefined()
    expect(adapterWith({}).contextSnapshot('cc-cold-1')).toBeUndefined()
    expect(adapterWith({ 'cc-live-1': fakeAgent('cc-live-1', fakeValues()) }, { registry: false })
      .contextSnapshot('cc-live-1')).toBeUndefined()
  })
})
