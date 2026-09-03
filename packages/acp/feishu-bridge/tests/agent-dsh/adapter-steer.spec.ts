/**
 * dshAgentSession.steer: mid-turn text enters the agent's next-step inbox
 * (agent-loop steer primitive), unlike send()'s followup next-turn queue —
 * the /ps mid-turn append path.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-steer
 */

import { describe, expect, it } from 'vitest'
import {
  DshAgentAdapter,
  type DshAgentHandleLike,
  type DshAgentLike,
  type DshCreateOptionsLike,
  type DshContextLike,
} from '../../src/agent-dsh/adapter.ts'

/** A fake agent recording steer and followup calls. */
interface RecordingAgent extends DshAgentLike {
  steered: Array<{ content?: Array<{ type: string; text: string }> }>
  followedUp: number
}

function newHarness(): { ctx: DshContextLike; agent: RecordingAgent } {
  const agent: RecordingAgent = {
    id: 'agent-1',
    status: 'running',
    session: { snapshotEvents: () => [] },
    steered: [],
    followedUp: 0,
    followup(): void {
      agent.followedUp += 1
    },
    steer(message: unknown): void {
      agent.steered.push(message as { content?: Array<{ type: string; text: string }> })
    },
    cancel(): void {},
  }
  const handle: DshAgentHandleLike = { agent, dispose: async () => {} }
  const ctx: DshContextLike = {
    agents: {
      create: async (_options: DshCreateOptionsLike) => handle,
      resume: async () => handle,
      get: () => agent,
    },
    on: () => () => {},
    get: () => undefined,
  }
  return { ctx, agent }
}

function newAdapter(ctx: DshContextLike): DshAgentAdapter {
  return new DshAgentAdapter(ctx, {
    agentName: 'dsh',
    cwd: '/workspace/project',
    providers: [],
    activeProvider: '',
  })
}

describe('dshAgentSession.steer', () => {
  it('routes mid-turn text into the agent next-step inbox, not the followup queue', async () => {
    const { ctx, agent } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')

    session.steer('mid-turn note')

    expect(agent.steered).toHaveLength(1)
    expect(agent.steered[0]!.content?.[0]).toEqual({ type: 'text', text: 'mid-turn note' })
    expect(agent.followedUp).toBe(0)
  })

  it('keeps send() on the followup next-turn queue', async () => {
    const { ctx, agent } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')

    await session.send('a fresh turn', [], [])

    expect(agent.followedUp).toBe(1)
    expect(agent.steered).toHaveLength(0)
  })
})
