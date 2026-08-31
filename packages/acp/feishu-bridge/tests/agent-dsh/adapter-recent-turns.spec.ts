/**
 * DshAgentAdapter recent-turn projection tests: the conversation window the
 * retired bridge-side history copy used to provide now folds out of the
 * native session log — live sessions maintain an incremental window seeded
 * from the resumed log, cold sessions fold persistence.inspect once and
 * cache.
 *
 * @module dsh-feishu-bridge/tests-agent-dsh-adapter-recent-turns
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldRecentTurns } from '../../src/agent-dsh/adapter.ts'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike } from '../../src/agent-dsh/adapter.ts'


let messageSeq = 0

function userEvent(text: string, kind = 'user'): SessionEvent {
  return {
    type: 'user/message',
    seq: messageSeq++,
    time: 1_700_000_000_000 + messageSeq,
    data: {
      id: `m-${messageSeq}` as never,
      role: 'user',
      content: [{ type: 'text', text }],
      source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'x' },
    },
  }
}

function assistantEvent(text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq: messageSeq++,
    time: 1_700_000_000_000 + messageSeq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m-${messageSeq}` as never,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
  }
}

function turnEnd(): SessionEvent {
  return {
    type: 'turn/end',
    seq: messageSeq++,
    time: 1_700_000_000_000 + messageSeq,
    data: { turn: 1, reason: { kind: 'completed' } },
  }
}

/** One user turn plus one assistant reply, as a compact event list. */
function conversation(pairs: Array<[string, string]>): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const [user, assistant] of pairs) {
    events.push(userEvent(user), assistantEvent(assistant), turnEnd())
  }
  return events
}

describe('foldRecentTurns', () => {
  it('folds one user entry per human prompt and one assistant entry per turn', () => {
    const folded = foldRecentTurns(conversation([
      ['first question', 'first answer'],
      ['second question', 'second answer'],
    ]))
    expect(folded.map(e => [e.role, e.content])).toEqual([
      ['user', 'first question'],
      ['assistant', 'first answer'],
      ['user', 'second question'],
      ['assistant', 'second answer'],
    ])
  })

  it('skips synthetic injections and joins a turn\'s assistant messages', () => {
    const events: SessionEvent[] = [
      userEvent('real prompt'),
      userEvent('injected AGENTS.md context', 'plugin'),
      assistantEvent('partial...'),
      assistantEvent('final answer'),
      turnEnd(),
    ]
    const folded = foldRecentTurns(events)
    expect(folded.map(e => [e.role, e.content])).toEqual([
      ['user', 'real prompt'],
      ['assistant', 'partial...final answer'],
    ])
  })

  it('bounds the window to the cap, keeping the trailing entries', () => {
    const pairs = Array.from({ length: 60 }, (_, i) => [`q${i}`, `a${i}`] as [string, string])
    const folded = foldRecentTurns(conversation(pairs), 100)
    expect(folded).toHaveLength(100)
    expect(folded[0]?.content).toBe('q10')
    expect(folded[folded.length - 1]?.content).toBe('a59')
  })
})

function fakeHandle(events: SessionEvent[], id = 'cc-live-1'): { handle: DshAgentHandleLike; agent: DshAgentLike } {
  const agent: DshAgentLike = {
    id,
    status: 'idle',
    session: { events },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
  }
  return { handle: { agent, dispose: async () => {} }, agent }
}

describe('DshAgentAdapter.recentTurns', () => {
  it('serves a live session from the incrementally maintained window', async () => {
    const seeded = conversation([['seeded question', 'seeded answer']])
    const { handle } = fakeHandle(seeded)
    const adapter = new DshAgentAdapter(
      {
        agents: { create: async () => { throw new Error('unused') }, resume: async () => handle, get: () => undefined },
        on: () => () => {},
        get: () => undefined,
      },
      { agentName: 'a', cwd: '/w', providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )

    // A live session's window is seeded at startSession (resume path) and
    // grows with the routed native events.
    const session = await adapter.startSession('cc-live-1')
    let folded = await adapter.recentTurns('cc-live-1', 0)
    expect(folded.map(e => [e.role, e.content])).toEqual([
      ['user', 'seeded question'],
      ['assistant', 'seeded answer'],
    ])

    const projector = session as unknown as { projectSessionEvent(event: Record<string, unknown>): void }
    for (const event of conversation([['live question', 'live answer']])) {
      session.events().drain()
      projector.projectSessionEvent(event)
    }
    folded = await adapter.recentTurns('cc-live-1', 0)
    expect(folded.map(e => e.content)).toEqual(['seeded question', 'seeded answer', 'live question', 'live answer'])

    // Trailing limit slices the window.
    expect((await adapter.recentTurns('cc-live-1', 2)).map(e => e.content)).toEqual(['live question', 'live answer'])
  })

  it('folds a cold session from persistence once and caches the fold', async () => {
    const events = conversation([['cold question', 'cold answer']])
    let inspectCalls = 0
    const adapter = new DshAgentAdapter(
      {
        agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
        on: () => () => {},
        get: (name: string) => (name === 'sessionPersistence'
          ? {
            inspect: async () => {
              inspectCalls++
              return { meta: {} as never, events }
            },
          }
          : undefined),
      },
      { agentName: 'a', cwd: '/w', providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )

    const first = await adapter.recentTurns('cc-cold-1', 0)
    expect(first.map(e => [e.role, e.content])).toEqual([['user', 'cold question'], ['assistant', 'cold answer']])
    const second = await adapter.recentTurns('cc-cold-1', 0)
    expect(second).toEqual(first)
    expect(inspectCalls).toBe(1)
  })

  it('returns [] for an unknown id, an empty id, and a missing persistence service', async () => {
    const adapter = new DshAgentAdapter(
      {
        agents: { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') }, get: () => undefined },
        on: () => () => {},
        get: (name: string) => (name === 'sessionPersistence'
          ? { inspect: async () => { throw new Error('unknown session') } }
          : undefined),
      },
      { agentName: 'a', cwd: '/w', providers: [{ name: 'r', provider: 'p', model: 'm' }], activeProvider: 'r' },
    )
    await expect(adapter.recentTurns('', 0)).resolves.toEqual([])
    await expect(adapter.recentTurns('nope', 0)).resolves.toEqual([])
  })
})
