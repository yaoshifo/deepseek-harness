/**
 * Fork-at locator (Go agent/dsh/fork.go): given a parent session's event log
 * and the quoted-message locator, decide how many leading events a rollback
 * fork keeps — everything through the `turn/end` closing the turn that
 * contains the quoted message. Pure logic over `SessionEvent[]`; the adapter
 * owns the persistence copy around it.
 *
 * @module dsh-feishu-bridge/agent-dsh-fork-at
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** How to find the turn a rollback fork truncates to (Go forkAtLocator, minus the plan-basis mode). */
export interface ForkAtLocator {
  /** Quoted-message text as Feishu delivered it (truncated and decorated). */
  quotedText: string
  /** 'app' (assistant message) or 'user'; '' when the platform did not report it. */
  senderType: string
  /** Update time of the quoted message in unix ms (card PATCH time); 0 = unknown. */
  quotedTimeMs: number
}

/** How far a message event may sit from the quoted update time and still match (Go: 10 minutes). */
const MATCH_WINDOW_MS = 10 * 60 * 1000

/** Length of the normalized quote prefix that must appear in the log text (Go: 40). */
const QUOTE_PREFIX_CHARS = 40

/** Cap on the normalized text compared for both sides (Go: 60). */
const NORM_MAX_CHARS = 60

/**
 * Whether a message text plausibly corresponds to the quoted excerpt: Feishu
 * quotes truncate and decorate, so compare a normalized prefix (Go
 * quoteTextMatch).
 *
 * @param text - the log-side message text.
 * @param quoted - the quote as the platform delivered it.
 * @returns whether the two plausibly refer to the same message.
 */
function quoteTextMatch(text: string, quoted: string): boolean {
  const norm = (s: string): string => {
    let t = s.trim().replaceAll('\r', '').replaceAll('\n', ' ').trim()
    const runes = Array.from(t)
    if (runes.length > NORM_MAX_CHARS) t = runes.slice(0, NORM_MAX_CHARS).join('')
    return t
  }
  const q = norm(quoted)
  if (q === '') return false
  const prefix = Array.from(q).slice(0, QUOTE_PREFIX_CHARS).join('')
  return norm(text).includes(prefix)
}

/**
 * Concatenate the text blocks of one message event (Go firstTextBlock): an
 * `assistant/message` carries its blocks under `data.message.content`, a
 * `user/message` directly under `data.content`.
 *
 * @param event - the message event to read.
 * @returns the concatenated visible text; '' when the event has none.
 */
function firstTextBlock(event: SessionEvent): string {
  const data = event.data as Record<string, unknown> | null
  if (data === null || typeof data !== 'object') return ''
  let blocks: unknown = data.content
  if (!Array.isArray(blocks) && data.message !== null && typeof data.message === 'object') {
    const message = data.message as Record<string, unknown>
    blocks = message.content
  }
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') parts.push(b.text)
    }
  }
  return parts.join(' ')
}

/**
 * Keep everything through the `turn/end` closing the turn that contains
 * `target` (an open last turn keeps up to the next `turn/start` or the end of
 * the log — Go cutAfterTurn).
 *
 * @param events - the full parent log.
 * @param target - index of the quoted message event.
 * @returns the number of leading events to keep.
 */
function cutAfterTurn(events: readonly SessionEvent[], target: number): number {
  let start = -1
  for (let i = target; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      start = i
      break
    }
  }
  // Scan for the first turn/end at-or-after the turn start, or after target
  // when the message sits before any turn marker.
  const scanFrom = start >= 0 ? start : target
  for (let i = scanFrom; i < events.length; i++) {
    if (events[i]?.type === 'turn/end') return i + 1
    if (i > target && events[i]?.type === 'turn/start') {
      // crossed into the next turn without a turn/end: open/crashed turn —
      // keep up to (excluding) the next turn/start
      return i
    }
  }
  return events.length
}

/**
 * Locate the cut point for a rollback fork (Go locateForkCut, minus the
 * plan-basis mode which only the /spawn quoted-plan path uses).
 *
 * @param events - the parent session's event log (live snapshot or persisted view).
 * @param loc - the quoted-message locator.
 * @returns the number of leading events the fork keeps.
 * @throws when no locator was provided or the quoted message cannot be found.
 */
export function locateForkCut(events: readonly SessionEvent[], loc: ForkAtLocator): number {
  if (loc.quotedTimeMs > 0) {
    const wantAssistant = loc.senderType === 'app'
    let best = -1
    let bestDelta = Number.MAX_SAFE_INTEGER
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (event === undefined) continue
      if (wantAssistant ? event.type !== 'assistant/message' : event.type !== 'user/message') continue
      const delta = Math.abs(event.time - loc.quotedTimeMs)
      if (loc.quotedText !== '' && delta < MATCH_WINDOW_MS
        && quoteTextMatch(firstTextBlock(event), loc.quotedText)) {
        // a text match inside the window wins outright
        return cutAfterTurn(events, i)
      }
      if (delta < bestDelta) {
        best = i
        bestDelta = delta
      }
    }
    if (best >= 0 && bestDelta <= MATCH_WINDOW_MS) return cutAfterTurn(events, best)
    throw new Error('dsh fork-at: no message within window of quoted time')
  }
  if (loc.quotedText !== '') {
    let target = -1
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (event === undefined) continue
      if (event.type !== 'assistant/message' && event.type !== 'user/message') continue
      if (quoteTextMatch(firstTextBlock(event), loc.quotedText)) target = i
    }
    if (target < 0) throw new Error('dsh fork-at: target turn not found')
    return cutAfterTurn(events, target)
  }
  throw new Error('dsh fork-at: no locator provided')
}
