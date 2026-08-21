/**
 * Fork-at locator (Go agent/dsh/fork.go locateForkCut/cutAfterTurn/
 * quoteTextMatch): given a parent session's event log and the quoted-message
 * locator (text / sender type / update time), find how many leading events a
 * rollback fork keeps — everything through the turn/end closing the turn that
 * contains the quoted message.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { locateForkCut } from '../../src/agent-dsh/fork-at.js'

interface EvSpec {
  type: string
  time?: number
  text?: string
}

/** Build a bare event; message events get a text block through the spec. */
function ev(spec: EvSpec, seq: number): SessionEvent {
  const data: Record<string, unknown> = spec.text === undefined
    ? {}
    : { content: [{ type: 'text', text: spec.text }] }
  return { type: spec.type, seq, time: spec.time ?? seq, data } as SessionEvent
}

function events(...specs: EvSpec[]): SessionEvent[] {
  return specs.map(ev)
}

/** assistant/message whose text lives under data.message.content. */
function assistant(text: string, time: number): EvSpec {
  return { type: 'assistant/message', time, text }
}

function user(text: string, time: number): EvSpec {
  return { type: 'user/message', time, text }
}

const MIN = 60 * 1000

describe('locateForkCut (time window)', () => {
  it('cuts after the turn/end closing the quoted assistant message', () => {
    const log = events(
      { type: 'turn/start' },
      user('fix the login bug', 1000),
      assistant('I will fix the login bug now', 2000),
      { type: 'tool/call' },
      { type: 'tool/result' },
      { type: 'turn/end' },
      { type: 'turn/start' },
      user('also fix the logout', 8000),
      assistant('logout fixed too', 9000),
      { type: 'turn/end' },
    )
    const keep = locateForkCut(log, { quotedText: '', senderType: 'app', quotedTimeMs: 2000 })
    // keeps through the FIRST turn/end; the second conversation is rolled back
    expect(keep).toBe(6)
    expect(log.slice(0, keep).map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end',
    ])
  })

  it('matches only assistant messages for an app quote', () => {
    const log = events(
      { type: 'turn/start' },
      user('question at noon', 12 * MIN),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant('answer an hour later', 72 * MIN),
      { type: 'turn/end' },
    )
    // the user message is nearer in time but the wrong sender; the assistant
    // message is outside the 10-minute window → no match
    expect(() => locateForkCut(log, { quotedText: '', senderType: 'app', quotedTimeMs: 12 * MIN }))
      .toThrow('no message within window')
  })

  it('matches only user messages for a user quote', () => {
    const log = events(
      { type: 'turn/start' },
      user('my question', 5000),
      assistant('my answer', 5100),
      { type: 'turn/end' },
    )
    const keep = locateForkCut(log, { quotedText: '', senderType: 'user', quotedTimeMs: 4900 })
    expect(keep).toBe(4)
  })

  it('a text match inside the window wins over a nearer non-matching message', () => {
    const log = events(
      { type: 'turn/start' },
      assistant('unrelated answer', 10 * MIN),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant('the quoted reply about the login bug', 18 * MIN),
      { type: 'turn/end' },
    )
    // quoted time is nearest the FIRST message, but only the second matches text
    const keep = locateForkCut(log, {
      quotedText: 'the quoted reply about the login bug',
      senderType: 'app',
      quotedTimeMs: 9 * MIN,
    })
    expect(keep).toBe(6)
  })

  it('falls back to the nearest message within the window', () => {
    const log = events(
      { type: 'turn/start' },
      assistant('first answer', 0),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant('second answer', 5 * MIN),
      { type: 'turn/end' },
    )
    // the second answer is nearer (1 min vs 4 min); the cut keeps its whole turn
    const keep = locateForkCut(log, { quotedText: 'matches nothing', senderType: 'app', quotedTimeMs: 4 * MIN })
    expect(keep).toBe(6)
  })

  it('rejects when no message is within the 10-minute window', () => {
    const log = events({ type: 'turn/start' }, assistant('old answer', 0), { type: 'turn/end' })
    expect(() => locateForkCut(log, { quotedText: '', senderType: 'app', quotedTimeMs: 30 * MIN }))
      .toThrow('no message within window')
  })
})

