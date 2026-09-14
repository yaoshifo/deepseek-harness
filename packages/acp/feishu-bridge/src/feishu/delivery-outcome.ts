/**
 * Three-state delivery-outcome classification for Feishu send failures
 * (dsh-im absorption batch 1).
 *
 * Judgment: a failure is definite ("failed") only when the server answered —
 * an HTTP status or a business code arrived, so the message provably did not
 * land. Transport symptoms and the bridge's own synthesized per-attempt
 * deadline leave the request's fate unknowable ("unknown"); rate-limit
 * rejections are definite rejections even though they stay retryable —
 * outcome and retryability are separate axes.
 *
 * @module dsh-feishu-bridge/feishu-delivery-outcome
 */

import { feishuBusinessCode } from './retry.ts'

/**
 * Classify a failed Feishu send by what the server said.
 * @param err - The thrown value from a send attempt (after transient retries
 *   are exhausted — the caller's retry layer owns retryability).
 * @returns 'failed' when a response arrived (HTTP status or business code,
 *   including rate-limit rejections); 'unknown' when only transport or
 *   timeout symptoms are visible, or the shape is unrecognized — the
 *   conservative default, mirroring dsh-im's uncertain-by-default.
 */
export function classifyDeliveryFailure(err: unknown): 'failed' | 'unknown' {
  if (err === undefined || err === null) return 'unknown'
  if (feishuBusinessCode(err) !== undefined) return 'failed'
  const status = (err as { response?: { status?: unknown } }).response?.status
  if (typeof status === 'number') return 'failed'
  return 'unknown'
}
