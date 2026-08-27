/**
 * Shared test helper: a bridge dispatch face carrying the chatroom policy
 * listeners (the production composition), for engines constructed in tests
 * that exercise the `feishuBridge/*` event path. The backing contexts are
 * disposed after each test.
 *
 * @module dsh-feishu-bridge/tests-stubs
 */

import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ctxBridgeDispatch, type BridgeDispatch } from '../../src/bridge-service.js'
import { registerChatroomPolicyListeners } from '../../src/engine/chatroom-policy.js'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * A dispatch face with the chatroom policy listeners registered (the
 * production composition).
 * @returns The context-bound dispatch face.
 */
export function chatroomPolicyFace(): BridgeDispatch {
  const ctx = new Context()
  contexts.push(ctx)
  registerChatroomPolicyListeners(ctx)
  return ctxBridgeDispatch(ctx)
}