describe('locateForkCut (text only, no timestamp)', () => {
  it('keeps through the LAST matching message', () => {
    const log = events(
      { type: 'turn/start' },
      assistant('retry the sync', 1000),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant('retry the sync', 2000),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant('something else', 3000),
      { type: 'turn/end' },
    )
    const keep = locateForkCut(log, { quotedText: 'retry the sync', senderType: 'app', quotedTimeMs: 0 })
    expect(keep).toBe(6)
  })

  it('matches user and assistant messages alike', () => {
    const log = events(
      { type: 'turn/start' },
      user('plan approved', 1000),
      { type: 'turn/end' },
    )
    const keep = locateForkCut(log, { quotedText: 'plan approved', senderType: 'user', quotedTimeMs: 0 })
    expect(keep).toBe(3)
  })
})

describe('cutAfterTurn edge cases', () => {
  it('cuts before the next turn/start when the target turn never ended', () => {
    const log = events(
      { type: 'turn/start' },
      assistant('crashed mid-turn', 1000),
      { type: 'tool/call' },
      // no turn/end — the turn was interrupted
      { type: 'turn/start' },
      user('next turn', 2000),
      { type: 'turn/end' },
    )
    const keep = locateForkCut(log, { quotedText: 'crashed mid-turn', senderType: 'app', quotedTimeMs: 1000 })
    expect(keep).toBe(3)
  })

  it('keeps the whole log when the target turn has no closer at all', () => {
    const log = events({ type: 'turn/start' }, assistant('last words', 1000))
    const keep = locateForkCut(log, { quotedText: 'last words', senderType: 'app', quotedTimeMs: 1000 })
    expect(keep).toBe(2)
  })

  it('cuts before the next turn/start when the message sits before any turn marker', () => {
    const log = events(
      assistant('pre-turn message', 500),
      { type: 'turn/start' },
      user('later', 1000),
      { type: 'turn/end' },
    )
    // Go cutAfterTurn: no turn/start at-or-before the target → scan from the
    // target and stop at the first turn/start after it
    const keep = locateForkCut(log, { quotedText: 'pre-turn message', senderType: 'app', quotedTimeMs: 500 })
    expect(keep).toBe(1)
  })
})

describe('quoteTextMatch normalization', () => {
  it('matches a decorated and line-broken quote against the log text', () => {
    const log = events(
      { type: 'turn/start' },
      assistant('first line of the answer\nsecond line of the answer', 1000),
      { type: 'turn/end' },
    )
    // Feishu quotes collapse newlines and truncate with decoration
    const keep = locateForkCut(log, {
      quotedText: 'first line of the answer second line of the answer …',
      senderType: 'app',
      quotedTimeMs: 1000,
    })
    expect(keep).toBe(3)
  })

  it('compares only the leading 40 characters of the quote', () => {
    const log = events(
      { type: 'turn/start' },
      assistant(`${'a'.repeat(50)} tail one`, 1000),
      { type: 'turn/end' },
      { type: 'turn/start' },
      assistant(`${'a'.repeat(50)} tail two`, 2000),
      { type: 'turn/end' },
    )
    // both messages share the 40-char prefix; the LAST match wins, keeping its whole turn
    const keep = locateForkCut(log, {
      quotedText: `${'a'.repeat(50)} tail one differs after the prefix`,
      senderType: 'app',
      quotedTimeMs: 0,
    })
    expect(keep).toBe(6)
  })
})

describe('locator validation', () => {
  it('rejects when no locator is provided', () => {
    const log = events({ type: 'turn/start' }, user('hi', 1000), { type: 'turn/end' })
    expect(() => locateForkCut(log, { quotedText: '', senderType: 'app', quotedTimeMs: 0 }))
      .toThrow('no locator')
  })

  it('rejects when the quoted text matches nothing', () => {
    const log = events({ type: 'turn/start' }, user('hi', 1000), { type: 'turn/end' })
    expect(() => locateForkCut(log, { quotedText: 'absent', senderType: 'app', quotedTimeMs: 0 }))
      .toThrow('target turn not found')
  })
})
