/**
 * The plugin-extension export face: the subpath
 * `@deepseek-ai/dsh-feishu-bridge/exports` resolves (tsconfig paths in the
 * source plane, package exports after build) and carries exactly the
 * sibling-plugin symbols — the narrow face chatroom and future plugins
 * consume instead of deep src imports.
 *
 * @module dsh-feishu-bridge/tests-exports
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  FeishuBridgeService,
  SessionManager,
  bareBridgeDispatch,
  ctxBridgeDispatch,
  declareToolFamily,
  emptyMessage,
  jumpButtonsMarkdown,
  lookupMessage,
  parentJumpButtons,
  registerSessionCommands,
} from '@deepseek-ai/dsh-feishu-bridge/exports'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('the plugin-extension export face', () => {
  it('exposes the service face and dispatch helpers sibling plugins consume', () => {
    expect(typeof FeishuBridgeService).toBe('function')
    expect(typeof SessionManager).toBe('function')
    expect(typeof registerSessionCommands).toBe('function')

    const bare = bareBridgeDispatch()
    // No listeners: the built-in base (the last dispatch argument) runs.
    expect(bare.waterfall('feishuBridge/permission-policy', { options: undefined }, () => true)).toBe(true)
    expect(emptyMessage().sessionKey).toBe('')

    const ctx = new Context()
    contexts.push(ctx)
    const face = ctxBridgeDispatch(ctx)
    expect(typeof face.serial).toBe('function')
  })

  it('exposes the shared engine symbols and registration helpers', () => {
    expect(jumpButtonsMarkdown([]).ok).toBe(false)
    expect(parentJumpButtons('k', 'name', { name: () => 'p' } as never)).toEqual([])

    // A missing key falls back to the key itself (the i18n contract).
    expect(lookupMessage('en', 'face_spec_missing_key' as never)).toBe('face_spec_missing_key')

    const undeclare = declareToolFamily('face_spec_tool', 'agent')
    expect(typeof undeclare).toBe('function')
    undeclare()
  })
})
