/**
 * dshAgentSession.steer: mid-turn text enters the agent's next-step inbox
 * (agent-loop steer primitive), unlike send()'s followup next-turn queue —
 * the /ps mid-turn append path. steer returns the minted message id so the
 * engine can track the pickup reaction until the durable user/message event
 * of the claim projects steer_claimed (the text reached a model request).
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

  it('returns the minted steer message id', async () => {
    const { ctx, agent } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')

    const id = session.steer('mid-turn note')

    expect(id).not.toBe('')
    expect((agent.steered[0] as { id?: string }).id).toBe(id)
  })
})

describe('dshAgentSession steer-claim projection', () => {
  /** Project one durable user/message event for the given message id. */
  function userMessage(dsh: { projectSessionEvent(event: Record<string, unknown>): void }, id: string, seq: number): void {
    dsh.projectSessionEvent({
      type: 'user/message',
      seq,
      time: seq,
      data: { id, role: 'user', content: [{ type: 'text', text: 'steered text' }], source: { kind: 'user' } },
    })
  }

  it('projects the claimed steer as a steer_claimed channel event', async () => {
    const { ctx } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')
    const dsh = session as unknown as { projectSessionEvent(event: Record<string, unknown>): void }
    const id = session.steer('steered text')

    userMessage(dsh, id, 1)
    const r = await session.events().receive()

    expect(r.done).toBe(false)
    if (!r.done) {
      expect(r.event.type).toBe('steer_claimed')
      expect(r.event.steerMessageID).toBe(id)
    }
  })

  it('does not project user messages that were never steered', async () => {
    const { ctx } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')
    const dsh = session as unknown as { projectSessionEvent(event: Record<string, unknown>): void }

    userMessage(dsh, 'a-normal-turn-prompt', 1)
    const id = session.steer('steered text')
    userMessage(dsh, id, 2)
    await session.close()

    const first = await session.events().receive()
    expect(first.done).toBe(false)
    if (!first.done) expect(first.event.steerMessageID).toBe(id)
    // Only the steered claim produced an event: the unsteered prompt id is
    // silent, and the channel is otherwise empty.
    const second = await session.events().receive()
    expect(second.done).toBe(true)
  })

  it('claims each steered id exactly once', async () => {
    const { ctx } = newHarness()
    const a = newAdapter(ctx)
    const session = await a.startSession('')
    const dsh = session as unknown as { projectSessionEvent(event: Record<string, unknown>): void }
    const id = session.steer('steered text')

    userMessage(dsh, id, 1)
    userMessage(dsh, id, 2) // a replayed projection of the same claim
    await session.close()

    const first = await session.events().receive()
    expect(first.done).toBe(false)
    if (!first.done) expect(first.event.steerMessageID).toBe(id)
    const second = await session.events().receive()
    expect(second.done).toBe(true)
  })
})
