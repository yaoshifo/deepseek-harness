/**
 * Session bookkeeping ported from cc-connect core/session.go: one Session per
 * conversation plus the SessionManager that owns named sessions per user key
 * with active-session tracking and JSON persistence. The on-disk snapshot
 * keeps the Go field names so an existing sessions.json reloads unchanged.
 *
 * Concurrency mapping (plan D7): Go's per-Session sync.Mutex collapses into
 * plain fields — JS runs the synchronous mutators on one thread, and the
 * busy flag (TryLock/Unlock) stays as logical turn ownership the way Go used
 * it. Persistence is awaited at call sites that need durability.
 *
 * @module dsh-feishu-bridge/session
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ContinueSession,
  ForkAtSessionPrefix,
  ForkSessionPrefix,
} from '../core/types.js'
import type { AgentSessionInfo, HistoryEntry } from '../core/types.js'
import { atomicWriteFileSync } from '../atomicwrite.js'

/** Bounds the in-memory Session.history slice (recent-window consumers only). */
const maxHistoryEntries = 100

/** Snapshot schema version for migration detection (Go snapshotVersion). */
const snapshotVersion = 1

function nowISO(): string {
  return new Date().toISOString()
}

/**
 * One conversation between a user and the agent (Go core.Session). Fields not
 * yet exercised by ported M1 tests stay as data carriers for later
 * milestones; accessors arrive with them.
 */
export class Session {
  id = ''
  name = ''
  agentSessionID = ''
  agentType = ''
  parentSessionKey = ''
  parentChatName = ''
  subtaskDepth = 0
  subtaskAttended = false
  spawnUserID = ''
  monitorGroup = false
  monitorOriginMessageID = ''
  monitorChild = false
  subtaskReported = false
  subtaskAutoReportSuppressed = false
  subtaskNoReport = false
  userInterjected = false
  lastResult = ''
  worktreePath = ''
  worktreeBranch = ''
  worktreeBase = ''
  worktreeRepoRoot = ''
  pastAgentSessionIDs: string[] = []
  topNoticeMessageID = ''
  chatroomHubKey = ''
  chatroomRoleName = ''
  chatroomAsked = false
  /** Hub session driving a research-mode chatroom (Go ChatroomResearch). */
  chatroomResearch = false
  /** Hub session converted into a 1:1 direct chatroom (Go ChatroomDirectRole). */
  chatroomDirectRole = false
  /** Session key of a research role's pre-spawned assistant subgroup (Go ResearchAssistantKey). */
  researchAssistantKey = ''
  /** Marks a pre-spawned research-assistant subgroup (Go ResearchAssistant). */
  researchAssistant = false
  /** Research role awaiting its assistant's report before concluding (Go ResearchAwaitingAssistant). */
  researchAwaitingAssistant = false
  /** Research role dispatched its assistant this round; in-memory only (Go ResearchDispatched). */
  researchDispatched = false
  /** Gather-round stamp on a role session; in-memory only (Go ChatroomAskSeq). */
  chatroomAskSeq = 0
  /** Hub session driving a chatroom as the moderator (Go ChatroomModerator). */
  chatroomModerator = false
  /** Research iteration driver: 'auto' | 'manual' (Go ChatroomResearchMode). */
  chatroomResearchMode = ''
  /** Current research iteration round, 1-based (Go ChatroomResearchRound). */
  chatroomResearchRound = 0
  /** Per-invocation override of the auto-mode research round cap (Go ChatroomResearchMaxRounds). */
  chatroomResearchMaxRounds = 0
  /** Monotonic per-hub gather-round counter (Go ChatroomGatherSeq). */
  chatroomGatherSeq = 0
  /** Shared uv venv path for research assistants (Go ResearchVenv). */
  researchVenv = ''
  /** Role has an asked question whose turn is generating; in-memory only (Go ChatroomInFlight). */
  chatroomInFlight = false
  /** Hub-side pending role name for a routed human reply (Go PendingHumanQuestionRole). */
  pendingHumanQuestionRole = ''
  /** Armed chatroom gather barrier on a hub session; in-memory only (Go PendingGather). */
  pendingGather: import('./chatroom.js').ChatroomGather | undefined
  /** Armed chatroom end barrier on a hub session; in-memory only (Go PendingEndBarrier). */
  pendingEndBarrier: import('./chatroom.js').ChatroomEndBarrier | undefined
  /**
   * Pending monitor dir-clarification on this chat (Go
   * PendingMonitorClarification); in-memory only — a restart mid-clarify
   * loses it and an orphan card click falls through to normal triage.
   */
  private pendingMonitorClarification: import('./monitor.js').MonitorClarification | undefined
  /** Permission mode pinned for a /spawn //fork child; in-memory only (Go InheritedMode). */
  inheritedMode = ''
  /** Armed subtask gather barrier on a parent session; in-memory only (Go PendingSubtaskGather). */
  pendingSubtaskGather: import('./subtask.js').SubtaskGather | undefined
  history: HistoryEntry[] = []
  createdAt = nowISO()
  updatedAt = nowISO()

