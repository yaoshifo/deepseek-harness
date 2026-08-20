/**
 * Send-path helpers ported from cc-connect core/engine_send.go: the plain
 * text fallback used when a card send fails (11311/11310 — the retried
 * plain text must not itself look like markdown or Feishu rebuilds it as a
 * card and fails again) and the fork-summary context builder.
 *
 * @module dsh-feishu-bridge/engine-send-helpers
 */

import type { HistoryEntry } from '../core/types.js'

const fallbackHTMLTagRe = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi
const fallbackLineStartRe = /^(\s*)(?:[-*+#>]|\d+\.)\s?/gm
const fallbackInlineWsRe = /[^\S\n]{3,}/g

/**
 * Strip markdown syntax and HTML from card-fallback text: removes code
 * fences, bold/strike/inline-code markers, dividers, HTML tags, list and
 * heading prefixes, and collapses long inline whitespace runs.
 *
 * @param s - the card body text to sanitize.
 * @returns the plain text safe to send after a card send fails.
 */
export function toPlainTextForFallback(s: string): string {
  for (const marker of ['```', '**', '~~', '`', '---']) {
    s = s.replaceAll(marker, '')
  }
  s = s.replace(fallbackHTMLTagRe, '')
  s = s.replace(fallbackLineStartRe, '$1')
  s = s.replace(fallbackInlineWsRe, ' ')
  return s
}

const maxSummaryUserMsgLen = 500
const maxSummaryAssistantLen = 4000

/**
 * Build the compact last-user/last-assistant context for fork queries.
 *
 * @param entries - the session history to scan for the latest user and assistant turns.
 * @returns the "User asked / Assistant replied" context block, '' when history has neither.
 */
export function buildSummaryContext(entries: HistoryEntry[]): string {
  let lastUser = ''
  let lastAssistant = ''
  for (const entry of entries) {
    switch (entry.role) {
      case 'user':
        lastUser = entry.content
        break
      case 'assistant':
        lastAssistant = entry.content
        break
      default:
        break
    }
  }
  let sb = ''
  if (lastUser !== '') {
    const text = lastUser.length > maxSummaryUserMsgLen ? `${lastUser.slice(0, maxSummaryUserMsgLen)}...` : lastUser
    sb += `User asked: ${text}\n`
  }
  if (lastAssistant !== '') {
    const text = lastAssistant.length > maxSummaryAssistantLen ? `${lastAssistant.slice(0, maxSummaryAssistantLen)}...` : lastAssistant
    sb += `Assistant replied: ${text}\n`
  }
  return sb
}
