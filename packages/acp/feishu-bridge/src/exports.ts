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

export { FeishuBridgeService, bareBridgeDispatch, ctxBridgeDispatch } from './bridge-service.ts'
export type { BridgeDispatch, FeishuBridgeEventName, LiveProject } from './bridge-service.ts'
export type { SubtaskAgentRouter, SubtaskRoute } from './tools/subtask.ts'
export { Engine, InteractiveState } from './engine/engine.ts'
export type { CommandRegistration, CommandHelpGroup } from './engine/engine.ts'
export { emptyMessage, jumpButtonsMarkdown, parentJumpButtons } from './engine/engine.ts'
export { ProjectStateStore } from './engine/project-state.ts'
export { registerSessionCommands, cleanupOneChat } from './engine/commands.ts'
export { Session, SessionManager } from './engine/session.ts'
export { lookupMessage, registerMessages } from './i18n/index.ts'
export type { Language } from './i18n/index.ts'
export { declareToolFamily, toolTagForProgress } from './streaming.ts'
export type { ToolTagFamily } from './streaming.ts'
export type {
  Agent,
  AgentSession,
  AskDecision,
  ButtonOption,
  ChatPhase,
  Event,
  ForkQuerierWithProvider,
  Message,
  PendingAsk,
  Platform,
  ProviderSwitcher,
  SessionStartOptions,
  SubtaskDelivery,
  UserQuestion,
} from './core/types.ts'
export {
  EventChannel,
  asCardSender,
  asCardSenderWithUpdate,
  asGroupRenamer,
  asReplyContextReconstructor,
} from './core/types.ts'
export { newCard } from './card.ts'
export type { Card, CardHeader, CardButton } from './card.ts'
export { maxGroupNameRunes } from './engine/groupname.ts'
export { WorktreeMode } from './engine/worktree.ts'
export { atomicWriteFileSync } from './atomicwrite.ts'
export { featureStateCodecs, registerFeatureStateCodec } from './engine/feature-state.ts'
export type { FeatureStateCodec } from './engine/feature-state.ts'