  private busy = false

  /** Claim the session for a turn; false when a turn is already in flight. */
  tryLock(): boolean {
    if (this.busy) return false
    this.busy = true
    return true
  }

  /** Whether a turn is currently in flight (SendToSubtask backpressure). */
  isBusy(): boolean {
    return this.busy
  }

  /** Release the turn claim, bumping updatedAt unless suppressed. */
  unlock(): void {
    this.unlockInternal(true)
  }

  /** Release the turn claim without touching updatedAt. */
  unlockWithoutUpdate(): void {
    this.unlockInternal(false)
  }

  private unlockInternal(update: boolean): void {
    this.busy = false
    if (update) this.updatedAt = nowISO()
  }

  /** Append one history entry, bounding the in-memory slice. */
  addHistory(role: HistoryEntry['role'], content: string): void {
    this.history.push({ role, content, timestamp: nowISO() })
    if (this.history.length > maxHistoryEntries) {
      this.history = this.history.slice(this.history.length - maxHistoryEntries)
    }
  }

  /** Save the current agentSessionID to pastAgentSessionIDs (no duplicates). */
  recordPastAgentSessionID(): void {
    if (this.agentSessionID === '' || this.agentSessionID === ContinueSession) return
    if (this.pastAgentSessionIDs.includes(this.agentSessionID)) return
    this.pastAgentSessionIDs.push(this.agentSessionID)
  }

  /** Atomically set the agent session ID, type, and name. */
  setAgentInfo(agentSessionID: string, agentType: string, name: string): void {
    if (agentSessionID === ContinueSession) agentSessionID = ''
    if (this.agentSessionID !== agentSessionID) this.recordPastAgentSessionID()
    this.agentSessionID = agentSessionID
    this.agentType = agentType
    this.name = name
  }

  getAgentSessionID(): string {
    return this.agentSessionID
  }

  getParentSessionKey(): string {
    return this.parentSessionKey
  }

  setParentSessionKey(key: string): void {
    this.parentSessionKey = key
  }

  /** Worktree metadata as [path, branch, base, root]; all empty when unset. */
  getWorktreeInfo(): [path: string, branch: string, base: string, root: string] {
    return [this.worktreePath, this.worktreeBranch, this.worktreeBase, this.worktreeRepoRoot]
  }

  setWorktreeInfo(path: string, branch: string, base: string, root: string): void {
    this.worktreePath = path
    this.worktreeBranch = branch
    this.worktreeBase = base
    this.worktreeRepoRoot = root
  }

  getParentChatName(): string {
    return this.parentChatName
  }

  setParentChatName(name: string): void {
    this.parentChatName = name
  }

  getSubtaskDepth(): number {
    return this.subtaskDepth
  }

  getSubtaskAttended(): boolean {
    return this.subtaskAttended
  }

  setSubtaskAttended(v: boolean): void {
    this.subtaskAttended = v
  }

  getSubtaskAutoReportSuppressed(): boolean {
    return this.subtaskAutoReportSuppressed
  }

  setSubtaskAutoReportSuppressed(v: boolean): void {
    this.subtaskAutoReportSuppressed = v
  }

  setSubtaskDepth(d: number): void {
    this.subtaskDepth = d
  }

  getChatroomHubKey(): string {
    return this.chatroomHubKey
  }

  setChatroomHubKey(key: string): void {
    this.chatroomHubKey = key
  }

  getChatroomRoleName(): string {
    return this.chatroomRoleName
  }

  setChatroomRoleName(name: string): void {
    this.chatroomRoleName = name
  }

  getChatroomAsked(): boolean {
    return this.chatroomAsked
  }

  setChatroomAsked(v: boolean): void {
    this.chatroomAsked = v
  }

  getChatroomResearch(): boolean {
    return this.chatroomResearch
  }

  setChatroomResearch(v: boolean): void {
    this.chatroomResearch = v
  }

  getChatroomDirectRole(): boolean {
    return this.chatroomDirectRole
  }

  setChatroomDirectRole(v: boolean): void {
    this.chatroomDirectRole = v
  }

  getResearchAssistantKey(): string {
    return this.researchAssistantKey
  }

  setResearchAssistantKey(key: string): void {
    this.researchAssistantKey = key
  }

  getResearchAssistant(): boolean {
    return this.researchAssistant
  }

  setResearchAssistant(v: boolean): void {
    this.researchAssistant = v
  }

