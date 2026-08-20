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
  /** Internal session ID (Go ID), e.g. 's1'. */
  id = ''
  /** Display name of the session. */
  name = ''
  /** Agent-side session ID currently mapped to this session ('' when none). */
  agentSessionID = ''
  /** Agent type that produced the current agentSessionID ('' when none). */
  agentType = ''
  /** Session key of the parent that spawned this subtask child ('' at top level). */
  parentSessionKey = ''
  /** Display label of the parent conversation used on subtask reply cards. */
  parentChatName = ''
  /** Nesting depth of this session in the subtask tree (0 = top level). */
  subtaskDepth = 0
  /** Whether a human is present in this subtask (attended subtask). */
  subtaskAttended = false
  /** User ID owning the chat this session was spawned from; inherited by /new. */
  spawnUserID = ''
  /** Marks the monitored-chat session: parent replies post a card only and never wake an agent. */
  monitorGroup = false
  /** Message ID of the alert that spawned the monitor child, for the later Done reaction; in-memory only. */
  monitorOriginMessageID = ''
  /** Whether this session is a child spawned for a monitored chat. */
  monitorChild = false
  /** Whether this subtask child already reported its result to the parent. */
  subtaskReported = false
  /** Whether the one-shot auto-report at turn end is suppressed for this child. */
  subtaskAutoReportSuppressed = false
  /** Whether this monitor-spawned subgroup must skip reporting its per-turn output. */
  subtaskNoReport = false
  /** Whether the user interjected mid-turn; exempts the session from auto-render suppression. */
  userInterjected = false
  /** Clean final SDK result of the last completed turn ('' when none). */
  lastResult = ''
  /** Absolute path of the session's git worktree ('' when none). */
  worktreePath = ''
  /** Branch checked out in the session's worktree. */
  worktreeBranch = ''
  /** Base ref the worktree branch forked from. */
  worktreeBase = ''
  /** Repository root the worktree was created under. */
  worktreeRepoRoot = ''
  /** Agent session IDs previously held by this session, so owned-session filtering keeps recognizing them. */
  pastAgentSessionIDs: string[] = []
  /** Message ID of the chat's pinned top-notice banner, cleared when replaced. */
  topNoticeMessageID = ''
  /** Session key of the hub driving this chatroom role session ('' when not a role). */
  chatroomHubKey = ''
  /** Role name this session plays in its chatroom. */
  chatroomRoleName = ''
  /** One-shot ask gate: the hub already asked this role in the current gather round. */
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
  /** Recent conversation entries, bounded to maxHistoryEntries in memory. */
  history: HistoryEntry[] = []
  /** ISO timestamp recorded at session creation. */
  createdAt = nowISO()
  /** ISO timestamp of the latest mutation. */
  updatedAt = nowISO()

  private busy = false

  /**
   * Claim the session for a turn; false when a turn is already in flight.
   *
   * @returns whether the claim succeeded.
   */
  tryLock(): boolean {
    if (this.busy) return false
    this.busy = true
    return true
  }

  /**
   * Whether a turn is currently in flight (SendToSubtask backpressure).
   *
   * @returns whether a turn holds the session.
   */
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

  /**
   * Append one history entry, bounding the in-memory slice.
   *
   * @param role - the entry's conversation role.
   * @param content - the entry's message text.
   */
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

  /**
   * Atomically set the agent session ID, type, and name.
   *
   * @param agentSessionID - the new agent session ID, '' to clear.
   * @param agentType - the agent type that owns the ID.
   * @param name - the new session display name.
   */
  setAgentInfo(agentSessionID: string, agentType: string, name: string): void {
    if (agentSessionID === ContinueSession) agentSessionID = ''
    if (this.agentSessionID !== agentSessionID) this.recordPastAgentSessionID()
    this.agentSessionID = agentSessionID
    this.agentType = agentType
    this.name = name
  }

  /**
   * Current agent session ID.
   *
   * @returns the stored agentSessionID, '' when unset.
   */
  getAgentSessionID(): string {
    return this.agentSessionID
  }

  /**
   * Parent session key.
   *
   * @returns the stored parentSessionKey, '' at top level.
   */
  getParentSessionKey(): string {
    return this.parentSessionKey
  }

  /**
   * Record the parent that spawned this subtask child.
   *
   * @param key - the parent's session key.
   */
  setParentSessionKey(key: string): void {
    this.parentSessionKey = key
  }

  /**
   * Worktree metadata as [path, branch, base, root]; all empty when unset.
   *
   * @returns the [path, branch, base, root] tuple.
   */
  getWorktreeInfo(): [path: string, branch: string, base: string, root: string] {
    return [this.worktreePath, this.worktreeBranch, this.worktreeBase, this.worktreeRepoRoot]
  }

  /**
   * Store the worktree metadata getWorktreeInfo returns.
   *
   * @param path - the worktree's absolute path.
   * @param branch - the branch checked out in the worktree.
   * @param base - the base ref the branch forked from.
   * @param root - the repository root the worktree lives under.
   */
  setWorktreeInfo(path: string, branch: string, base: string, root: string): void {
    this.worktreePath = path
    this.worktreeBranch = branch
    this.worktreeBase = base
    this.worktreeRepoRoot = root
  }

  /**
   * Parent conversation's display label.
   *
   * @returns the stored parentChatName, '' when unset.
   */
  getParentChatName(): string {
    return this.parentChatName
  }

  /**
   * Set the parent conversation's display label.
   *
   * @param name - the new label.
   */
  setParentChatName(name: string): void {
    this.parentChatName = name
  }

  /**
   * Nesting depth in the subtask tree.
   *
   * @returns the stored subtaskDepth, 0 at top level.
   */
  getSubtaskDepth(): number {
    return this.subtaskDepth
  }

  /**
   * Whether a human is present in this subtask.
   *
   * @returns the stored subtaskAttended.
   */
  getSubtaskAttended(): boolean {
    return this.subtaskAttended
  }

  /**
   * Mark whether a human is present in this subtask.
   *
   * @param v - the new flag value.
   */
  setSubtaskAttended(v: boolean): void {
    this.subtaskAttended = v
  }

  /**
   * Whether the one-shot auto-report at turn end is suppressed.
   *
   * @returns the stored subtaskAutoReportSuppressed.
   */
  getSubtaskAutoReportSuppressed(): boolean {
    return this.subtaskAutoReportSuppressed
  }

  /**
   * Suppress or restore the one-shot auto-report for this child.
   *
   * @param v - the new flag value.
   */
  setSubtaskAutoReportSuppressed(v: boolean): void {
    this.subtaskAutoReportSuppressed = v
  }

  /**
   * Set the nesting depth in the subtask tree.
   *
   * @param d - the new depth, 0 at top level.
   */
  setSubtaskDepth(d: number): void {
    this.subtaskDepth = d
  }

  /**
   * Session key of the hub driving this role session.
   *
   * @returns the stored chatroomHubKey, '' when not a chatroom role.
   */
  getChatroomHubKey(): string {
    return this.chatroomHubKey
  }

  /**
   * Attach this role session to a chatroom hub.
   *
   * @param key - the hub's session key.
   */
  setChatroomHubKey(key: string): void {
    this.chatroomHubKey = key
  }

  /**
   * Role name this session plays in its chatroom.
   *
   * @returns the stored chatroomRoleName, '' when unset.
   */
  getChatroomRoleName(): string {
    return this.chatroomRoleName
  }

  /**
   * Set the role name this session plays in its chatroom.
   *
   * @param name - the new role name.
   */
  setChatroomRoleName(name: string): void {
    this.chatroomRoleName = name
  }

  /**
   * Whether the hub already asked this role in the current gather round.
   *
   * @returns the stored chatroomAsked.
   */
  getChatroomAsked(): boolean {
    return this.chatroomAsked
  }

  /**
   * Arm or clear the one-shot ask gate for the current gather round.
   *
   * @param v - the new flag value.
   */
  setChatroomAsked(v: boolean): void {
    this.chatroomAsked = v
  }

  /**
   * Whether this hub session drives a research-mode chatroom.
   *
   * @returns the stored chatroomResearch.
   */
  getChatroomResearch(): boolean {
    return this.chatroomResearch
  }

  /**
   * Mark this hub session as driving a research-mode chatroom.
   *
   * @param v - the new flag value.
   */
  setChatroomResearch(v: boolean): void {
    this.chatroomResearch = v
  }

  /**
   * Whether this hub session was converted into a 1:1 direct chatroom.
   *
   * @returns the stored chatroomDirectRole.
   */
  getChatroomDirectRole(): boolean {
    return this.chatroomDirectRole
  }

  /**
   * Mark this hub session as converted into a 1:1 direct chatroom.
   *
   * @param v - the new flag value.
   */
  setChatroomDirectRole(v: boolean): void {
    this.chatroomDirectRole = v
  }

  /**
   * Session key of the research role's pre-spawned assistant subgroup.
   *
   * @returns the stored researchAssistantKey, '' when none.
   */
  getResearchAssistantKey(): string {
    return this.researchAssistantKey
  }

  /**
   * Point this research role at its pre-spawned assistant subgroup.
   *
   * @param key - the assistant subgroup's session key.
   */
  setResearchAssistantKey(key: string): void {
    this.researchAssistantKey = key
  }

  /**
   * Whether this session is a pre-spawned research-assistant subgroup.
   *
   * @returns the stored researchAssistant.
   */
  getResearchAssistant(): boolean {
    return this.researchAssistant
  }

  /**
   * Mark this session as a pre-spawned research-assistant subgroup.
   *
   * @param v - the new flag value.
   */
  setResearchAssistant(v: boolean): void {
    this.researchAssistant = v
  }

  /**
   * Whether this research role awaits its assistant's report before concluding.
   *
   * @returns the stored researchAwaitingAssistant.
   */
  getResearchAwaitingAssistant(): boolean {
    return this.researchAwaitingAssistant
  }

  /**
   * Arm or clear the awaiting-assistant state for this research role.
   *
   * @param v - the new flag value.
   */
  setResearchAwaitingAssistant(v: boolean): void {
    this.researchAwaitingAssistant = v
  }

  /**
   * Whether this research role dispatched its assistant this round.
   *
   * @returns the stored researchDispatched.
   */
  getResearchDispatched(): boolean {
    return this.researchDispatched
  }

  /**
   * Record whether this research role dispatched its assistant this round.
   *
   * @param v - the new flag value.
   */
  setResearchDispatched(v: boolean): void {
    this.researchDispatched = v
  }

  /**
   * Gather-round stamp of this role's current ask.
   *
   * @returns the stored chatroomAskSeq, 0 when unstamped.
   */
  getChatroomAskSeq(): number {
    return this.chatroomAskSeq
  }

  /**
   * Stamp this role's turn with the gather round it was asked in.
   *
   * @param seq - the gather-round sequence number.
   */
  setChatroomAskSeq(seq: number): void {
    this.chatroomAskSeq = seq
  }

  /**
   * Whether this hub session drives the chatroom as the moderator.
   *
   * @returns the stored chatroomModerator.
   */
  getChatroomModerator(): boolean {
    return this.chatroomModerator
  }

  /**
   * Mark this hub session as the chatroom moderator.
   *
   * @param v - the new flag value.
   */
  setChatroomModerator(v: boolean): void {
    this.chatroomModerator = v
  }

  /**
   * Research iteration driver.
   *
   * @returns the stored chatroomResearchMode: 'auto' or 'manual', '' when unset.
   */
  getChatroomResearchMode(): string {
    return this.chatroomResearchMode
  }

  /**
   * Set the research iteration driver.
   *
   * @param mode - the driver: 'auto' or 'manual'.
   */
  setChatroomResearchMode(mode: string): void {
    this.chatroomResearchMode = mode
  }

  /**
   * Current research iteration round.
   *
   * @returns the stored chatroomResearchRound, 1-based and 0 before the first.
   */
  getChatroomResearchRound(): number {
    return this.chatroomResearchRound
  }

  /**
   * Set the current research iteration round.
   *
   * @param round - the 1-based round number.
   */
  setChatroomResearchRound(round: number): void {
    this.chatroomResearchRound = round
  }

  /**
   * Per-invocation auto-mode research round cap.
   *
   * @returns the stored chatroomResearchMaxRounds, 0 for the default.
   */
  getChatroomResearchMaxRounds(): number {
    return this.chatroomResearchMaxRounds
  }

  /**
   * Override the auto-mode research round cap for this invocation.
   *
   * @param n - the round cap, 0 for the default.
   */
  setChatroomResearchMaxRounds(n: number): void {
    this.chatroomResearchMaxRounds = n
  }

  /**
   * Monotonic per-hub gather-round counter.
   *
   * @returns the stored chatroomGatherSeq.
   */
  getChatroomGatherSeq(): number {
    return this.chatroomGatherSeq
  }

  /**
   * Advance the hub's gather-round counter.
   *
   * @param seq - the new counter value.
   */
  setChatroomGatherSeq(seq: number): void {
    this.chatroomGatherSeq = seq
  }

  /**
   * Shared uv venv path research assistants reuse.
   *
   * @returns the stored researchVenv, '' when none.
   */
  getResearchVenv(): string {
    return this.researchVenv
  }

  /**
   * Set the shared uv venv path research assistants reuse.
   *
   * @param v - the venv path, '' to clear.
   */
  setResearchVenv(v: string): void {
    this.researchVenv = v
  }

  /**
   * Whether this role's asked question has a turn generating.
   *
   * @returns the stored chatroomInFlight.
   */
  getChatroomInFlight(): boolean {
    return this.chatroomInFlight
  }

  /**
   * Mark this role's asked question as generating or finished.
   *
   * @param v - the new flag value.
   */
  setChatroomInFlight(v: boolean): void {
    this.chatroomInFlight = v
  }

  /**
   * Hub-side role name a routed human reply is pending for.
   *
   * @returns the stored pendingHumanQuestionRole, '' when none.
   */
  getPendingHumanQuestionRole(): string {
    return this.pendingHumanQuestionRole
  }

  /**
   * Route the next human reply on the hub to this role.
   *
   * @param role - the role name, '' to clear the routing.
   */
  setPendingHumanQuestionRole(role: string): void {
    this.pendingHumanQuestionRole = role
  }

  /**
   * The armed gather barrier on a hub session.
   *
   * @returns the pending ChatroomGather barrier, undefined when none.
   */
  getPendingGather(): import('./chatroom.js').ChatroomGather | undefined {
    return this.pendingGather
  }

  /**
   * Arm or clear the chatroom gather barrier on this hub session.
   *
   * @param g - the barrier, or undefined to clear.
   */
  setPendingGather(g: import('./chatroom.js').ChatroomGather | undefined): void {
    this.pendingGather = g
  }

  /**
   * The armed end barrier on a hub session.
   *
   * @returns the pending ChatroomEndBarrier, undefined when none.
   */
  getPendingEndBarrier(): import('./chatroom.js').ChatroomEndBarrier | undefined {
    return this.pendingEndBarrier
  }

  /**
   * Arm or clear the chatroom end barrier on this hub session.
   *
   * @param b - the barrier, or undefined to clear.
   */
  setPendingEndBarrier(b: import('./chatroom.js').ChatroomEndBarrier | undefined): void {
    this.pendingEndBarrier = b
  }

  /**
   * Permission mode pinned for a /spawn //fork child.
   *
   * @returns the stored inheritedMode, '' when none.
   */
  getInheritedMode(): string {
    return this.inheritedMode
  }

  /**
   * Pin the permission mode a /spawn //fork child inherits.
   *
   * @param mode - the permission mode name, '' to clear.
   */
  setInheritedMode(mode: string): void {
    this.inheritedMode = mode
  }

  /**
   * The armed subtask gather barrier on a parent session.
   *
   * @returns the pending SubtaskGather barrier, undefined when none.
   */
  getPendingSubtaskGather(): import('./subtask.js').SubtaskGather | undefined {
    return this.pendingSubtaskGather
  }

  /**
   * Arm or clear the subtask gather barrier on this parent session.
   *
   * @param g - the barrier, or undefined to clear.
   */
  setPendingSubtaskGather(g: import('./subtask.js').SubtaskGather | undefined): void {
    this.pendingSubtaskGather = g
  }

  /**
   * Whether this chat is the monitored-chat group carrying monitor replies.
   *
   * @returns the stored monitorGroup.
   */
  getMonitorGroup(): boolean {
    return this.monitorGroup
  }

  /**
   * Mark this chat as the monitored-chat group.
   *
   * @param v - the new flag value.
   */
  setMonitorGroup(v: boolean): void {
    this.monitorGroup = v
  }

  /**
   * Message ID of the alert that spawned the monitor child, for the later Done reaction.
   *
   * @returns the stored monitorOriginMessageID, '' when none.
   */
  getMonitorOriginMessageID(): string {
    return this.monitorOriginMessageID
  }

  /**
   * Remember the alert message the monitor child reports back onto.
   *
   * @param id - the origin message ID, '' to clear.
   */
  setMonitorOriginMessageID(id: string): void {
    this.monitorOriginMessageID = id
  }

  /**
   * Whether #47/#48 auto-render should be skipped: chatroom roles relay to
   * the hub and subtask children report to their parent, so a local HTML
   * overview is redundant. Monitor-hub children and user-interjected sessions
   * are exempt.
   *
   * @returns whether to skip the local HTML overview.
   */
  shouldSuppressAutoRender(): boolean {
    if (this.monitorChild) return false
    return (this.chatroomHubKey !== '' || this.subtaskDepth > 0) && !this.userInterjected
  }

  /**
   * User ID owning the chat this session was spawned from.
   *
   * @returns the stored spawnUserID, '' when unset.
   */
  getSpawnUserID(): string {
    return this.spawnUserID
  }

  /**
   * Record the spawning user so later children inherit the owner.
   *
   * @param id - the spawning user's ID.
   */
  setSpawnUserID(id: string): void {
    this.spawnUserID = id
  }

  /**
   * Whether this subtask child already reported to its parent.
   *
   * @returns the stored subtaskReported.
   */
  getSubtaskReported(): boolean {
    return this.subtaskReported
  }

  /**
   * Mark this subtask child as having reported to its parent.
   *
   * @param v - the new flag value.
   */
  setSubtaskReported(v: boolean): void {
    this.subtaskReported = v
  }

  /**
   * Whether this monitor-spawned subgroup must skip reporting its per-turn output.
   *
   * @returns the stored subtaskNoReport.
   */
  getSubtaskNoReport(): boolean {
    return this.subtaskNoReport
  }

  /**
   * Forbid or allow report-back from this child.
   *
   * @param v - the new flag value.
   */
  setSubtaskNoReport(v: boolean): void {
    this.subtaskNoReport = v
  }

  /**
   * Record that the user interjected mid-turn.
   *
   * @param v - the new flag value.
   */
  setUserInterjected(v: boolean): void {
    this.userInterjected = v
  }

  /**
   * Whether the user interjected mid-turn.
   *
   * @returns the stored userInterjected.
   */
  getUserInterjected(): boolean {
    return this.userInterjected
  }

  /**
   * Mark this session as a monitor-spawned child.
   *
   * @param v - the new flag value.
   */
  setMonitorChild(v: boolean): void {
    this.monitorChild = v
  }

  /**
   * The pending monitor dir-clarification on this chat.
   *
   * @returns the pending MonitorClarification, undefined when none.
   */
  getPendingMonitorClarification(): import('./monitor.js').MonitorClarification | undefined {
    return this.pendingMonitorClarification
  }

  /**
   * Store or clear the pending monitor dir-clarification.
   *
   * @param pc - the clarification, or undefined to clear.
   */
  setPendingMonitorClarification(pc: import('./monitor.js').MonitorClarification | undefined): void {
    this.pendingMonitorClarification = pc
  }

  /**
   * Most recent assistant turn's text, or '' when none.
   *
   * @returns the last assistant entry's content, '' when none exists.
   */
  lastAssistantReply(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i]
      if (entry?.role === 'assistant') return entry.content
    }
    return ''
  }

  /**
   * Store the clean final SDK result of the last turn.
   *
   * @param v - the result text, '' to clear.
   */
  setLastResult(v: string): void {
    this.lastResult = v
  }

  /**
   * Clean SDK final result when available, else the last assistant entry.
   *
   * @returns lastResult when non-blank, else the last assistant entry.
   */
  lastResultOrReply(): string {
    if (this.lastResult.trim() !== '') return this.lastResult
    return this.lastAssistantReply()
  }

  /**
   * Session display name.
   *
   * @returns the stored name.
   */
  getName(): string {
    return this.name
  }

  /**
   * Set the session display name.
   *
   * @param name - the new name.
   */
  setName(name: string): void {
    this.name = name
  }

  /**
   * ISO timestamp of the latest mutation.
   *
   * @returns the stored updatedAt.
   */
  getUpdatedAt(): string {
    return this.updatedAt
  }

  /**
   * Set the agent session ID and type. The ContinueSession sentinel is never
   * persisted; a replaced or cleared ID is saved to pastAgentSessionIDs so
   * owned-session filtering keeps recognizing the session.
   *
   * @param id - the new agent session ID; the ContinueSession sentinel is ignored.
   * @param agentType - the agent type that owns the ID.
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
   *
   * @param id - the concrete agent session ID to set; '' or the ContinueSession sentinel never writes.
   * @param agentType - the agent type that owns the ID.
   * @returns whether the ID was set.
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

  /**
   * Drop all in-memory history entries.
   */
  clearHistory(): void {
    this.history = []
  }

  /**
   * True when the session has exactly one user entry (the first message).
   *
   * @returns whether history holds exactly one user entry.
   */
  isFirstMessage(): boolean {
    const first = this.history[0]
    return this.history.length === 1 && first?.role === 'user'
  }

  /**
   * Remember the chat's pinned top-notice banner message.
   *
   * @param messageID - the banner message ID, '' to clear.
   */
  setTopNoticeMessageID(messageID: string): void {
    this.topNoticeMessageID = messageID
  }

  /**
   * Message ID of the chat's pinned top-notice banner.
   *
   * @returns the stored topNoticeMessageID, '' when none.
   */
  getTopNoticeMessageID(): string {
    return this.topNoticeMessageID
  }

  /**
   * Last n entries; n <= 0 returns all.
   *
   * @param n - the number of trailing entries to return; n <= 0 returns all.
   * @returns the trailing history entries.
   */
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

  /**
   * File path used for persistence ('' = none).
   *
   * @returns the persistence file path, '' when persistence is disabled.
   */
  storePath(): string {
    return this.storePathValue
  }

  private nextID(): string {
    this.counter++
    return `s${this.counter}`
  }

  /**
   * The user key's active session, creating one when absent.
   *
   * @param userKey - the chat's session key.
   * @returns the active or newly created session.
   */
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

  /**
   * Create a new session and make it active.
   *
   * @param userKey - the chat's session key.
   * @param name - the new session's display name.
   * @returns the created session.
   */
  newSession(userKey: string, name: string): Session {
    const s = this.createLocked(userKey, name)
    this.saveLocked()
    return s
  }

  /**
   * Register a session without changing the active one — isolated one-off
   * runs (cron new_per_run) keep the user's chat as the default target.
   *
   * @param userKey - the chat's session key.
   * @param name - the side session's display name.
   * @returns the created side session.
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

  /**
   * Switch to a session owned by the user key, matched by ID or name.
   *
   * @param userKey - the chat's session key.
   * @param target - the session ID or name to switch to.
   * @returns the now-active session.
   */
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
   *
   * @param userKey - the chat's session key.
   * @param agentSID - the agent session ID to map.
   * @param agentName - the agent type name recorded on the session.
   * @param summary - display name for a freshly created session.
   * @returns the active or newly created session.
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

  /**
   * All sessions for a user key, in creation order.
   *
   * @param userKey - the chat's session key.
   * @returns the user's sessions in creation order.
   */
  listSessions(userKey: string): Session[] {
    const out: Session[] = []
    for (const sid of this.userSessions.get(userKey) ?? []) {
      const s = this.sessions.get(sid)
      if (s !== undefined) out.push(s)
    }
    return out
  }

  /**
   * The user key's active session ID ('' when none).
   *
   * @param userKey - the chat's session key.
   * @returns the active session ID, '' when none.
   */
  activeSessionID(userKey: string): string {
    return this.activeSession.get(userKey) ?? ''
  }

  /**
   * Resolve the active Session without creating one (reapers, predicates).
   *
   * @param userKey - the chat's session key.
   * @returns the active session, undefined when none.
   */
  findActive(userKey: string): Session | undefined {
    const sid = this.activeSessionID(userKey)
    if (sid !== '') return this.findByID(sid)
    return undefined
  }

  /**
   * Set (or clear, with '') a custom display name for an agent session.
   *
   * @param agentSessionID - the agent session to name.
   * @param name - the custom display name, '' to clear.
   */
  setSessionName(agentSessionID: string, name: string): void {
    if (name === '') this.sessionNames.delete(agentSessionID)
    else this.sessionNames.set(agentSessionID, name)
    this.saveLocked()
  }

  /**
   * Custom name for an agent session, or ''.
   *
   * @param agentSessionID - the agent session to look up.
   * @returns the custom name, '' when none.
   */
  getSessionName(agentSessionID: string): string {
    return this.sessionNames.get(agentSessionID) ?? ''
  }

  /**
   * Merge non-empty display fields for a session key.
   *
   * @param sessionKey - the chat's session key.
   * @param userName - the user display name to merge; '' keeps the stored one.
   * @param chatName - the chat display name to merge; '' keeps the stored one.
   */
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

  /**
   * Stored metadata for a session key (a copy), or undefined.
   *
   * @param sessionKey - the chat's session key.
   * @returns a copy of the stored metadata, undefined when none.
   */
  getUserMeta(sessionKey: string): UserMeta | undefined {
    const m = this.userMeta.get(sessionKey)
    if (m === undefined) return undefined
    return { ...m }
  }

  /**
   * All sessions across all user keys.
   *
   * @returns every session across all user keys.
   */
  allSessions(): Session[] {
    return [...this.sessions.values()]
  }

  /**
   * Find the session currently or historically mapped to an agent session ID.
   *
   * @param agentSID - the agent session ID to look up.
   * @returns the matching session, undefined when none.
   */
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
   *
   * @returns the tracked ID set, or null while legacy data disables filtering.
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

  /**
   * Session ID → user key, plus the active session IDs per user key.
   *
   * @returns the session ID → user key map plus the per-user active session IDs.
   */
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

  /**
   * Look up a session by internal ID across all users.
   *
   * @param id - the internal session ID.
   * @returns the matching session, undefined when none.
   */
  findByID(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * Remove a session by internal ID; true when it existed.
   *
   * @param id - the internal session ID.
   * @returns whether a session was removed.
   */
  deleteByID(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.deleteByIDLocked(id)
    this.saveLocked()
    return true
  }

  /**
   * Remove all local sessions mapped to an agent session ID; count removed.
   *
   * @param agentSessionID - the agent session ID to remove mappings for.
   * @returns the number of sessions removed.
   */
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
   *
   * @param agentType - the current agent's type name.
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
 *
 * @param sessions - the agent.listSessions() output to filter.
 * @param known - the tracked agent session ID set, or null to disable filtering.
 * @returns the sessions whose ID is tracked; all of them when known is null or empty.
 */
export function filterOwnedSessions(
  sessions: AgentSessionInfo[],
  known: Record<string, true> | null,
): AgentSessionInfo[] {
  if (known === null || Object.keys(known).length === 0) return sessions
  return sessions.filter(s => s.id in known)
}
