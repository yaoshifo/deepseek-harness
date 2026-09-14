/**
 * Three-state delivery-outcome classification for Feishu send failures
 * (dsh-im absorption batch 1, u1).
 *
 * Judgment: a failure is definite ("failed") only when the server answered —
 * an HTTP status or a business code arrived, so the message provably did not
 * land. Transport symptoms and the bridge's own synthesized per-attempt
 * deadline leave the request's fate unknowable ("unknown"); rate-limit
 * rejections are definite rejections even though they stay retryable —
 * outcome and retryability are separate axes.
 *
 * @module dsh-feishu-bridge/tests-feishu-delivery-outcome
 */

import { describe, expect, it } from 'vitest'
import { classifyDeliveryFailure } from '../../src/feishu/delivery-outcome.ts'
import { asDeliveryOutcomeClassifier } from '../../src/core/types.ts'
import { FeishuPlatform } from '../../src/feishu/platform.ts'

/** AxiosError-shaped failure as the SDK surfaces API rejections. */
function sdkError(status: number, code?: number | string): object {
  return {
    message: `Request failed with status code ${status}`,
    response: { status, data: code === undefined ? {} : { code } },
  }
}

describe('classifyDeliveryFailure', () => {
  it('a definite business-code rejection is failed', () => {
    expect(classifyDeliveryFailure(sdkError(400, 230001))).toBe('failed')
    expect(classifyDeliveryFailure(new Error('tag create failed code=402'))).toBe('failed')
  })

  it('auth and permission rejections are failed', () => {
    expect(classifyDeliveryFailure(sdkError(401))).toBe('failed')
    expect(classifyDeliveryFailure(sdkError(403))).toBe('failed')
    expect(classifyDeliveryFailure(sdkError(400, 99991663))).toBe('failed')
  })

  it('a rate-limit rejection answered by the server is failed', () => {
    expect(classifyDeliveryFailure(sdkError(200, 230020))).toBe('failed')
    expect(classifyDeliveryFailure(sdkError(400, 99991400))).toBe('failed')
  })

  it('timeout symptoms may have delivered, so unknown', () => {
    expect(classifyDeliveryFailure(new Error('context deadline exceeded'))).toBe('unknown')
    expect(classifyDeliveryFailure(new Error('i/o timeout'))).toBe('unknown')
    expect(classifyDeliveryFailure(new Error('This operation was aborted'))).toBe('unknown')
  })

  it('transport symptoms without a response are unknown', () => {
    expect(classifyDeliveryFailure(new Error('fetch failed'))).toBe('unknown')
    expect(classifyDeliveryFailure(new Error('read ECONNRESET connection reset by peer'))).toBe('unknown')
    expect(classifyDeliveryFailure(new Error('connect ECONNREFUSED connection refused'))).toBe('unknown')
    expect(classifyDeliveryFailure(undefined)).toBe('unknown')
    expect(classifyDeliveryFailure(new Error('everything is fine'))).toBe('unknown')
  })

  it('the platform exposes the classifier through the capability guard', () => {
    const p = new FeishuPlatform({ appID: 'cli_x', appSecret: 's' })
    const cap = asDeliveryOutcomeClassifier(p)
    expect(cap, 'FeishuPlatform satisfies asDeliveryOutcomeClassifier').toBeDefined()
    expect(cap?.classifyDeliveryFailure(new Error('context deadline exceeded'))).toBe('unknown')
    expect(cap?.classifyDeliveryFailure(sdkError(403))).toBe('failed')
  })
})