  getResearchAwaitingAssistant(): boolean {
    return this.researchAwaitingAssistant
  }

  setResearchAwaitingAssistant(v: boolean): void {
    this.researchAwaitingAssistant = v
  }

  getResearchDispatched(): boolean {
    return this.researchDispatched
  }

  setResearchDispatched(v: boolean): void {
    this.researchDispatched = v
  }

  getChatroomAskSeq(): number {
    return this.chatroomAskSeq
  }

  setChatroomAskSeq(seq: number): void {
    this.chatroomAskSeq = seq
  }

  getChatroomModerator(): boolean {
    return this.chatroomModerator
  }

  setChatroomModerator(v: boolean): void {
    this.chatroomModerator = v
  }

  getChatroomResearchMode(): string {
    return this.chatroomResearchMode
  }

  setChatroomResearchMode(mode: string): void {
    this.chatroomResearchMode = mode
  }

  getChatroomResearchRound(): number {
    return this.chatroomResearchRound
  }

  setChatroomResearchRound(round: number): void {
    this.chatroomResearchRound = round
  }

  getChatroomResearchMaxRounds(): number {
    return this.chatroomResearchMaxRounds
  }

  setChatroomResearchMaxRounds(n: number): void {
    this.chatroomResearchMaxRounds = n
  }

  getChatroomGatherSeq(): number {
    return this.chatroomGatherSeq
  }

  setChatroomGatherSeq(seq: number): void {
    this.chatroomGatherSeq = seq
  }

  getResearchVenv(): string {
    return this.researchVenv
  }

  setResearchVenv(v: string): void {
    this.researchVenv = v
  }

  getChatroomInFlight(): boolean {
    return this.chatroomInFlight
  }

  setChatroomInFlight(v: boolean): void {
    this.chatroomInFlight = v
  }

  getPendingHumanQuestionRole(): string {
    return this.pendingHumanQuestionRole
  }

  setPendingHumanQuestionRole(role: string): void {
    this.pendingHumanQuestionRole = role
  }

  getPendingGather(): import('./chatroom.js').ChatroomGather | undefined {
    return this.pendingGather
  }

  setPendingGather(g: import('./chatroom.js').ChatroomGather | undefined): void {
    this.pendingGather = g
  }

  getPendingEndBarrier(): import('./chatroom.js').ChatroomEndBarrier | undefined {
    return this.pendingEndBarrier
  }

  setPendingEndBarrier(b: import('./chatroom.js').ChatroomEndBarrier | undefined): void {
    this.pendingEndBarrier = b
  }

  getInheritedMode(): string {
    return this.inheritedMode
  }

  setInheritedMode(mode: string): void {
    this.inheritedMode = mode
  }

  getPendingSubtaskGather(): import('./subtask.js').SubtaskGather | undefined {
    return this.pendingSubtaskGather
  }

  setPendingSubtaskGather(g: import('./subtask.js').SubtaskGather | undefined): void {
    this.pendingSubtaskGather = g
  }

  getMonitorGroup(): boolean {
    return this.monitorGroup
  }

  setMonitorGroup(v: boolean): void {
    this.monitorGroup = v
  }

  getMonitorOriginMessageID(): string {
    return this.monitorOriginMessageID
  }

  setMonitorOriginMessageID(id: string): void {
    this.monitorOriginMessageID = id
  }

  /**
   * Whether #47/#48 auto-render should be skipped: chatroom roles relay to
   * the hub and subtask children report to their parent, so a local HTML
   * overview is redundant. Monitor-hub children and user-interjected sessions
   * are exempt.
   */
  shouldSuppressAutoRender(): boolean {
    if (this.monitorChild) return false
    return (this.chatroomHubKey !== '' || this.subtaskDepth > 0) && !this.userInterjected
  }

  getSpawnUserID(): string {
    return this.spawnUserID
  }

  setSpawnUserID(id: string): void {
    this.spawnUserID = id
  }

  getSubtaskReported(): boolean {
    return this.subtaskReported
  }

  setSubtaskReported(v: boolean): void {
    this.subtaskReported = v
  }

  getSubtaskNoReport(): boolean {
    return this.subtaskNoReport
  }

  setSubtaskNoReport(v: boolean): void {
    this.subtaskNoReport = v
  }

  setUserInterjected(v: boolean): void {
    this.userInterjected = v
  }

  getUserInterjected(): boolean {
    return this.userInterjected
  }

  setMonitorChild(v: boolean): void {
    this.monitorChild = v
  }

  getPendingMonitorClarification(): import('./monitor.js').MonitorClarification | undefined {
    return this.pendingMonitorClarification
  }

  setPendingMonitorClarification(pc: import('./monitor.js').MonitorClarification | undefined): void {
    this.pendingMonitorClarification = pc
  }

