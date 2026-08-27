/**
 * Feishu-bridge chatroom plugin: the multi-role chatroom orchestration
 * (role groups, moderator, `/chatroom` command family) extracted from the
 * feishu-bridge engine into its own package, mounted beside
 * `@deepseek-ai/dsh-feishu-bridge`. This is the package skeleton — the
 * chatroom implementation still lives in the feishu-bridge engine and moves
 * here in the follow-up migration.
 *
 * @module dsh-feishu-bridge-chatroom
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name for the chatroom row mounted by the bundle patch. */
export const name = 'feishu-bridge-chatroom'

/**
 * Services the chatroom consumes. Empty placeholder: the follow-up migration
 * declares `feishuBridge` here once the chatroom code moves in.
 */
export const inject: string[] = []

/** Deployment config for the chatroom plugin; fields arrive with the migration. */
export const Config = Schema.object({})

/**
 * Start the chatroom. TODO(migration): mount the chatroom hub — role-group
 * sessions, the moderator orchestration, and the `/chatroom` command family
 * migrated from the feishu-bridge engine.
 *
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 */
export function apply(_ctx: Context, _config: Record<string, never>): void {
  // TODO(migration): chatroom startup lands with the code move.
}
