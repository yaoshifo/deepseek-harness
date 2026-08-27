/**
 * The narrow cross-package face for sibling plugins extending the bridge
 * (the chatroom package): the service and dispatch types, the caller-routing
 * types, the engine symbols feature modules share, and the helpers a plugin
 * registers through (i18n lookup, tool tag families). This module is the
 * supported import surface — everything else stays an internal src path.
 *
 * @module dsh-feishu-bridge/exports
 */

export { FeishuBridgeService, bareBridgeDispatch, ctxBridgeDispatch } from './bridge-service.js'
export type { BridgeDispatch, FeishuBridgeEventName, LiveProject } from './bridge-service.js'
export type { SubtaskAgentRouter, SubtaskRoute } from './tools/subtask.js'
export type { Engine, InteractiveState } from './engine/engine.js'
export { emptyMessage, jumpButtonsMarkdown, parentJumpButtons } from './engine/engine.js'
export { registerSessionCommands } from './engine/commands.js'
export type { Session } from './engine/session.js'
export { SessionManager } from './engine/session.js'
export { lookupMessage } from './i18n/index.js'
export { declareToolFamily } from './streaming.js'
export type { ToolTagFamily } from './streaming.js'