  /** Most recent assistant turn's text, or '' when none. */
  lastAssistantReply(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i]
      if (entry?.role === 'assistant') return entry.content
    }
    return ''
  }

  setLastResult(v: string): void {
    this.lastResult = v
  }

  /** Clean SDK final result when available, else the last assistant entry. */
  lastResultOrReply(): string {
    if (this.lastResult.trim() !== '') return this.lastResult
    return this.lastAssistantReply()
  }

  getName(): string {
    return this.name
  }

  setName(name: string): void {
    this.name = name
  }

  getUpdatedAt(): string {
    return this.updatedAt
  }

  /**
   * Set the agent session ID and type. The ContinueSession sentinel is never
   * persisted; a replaced or cleared ID is saved to pastAgentSessionIDs so
   * owned-session filtering keeps recognizing the session.
   */
  setAgentSessionID(id: string, agentType: string): void {
    if (id === ContinueSession) return
    if (this.agentSessionID !== id) this.recordPastAgentSessionID()
    this.agentSessionID = id
    this.agentType = agentType
  }

  /**
   * Set the agent session ID only when the slot is empty or still holds a
   * sentinel (Continue / fork prefixes); a concrete ID is sticky.
   */
  compareAndSetAgentSessionID(id: string, agentType: string): boolean {
    if (id === '' || id === ContinueSession) return false
    if (this.agentSessionID !== '' && this.agentSessionID !== ContinueSession
      && !this.agentSessionID.startsWith(ForkSessionPrefix)
      && !this.agentSessionID.startsWith(ForkAtSessionPrefix)) {
      return false
    }
    this.agentSessionID = id
    this.agentType = agentType
    return true
  }

  /** Drop a persisted ContinueSession sentinel (load-time sanitize). */
  stripContinueSessionSentinel(): void {
    if (this.agentSessionID === ContinueSession) this.agentSessionID = ''
  }

  clearHistory(): void {
    this.history = []
  }

  /** True when the session has exactly one user entry (the first message). */
  isFirstMessage(): boolean {
    const first = this.history[0]
    return this.history.length === 1 && first?.role === 'user'
  }

  setTopNoticeMessageID(messageID: string): void {
    this.topNoticeMessageID = messageID
  }

  getTopNoticeMessageID(): string {
    return this.topNoticeMessageID
  }

  /** Last n entries; n <= 0 returns all. */
  getHistory(n: number): HistoryEntry[] {
    const total = this.history.length
    if (n <= 0 || n > total) n = total
    return this.history.slice(total - n)
  }
}

/** Human-readable display info for a session key. */
export interface UserMeta {
  userName: string
  chatName: string
}

/** JSON-serializable SessionManager state (Go sessionSnapshot, same field names). */
interface SessionSnapshot {
  sessions?: Record<string, SerializedSession>
  active_session?: Record<string, string>
  user_sessions?: Record<string, string[]>
  counter?: number
  session_names?: Record<string, string>
  user_meta?: Record<string, UserMeta>
  past_id_tracking?: boolean
  legacy_data?: boolean
  version?: number
}

/** Serialized Session (Go field names, snake_case). */
interface SerializedSession {
  id: string
  name: string
  agent_session_id: string
  agent_type?: string
  parent_session_key?: string
  parent_chat_name?: string
  subtask_depth?: number
  subtask_attended?: boolean
  spawn_user_id?: string
  subtask_reported?: boolean
  subtask_auto_report_suppressed?: boolean
  subtask_no_report?: boolean
  user_interjected?: boolean
  monitor_group?: boolean
  monitor_child?: boolean
  last_result?: string
  worktree_path?: string
  worktree_branch?: string
  worktree_base?: string
  worktree_repo_root?: string
  past_agent_session_ids?: string[]
  topnotice_message_id?: string
  chatroom_hub_key?: string
  chatroom_role_name?: string
  chatroom_asked?: boolean
  chatroom_research?: boolean
  chatroom_direct_role?: boolean
  research_assistant_key?: string
  research_assistant?: boolean
  research_awaiting_assistant?: boolean
  chatroom_moderator?: boolean
  chatroom_research_mode?: string
  chatroom_research_round?: number
  chatroom_research_max_rounds?: number
  chatroom_gather_seq?: number
  research_venv?: string
  pending_human_question_role?: string
  history?: HistoryEntry[]
  created_at: string
  updated_at: string
}

