/**
 * M3 permission/question helper functions — pure-logic port of Go
 * engine_events.go permission keyword matching, AskUserQuestion answer
 * resolution, and unsolicited-permission surfacing rules.
 *
 * @module dsh-feishu-bridge/engine/permission
 */

import type { UserQuestion } from '../core/types.js'

/** Lowercase trimmed string matches an "allow" keyword (Go isAllowResponse). */
export function isAllowResponse(s: string): boolean {
  const words = ['allow', 'yes', 'y', 'ok', '允许', '同意', '可以', '好', '好的', '是', '确认', 'approve']
  return words.includes(s)
}

/** Lowercase trimmed string matches a "deny" keyword (Go isDenyResponse). */
export function isDenyResponse(s: string): boolean {
  const words = ['deny', 'no', 'n', 'reject', '拒绝', '不允许', '不行', '不', '否', '取消', 'cancel']
  return words.includes(s)
}

/** Lowercase trimmed string matches an "allow all" keyword (Go isApproveAllResponse). */
export function isApproveAllResponse(s: string): boolean {
  const words = [
    'allow all', 'allowall', 'approve all', 'yes all',
    '允许所有', '允许全部', '全部允许', '所有允许', '都允许', '全部同意',
  ]
  return words.includes(s)
}

/**
 * Convert user input into an answer text for an AskUserQuestion option
 * (Go resolveAskQuestionAnswer). Handles:
 * - Card button callback: "askq:qIdx:optIdx" or "askq:qIdx:idx1,idx2,..."
 * - Legacy format: "askq:N"
 * - Numeric index(es): "1" or "1,3,5" (multi-select)
 * - Free text: returned as-is
 */
export function resolveAskQuestionAnswer(q: UserQuestion, input: string): string {
  const trimmed = input.trim()

  if (trimmed.startsWith('askq:')) {
    const parts = trimmed.split(':', 3)
    if (parts.length === 3) {
      const part2 = parts[2] ?? ''
      if (part2.includes(',')) {
        const labels: string[] = []
        for (const ip of part2.split(',')) {
          const idx = Number.parseInt(ip.trim(), 10)
          const opt = q.options[idx - 1]
          if (idx >= 1 && idx <= q.options.length && opt !== undefined) {
            labels.push(opt.label)
          }
        }
        if (labels.length > 0) return labels.join(', ')
      }
      const idx = Number.parseInt(part2, 10)
      const opt = q.options[idx - 1]
      if (idx >= 1 && idx <= q.options.length && opt !== undefined) {
        return opt.label
      }
    }
    if (parts.length === 2) {
      const idx = Number.parseInt(parts[1] ?? '', 10)
      const opt = q.options[idx - 1]
      if (idx >= 1 && idx <= q.options.length && opt !== undefined) {
        return opt.label
      }
    }
  }

  if (q.multiSelect) {
    const parts = trimmed.split(/[,，\s]+/).filter(p => p !== '')
    const labels: string[] = []
    let allNumeric = true
    for (const p of parts) {
      const idx = Number.parseInt(p.trim(), 10)
      const opt = q.options[idx - 1]
      if (Number.isNaN(idx) || idx < 1 || idx > q.options.length || opt === undefined) {
        allNumeric = false
        break
      }
      labels.push(opt.label)
    }
    if (allNumeric && labels.length > 0) return labels.join(', ')
  } else {
    const idx = Number.parseInt(trimmed, 10)
    const opt = q.options[idx - 1]
    if (!Number.isNaN(idx) && idx >= 1 && idx <= q.options.length && opt !== undefined) {
      return opt.label
    }
  }

  return trimmed
}

/**
 * Build the updated tool input with collected AskUserQuestion answers
 * (Go buildAskQuestionResponse). The answers map is keyed by question
 * index; the result carries the original fields plus an `answers` object
 * mapping question text to answer text.
 */
export function buildAskQuestionResponse(
  originalInput: Record<string, unknown>,
  questions: UserQuestion[],
  collected: Map<number, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...originalInput }
  const answers: Record<string, string> = {}
  for (const [idx, ans] of collected) {
    const question = questions[idx]
    if (question !== undefined) {
      answers[question.question] = ans
    }
  }
  result.answers = answers
  return result
}

/**
 * Whether an unsolicited (background-reader) permission request should
 * surface to the user instead of being auto-denied (Go
 * shouldSurfaceUnsolicitedPermission). Auto-approve never surfaces;
 * AskUserQuestion and stall-retried turns always surface.
 */
export function shouldSurfaceUnsolicitedPermission(
  _toolName: string,
  isAskQuestion: boolean,
  stallRetried: boolean,
  autoApprove: boolean,
): boolean {
  if (autoApprove) return false
  return isAskQuestion || stallRetried
}

/**
 * Native Claude Code deny message (Go handlePendingPermission deny branch).
 * The preamble mirrors the claude binary's uPe/wvt tool_result so the model
 * follows the rejection format with highest fidelity.
 */
export function buildDenyMessage(denyReason: string): string {
  const preamble = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
  if (denyReason !== '') {
    return `${preamble} To tell you how to proceed, the user said:\n\n${denyReason}`
  }
  return `${preamble} STOP what you are doing and wait for the user to tell you how to proceed.`
}
