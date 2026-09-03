/**
 * Fork-seed builder: the /fork seed of a parent session that may still have an
 * in-flight turn. The seed contract (dsh-session) admits no open turn/step and
 * no dangling tool call, so the in-flight turn is cut at its last balanced
 * point and closed with synthetic events — an aborted settle per dangling tool
 * call (the runtime's /stop settle shape), then step/end and turn/end. The
 * parent's own log is never touched.
 *
 * @module dsh-feishu-bridge/agent-dsh-fork-seed
 */

import { randomUUID } from 'node:crypto'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * The event at an index a `findIndex`/loop bound just proved in range. The
 * guard never fires on well-formed logs; it exists so index math needs no
 * non-null assertions.
 */
function at(events: readonly SessionEvent[], index: number): SessionEvent {
  const event = events[index]
  if (event === undefined) throw new Error(`fork-seed: event index ${index} out of range`)
  return event
}

/**
 * The seedable prefix of a session log: with no in-flight turn this is exactly
 * the historical completed-turn prefix (every event through the last
 * `turn/end`); an in-flight turn is cut at its last balanced point and closed
 * with synthetic events (see the module doc).
 *
 * @param events - the source session's event log (live snapshot or persisted view).
 * @returns the balanced seed events, contiguous from seq 0.
 */
export function seedablePrefix(events: readonly SessionEvent[]): SessionEvent[] {
  const lastEnd = events.findLastIndex(e => e.type === 'turn/end')
  const turnStart = events.findIndex((e, i) => i > lastEnd && e.type === 'turn/start')
  if (turnStart === -1) return events.slice(0, lastEnd + 1)
  const turn = numberOf((at(events, turnStart) as SessionEvent<'turn/start'>).data.turn)

  // Cut inside the open step (a step/start without its step/end) when it holds
  // a formed assistant message: through the last dangling tool call (rule a)
  // or through the message itself (rule b).
  const lastStepEnd = events.findLastIndex((e, i) => i > turnStart && e.type === 'step/end')
  const openStepStart = events.findIndex(
    (e, i) => i > (lastStepEnd === -1 ? turnStart : lastStepEnd) && e.type === 'step/start',
  )
  if (openStepStart !== -1) {
    const cut = openStepCut(events, openStepStart)
    if (cut !== undefined) {
      const step = numberOf((at(events, openStepStart) as SessionEvent<'step/start'>).data.step)
      const danglers = danglingCalls(events, openStepStart, cut)
      const time = at(events, cut).time
      const synthetics: SessionEvent[] = []
      let seq = SessionSeq(cut + 1)
      for (const call of danglers) {
        synthetics.push(syntheticToolResult(seq, time, turn, step, call.callId, call.seq))
        seq = SessionSeq(seq + 1)
      }
      synthetics.push({ type: 'step/end', seq, time, data: { turn, step } })
      synthetics.push(syntheticTurnEnd(SessionSeq(seq + 1), time, turn))
      return [...events.slice(0, cut + 1), ...synthetics]
    }
  }

  // The open step carries nothing formed (streaming chunks only): drop it and
  // close the turn after its last completed step.
  if (lastStepEnd > turnStart) {
    return [
      ...events.slice(0, lastStepEnd + 1),
      syntheticTurnEnd(SessionSeq(lastStepEnd + 1), at(events, lastStepEnd).time, turn),
    ]
  }

  // No completed step at all: keep the turn's user messages (the newest input
  // the child can still inherit), up to the first step/start.
  const firstStep = events.findIndex((e, i) => i > turnStart && e.type === 'step/start')
  const bound = firstStep === -1 ? events.length : firstStep
  let cut = -1
  for (let i = turnStart + 1; i < bound; i++) {
    if (events[i]?.type === 'user/message') cut = i
  }
  if (cut === -1) return events.slice(0, lastEnd + 1) // bare turn/start: drop it
  return [...events.slice(0, cut + 1), syntheticTurnEnd(SessionSeq(cut + 1), at(events, cut).time, turn)]
}

/**
 * The balanced cut index inside an open step: the last tool/call or tool/result
 * when the step's assistant message carries calls, else the message itself.
 * Undefined when the step has no formed assistant message (nothing durable to
 * keep).
 */
function openStepCut(events: readonly SessionEvent[], openStepStart: number): number | undefined {
  let lastCallish = -1
  let lastMessage = -1
  for (let i = openStepStart + 1; i < events.length; i++) {
    const type = events[i]?.type
    if (type === 'step/end' || type === 'turn/end') break
    if (type === 'tool/call' || type === 'tool/result') lastCallish = i
    if (type === 'assistant/message') lastMessage = i
  }
  if (lastCallish !== -1) return lastCallish
  return lastMessage === -1 ? undefined : lastMessage
}

/**
 * Calls inside the kept range with no matching tool/result. Only calls after
 * the last step/end can dangle — a completed step's calls are settled before
 * its step/end, and a synthetic result must stay inside its own step.
 */
function danglingCalls(
  events: readonly SessionEvent[], openStepStart: number, cut: number,
): { callId: string; seq: SessionSeq }[] {
  const settled = new Set<string>()
  const calls: { callId: string; seq: SessionSeq }[] = []
  for (const event of events.slice(openStepStart, cut + 1)) {
    if (event.type === 'tool/call' && typeof event.data.callId === 'string') {
      calls.push({ callId: event.data.callId, seq: event.seq })
    }
    if (event.type === 'tool/result') {
      const callId = (event.data.message as { source?: { callId?: unknown } } | undefined)?.source?.callId
      if (typeof callId === 'string') settled.add(callId)
    }
  }
  return calls.filter(call => !settled.has(call.callId))
}

/** The `turn`/`step` number an event carries, tolerant of absent data. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * A synthetic tool/result settling one dangling call — the exact shape the
 * runtime writes when /stop aborts a blocked tool (isError AbortError;
 * surfaceOp append; sourceEventSeqs cites the dangling call; the message id
 * is fresh per event).
 */
function syntheticToolResult(
  seq: SessionSeq, time: number, turn: number, step: number, callId: string, callSeq: SessionSeq,
): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time,
    surfaceOp: 'append',
    sourceEventSeqs: [callSeq],
    data: {
      turn,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: true,
          content: [{ type: 'text', text: 'Error: tool call aborted' }],
        }],
        role: 'user',
        id: randomUUID(),
      },
      error: { name: 'AbortError', code: 'ABORTED' },
    },
  } as SessionEvent
}

/** A synthetic turn/end closing the cut turn with the interrupted marker. */
function syntheticTurnEnd(seq: SessionSeq, time: number, turn: number): SessionEvent {
  return {
    type: 'turn/end',
    seq,
    time,
    data: { turn, reason: { kind: 'interrupted' } },
  }
}