function serializeSession(s: Session): SerializedSession {
  const agentSessionID = s.agentSessionID === ContinueSession ? '' : s.agentSessionID
  return {
    id: s.id,
    name: s.name,
    agent_session_id: agentSessionID,
    ...(s.agentType !== '' ? { agent_type: s.agentType } : {}),
    ...(s.parentSessionKey !== '' ? { parent_session_key: s.parentSessionKey } : {}),
    ...(s.parentChatName !== '' ? { parent_chat_name: s.parentChatName } : {}),
    ...(s.subtaskDepth !== 0 ? { subtask_depth: s.subtaskDepth } : {}),
    ...(s.subtaskAttended ? { subtask_attended: true } : {}),
    ...(s.spawnUserID !== '' ? { spawn_user_id: s.spawnUserID } : {}),
    ...(s.subtaskReported ? { subtask_reported: true } : {}),
    ...(s.subtaskAutoReportSuppressed ? { subtask_auto_report_suppressed: true } : {}),
    ...(s.subtaskNoReport ? { subtask_no_report: true } : {}),
    ...(s.userInterjected ? { user_interjected: true } : {}),
    ...(s.monitorGroup ? { monitor_group: true } : {}),
    ...(s.monitorChild ? { monitor_child: true } : {}),
    ...(s.lastResult !== '' ? { last_result: s.lastResult } : {}),
    ...(s.worktreePath !== '' ? { worktree_path: s.worktreePath } : {}),
    ...(s.worktreeBranch !== '' ? { worktree_branch: s.worktreeBranch } : {}),
    ...(s.worktreeBase !== '' ? { worktree_base: s.worktreeBase } : {}),
    ...(s.worktreeRepoRoot !== '' ? { worktree_repo_root: s.worktreeRepoRoot } : {}),
    ...(s.pastAgentSessionIDs.length > 0 ? { past_agent_session_ids: [...s.pastAgentSessionIDs] } : {}),
    ...(s.topNoticeMessageID !== '' ? { topnotice_message_id: s.topNoticeMessageID } : {}),
    ...(s.chatroomHubKey !== '' ? { chatroom_hub_key: s.chatroomHubKey } : {}),
    ...(s.chatroomRoleName !== '' ? { chatroom_role_name: s.chatroomRoleName } : {}),
    ...(s.chatroomAsked ? { chatroom_asked: true } : {}),
    ...(s.chatroomResearch ? { chatroom_research: true } : {}),
    ...(s.chatroomDirectRole ? { chatroom_direct_role: true } : {}),
    ...(s.researchAssistantKey !== '' ? { research_assistant_key: s.researchAssistantKey } : {}),
    ...(s.researchAssistant ? { research_assistant: true } : {}),
    ...(s.researchAwaitingAssistant ? { research_awaiting_assistant: true } : {}),
    ...(s.chatroomModerator ? { chatroom_moderator: true } : {}),
    ...(s.chatroomResearchMode !== '' ? { chatroom_research_mode: s.chatroomResearchMode } : {}),
    ...(s.chatroomResearchRound !== 0 ? { chatroom_research_round: s.chatroomResearchRound } : {}),
    ...(s.chatroomResearchMaxRounds !== 0 ? { chatroom_research_max_rounds: s.chatroomResearchMaxRounds } : {}),
    ...(s.chatroomGatherSeq !== 0 ? { chatroom_gather_seq: s.chatroomGatherSeq } : {}),
    ...(s.researchVenv !== '' ? { research_venv: s.researchVenv } : {}),
    ...(s.pendingHumanQuestionRole !== '' ? { pending_human_question_role: s.pendingHumanQuestionRole } : {}),
    history: [...s.history],
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }
}

