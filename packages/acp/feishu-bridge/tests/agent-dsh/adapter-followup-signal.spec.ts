/**
 * followupChild signal regression: the adapter must pass an AbortSignal —
 * the runtime's followup dereferences it on the cold-resume arm (a child
 * that already settled to storage), and omitting it crashed every follow-up
 * to a settled child (2026-08-27 oc_56801302: two environment-hint sends
 * failed with "Cannot read properties of undefined (reading
 * 'throwIfAborted')" and the hints were never delivered).
 *
 * @module dsh-feishu-bridge/tests-adapter-followup-signal
 */

import { describe, expect, it } from 'vitest'
import { DshAgentAdapter, type DshAgentLike, type DshContextLike } from '../../src/agent-dsh/adapter.ts'

/** One recorded followup call against the fake subagents service. */
interface RecordedFollowup {
  parent: unknown
  child: unknown
  content: Array<Record<string, unknown>>
  source: Record<string, unknown>
  signal: AbortSignal | undefined
}

function createHarness(): {
  ctx: DshContextLike
  followups: RecordedFollowup[]
} {
  const followups: RecordedFollowup[] = []
  const agent: DshAgentLike = {
    id: 'parent-1',
    status: 'idle',
    session: { events: [] },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
  const ctx: DshContextLike = {
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => { throw new Error('resume not used in this suite') },
      get: (id: unknown) => String(id) === 'parent-1' ? agent : undefined,
    },
    on: () => () => {},
    get: (name: string): unknown => {
      if (name !== 'subagents') return undefined
      return {
        startContinuable: async () => ({ childId: 'child-1' }),
        followup: async (
          parent: unknown,
          child: unknown,
          content: Array<Record<string, unknown>>,
          options: { source: Record<string, unknown>; signal?: AbortSignal },
        ) => {
          followups.push({ parent, child, content, source: options.source, signal: options.signal })
        },
        interrupt: () => {},
        reportFrom: async () => {},
      }
    },
  }
  return { ctx, followups }
}

function newAdapter(ctx: DshContextLike): DshAgentAdapter {
  return new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
    activeProvider: 'glm',
  })
}

describe('followupChild signal', () => {
  it('passes a live AbortSignal so the runtime cold-resume arm cannot crash', async () => {
    const { ctx, followups } = createHarness()
    const adapter = newAdapter(ctx)

    await adapter.followupChild('parent-1', 'child-1', 'hint text')

    expect(followups).toHaveLength(1)
    expect(followups[0]?.content).toEqual([{ type: 'text', text: 'hint text' }])
    expect(followups[0]?.source.kind).toBe('coordinator')
    expect(followups[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(followups[0]?.signal?.aborted).toBe(false)
  })
})
