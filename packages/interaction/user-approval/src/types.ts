/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains (apiproxy api → client) can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, a standing grant for the rest of
 * the agent's lifetime, explicit rejection, withdrawn request, or unavailable
 * answerer. Callers fail closed on `unavailable`.
 */
export type ApprovalOutcome = 'allowed-once' | 'allowed-always' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * A rich answerer return: an outcome plus an optional human note collected
 * alongside the decision. Answerers may return a bare
 * {@link ApprovalOutcome} instead; the service normalizes both shapes.
 */
export interface ApprovalAnswer {
  readonly outcome: ApprovalOutcome
  /** Human commentary riding the decision; bounded and trimmed by the service. */
  readonly note?: string
}

/**
 * The settled decision returned by {@link ApprovalService.request}: the closed
 * outcome plus the answerer's note when one was given.
 */
export interface ApprovalResult {
  readonly outcome: ApprovalOutcome
  /** The answerer's note, already bounded and trimmed; absent when none was given. */
  readonly note?: string
}
