/**
 * Pure budget arithmetic for capping a subtask report before it enters the
 * parent agent's context (2026-09-16 plan): a report longer than
 * `subtask.reportMaxChars` code points is delivered as head + tail + a
 * caller-assembled notice line, so the parent's context spend per report is
 * bounded. The caller (the engine's parent-reply delivery) owns the notice
 * text — it needs the spill file path — and this module only splits and
 * joins, keeping code-point safety and budget math unit-testable without
 * I/O or i18n.
 *
 * @module dsh-feishu-bridge/subtask-report-cap
 */

/** Default cap on a subtask report's delivered text, in Unicode code points. */
export const DEFAULT_SUBTASK_REPORT_MAX_CHARS = 8192

/**
 * Floor for a configured cap: below this a notice of ordinary length would
 * crowd out the report text entirely, so configuration rejects it at load.
 */
export const MIN_SUBTASK_REPORT_MAX_CHARS = 1024

/** Separator marking the dropped middle between the retained head and tail. */
const MID_MARKER = '\n…\n'

/** One planned capped delivery of an oversized report. */
export interface SubtaskReportCapPlan {
  /** The text to deliver: head + marker + tail + notice, within the cap. */
  delivered: string
  /** Code points of the raw report dropped from the middle. */
  omitted: number
}

/**
 * Plan the capped delivery of an oversized report: the budget not spent on
 * the notice and separators splits head 2/3 / tail 1/3 of the raw text.
 *
 * @param raw - The report's full text.
 * @param cap - Maximum delivered code points (callers keep it at or above
 *   {@link MIN_SUBTASK_REPORT_MAX_CHARS}).
 * @param notice - The notice line the caller appends (spill path or
 *   not-saved wording).
 * @returns The plan, or `null` when the raw report is within the cap.
 */
export function planSubtaskReportCap(raw: string, cap: number, notice: string): SubtaskReportCapPlan | null {
  const rawRunes = Array.from(raw)
  if (rawRunes.length <= cap) return null
  const noticeRunes = Array.from(notice).length
  const remaining = cap - noticeRunes - 2 /* '\n\n' before the notice */ - 3 /* MID_MARKER */
  if (remaining < 2) {
    // A notice that eats the whole budget leaves no room for report text;
    // the notice alone is the delivery (never longer than the cap in
    // practice — the configured floor keeps caps at 1024 while notices stay
    // under ~200 code points).
    return { delivered: notice, omitted: rawRunes.length }
  }
  const head = Math.ceil((remaining * 2) / 3)
  const tail = remaining - head
  const delivered = rawRunes.slice(0, head).join('')
    + MID_MARKER
    + rawRunes.slice(rawRunes.length - tail).join('')
    + '\n\n'
    + notice
  return { delivered, omitted: rawRunes.length - head - tail }
}