function deserializeSession(raw: SerializedSession): Session {
  const s = new Session()
  s.id = raw.id
  s.name = raw.name
  s.agentSessionID = raw.agent_session_id
  s.agentType = raw.agent_type ?? ''
  s.parentSessionKey = raw.parent_session_key ?? ''
  s.parentChatName = raw.parent_chat_name ?? ''
  s.subtaskDepth = raw.subtask_depth ?? 0
  s.subtaskAttended = raw.subtask_attended ?? false
  s.spawnUserID = raw.spawn_user_id ?? ''
  s.monitorGroup = raw.monitor_group ?? false
  s.monitorOriginMessageID = ''
  s.monitorChild = raw.monitor_child ?? false
  s.subtaskReported = raw.subtask_reported ?? false
  s.subtaskAutoReportSuppressed = raw.subtask_auto_report_suppressed ?? false
  s.subtaskNoReport = raw.subtask_no_report ?? false
  s.userInterjected = raw.user_interjected ?? false
  s.lastResult = raw.last_result ?? ''
  s.worktreePath = raw.worktree_path ?? ''
  s.worktreeBranch = raw.worktree_branch ?? ''
  s.worktreeBase = raw.worktree_base ?? ''
  s.worktreeRepoRoot = raw.worktree_repo_root ?? ''
  s.pastAgentSessionIDs = raw.past_agent_session_ids ?? []
  s.topNoticeMessageID = raw.topnotice_message_id ?? ''
  s.chatroomHubKey = raw.chatroom_hub_key ?? ''
  s.chatroomRoleName = raw.chatroom_role_name ?? ''
  s.chatroomAsked = raw.chatroom_asked ?? false
  s.chatroomResearch = raw.chatroom_research ?? false
  s.chatroomDirectRole = raw.chatroom_direct_role ?? false
  s.researchAssistantKey = raw.research_assistant_key ?? ''
  s.researchAssistant = raw.research_assistant ?? false
  s.researchAwaitingAssistant = raw.research_awaiting_assistant ?? false
  s.chatroomModerator = raw.chatroom_moderator ?? false
  s.chatroomResearchMode = raw.chatroom_research_mode ?? ''
  s.chatroomResearchRound = raw.chatroom_research_round ?? 0
  s.chatroomResearchMaxRounds = raw.chatroom_research_max_rounds ?? 0
  s.chatroomGatherSeq = raw.chatroom_gather_seq ?? 0
  s.researchVenv = raw.research_venv ?? ''
  s.pendingHumanQuestionRole = raw.pending_human_question_role ?? ''
  s.history = raw.history ?? []
  s.createdAt = raw.created_at
  s.updatedAt = raw.updated_at
  return s
}

/**
 * Multiple named sessions per user key with active-session tracking and JSON
 * persistence (Go SessionManager). An empty storePath disables persistence.
 */
export class SessionManager {
  private sessions = new Map<string, Session>()
  private activeSession = new Map<string, string>()
  private userSessions = new Map<string, string[]>()
  private sessionNames = new Map<string, string>()
  private userMeta = new Map<string, UserMeta>()
  private counter = 0
  private readonly storePathValue: string
  /**
   * True while loaded data predates pastAgentSessionIDs tracking;
   * knownAgentSessionIDs returns null to disable owned-session filtering
   * until every session carries at least one tracked ID.
   */
  private legacyData = false

  constructor(storePath: string) {
    this.storePathValue = storePath
    if (storePath !== '') this.load()
  }

  /** File path used for persistence ('' = none). */
  storePath(): string {
    return this.storePathValue
  }

  private nextID(): string {
    this.counter++
    return `s${this.counter}`
  }

  /** The user key's active session, creating one when absent. */
  getOrCreateActive(userKey: string): Session {
    const sid = this.activeSession.get(userKey)
    if (sid !== undefined) {
      const s = this.sessions.get(sid)
      if (s !== undefined) return s
    }
    const s = this.createLocked(userKey, 'default')
    this.saveLocked()
    return s
  }

  /** Create a new session and make it active. */
  newSession(userKey: string, name: string): Session {
    const s = this.createLocked(userKey, name)
    this.saveLocked()
    return s
  }

  /**
   * Register a session without changing the active one — isolated one-off
   * runs (cron new_per_run) keep the user's chat as the default target.
   */
  newSideSession(userKey: string, name: string): Session {
    const id = this.nextID()
    const now = nowISO()
    const s = new Session()
    s.id = id
    s.name = name
    s.createdAt = now
    s.updatedAt = now
    this.sessions.set(id, s)
    this.pushUserSession(userKey, id)
    this.saveLocked()
    return s
  }

  private createLocked(userKey: string, name: string): Session {
    const id = this.nextID()
    const now = nowISO()
    const s = new Session()
    s.id = id
    s.name = name
    s.createdAt = now
    s.updatedAt = now
    // Inherit the chat-scoped owner so /new does not drop the spawn user ID.
    const prevID = this.activeSession.get(userKey)
    if (prevID !== undefined) {
      const prev = this.sessions.get(prevID)
      if (prev !== undefined) s.spawnUserID = prev.spawnUserID
    }
    this.sessions.set(id, s)
    this.activeSession.set(userKey, id)
    this.pushUserSession(userKey, id)
    return s
  }

  private pushUserSession(userKey: string, id: string): void {
    const list = this.userSessions.get(userKey)
    if (list === undefined) this.userSessions.set(userKey, [id])
    else list.push(id)
  }

  /** Switch to a session owned by the user key, matched by ID or name. */
  switchSession(userKey: string, target: string): Session {
    for (const sid of this.userSessions.get(userKey) ?? []) {
      const s = this.sessions.get(sid)
      if (s !== undefined && (s.id === target || s.name === target)) {
        this.activeSession.set(userKey, s.id)
        this.saveLocked()
        return s
      }
    }
    throw new Error(`session "${target}" not found`)
  }

