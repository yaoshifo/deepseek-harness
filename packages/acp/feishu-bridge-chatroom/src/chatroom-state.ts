/**
 * The chatroom per-session live state: the durable fields of the `chatroom`
 * featureState section (persisted through the codec below) plus the
 * process-local fields the old bridge Session carried (armed barrier
 * instances, the gather-round stamp, in-flight flags). Keyed by Session in a
 * module-level WeakMap — a Session record replaced by /new or an idle reset
 * starts a fresh state, and the reset-carry semantics are the codec's.
 *
 * @module dsh-feishu-bridge-chatroom/chatroom-state
 */

import type { FeatureStateCodec, Session } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { ChatroomEndBarrier, ChatroomGather, type EndBarrierSnapshot, type GatherBarrierSnapshot } from './engine/chatroom.ts'

/** The featureState key of the chatroom section. */
export const chatroomFeatureStateKey = 'chatroom'

/**
 * The chatroom section of `Session.featureState`: the durable chatroom and
 * research session fields (all optional; the live state defaults the missing
 * keys), nested one level below their version-2 flat names. The bridge lifts
 * a version-2 file's flat fields into this section raw on load.
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
  /** 1-based count of chatrooms started on this hub; run ≥ 2 gets its own ledger dir. */
  chatroomLedgerRun?: number
  /** Shared uv venv path for research assistants. */
  researchVenv?: string
  /** Hub-side pending role name for a routed human reply. */
  pendingHumanQuestionRole?: string
  /** Durable snapshot of the armed gather barrier (consumed at engine start). */
  pendingGatherData?: GatherBarrierSnapshot | undefined
  /** Durable snapshot of the armed end barrier (consumed at engine start). */
  pendingEndBarrierData?: EndBarrierSnapshot | undefined
}

/**
 * One session's chatroom state. Durable fields read and write the
 * featureState section in place (so a codec-less save still persists them
 * verbatim); the process-local fields (barrier instances, stamps, flags)
 * live only here.
 */
export class ChatroomSessionState {
  private readonly section: ChatroomFeatureState

  constructor(section: ChatroomFeatureState) {
    this.section = section
  }

  /** Session key of the hub driving this role session ('' when not a role). */
  get chatroomHubKey(): string { return this.section.chatroomHubKey ?? '' }
  set chatroomHubKey(value: string) { this.section.chatroomHubKey = value }

  /** Role name this session plays in its chatroom. */
  get chatroomRoleName(): string { return this.section.chatroomRoleName ?? '' }
  set chatroomRoleName(value: string) { this.section.chatroomRoleName = value }

  /** One-shot ask gate: the hub already asked this role in the current gather round. */
  get chatroomAsked(): boolean { return this.section.chatroomAsked ?? false }
  set chatroomAsked(value: boolean) { this.section.chatroomAsked = value }

  /** Hub session driving a research-mode chatroom. */
  get chatroomResearch(): boolean { return this.section.chatroomResearch ?? false }
  set chatroomResearch(value: boolean) { this.section.chatroomResearch = value }

  /** Hub session converted into a 1:1 direct chatroom. */
  get chatroomDirectRole(): boolean { return this.section.chatroomDirectRole ?? false }
  set chatroomDirectRole(value: boolean) { this.section.chatroomDirectRole = value }

  /** Session key of a research role's pre-spawned assistant subgroup. */
  get researchAssistantKey(): string { return this.section.researchAssistantKey ?? '' }
  set researchAssistantKey(value: string) { this.section.researchAssistantKey = value }

  /** Marks a pre-spawned research-assistant subgroup. */
  get researchAssistant(): boolean { return this.section.researchAssistant ?? false }
  set researchAssistant(value: boolean) { this.section.researchAssistant = value }

  /** Research role awaiting its assistant's report before concluding. */
  get researchAwaitingAssistant(): boolean { return this.section.researchAwaitingAssistant ?? false }
  set researchAwaitingAssistant(value: boolean) { this.section.researchAwaitingAssistant = value }

  /** Research role dispatched its assistant this round; in-memory only. */
  researchDispatched = false

