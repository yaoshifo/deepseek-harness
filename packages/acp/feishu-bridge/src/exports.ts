/**
 * The narrow cross-package face for sibling plugins extending the bridge
 * (the chatroom package): the service and dispatch types, the caller-routing
 * types, the engine symbols feature modules share, the platform capability
 * casts, and the registration helpers a plugin mounts through (i18n lookup
 * and subtables, tool tag families, feature-state codecs). This module is
 * the supported import surface — everything else stays an internal src path.
 *
 * @module dsh-feishu-bridge/exports
 */

export { FeishuBridgeService, bareBridgeDispatch, ctxBridgeDispatch } from './bridge-service.js'
export type { BridgeDispatch, FeishuBridgeEventName, LiveProject } from './bridge-service.js'
export type { SubtaskAgentRouter, SubtaskRoute } from './tools/subtask.js'
export { Engine, InteractiveState } from './engine/engine.js'
export type { CommandRegistration, CommandHelpGroup } from './engine/engine.js'
export { emptyMessage, jumpButtonsMarkdown, parentJumpButtons } from './engine/engine.js'
export { ProjectStateStore } from './engine/project-state.js'
export { registerSessionCommands, cleanupOneChat } from './engine/commands.js'
export { Session, SessionManager } from './engine/session.js'
export { lookupMessage, registerMessages } from './i18n/index.js'
export type { Language } from './i18n/index.js'
export { declareToolFamily } from './streaming.js'
export type { ToolTagFamily } from './streaming.js'
export type {
  Agent,
  AgentSession,
  ButtonOption,
  Event,
  ForkQuerierWithProvider,
  Message,
  PendingAsk,
  Platform,
  ProviderSwitcher,
  SessionStartOptions,
  UserQuestion,
} from './core/types.js'
export {
  EventChannel,
  asCardSender,
  asCardSenderWithUpdate,
  asGroupRenamer,
  asReplyContextReconstructor,
} from './core/types.js'
export { newCard } from './card.js'
export type { Card, CardHeader, CardButton } from './card.js'
export { maxGroupNameRunes } from './engine/groupname.js'
export { WorktreeMode } from './engine/worktree.js'
export { atomicWriteFileSync } from './atomicwrite.js'
export { featureStateCodecs, registerFeatureStateCodec } from './engine/feature-state.js'
export type { FeatureStateCodec } from './engine/feature-state.js'