  /**
   * Find (or create) the internal session mapped to an agent session ID; an
   * existing mapping becomes active, otherwise a fresh session preserves the
   * previous one's ID in knownAgentSessionIDs.
   */
  switchToAgentSession(userKey: string, agentSID: string, agentName: string, summary: string): Session {
    for (const sid of this.userSessions.get(userKey) ?? []) {
      const s = this.sessions.get(sid)
      if (s === undefined) continue
      if (s.agentSessionID === agentSID) {
        this.activeSession.set(userKey, s.id)
        this.saveLocked()
        return s
      }
    }
    const s = this.createLocked(userKey, summary)
    s.setAgentInfo(agentSID, agentName, summary)
    this.saveLocked()
    return s
  }

  /** All sessions for a user key, in creation order. */
  listSessions(userKey: string): Session[] {
    const out: Session[] = []
    for (const sid of this.userSessions.get(userKey) ?? []) {
      const s = this.sessions.get(sid)
      if (s !== undefined) out.push(s)
    }
    return out
  }

  /** The user key's active session ID ('' when none). */
  activeSessionID(userKey: string): string {
    return this.activeSession.get(userKey) ?? ''
  }

  /** Resolve the active Session without creating one (reapers, predicates). */
  findActive(userKey: string): Session | undefined {
    const sid = this.activeSessionID(userKey)
    if (sid !== '') return this.findByID(sid)
    return undefined
  }

  /** Set (or clear, with '') a custom display name for an agent session. */
  setSessionName(agentSessionID: string, name: string): void {
    if (name === '') this.sessionNames.delete(agentSessionID)
    else this.sessionNames.set(agentSessionID, name)
    this.saveLocked()
  }

  /** Custom name for an agent session, or ''. */
  getSessionName(agentSessionID: string): string {
    return this.sessionNames.get(agentSessionID) ?? ''
  }

  /** Merge non-empty display fields for a session key. */
  updateUserMeta(sessionKey: string, userName: string, chatName: string): void {
    if (userName === '' && chatName === '') return
    let meta = this.userMeta.get(sessionKey)
    if (meta === undefined) {
      meta = { userName: '', chatName: '' }
      this.userMeta.set(sessionKey, meta)
    }
    if (userName !== '') meta.userName = userName
    if (chatName !== '') meta.chatName = chatName
  }

  /** Stored metadata for a session key (a copy), or undefined. */
  getUserMeta(sessionKey: string): UserMeta | undefined {
    const m = this.userMeta.get(sessionKey)
    if (m === undefined) return undefined
    return { ...m }
  }

  /** All sessions across all user keys. */
  allSessions(): Session[] {
    return [...this.sessions.values()]
  }

  /** Find the session currently or historically mapped to an agent session ID. */
  findByAgentSessionID(agentSID: string): Session | undefined {
    for (const s of this.sessions.values()) {
      if (s.agentSessionID === agentSID) return s
      if (s.pastAgentSessionIDs.includes(agentSID)) return s
    }
    return undefined
  }

  /**
   * Agent session IDs cc-connect tracks (current and past), used to filter
   * agent.listSessions() output. Null while legacyData disables filtering.
   */
  knownAgentSessionIDs(): Record<string, true> | null {
    if (this.legacyData) return null
    const ids: Record<string, true> = {}
    for (const s of this.sessions.values()) {
      if (s.agentSessionID !== '') ids[s.agentSessionID] = true
      for (const past of s.pastAgentSessionIDs) ids[past] = true
    }
    return ids
  }

  /** Session ID → user key, plus the active session IDs per user key. */
  sessionKeyMap(): { idToKey: Record<string, string>; activeIDs: Record<string, true> } {
    const idToKey: Record<string, string> = {}
    const activeIDs: Record<string, true> = {}
    for (const [userKey, ids] of this.userSessions) {
      for (const sid of ids) idToKey[sid] = userKey
      const aid = this.activeSession.get(userKey)
      if (aid !== undefined) activeIDs[aid] = true
    }
    return { idToKey, activeIDs }
  }

