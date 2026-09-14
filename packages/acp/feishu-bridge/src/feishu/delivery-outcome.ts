/**
 * Three-state delivery-outcome classification for Feishu send failures
 * (dsh-im absorption batch 1).
 *
 * Judgment: a failure is definite ("failed") only when the server's answer
 * itself proves the message did not land — a 4xx HTTP status or a business
 * code rejected the send. Gateway 5xx statuses prove nothing either way
 * (504 in particular answers after the upstream work), transport symptoms
 * and the bridge's own synthesized per-attempt deadline likewise leave the
 * request's fate unknowable ("unknown"); rate-limit rejections are definite
 * rejections even though they stay retryable — outcome and retryability
 * are separate axes.
 *
 * @module dsh-feishu-bridge/feishu-delivery-outcome
 */

import { feishuBusinessCode } from './retry.ts'

/**
 * Classify a failed Feishu send by what the server said.
 * @param err - The thrown value from a send attempt (after transient retries
 *   are exhausted — the caller's retry layer owns retryability).
 * @returns 'failed' when the answer proves a definite rejection (a 4xx HTTP
 *   status or a business code, including rate-limit rejections); 'unknown'
 *   for 5xx gateway statuses, transport or timeout symptoms, and
 *   unrecognized shapes — the conservative default, mirroring dsh-im's
 *   uncertain-by-default.
 */
export function classifyDeliveryFailure(err: unknown): 'failed' | 'unknown' {
  if (err === undefined || err === null) return 'unknown'
  if (feishuBusinessCode(err) !== undefined) return 'failed'
  const status = (err as { response?: { status?: unknown } }).response?.status
  if (typeof status === 'number') return status >= 500 ? 'unknown' : 'failed'
  return 'unknown'
}
