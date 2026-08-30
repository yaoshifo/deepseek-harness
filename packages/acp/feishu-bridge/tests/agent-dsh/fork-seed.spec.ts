/**
 * seedablePrefix (fork-seed): the /fork seed when the parent session still has
 * an in-flight turn — the balanced cut inside that turn plus synthetic closure
 * events, so the child inherits the flying turn's user input, completed steps,
 * and a dangling tool call settled as aborted. A log with no in-flight turn
 * keeps the historical completed-turn prefix byte for byte.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { seedablePrefix } from '../../src/agent-dsh/fork-seed.js'

/** Build a bare event with minimal data fields for the type at hand. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map(e => e.type)
}

describe('seedablePrefix', () => {
  it('returns the completed-turn prefix unchanged when no turn is in flight', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', 3, { turn: 2 }),
      ev('user/message', 4),
      ev('turn/end', 5, { turn: 2, reason: { kind: 'completed' } }),
    ]
    expect(seedablePrefix(log)).toEqual(log)
  })

  it('drops a bare in-flight turn/start with nothing user-visible inside', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', 3, { turn: 2 }),
    ]
    expect(seedablePrefix(log)).toEqual(log.slice(0, 3))
  })

  it('keeps an in-flight turn with only a user message and closes it synthetically', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
      ev('turn/start', 3, { turn: 2 }),
      ev('user/message', 4),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'turn/end', 'turn/start', 'user/message', 'turn/end',
    ])
    const closer = seed.at(-1)!
    expect(closer.seq).toBe(5)
    expect(closer.time).toBe(4)
    expect(closer.data).toEqual({ turn: 2, reason: { kind: 'interrupted' } })
  })

  it('settles a dangling tool call in the open step and closes step and turn', () => {
    // The ask_user_question-blocked shape from the 2026-08-30 incident: the
    // flying turn has completed steps, then an open step whose assistant
    // message carries a tool call with no result.
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3),
      ev('tool/call', 4, { turn: 1, step: 1, callId: 'call-a', name: 'bash' }),
      ev('tool/result', 5, { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-a' } } }),
      ev('step/end', 6, { turn: 1, step: 1 }),
      ev('step/start', 7, { turn: 1, step: 2 }),
      ev('assistant/message', 8),
      ev('tool/call', 9, { turn: 1, step: 2, callId: 'call-ask', name: 'ask_user_question' }),
      ev('agent/inbox/spliced', 10),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/result',
      'step/end', 'step/start', 'assistant/message', 'tool/call',
      'tool/result', 'step/end', 'turn/end',
    ])
    const settled = seed[10]! as SessionEvent<'tool/result'>
    expect(settled.seq).toBe(10)
    expect(settled.time).toBe(9)
    expect(settled.data).toEqual({
      turn: 1, step: 2,
      message: {
        source: { kind: 'tool', callId: 'call-ask' },
        content: [{
          type: 'tool-result', toolCallId: 'call-ask', isError: true,
          content: [{ type: 'text', text: 'Error: tool call aborted' }],
        }],
        role: 'user', id: expect.any(String) as unknown,
      },
      error: { name: 'AbortError', code: 'ABORTED' },
    })
    expect(seed[11]!.data).toEqual({ turn: 1, step: 2 })
    expect((seed[12]! as SessionEvent<'turn/end'>).data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
    expect(seed[12]!.time).toBe(9)
  })

  it('settles each of several parallel dangling calls in call order', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3),
      ev('tool/call', 4, { turn: 1, step: 1, callId: 'call-1', name: 'bash' }),
      ev('tool/call', 5, { turn: 1, step: 1, callId: 'call-2', name: 'grep' }),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/call',
      'tool/result', 'tool/result', 'step/end', 'turn/end',
    ])
    expect((seed[6]! as SessionEvent<'tool/result'>).data.message.source.callId).toBe('call-1')
    expect((seed[7]! as SessionEvent<'tool/result'>).data.message.source.callId).toBe('call-2')
    expect(seed.slice(6).map(e => e.seq)).toEqual([6, 7, 8, 9])
  })

  it('settles only the calls still missing results when a sibling call resolved', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3),
      ev('tool/call', 4, { turn: 1, step: 1, callId: 'call-1', name: 'bash' }),
      ev('tool/result', 5, { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'call-1' } } }),
      ev('tool/call', 6, { turn: 1, step: 1, callId: 'call-2', name: 'ask_user_question' }),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'tool/call', 'tool/result',
      'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    expect((seed[7]! as SessionEvent<'tool/result'>).data.message.source.callId).toBe('call-2')
    // seq stays contiguous across the cut: original events 0..6 then synthetics
    expect(seed.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('keeps a formed assistant message with no calls and closes step and turn', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3),
      ev('agent/inbox/spliced', 4),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(seed[4]!.data).toEqual({ turn: 1, step: 1 })
    expect(seed[5]!.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
    // the trailing splice stays out: the child gets its own first message
    expect(seed.some(e => e.type === 'agent/inbox/spliced')).toBe(false)
  })

  it('drops an open step holding only streaming chunks and cuts at the last completed step', () => {
    const log = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1),
      ev('step/start', 2, { turn: 1, step: 1 }),
      ev('assistant/message', 3),
      ev('step/end', 4, { turn: 1, step: 1 }),
      ev('step/start', 5, { turn: 1, step: 2 }),
      ev('assistant/chunk', 6),
      ev('assistant/chunk', 7),
    ]
    const seed = seedablePrefix(log)
    expect(types(seed)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(seed[5]!.seq).toBe(5)
    expect(seed[5]!.time).toBe(4)
    expect(seed[5]!.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
  })

  it('produces a seed the dsh-session boundary accepts (real event shapes)', async () => {
    const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
    const msgId = (n: string): string => `00000000-0000-4000-8000-${n.padStart(12, '0')}`
    // The incident log with full durable shapes: a completed turn, then a
    // flying turn whose open step blocks on an unanswered ask_user_question.
    const log: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 2, surfaceOp: 'append',
        data: {
          id: msgId('1'), role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: '完成率 = 实际平仓手数 / 理论平仓手数' }],
        },
      } as SessionEvent,
      { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 3, time: 4, surfaceOp: 'append',
        data: {
          message: {
            id: msgId('2'), role: 'assistant',
            source: { kind: 'model', provider: 'glm', model: 'glm-5.3' },
            content: [{ type: 'text', text: '我来验证' }],
          },
        },
      } as SessionEvent,
      { type: 'tool/call', seq: 4, time: 5, data: { turn: 1, step: 1, callId: 'call-run', name: 'bash', arguments: '{}' } } as SessionEvent,
      {
        type: 'tool/result', seq: 5, time: 6, surfaceOp: 'append', sourceEventSeqs: [4],
        data: {
          turn: 1, step: 1,
          message: {
            id: msgId('3'), role: 'user', source: { kind: 'tool', callId: 'call-run' },
            content: [{
              type: 'tool-result', toolCallId: 'call-run',
              content: [{ type: 'text', text: 'ok' }],
            }],
          },
        },
      } as SessionEvent,
      { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 1, step: 2 } },
      {
        type: 'assistant/message', seq: 8, time: 9, surfaceOp: 'append',
        data: {
          message: {
            id: msgId('4'), role: 'assistant',
            source: { kind: 'model', provider: 'glm', model: 'glm-5.3' },
            content: [{ type: 'text', text: '验证发现不一致，需要调整哪些？' }],
          },
        },
      } as SessionEvent,
      { type: 'tool/call', seq: 9, time: 10, data: { turn: 1, step: 2, callId: 'call-ask', name: 'ask_user_question', arguments: '{}' } } as SessionEvent,
    ]
    const seed = seedablePrefix(log)
    const child = Session.create(SessionId('fork-child'), seed)
    // the constructor appends session/end-seed after the borrowed events
    expect(child.events.slice(0, seed.length).map(e => e.type)).toEqual(seed.map(e => e.type))
    expect(child.events.at(-1)!.type).toBe('session/end-seed')
    expect(seed.at(-1)!.data).toEqual({ turn: 1, reason: { kind: 'interrupted' } })
  })
})
