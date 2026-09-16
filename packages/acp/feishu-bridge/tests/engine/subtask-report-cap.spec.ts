/**
 * Subtask report cap (2026-09-16 plan): a child's report longer than
 * `subtask.reportMaxChars` (default 8192 code points) must not enter the
 * parent agent's context whole — the delivered text keeps the head (2/3) and
 * tail (1/3) of the budget, drops the middle, and ends with a notice line
 * naming the truncation and the full-text file path. The plan function is
 * pure: the caller assembles the notice (it owns the path) and the function
 * only splits and joins, so code-point safety and budget arithmetic are
 * unit-testable here. Engine-level delivery behavior lives beside the dedup
 * suite.
 *
 * @module dsh-feishu-bridge/tests-subtask-report-cap
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTASK_REPORT_MAX_CHARS,
  MIN_SUBTASK_REPORT_MAX_CHARS,
  planSubtaskReportCap,
} from '../../src/engine/subtask-report-cap.ts'

/** Code points of `text` (the cap's counting unit — emoji count as 1). */
function runes(text: string): number {
  return Array.from(text).length
}

describe('planSubtaskReportCap (pure split/join)', () => {
  it('exposes the planned default and minimum cap constants', () => {
    expect(DEFAULT_SUBTASK_REPORT_MAX_CHARS).toBe(8192)
    expect(MIN_SUBTASK_REPORT_MAX_CHARS).toBe(1024)
  })

  it('returns null for a report within the cap — boundary: exactly cap code points', () => {
    const raw = 'x'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
    expect(planSubtaskReportCap(raw, DEFAULT_SUBTASK_REPORT_MAX_CHARS, '（说明）')).toBeNull()
  })

  it('caps an oversized report into head 2/3 + tail 1/3 + notice, total within cap', () => {
    const raw = 'a'.repeat(100)
    // Budget: cap 20 − notice 1 rune − '\n\n' join 2 − mid marker '\n…\n' 3 = 14;
    // head = ceil(14 × 2/3) = 10, tail = 4.
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(planned).not.toBeNull()
    const delivered = planned!.delivered
    expect(runes(delivered)).toBeLessThanOrEqual(20)
    expect(delivered).toContain('a'.repeat(10))
    expect(delivered).toContain('a'.repeat(4))
    expect(delivered.endsWith('\n\nN')).toBe(true)
    expect(planned!.omitted).toBe(100 - 14)
  })

  it('keeps the raw report\'s head and tail: head is a prefix, tail is a suffix', () => {
    const raw = 'HEAD-'.repeat(10) + 'MIDDLE-'.repeat(40) + '-TAIL'
    // head budget 10 → the first 10 runes ('HEAD-HEAD-'); tail budget 4 → the
    // last 4 runes ('TAIL' — the dash stays dropped in the middle).
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(planned!.delivered).toBe('HEAD-HEAD-\n…\nTAIL\n\nN')
  })

  it('counts code points, never splitting a surrogate pair', () => {
    const raw = '😀'.repeat(60) // 60 code points, 120 UTF-16 units
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(runes(planned!.delivered)).toBeLessThanOrEqual(20)
    // Every retained rune is a complete emoji — no lone surrogates.
    for (const ch of planned!.delivered) {
      expect(ch).not.toMatch(/^[\uD800-\uDFFF]$/)
    }
    expect(planned!.delivered).toContain('😀😀😀😀')
  })

  it('degrades to notice-only when the notice alone eats the budget', () => {
    const planned = planSubtaskReportCap('x'.repeat(500), 10, 'N'.repeat(9))
    expect(planned!.delivered).toBe('N'.repeat(9))
    expect(planned!.omitted).toBe(500)
  })
})