  /** Gather-round stamp on a role session; in-memory only. */
  chatroomAskSeq = 0

  /** Hub session driving a chatroom as the moderator. */
  get chatroomModerator(): boolean { return this.section.chatroomModerator ?? false }
  set chatroomModerator(value: boolean) { this.section.chatroomModerator = value }

  /** Research iteration driver: 'auto' | 'manual' ('' when unset). */
  get chatroomResearchMode(): string { return this.section.chatroomResearchMode ?? '' }
  set chatroomResearchMode(value: string) { this.section.chatroomResearchMode = value }

  /** Current research iteration round, 1-based (0 before the first). */
  get chatroomResearchRound(): number { return this.section.chatroomResearchRound ?? 0 }
  set chatroomResearchRound(value: number) { this.section.chatroomResearchRound = value }

  /** Per-invocation auto-mode research round cap (0 for the default). */
  get chatroomResearchMaxRounds(): number { return this.section.chatroomResearchMaxRounds ?? 0 }
  set chatroomResearchMaxRounds(value: number) { this.section.chatroomResearchMaxRounds = value }

  /** Monotonic per-hub gather-round counter. */
  get chatroomGatherSeq(): number { return this.section.chatroomGatherSeq ?? 0 }
  set chatroomGatherSeq(value: number) { this.section.chatroomGatherSeq = value }

  /** 1-based count of chatrooms started on this hub (0 before the first). */
  get chatroomLedgerRun(): number { return this.section.chatroomLedgerRun ?? 0 }
  set chatroomLedgerRun(value: number) { this.section.chatroomLedgerRun = value }

  /** Shared uv venv path research assistants reuse. */
  get researchVenv(): string { return this.section.researchVenv ?? '' }
  set researchVenv(value: string) { this.section.researchVenv = value }

  /** Role has an asked question whose turn is generating; in-memory only. */
  chatroomInFlight = false

  /** Hub-side pending role name for a routed human reply. */
  get pendingHumanQuestionRole(): string { return this.section.pendingHumanQuestionRole ?? '' }
  set pendingHumanQuestionRole(value: string) { this.section.pendingHumanQuestionRole = value }

  /** Armed chatroom gather barrier on a hub session; in-memory only. */
  pendingGather: ChatroomGather | undefined

  /** Armed chatroom end barrier on a hub session; in-memory only. */
  pendingEndBarrier: ChatroomEndBarrier | undefined

  /**
   * Durable snapshot of pendingGather from the last on-disk load; recovery
   * (recoverChatroomBarriers) consumes it at engine start.
   */
  get pendingGatherData(): GatherBarrierSnapshot | undefined { return this.section.pendingGatherData }
  set pendingGatherData(value: GatherBarrierSnapshot | undefined) { this.section.pendingGatherData = value }

  /**
   * Durable snapshot of pendingEndBarrier from the last on-disk load;
   * recovery (recoverChatroomBarriers) consumes it at engine start.
   */
  get pendingEndBarrierData(): EndBarrierSnapshot | undefined { return this.section.pendingEndBarrierData }
  set pendingEndBarrierData(value: EndBarrierSnapshot | undefined) { this.section.pendingEndBarrierData = value }
}

const liveStates = new WeakMap<Session, ChatroomSessionState>()

/**
 * The chatroom live state of a session, creating it on first access. The
 * durable fields address `session.featureState.chatroom`; a section that is
 * not an object (a hand-corrupted file) is replaced — the accessors default
 * every missing key, so state is lost either way but reads and writes must
 * not throw.
 * @param session - The session whose chatroom state is addressed.
 * @returns the mutable chatroom state of the session.
 */
export function chatroomState(session: Session): ChatroomSessionState {
  let state = liveStates.get(session)
  if (state === undefined) {
    let section: unknown = session.featureState[chatroomFeatureStateKey]
    if (typeof section !== 'object' || section === null) {
      section = {}
      session.featureState[chatroomFeatureStateKey] = section
    }
    state = new ChatroomSessionState(section as ChatroomFeatureState)
    liveStates.set(session, state)
  }
  return state
}

