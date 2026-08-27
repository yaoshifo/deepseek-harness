/**
 * The chatroom feature-state codec: owns the `chatroom` section of
 * `Session.featureState` (snapshot version 3). The 17 durable chatroom and
 * research session fields live in that section, addressed through the
 * Session accessor pairs; encode projects them for persistence (the armed
 * barrier snapshots included) and carry declares the chat-scoped subset that
 * survives a conversation reset. The codec registration itself happens once
 * per process in the plugin apply.
 *
 * @module dsh-feishu-bridge/chatroom-feature-state
 */

import type { Session } from './session.js'
import type { FeatureStateCodec } from './feature-state.js'

/** The featureState key of the chatroom section. */
export const chatroomFeatureStateKey = 'chatroom'

/**
 * The chatroom section of {@link Session.featureState}: the durable
 * chatroom/research fields (all optional; Session accessors default the
 * missing keys), nested one level below their version-2 flat names.
 */
export interface ChatroomFeatureState {
  /** Session key of the hub driving this chatroom role session. */
  chatroomHubKey?: string
  /** Role name this session plays in its chatroom. */
  chatroomRoleName?: string
  /** One-shot ask gate: the hub already asked this role in the current gather round. */
  chatroomAsked?: boolean
  /** Hub session driving a research-mode chatroom. */
  chatroomResearch?: boolean
  /** Hub session converted into a 1:1 direct chatroom. */
  chatroomDirectRole?: boolean
  /** Session key of a research role's pre-spawned assistant subgroup. */
  researchAssistantKey?: string
  /** Marks a pre-spawned research-assistant subgroup. */
  researchAssistant?: boolean
  /** Research role awaiting its assistant's report before concluding. */
  researchAwaitingAssistant?: boolean
  /** Hub session driving a chatroom as the moderator. */
  chatroomModerator?: boolean
  /** Research iteration driver: 'auto' | 'manual'. */
  chatroomResearchMode?: string
  /** Current research iteration round, 1-based. */
  chatroomResearchRound?: number
  /** Per-invocation override of the auto-mode research round cap. */
  chatroomResearchMaxRounds?: number
  /** Monotonic per-hub gather-round counter. */
  chatroomGatherSeq?: number
  /** Shared uv venv path for research assistants. */
  researchVenv?: string
  /** Hub-side pending role name for a routed human reply. */
  pendingHumanQuestionRole?: string
  /** Durable snapshot of the armed gather barrier (consumed at engine start). */
  pendingGatherData?: import('./chatroom.js').GatherBarrierSnapshot | undefined
  /** Durable snapshot of the armed end barrier (consumed at engine start). */
  pendingEndBarrierData?: import('./chatroom.js').EndBarrierSnapshot | undefined
}

/**
 * The chatroom featureState section of the session, creating it on first
 * access. A section that is not an object (a hand-corrupted file) is
 * replaced: the accessors default every missing key, so state is lost either
 * way but reads and writes must not throw.
 * @param session - The session whose chatroom section is addressed.
 * @returns the mutable chatroom section.
 */
export function chatroomFeatureState(session: Session): ChatroomFeatureState {
  let section: unknown = session.featureState[chatroomFeatureStateKey]
  if (typeof section !== 'object' || section === null) {
    section = {}
    session.featureState[chatroomFeatureStateKey] = section
  }
  return section as ChatroomFeatureState
}

/**
 * The chatroom codec: projects the durable chatroom/research fields (plus
 * the armed barrier snapshots) into the `chatroom` featureState section, and
 * carries the chat-scoped subset — identity, orchestration counters, the
 * provisioned research assistant, the pending human question, and the armed
 * barriers by reference — across a conversation reset. The conversation-
 * scoped gates (chatroomAsked, researchAwaitingAssistant) deliberately reset
 * with the conversation.
 */
export const chatroomFeatureStateCodec: FeatureStateCodec = {
  key: chatroomFeatureStateKey,
  encode(session: Session): unknown {
    const pendingGatherData = session.pendingGather?.snapshot()
    const pendingEndBarrierData = session.pendingEndBarrier?.snapshot()
    const section = {
      ...(session.chatroomHubKey !== '' ? { chatroomHubKey: session.chatroomHubKey } : {}),
      ...(session.chatroomRoleName !== '' ? { chatroomRoleName: session.chatroomRoleName } : {}),
      ...(session.chatroomAsked ? { chatroomAsked: true } : {}),
      ...(session.chatroomResearch ? { chatroomResearch: true } : {}),
      ...(session.chatroomDirectRole ? { chatroomDirectRole: true } : {}),
      ...(session.researchAssistantKey !== '' ? { researchAssistantKey: session.researchAssistantKey } : {}),
      ...(session.researchAssistant ? { researchAssistant: true } : {}),
      ...(session.researchAwaitingAssistant ? { researchAwaitingAssistant: true } : {}),
      ...(session.chatroomModerator ? { chatroomModerator: true } : {}),
      ...(session.chatroomResearchMode !== '' ? { chatroomResearchMode: session.chatroomResearchMode } : {}),
      ...(session.chatroomResearchRound !== 0 ? { chatroomResearchRound: session.chatroomResearchRound } : {}),
      ...(session.chatroomResearchMaxRounds !== 0 ? { chatroomResearchMaxRounds: session.chatroomResearchMaxRounds } : {}),
      ...(session.chatroomGatherSeq !== 0 ? { chatroomGatherSeq: session.chatroomGatherSeq } : {}),
      ...(session.researchVenv !== '' ? { researchVenv: session.researchVenv } : {}),
      ...(session.pendingHumanQuestionRole !== '' ? { pendingHumanQuestionRole: session.pendingHumanQuestionRole } : {}),
      ...(pendingGatherData !== undefined ? { pendingGatherData } : {}),
      ...(pendingEndBarrierData !== undefined ? { pendingEndBarrierData } : {}),
    }
    return Object.keys(section).length > 0 ? section : undefined
  },
  carry(from: Session, to: Session): void {
    // Chatroom identity and orchestration.
    to.chatroomHubKey = from.chatroomHubKey
    to.chatroomRoleName = from.chatroomRoleName
    to.chatroomModerator = from.chatroomModerator
    to.chatroomDirectRole = from.chatroomDirectRole
    to.chatroomResearch = from.chatroomResearch
    to.chatroomResearchMode = from.chatroomResearchMode
    to.chatroomResearchRound = from.chatroomResearchRound
    to.chatroomResearchMaxRounds = from.chatroomResearchMaxRounds
    to.chatroomGatherSeq = from.chatroomGatherSeq
    // The chat's provisioned research assistant.
    to.researchAssistantKey = from.researchAssistantKey
    to.researchAssistant = from.researchAssistant
    to.researchVenv = from.researchVenv
    // Chat-scoped scheduling: in-flight barriers and the pending human
    // question survive a conversation reset, or a running round silently
    // degrades and a suspended question stops routing.
    to.pendingGather = from.pendingGather
    to.pendingEndBarrier = from.pendingEndBarrier
    to.pendingHumanQuestionRole = from.pendingHumanQuestionRole
  },
}