  /** Look up a session by internal ID across all users. */
  findByID(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /** Remove a session by internal ID; true when it existed. */
  deleteByID(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.deleteByIDLocked(id)
    this.saveLocked()
    return true
  }

  /** Remove all local sessions mapped to an agent session ID; count removed. */
  deleteByAgentSessionID(agentSessionID: string): number {
    if (agentSessionID === '') return 0
    let removed = 0
    for (const [id, s] of this.sessions) {
      if (s.agentSessionID !== agentSessionID) continue
      this.deleteByIDLocked(id)
      removed++
    }
    if (removed > 0) this.saveLocked()
    return removed
  }

  private deleteByIDLocked(id: string): void {
    this.sessions.delete(id)
    for (const [userKey, ids] of this.userSessions) {
      const idx = ids.indexOf(id)
      if (idx >= 0) ids.splice(idx, 1)
      if (this.activeSession.get(userKey) === id) this.activeSession.delete(userKey)
    }
  }

  /** Persist current state to disk synchronously (Go saveLocked). */
  save(): void {
    this.saveLocked()
  }

  private saveLocked(): void {
    if (this.storePathValue === '') return

    const snapSessions: Record<string, SerializedSession> = {}
    for (const [id, s] of this.sessions) {
      if (s.agentSessionID === ContinueSession) s.agentSessionID = ''
      snapSessions[id] = serializeSession(s)
    }

    // Auto-clear legacyData once every session has at least one tracked ID.
    if (this.legacyData) {
      let allTracked = true
      for (const s of Object.values(snapSessions)) {
        if (s.agent_session_id === '' && (s.past_agent_session_ids ?? []).length === 0) {
          allTracked = false
          break
        }
      }
      if (allTracked) this.legacyData = false
    }

    const activeSession: Record<string, string> = {}
    for (const [k, v] of this.activeSession) activeSession[k] = v
    const userSessions: Record<string, string[]> = {}
    for (const [k, v] of this.userSessions) userSessions[k] = [...v]
    const sessionNames: Record<string, string> = {}
    for (const [k, v] of this.sessionNames) sessionNames[k] = v
    const userMeta: Record<string, UserMeta> = {}
    for (const [k, v] of this.userMeta) userMeta[k] = { ...v }

    const snap: SessionSnapshot = {
      sessions: snapSessions,
      active_session: activeSession,
      user_sessions: userSessions,
      counter: this.counter,
      session_names: sessionNames,
      user_meta: userMeta,
      past_id_tracking: true,
      legacy_data: this.legacyData,
      version: snapshotVersion,
    }
    const data = JSON.stringify(snap, null, 2) + '\n'
    try {
      mkdirSync(dirname(this.storePathValue), { recursive: true })
      atomicWriteFileSync(this.storePathValue, new TextEncoder().encode(data), 0o644)
    } catch (error) {
      // Persistence failure must not break message processing (Go logged and
      // returned; the engine keeps running on in-memory state).
      console.error('session: failed to write', this.storePathValue, String(error))
    }
  }

  private load(): void {
    let data: string
    try {
      data = readFileSync(this.storePathValue, 'utf8')
    } catch {
      return
    }
    let snap: SessionSnapshot
    try {
      snap = JSON.parse(data) as SessionSnapshot
    } catch (error) {
      console.error('session: failed to unmarshal', this.storePathValue, String(error))
      return
    }
    for (const [id, raw] of Object.entries(snap.sessions ?? {})) {
      this.sessions.set(id, deserializeSession(raw))
    }
    for (const [k, v] of Object.entries(snap.active_session ?? {})) this.activeSession.set(k, v)
    for (const [k, v] of Object.entries(snap.user_sessions ?? {})) this.userSessions.set(k, [...v])
    for (const [k, v] of Object.entries(snap.session_names ?? {})) this.sessionNames.set(k, v)
    for (const [k, v] of Object.entries(snap.user_meta ?? {})) this.userMeta.set(k, { userName: v.userName, chatName: v.chatName })
    this.counter = snap.counter ?? 0

    if ((snap.version ?? 0) >= snapshotVersion) {
      this.legacyData = snap.legacy_data ?? false
    } else {
      this.legacyData = !(snap.past_id_tracking ?? false)
      if (!this.legacyData) {
        for (const s of this.sessions.values()) {
          if (s.agentSessionID === '' && s.pastAgentSessionIDs.length === 0) {
            this.legacyData = true
            break
          }
        }
      }
    }

    for (const s of this.sessions.values()) s.stripContinueSessionSentinel()
  }

  /**
   * Clear agentSessionID on sessions whose agentType mismatches the current
   * agent, so stale IDs from a switched agent type cannot break resume.
   */
  invalidateForAgent(agentType: string): void {
    let invalidated = 0
    for (const s of this.sessions.values()) {
      if (s.agentSessionID !== '' && s.agentType !== '' && s.agentType !== agentType) {
        s.recordPastAgentSessionID()
        s.agentSessionID = ''
        s.agentType = agentType
        invalidated++
      }
    }
    if (invalidated > 0) this.saveLocked()
  }
}

/**
 * Keep only agent sessions tracked by cc-connect, hiding external CLI
 * sessions in the same work_dir. An empty known set returns everything.
 */
export function filterOwnedSessions(
  sessions: AgentSessionInfo[],
  known: Record<string, true> | null,
): AgentSessionInfo[] {
  if (known === null || Object.keys(known).length === 0) return sessions
  return sessions.filter(s => s.id in known)
}