/**
 * The chatroom codec: projects the durable chatroom/research fields (plus
 * the armed barrier snapshots) into the `chatroom` featureState section, and
 * carries the chat-scoped subset — identity, orchestration counters, the
 * provisioned research assistant, the pending human question, and the armed
 * barriers by reference — across a conversation reset. The
 * conversation-scoped gates (chatroomAsked, researchAwaitingAssistant)
 * deliberately reset with the conversation. Registration happens once per
 * process in the plugin apply.
 */
export const chatroomFeatureStateCodec: FeatureStateCodec = {
  key: chatroomFeatureStateKey,
  encode(session: Session): unknown {
    const s = chatroomState(session)
    const pendingGatherData = s.pendingGather?.snapshot()
    const pendingEndBarrierData = s.pendingEndBarrier?.snapshot()
    const section = {
      ...(s.chatroomHubKey !== '' ? { chatroomHubKey: s.chatroomHubKey } : {}),
      ...(s.chatroomRoleName !== '' ? { chatroomRoleName: s.chatroomRoleName } : {}),
      ...(s.chatroomAsked ? { chatroomAsked: true } : {}),
      ...(s.chatroomResearch ? { chatroomResearch: true } : {}),
      ...(s.chatroomDirectRole ? { chatroomDirectRole: true } : {}),
      ...(s.researchAssistantKey !== '' ? { researchAssistantKey: s.researchAssistantKey } : {}),
      ...(s.researchAssistant ? { researchAssistant: true } : {}),
      ...(s.researchAwaitingAssistant ? { researchAwaitingAssistant: true } : {}),
      ...(s.chatroomModerator ? { chatroomModerator: true } : {}),
      ...(s.chatroomResearchMode !== '' ? { chatroomResearchMode: s.chatroomResearchMode } : {}),
      ...(s.chatroomResearchRound !== 0 ? { chatroomResearchRound: s.chatroomResearchRound } : {}),
      ...(s.chatroomResearchMaxRounds !== 0 ? { chatroomResearchMaxRounds: s.chatroomResearchMaxRounds } : {}),
      ...(s.chatroomGatherSeq !== 0 ? { chatroomGatherSeq: s.chatroomGatherSeq } : {}),
      ...(s.chatroomLedgerRun !== 0 ? { chatroomLedgerRun: s.chatroomLedgerRun } : {}),
      ...(s.researchVenv !== '' ? { researchVenv: s.researchVenv } : {}),
      ...(s.pendingHumanQuestionRole !== '' ? { pendingHumanQuestionRole: s.pendingHumanQuestionRole } : {}),
      ...(pendingGatherData !== undefined ? { pendingGatherData } : {}),
      ...(pendingEndBarrierData !== undefined ? { pendingEndBarrierData } : {}),
    }
    return Object.keys(section).length > 0 ? section : undefined
  },
  carry(from: Session, to: Session): void {
    const f = chatroomState(from)
    const t = chatroomState(to)
    // Chatroom identity and orchestration.
    t.chatroomHubKey = f.chatroomHubKey
    t.chatroomRoleName = f.chatroomRoleName
    t.chatroomModerator = f.chatroomModerator
    t.chatroomDirectRole = f.chatroomDirectRole
    t.chatroomResearch = f.chatroomResearch
    t.chatroomResearchMode = f.chatroomResearchMode
    t.chatroomResearchRound = f.chatroomResearchRound
    t.chatroomResearchMaxRounds = f.chatroomResearchMaxRounds
    t.chatroomGatherSeq = f.chatroomGatherSeq
    t.chatroomLedgerRun = f.chatroomLedgerRun
    // The chat's provisioned research assistant.
    t.researchAssistantKey = f.researchAssistantKey
    t.researchAssistant = f.researchAssistant
    t.researchVenv = f.researchVenv
    // Chat-scoped scheduling: in-flight barriers and the pending human
    // question survive a conversation reset, or a running round silently
    // degrades and a suspended question stops routing.
    t.pendingGather = f.pendingGather
    t.pendingEndBarrier = f.pendingEndBarrier
    t.pendingHumanQuestionRole = f.pendingHumanQuestionRole
  },
}
