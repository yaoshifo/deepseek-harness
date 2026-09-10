/**
 * Chatroom orchestration core ported from cc-connect core/engine_chatroom.go:
 * the parallel gather fan-in barrier, the soft end barrier, and the
 * ask/relay/human-question primitives the moderator drives. The /chatroom
 * command surface and the interactive pickers live in chatroom-cmd.ts /
 * chatroom-pick.ts; the priming texts in chatroom-priming.ts.
 *
 * Concurrency mapping (plan D7): the Go mutex-guarded barrier state collapses
 * to plain fields — JS runs the accumulate calls on one thread, and the
 * one-shot `woken` guard keeps the wake single-fire exactly like Go.
 *
 * @module dsh-feishu-bridge/chatroom
 */

import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Engine, InteractiveState } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Session, SubtaskDelivery } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { emptyMessage, jumpButtonsMarkdown, parentJumpButtons } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { maxGroupNameRunes } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Message, PendingAsk, Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { asCardSender, asCardSenderWithUpdate, asForkQuerierWithProvider, asReplyContextReconstructor } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { newCard } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { failureBriefForAgentContext } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Card } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { Msg } from '../i18n.ts'
import { chatroomState } from '../chatroom-state.ts'
import { chatroomConfig } from '../chatroom-config.ts'
import { ChatroomPoll, type ChatroomPollRound } from './chatroom-poll.ts'
import {
  appendChatroomLedger,
  chatroomLedgerDir,
  initChatroomLedger,
  listChatroomLedgers,
  resolveChatroomInherit,
  updateChatroomLedgerSynthesis,
  updateChatroomReport,
  updateChatroomSubproblems,
  writeChatroomLedgerEnded,
  type ChatroomLedgerPrior,
} from './chatroom-ledger.ts'
import { listRoleNames, roleDir, roleExists } from './chatroom-roles.ts'
import { chatroomRoleAnchorPrompt } from './chatroom-persona.ts'
import { cleanupOneChat } from '@deepseek-ai/dsh-feishu-bridge/exports'

const execFileP = promisify(execFile)

/** Default cap on role agents per chatroom (bounds token cost; Go defaultMaxChatroomRoles). */
export const defaultMaxChatroomRoles = 5

/**
 * Default lightning-round poll timeout: 10 minutes. A poll statement is one
 * cheap single-turn query; the window only needs to cover a slow provider,
 * not research work (tools are masked), so it stays far below the gather
 * timeout and degrades in one shot — the closing round remains as the
 * second chance for absent roles.
 */
export const defaultChatroomPollTimeout = 10 * 60 * 1000

/**
 * Default lightning-round concurrency cap: at most 4 one-shot queries in
 * flight. A 13-role library would otherwise hit the LLM gateway with the
 * full fan-out at once (the 2026-08-31 incident: rate-limit windows hang
 * instead of returning 429).
 */
export const defaultChatroomPollConcurrent = 4

/** Default gather barrier fallback timeout: 20 minutes (Go defaultChatroomGatherTimeout). */
export const defaultChatroomGatherTimeout = 20 * 60 * 1000

/**
 * Default re-arm window after a gather timeout: 20 more minutes for the
 * still-missing roles before the barrier degrades to free relay. One re-arm
 * per gather round, so the total wait is bounded at ≈ 2× the gather timeout.
 */
export const defaultChatroomGatherRearm = 20 * 60 * 1000

/** Default research-mode gather round timeout: 60 minutes (Go defaultChatroomResearchTimeout). */
export const defaultChatroomResearchTimeout = 60 * 60 * 1000

/** Research config ranges (Go constants, mirrored from config). */
export const minChatroomResearchTimeout = 60 * 1000

/** Upper bound a configured research gather timeout may take. */
export const maxChatroomResearchTimeout = 24 * 60 * 60 * 1000

/** Default research-assistant stall deadline: 30 minutes of hub↔steward quiet before a supervision wake. */
export const defaultChatroomAssistantStallSec = 1800

/** Floor for a configured non-zero stall deadline; below it the supervisor would nag through legitimate quiet stretches. */
export const minChatroomAssistantStallSec = 600

/** How long a research-manual ask_user_question card waits before answering itself (Go var). */
export const chatroomResearchManualAskTimeout = { ms: 10 * 60 * 1000 }

/** One spawned role agent in a chatroom (Go ChatroomRole). */
export interface ChatroomRole {
  name: string
  sessionKey: string
  dir: string
}

/** Result of endChatroom for the caller/tool surface (Go ChatroomEndResult). */
export interface ChatroomEndResult {
  /** 'ended' (cleaned up) or 'pending' (draining in-flight replies). */
  status: 'ended' | 'pending'
  /** Role names whose replies are being awaited (pending only). */
  inFlight: string[]
  /** Drain timeout in seconds (pending only). */
  timeoutSecs: number
  /** Roles cleaned up (ended only). */
  rolesRemoved: number
}

/** Clear an armed fallback timer (shared by both barrier classes). */
function stopFallbackTimer(
  timer: ReturnType<typeof setTimeout> | undefined,
  set: (t: ReturnType<typeof setTimeout> | undefined) => void,
): void {
  if (timer !== undefined) {
    clearTimeout(timer)
    set(undefined)
  }
}

/** Per-reply rune ceiling in barrier summaries (gather wake and end closing). */
const summaryReplyRunes = 200

/** Clip text to max runes with an ellipsis tail (shared by both barrier summaries). */
function clipRunes(text: string, max: number): string {
  const runes = Array.from(text)
  if (runes.length <= max) return text
  return `${runes.slice(0, max).join('')}…`
}

/** Durable snapshot of an armed gather barrier (sessions.json; timer, woken flag, and card handle stay in memory). */
export interface GatherBarrierSnapshot {
  /** The broadcast question. */
  question: string
  /** The gather-round stamp. */
  seq: number
  /** Role names whose replies were still awaited at the last save. */
  expected: string[]
  /** Role name → reply text collected so far. */
  collected: Record<string, string>
  /** When the round was armed (ms epoch); absent in pre-field snapshots reads as 0. */
  startedAt?: number
  /** Whether the timeout already re-armed this barrier once; absent reads as false. */
  rearmed?: boolean
}

/** Durable snapshot of an armed end barrier (sessions.json; timer and woken flag stay in memory). */
export interface EndBarrierSnapshot {
  /** Role names whose final replies were still awaited at the last save. */
  expected: string[]
  /** Role name → final reply text collected so far. */
  collected: Record<string, string>
}

/**
 * One outstanding serial ask on a hub (a moderator→single-role question
 * outside any gather round). Keyed by role name on
 * {@link ChatroomSessionState.pendingSerialAsks}; the entry is the durable
 * unit of "this role owes the moderator an answer" — ask-identity routing
 * completes it when the role's answering turn ends, the stall supervisor
 * reads it as the relation's deadline, and a restart recovery retires it.
 */
export interface SerialAskEntry {
  /** Ask identity from the hub's shared counter; role turns carry it as their stamp. */
  readonly id: number
  /** The question the moderator asked (excerpt for wakes and recovery notices). */
  readonly question: string
  /** When the ask was minted (ms epoch); the stall deadline counts from here. */
  readonly armedAt: number
  /** When the stall supervisor last woke the moderator about this entry (ms epoch). */
  lastWakeAt: number
  /** Supervisor wakes already spent on this entry's stall episode. */
  wakeCount: number
}

/** Durable form of a serial ask: the map key (role name) rides the entry. */
export interface SerialAskSnapshot extends SerialAskEntry {
  /** The role the moderator asked (the pendingSerialAsks map key). */
  roleName: string
}

/** Research progress-card heartbeat cadence: the live card refreshes with waiting roles and elapsed time. */
const progressCardTickMs = 60_000

/** Merge window for live progress PATCHes: replies arriving together coalesce into one card update. */
const progressCardMergeMs = 2_000

/**
 * The in-memory fan-in barrier for a parallel gather (Go chatroomGather):
 * the moderator broadcasts one question to every role and the engine
 * accumulates replies, waking the moderator EXACTLY ONCE (all roles replied
 * or the timeout fired). Held on the hub Session as pendingGather; persisted
 * through {@link GatherBarrierSnapshot} so a restart can close the round
 * instead of losing the wake.
 */
export class ChatroomGather {
  /** The question the moderator broadcast to every role in this gather. */
  readonly question: string
  /** Gather round stamp; role turns carry it so stale replies are detectable. */
  readonly seq: number
  /** Role names whose replies are still awaited. */
  readonly expected = new Set<string>()
  /** Role name → reply text, filled in as replies arrive. */
  readonly collected = new Map<string, string>()
  /** Fallback wake timer; stopped on early completion. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Live progress-card heartbeat timer (research gathers only). */
  tickTimer: ReturnType<typeof setInterval> | undefined
  /** Trailing merge timer for coalesced live progress PATCHes. */
  mergeTimer: ReturnType<typeof setTimeout> | undefined
  /** When the live-progress merge window last flushed a PATCH (ms epoch). */
  lastPatchAt = 0
  /** When this round was armed (ms epoch); the live card's elapsed clock. */
  startedAt = 0
  /**
   * Whether the fallback timeout already re-armed this barrier once. A
   * re-armed barrier waits one more window for the still-missing roles
   * (late replies keep funneling in); the NEXT timeout degrades to free
   * relay. Persisted so a restart mid-window cannot lose the count.
   */
  rearmed = false
  private woken = false
  /** Research progress-card handle (research gathers only). */
  progressHandle: unknown

  constructor(question: string, seq: number) {
    this.question = question
    this.seq = seq
  }

  /**
   * Durable snapshot for sessions.json; undefined once woken — a woken
   * barrier is cleared before the next save except inside the async
   * finalize window, and a restart there must not resurrect it.
   * @returns the JSON-safe snapshot, or undefined for a woken barrier.
   */
  snapshot(): GatherBarrierSnapshot | undefined {
    if (this.woken) return undefined
    return {
      question: this.question,
      seq: this.seq,
      expected: [...this.expected],
      collected: Object.fromEntries(this.collected),
      startedAt: this.startedAt,
      rearmed: this.rearmed,
    }
  }

  /**
   * Record a role's reply. done=true means this call completed the barrier
   * (or the timeout already did) — the caller owns the wake and MUST deliver
   * wakeContent to the moderator. An empty/silent reply still counts as
   * "replied" so a NO_REPLY role does not stall the barrier.
   *
   * @param roleName - The role whose reply is recorded.
   * @param reply - The role's reply text; empty counts as a NO_REPLY.
   * @returns done=true when this call completed the barrier (caller owns
   * the wake and must deliver wakeContent); otherwise done=false with an
   * empty wakeContent.
   */
  accumulate(roleName: string, reply: string): { done: boolean; wakeContent: string } {
    if (this.woken) return { done: false, wakeContent: '' }
    this.collected.set(roleName, reply)
    this.expected.delete(roleName)
    if (this.expected.size > 0) return { done: false, wakeContent: '' }
    this.woken = true
    this.stopTimer()
    return { done: true, wakeContent: this.summary() }
  }

  /** Timer-side completion; done=false when replies already completed the barrier.
   *
   * @returns done=true when the timeout owns the wake, with the summary
   * wake text and the sorted names of roles that never replied; otherwise
   * done=false.
   */
  timeoutFire(): { done: boolean; wake: string; missing: string[] } {
    if (this.woken) return { done: false, wake: '', missing: [] }
    this.woken = true
    // The timer fired, but the research heartbeat/merge timers must die with
    // the barrier or they PATCH the terminal card back to a live view.
    this.stopTimer()
    const wake = this.summary()
    const missing = [...this.expected].sort()
    return { done: true, wake, missing }
  }

  /**
   * Drop a role whose broadcast failed before it ever saw the question — no
   * reply can arrive for it, so an empty expected set must complete the
   * barrier here instead of idling to the fallback timeout.
   *
   * @param roleName - The role whose broadcast failed.
   * @returns done=true when this emptied the barrier (caller owns the wake
   * with wakeContent); otherwise done=false.
   */
  forgetFailed(roleName: string): { done: boolean; wakeContent: string } {
    if (this.woken) return { done: false, wakeContent: '' }
    this.expected.delete(roleName)
    if (this.expected.size > 0) return { done: false, wakeContent: '' }
    this.woken = true
    this.stopTimer()
    return { done: true, wakeContent: this.summary() }
  }

  /** Stop the fallback timer once the barrier completes (early or timed out). */
  stopTimer(): void {
    stopFallbackTimer(this.timer, (t: ReturnType<typeof setTimeout> | undefined) => { this.timer = t })
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }
    if (this.mergeTimer !== undefined) {
      clearTimeout(this.mergeTimer)
      this.mergeTimer = undefined
    }
  }

  /** The wake message: broadcast question + each role's reply, role-tagged.
   * Each reply is clipped to {@link summaryReplyRunes} runes — a 60m
   * research round × N roles must not grow the wake text without bound into
   * the moderator's context (the full replies live in the ledger and the
   * relay cards).
   *
   * @returns The full wake text delivered to the moderator.
   */
  summary(): string {
    const lines: string[] = []
    lines.push('[并行收集完成]\n')
    lines.push('主持人发出的问题：\n')
    lines.push(this.question)
    lines.push('\n\n各角色回复：\n')
    for (const n of [...this.collected.keys()].sort()) {
      const r = this.collected.get(n) ?? ''
      lines.push(`【${n}】${r === '' ? '（NO_REPLY / 无追问）' : clipRunes(r, summaryReplyRunes)}\n`)
    }
    lines.push('\n请基于以上回复，按你当前所处阶段推进：若在澄清阶段，去重合并后用原生 ask_user_question(multi_select: true) 向用户发飞书多选卡提问（若全部「无需追问」则进入阶段 2；否则 note 用户回答后再次 gather，最多 3 轮）；若在拆解阶段，去重合并成子问题列表后用 note（section: subproblems）写入。')
    return lines.join('')
  }
}

/**
 * The soft end barrier (Go chatroomEndBarrier): when the moderator ends the
 * chatroom while roles are in-flight, accumulates their final replies before
 * teardown so none are silently dropped. Same one-shot-wake discipline.
 * Persisted through {@link EndBarrierSnapshot} so a restart can finalize the
 * teardown instead of stalling it.
 */
export class ChatroomEndBarrier {
  /** Role names whose final replies are still awaited. */
  readonly expected = new Set<string>()
  /** Role name → final reply text, filled in as replies arrive. */
  readonly collected = new Map<string, string>()
  /** Fallback drain timer; stopped when the last reply completes the barrier. */
  timer: ReturnType<typeof setTimeout> | undefined
  private woken = false

  /**
   * Durable snapshot for sessions.json; undefined once woken (same window
   * discipline as {@link ChatroomGather.snapshot}).
   * @returns the JSON-safe snapshot, or undefined for a woken barrier.
   */
  snapshot(): EndBarrierSnapshot | undefined {
    if (this.woken) return undefined
    return {
      expected: [...this.expected],
      collected: Object.fromEntries(this.collected),
    }
  }

  /**
   * Record a role's final reply; done=true means this was the last expected
   * reply — the caller finalizes the chatroom and wakes the moderator once
   * with the summary.
   *
   * @param roleName - The role whose final reply is recorded.
   * @param reply - The role's final reply text; empty counts as NO_REPLY.
   * @returns done=true when this was the last expected reply (caller
   * finalizes the chatroom and wakes the moderator with summary);
   * otherwise done=false.
   */
  accumulate(roleName: string, reply: string): { done: boolean; summary: string } {
    if (this.woken) return { done: false, summary: '' }
    this.collected.set(roleName, reply)
    this.expected.delete(roleName)
    if (this.expected.size > 0) return { done: false, summary: '' }
    this.woken = true
    this.clearFallbackTimer()
    return { done: true, summary: this.summarizeEnd() }
  }

  /**
   * Force completion on timeout. The caller is expected to have reconciled
   * first (dropped roles whose in-flight flag already cleared), so any name
   * remaining is a genuine timeout.
   *
   * @returns done=true with the closing summary (prefixed by the timed-out
   * role names when any); done=false when replies already completed the
   * barrier.
   */
  timeoutFire(): { done: boolean; summary: string } {
    if (this.woken) return { done: false, summary: '' }
    this.woken = true
    let summary = this.summarizeEnd()
    const missing = this.expected.size
    if (missing > 0) {
      const names = [...this.expected].sort()
      summary = `（${missing} 个角色超时未回复：${names.join('、')}，已强杀。）\n\n${summary}`
    }
    return { done: true, summary }
  }

  /** Stop the fallback timer (same shape as ChatroomGather.stopTimer). */
  clearFallbackTimer(): void {
    stopFallbackTimer(this.timer, (t: ReturnType<typeof setTimeout> | undefined) => { this.timer = t })
  }

  /** The closing summary (Go summarizeEndLocked).
   *
   * @returns The closing text delivered to the moderator, each reply truncated to 200 runes.
   */
  summarizeEnd(): string {
    const lines: string[] = []
    lines.push('[聊天室收尾完成]\n')
    lines.push('各角色末轮回复：\n')
    for (const n of [...this.collected.keys()].sort()) {
      const r = this.collected.get(n) ?? ''
      lines.push(`【${n}】${r === '' ? '（NO_REPLY / 无发言）' : clipRunes(r, summaryReplyRunes)}\n`)
    }
    lines.push('\n请基于以上末轮回复 + 账本（RECORD.md）给出收尾总结。')
    return lines.join('')
  }

  /** Snapshot of outstanding role names (unordered).
   *
   * @returns The outstanding role names in set order.
   */
  expectedSnapshot(): string[] {
    return [...this.expected]
  }

  /** Outstanding role names, sorted (for display).
   *
   * @returns The outstanding role names, sorted alphabetically.
   */
  expectedRemaining(): string[] {
    return [...this.expected].sort()
  }

  /** Drop a role from the outstanding set (it relayed via the normal path).
   *
   * @param roleName - The role no longer being waited on.
   */
  forgetExpected(roleName: string): void {
    this.expected.delete(roleName)
  }
}

// ── group naming ──────────────────────────────────────────────────────────

/** Role group display name: 「聊天室·<role>」, truncated to the rune ceiling.
 *
 * @param role - The role name to embed.
 * @returns The group display name, truncated with a "..." tail when it exceeds the rune ceiling.
 */
export function chatroomGroupName(role: string): string {
  let name = `聊天室·${role}`
  if (Array.from(name).length > maxGroupNameRunes) {
    name = `${Array.from(name).slice(0, maxGroupNameRunes - 3).join('')}...`
  }
  return name
}

/**
 * Hub group name derived from the chatroom topic: the topic truncated to the
 * 60-rune ceiling, no prefix (Go chatroomHubGroupName; moved with the
 * chatroom from the bridge's groupname module).
 *
 * @param topic - The chatroom topic.
 * @returns the hub group display name.
 */
export function chatroomHubGroupName(topic: string): string {
  if (Array.from(topic).length > maxGroupNameRunes) {
    return `${Array.from(topic).slice(0, maxGroupNameRunes - 3).join('')}...`
  }
  return topic
}

/** Research assistant subgroup display name: 「聊天室·助手·<role>」.
 *
 * @param roleName - The role name to embed after the assistant prefix.
 * @returns The group display name, with the role-name tail truncated when the full name exceeds the rune ceiling.
 */
export function chatroomAssistantGroupName(roleName: string): string {
  const name = `聊天室·助手·${roleName}`
  if (Array.from(name).length <= maxGroupNameRunes) return name
  // Keep the prefix, truncate the role-name tail.
  const prefix = '聊天室·助手·'
  const remaining = Math.max(0, maxGroupNameRunes - Array.from(prefix).length - 3)
  const r = Array.from(roleName)
  return `${prefix}${r.slice(0, remaining).join('')}...`
}

/** Research steward subgroup display name: the hub-parented shared-data assistant.
 *
 * @returns The fixed display name 「聊天室·数据管家」 — 8 runes, far below the rune ceiling, so no truncation applies.
 */
export function chatroomStewardGroupName(): string {
  return '聊天室·数据管家'
}

// ── roles listing / resolution ────────────────────────────────────────────

/** The ledger directory for a chatroom hub, or undefined when the ledger is off.
 * The directory carries the hub's current run number, so a second chatroom
 * on the same hub gets its own dir instead of overwriting the first ledger.
 *
 * @param e - Engine carrying the moderator-dir configuration and session registry.
 * @param hubKey - Session key of the chatroom hub.
 * @returns The hub's ledger directory, or undefined when no moderator dir is configured.
 */
export function chatroomLedgerDirFor(e: Engine, hubKey: string): string | undefined {
  const mod = chatroomConfig(e).moderatorDir()
  if (!mod.ok) return undefined
  const hub = e.sessions.findActive(hubKey)
  const run = hub === undefined ? 1 : Math.max(chatroomState(hub).chatroomLedgerRun, 1)
  return chatroomLedgerDir(mod.dir, hubKey, run)
}

/** The roles in a chatroom (sessions whose chatroomHubKey matches).
 *
 * @param e - Engine carrying the session registry and per-chat workdirs.
 * @param hubKey - Session key of the chatroom hub.
 * @returns One entry per live role session, each with name, session key, and persona workdir.
 */
export function listChatroomRoles(e: Engine, hubKey: string): ChatroomRole[] {
  const { idToKey } = e.sessions.sessionKeyMap()
  const out: ChatroomRole[] = []
  for (const s of e.sessions.allSessions()) {
    if (chatroomState(s).chatroomHubKey !== hubKey) continue
    const k = idToKey[s.id] ?? ''
    if (k === '') continue
    out.push({
      name: chatroomState(s).chatroomRoleName,
      sessionKey: k,
      dir: e.perChatWorkDir(e.dirOverrideKey(k)),
    })
  }
  return out
}

/**
 * Resolve a role reference — a session key or a role name within the
 * chatroom — to the role's session key. Never creates sessions.
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param hubKey - Session key of the chatroom hub that scopes the search.
 * @param ref - The reference to resolve: a role session key or a role name.
 * @returns The matching role's session key.
 * @throws When the reference is empty or matches no role in the chatroom.
 */
export function resolveChatroomRole(e: Engine, hubKey: string, ref: string): string {
  const trimmed = ref.trim()
  if (trimmed === '') throw new Error('chatroom: role reference is required')
  const { idToKey } = e.sessions.sessionKeyMap()
  for (const s of e.sessions.allSessions()) {
    if (chatroomState(s).chatroomHubKey !== hubKey) continue
    const k = idToKey[s.id] ?? ''
    if (k === '') continue
    if (k === trimmed || (chatroomState(s).chatroomRoleName !== '' && chatroomState(s).chatroomRoleName === trimmed)) {
      return k
    }
  }
  throw new Error(e.i18n.tf(Msg.ChatroomRoleNotFound, trimmed))
}

/**
 * The hub session behind a chatroom key, without creating one. The chatroom
 * protocol reads moderator state (barriers, research flags, pending human
 * questions) through this: a dangling hub key means the registry lost the
 * moderator record, and readers treat that as "no chatroom state" (entry
 * points fail loud) instead of minting a phantom hub whose empty flags
 * silently degrade gathers into serial relays.
 *
 * @param e - Engine carrying the session registry.
 * @param hubKey - Session key of the chatroom hub.
 * @returns the hub session, or undefined when no active session holds the key.
 */
export function chatroomHubOf(e: Engine, hubKey: string): Session | undefined {
  const hub = e.sessions.findActive(hubKey)
  if (hub === undefined) {
    console.warn(`chatroom: hub session missing, treating as no chatroom state (hub=${hubKey})`)
  }
  return hub
}

// ── spawning ──────────────────────────────────────────────────────────────


/** Structural alias over the platform's spawner surface (Ex preferred). */
function groupSpawnerOf(
  p: Platform,
): ((msg: Message, groupName: string, firstMsg: string, opts: { workDir: string }) => Promise<Message>) | undefined {
  const ex = (p as {
    spawnGroupWithOptions?: (msg: Message, groupName: string, firstMsg: string, opts: { workDir: string }) => Promise<Message>
  }).spawnGroupWithOptions
  if (typeof ex === 'function') return (msg, groupName, firstMsg, opts) => ex.call(p, msg, groupName, firstMsg, opts)
  const base = (p as { spawnGroup?: (msg: Message, groupName: string, firstMsg: string) => Promise<Message> }).spawnGroup
  if (typeof base !== 'function') return undefined
  return async (msg, groupName, firstMsg) => base.call(p, msg, groupName, firstMsg)
}

/**
 * StartChatroom spawns one isolated group per role, each with its own workdir
 * = the role's persona directory, linked to the hub as children. Roles start
 * IDLE — the moderator drives turns via askRole.
 *
 * @param e - Engine carrying the session registry, platform, and role configs.
 * @param hubSessionKey - Session key of the moderator hub the roles attach to.
 * @param roleNames - Role names to spawn; empty defaults to every configured role.
 * @param topic - The discussion topic, written to the ledger and ready cards.
 * @returns One entry per spawned role, in the order spawned.
 */
export async function startChatroom(
  e: Engine, hubSessionKey: string, roleNames: string[] | undefined, topic: string,
  prior?: ChatroomLedgerPrior,
): Promise<ChatroomRole[]> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no group-capable platform available')
  const spawner = groupSpawnerOf(p)
  if (spawner === undefined) {
    throw new Error(`chatroom: platform "${p.name()}" cannot spawn groups`)
  }
  topic = topic.trim()
  if (topic === '') throw new Error('chatroom: topic is required')
  const rolesDir = chatroomConfig(e).rolesDir()
  let names = roleNames ?? []
  if (names.length === 0) {
    // No roles specified → default to every role under the roles dir
    // (single source of truth shared by the command and the tool surface).
    names = [...listRoleNames(rolesDir)].sort()
    if (names.length === 0) {
      throw new Error(e.i18n.tf(Msg.ChatroomNoRolesConfigured, rolesDir))
    }
  }
  if (names.length > chatroomConfig(e).maxRoles()) {
    throw new Error(`chatroom: too many roles (${names.length} > max ${chatroomConfig(e).maxRoles()})`)
  }
  // Validate all roles up front (fail fast → no partial spawn with orphans).
  for (const name of names) {
    if (!roleExists(rolesDir, name)) {
      throw new Error(e.i18n.tf(Msg.ChatroomUnknownRole, name, name))
    }
  }

  const parent = e.sessions.getOrCreateActive(hubSessionKey)
  // Mark the hub as the moderator BEFORE spawning: a mid-loop spawn failure
  // skips afterChatroomStarted (which sets this flag on the success path),
  // and without it resolveChatroomHubKey cannot resolve the HUB group
  // itself — /chatroom stop there answered not-in-room while the orphan
  // role groups lived on.
  chatroomState(parent).chatroomModerator = true
  e.sessions.save()
  let userID = parent.getSpawnUserID()
  if (userID === '') {
    const parts = hubSessionKey.split(':', 3)
    if (parts.length === 3 && parts[2] !== undefined
      && !parts[2].startsWith('thread:') && !parts[2].startsWith('root:')) {
      userID = parts[2]
    }
  }
  const hubLabel = e.subtaskParentLabel(parent)

  const out: ChatroomRole[] = []
  for (const name of names) {
    const dir = roleDir(rolesDir, name)
    const spawnMsg: Message = { ...emptyMessage(), sessionKey: hubSessionKey, platform: p.name(), userID }
    const groupName = chatroomGroupName(name)
    // Empty firstMsg → the group is created IDLE (no first turn); the
    // moderator wakes each role via askRole.
    const syntheticMsg = await spawner(spawnMsg, groupName, '', { workDir: dir })
    // Persist the role workdir so restarts keep pointing at the same persona
    // directory → memory stays continuous.
    e.projectState?.setWorkspaceDirOverride(e.dirOverrideKey(syntheticMsg.sessionKey), dir)
    e.projectState?.save()
    const ns = e.sessions.getOrCreateActive(syntheticMsg.sessionKey)
    ns.setParentSessionKey(hubSessionKey)
    chatroomState(ns).chatroomHubKey = hubSessionKey
    chatroomState(ns).chatroomRoleName = name
    ns.setName(groupName)
    ns.setParentChatName(hubLabel)
    if (userID !== '') ns.setSpawnUserID(userID)
    e.sessions.save()

    // Ready card in the role group (mirrors cmdSpawn — sent synchronously in
    // order, like Go's in-loop SendCard).
    const cs = asCardSender(p)
    if (cs !== undefined) {
      const note = `${name} · ${dir}\n${e.i18n.t(Msg.ChatroomTopicLabel)} ${topic}`
      const jumpMD = jumpButtonsMarkdown(parentJumpButtons(hubSessionKey, hubLabel, p))
      try {
        const card = await e.buildSpawnNotifyCard(dir, e.i18n.t(Msg.ChatroomReady), note, jumpMD, syntheticMsg.sessionKey)
        await cs.sendCard(syntheticMsg.replyCtx, card)
      } catch (error) {
        console.warn(`chatroom: ready card send failed (role=${name}): ${String(error)}`)
      }
    }
    out.push({ name, sessionKey: syntheticMsg.sessionKey, dir })
  }
  // Consume the next run number BEFORE resolving the ledger dir: every
  // chatroom on this hub gets its own dir, so a new discussion never
  // overwrites a previous one's ledger.
  const run = chatroomState(parent).chatroomLedgerRun + 1
  chatroomState(parent).chatroomLedgerRun = run
  e.sessions.save()
  const ledgerDir = chatroomLedgerDirFor(e, hubSessionKey)
  if (ledgerDir !== undefined) {
    void initChatroomLedger(ledgerDir, topic, names, prior).catch((error: unknown) => {
      console.warn(`chatroom: ledger init failed (${ledgerDir}): ${String(error)}`)
    })
  }
  console.info(`chatroom: started (hub=${hubSessionKey} roles=${names.join(',')} topic=${topic})`)
  return out
}

// ── asking / gathering ────────────────────────────────────────────────────

/**
 * Post the moderator's question to a role's group (visible card) and inject
 * it into the role session, re-arming the one-shot relay. Non-blocking. The
 * role is addressed by name or session key. The injection rides
 * `deliverMachineMessage` for both deliveries: a busy role receives the
 * question mid-turn at its nearest step boundary, an idle one through the
 * machine-flagged turn pipeline.
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param callerHubKey - Session key of the chatroom hub the role must belong to.
 * @param roleRef - The role to ask: a role name or session key.
 * @param question - The moderator's question text; empty is rejected.
 * @param delivery - Queue (default) opens the role's answer as its own turn
 * and is rejected while a gather is armed; steer is the mid-round course
 * correction — its reply counts as the armed round's answer.
 */
export async function askRole(e: Engine, callerHubKey: string, roleRef: string, question: string, delivery: SubtaskDelivery = 'queue'): Promise<void> {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  const askHub = chatroomHubOf(e, callerHubKey)
  if (askHub !== undefined && chatroomState(askHub).pendingEndBarrier !== undefined) {
    throw new Error('chatroom: 正在收尾中，无法 ask')
  }
  // Ask during an armed gather loses the answer either way: a busy role's
  // reply never relays (its one-shot gate was consumed by the gather
  // question), an idle role's reply is absorbed as its gather reply.
  // Steer is the exception: it reaches a busy role inside the running turn
  // (the reply still counts as that role's gather reply), so mid-round
  // course correction stays available to the moderator.
  // The pending-ask-human reply path cannot reach here — the two states
  // are mutually exclusive by askHuman's and gatherRoles' two-way guards.
  if (askHub !== undefined && chatroomState(askHub).pendingGather !== undefined && delivery !== 'steer') {
    throw new Error(e.i18n.t(Msg.ChatroomAskGatherBlocked))
  }
  // Mirror of gather's pendingHumanQuestionRole guard (guards must be
  // two-way): asking the role that holds the pending human question injects
  // a second in-flight question — one of the two replies is then lost to the
  // one-shot relay gate.
  if (askHub !== undefined && chatroomState(askHub).pendingHumanQuestionRole !== '') {
    throw new Error(e.i18n.t(Msg.ChatroomAskPendingHumanBlocked))
  }
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const roleKey = resolveChatroomRole(e, callerHubKey, roleRef)
  const role = e.sessions.getOrCreateActive(roleKey)
  if (chatroomState(role).chatroomHubKey !== callerHubKey) {
    throw new Error(e.i18n.t(Msg.ChatroomAskNotInRoom))
  }
  const roleName = chatroomState(role).chatroomRoleName
  await askRoleInternal(e, p, callerHubKey, roleKey, roleName, q, e.i18n.tf(Msg.ChatroomAskHeader, roleName), 0, false)
  console.info(`chatroom: moderator asked role (hub=${callerHubKey} role=${roleKey})`)
}

/**
 * The shared "post question card to the role group + inject the question
 * into the role session + re-arm the one-shot relay" path (Go
 * askRoleInternal). askSeq is the gather round stamp; 0 for serial asks.
 * awaitAssistant arms the research dispatch-defer at turn start. The
 * injection rides `deliverMachineMessage`: a busy role receives the
 * question mid-turn at its nearest step boundary (identity pre-stamped
 * here — no turn starts, so turn-start stamping never fires); an idle role
 * rides the same machine-flagged synthetic-message pipeline as every
 * machine wake, and turn start stamps the identity from the message
 * metadata.
 */
async function askRoleInternal(
  e: Engine,
  p: Platform,
  hubKey: string,
  roleKey: string,
  _roleName: string,
  question: string,
  headerTitle: string,
  askSeq: number,
  awaitAssistant: boolean,
): Promise<void> {
  const r = asReplyContextReconstructor(p)
  if (r === undefined) {
    throw new Error(`chatroom: platform "${p.name()}" cannot address the role group`)
  }
  let roleRctx: unknown
  try {
    roleRctx = await r.reconstructReplyCtx(roleKey)
  } catch (error) {
    throw new Error(`chatroom: reconstruct role reply ctx: ${String(error instanceof Error ? error.message : error)}`)
  }

  // Serial asks (askSeq 0) mint the next identity from the hub's shared
  // counter and register an outstanding entry; the role's answering turn
  // routes by the identity and completes the entry. A steer that arrives
  // while a gather is armed is a course correction OF that round — the
  // role's reply counts as its round reply (no new identity). A mid-turn
  // steer never opens a turn, so the stamp is applied at delivery time —
  // turn-start stamping would otherwise never fire for a steered question.
  const hub = chatroomHubOf(e, hubKey)
  let stamp = askSeq
  if (askSeq === 0) {
    if (hub === undefined) throw new Error(`chatroom: hub session missing (hub=${hubKey})`)
    const armed = chatroomState(hub).pendingGather
    if (armed !== undefined) {
      stamp = armed.seq
    } else {
      stamp = chatroomState(hub).chatroomGatherSeq + 1
      chatroomState(hub).chatroomGatherSeq = stamp
      chatroomState(hub).pendingSerialAsks.set(_roleName, {
        id: stamp,
        question,
        armedAt: Date.now(),
        lastWakeAt: 0,
        wakeCount: 0,
      })
    }
  }

  // Re-arm the one-shot relay so this role's next reply forwards to the
  // hub. Mark in-flight so endChatroom can detect a generating role.
  const role = e.sessions.getOrCreateActive(roleKey)
  chatroomState(role).chatroomAsked = false
  chatroomState(role).chatroomInFlight = true
  // A busy role receives the question as a mid-turn steer — no new turn
  // starts, so turn-start stamping never fires for it. Stamp the identity
  // here unconditionally: the steer's relay routes by it, and an idle role's
  // turn-start re-stamps the same value.
  chatroomState(role).chatroomAskSeq = stamp
  // Research mode: new round — clear the previous round's sticky dispatch
  // flag. ResearchAwaitingAssistant arms at turn start.
  const researchHub = chatroomHubOf(e, hubKey)
  if (researchHub !== undefined && chatroomState(researchHub).chatroomResearch) {
    chatroomState(role).researchDispatched = false
  }
  e.sessions.save()

  // Awaited: the card must land before the injected turn's placeholder card
  // below, or the two sends race and whichever loses buries the other at the
  // chat tail for the whole turn. A failed send must also clear the
  // in-flight flag: a phantom flag makes endChatroom arm its drain barrier
  // for a turn that never started and idle out the whole drain timeout.
  try {
    await e.sendAsCard(p, roleRctx, question, { title: headerTitle, color: 'blue' })
  } catch (error) {
    chatroomState(role).chatroomInFlight = false
    if (askSeq === 0 && hub !== undefined) chatroomState(hub).pendingSerialAsks.delete(_roleName)
    e.sessions.save()
    throw error
  }

  let roleContent = `[主持] ${question}`
  const lp = chatroomLedgerDirFor(e, hubKey)
  if (lp !== undefined) {
    roleContent += `\n\n（完整上下文见账本目录：${lp}；SYNTHESIS.md/SUBPROBLEMS.md/RECORD.md，回答前先读）`
  }
  // Per-turn persona re-anchor: the one-shot system-prompt persona decays into
  // a distant prefix over long research sessions while the moderator's task
  // register pulls the role toward ops-report language (2026-09 oc_e51a
  // session-log evidence) — every turn message re-states the anchor.
  roleContent += `\n\n${chatroomRoleAnchorPrompt()}`
  const roleMsg: Message = {
    ...emptyMessage(),
    sessionKey: roleKey,
    platform: p.name(),
    userName: '[主持]',
    content: roleContent,
    replyCtx: roleRctx,
    metadata: { chatroomAskSeq: stamp, chatroomAwaitAssistant: awaitAssistant },
  }
  // Every delivery rides the machine channel: busy → mid-turn steer claimed
  // at the next step boundary (the role's reply still relays through the
  // one-shot gate re-armed above); idle/startup → the machine-flagged
  // synthetic-message pipeline with the full turn machinery. The human
  // pipeline must not carry a role ask — its busy-queue cap and rate-limit
  // drops would lose the question while the outstanding entry sits
  // unnoticed.
  try {
    e.deliverMachineMessage(p, roleMsg)
  } catch (error) {
    console.error(`engine: deliver-machine-message failed (${roleKey}): ${String(error)}`)
  }
}

/**
 * GatherRoles broadcasts the SAME question to every role at once (each in its
 * own group) and sets up a barrier on the hub so the moderator is woken
 * EXACTLY ONCE with all replies collected. Non-blocking.
 *
 * @param e - Engine carrying the session registry and gather timeouts.
 * @param hubKey - Session key of the chatroom hub.
 * @param question - The question broadcast to every role; empty is rejected.
 * @param research - True to run a research round (longer timeout, progress card).
 */
export function gatherRoles(e: Engine, hubKey: string, question: string, research: boolean): void {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) throw new Error(`chatroom: hub session missing (hub=${hubKey})`)
  if (chatroomState(hub).pendingEndBarrier !== undefined) {
    throw new Error('chatroom: 正在收尾中，无法 gather')
  }
  // A repeat gather while one is armed overwrites the barrier: the old
  // round's timer, expected set, and collected replies are dropped while
  // its roles keep generating against a barrier nobody holds.
  if (chatroomState(hub).pendingGather !== undefined) {
    throw new Error(e.i18n.t(Msg.ChatroomGatherInFlight))
  }
  // Mirror of askHuman's pendingGather guard (guards must be two-way): a
  // gather while a human question is pending would inject a second in-flight
  // ask into the asking role — its first turn-end consumes the one-shot relay
  // gate and the reply to the human's answer is then dropped wholesale.
  if (chatroomState(hub).pendingHumanQuestionRole !== '') {
    throw new Error(e.i18n.t(Msg.ChatroomGatherPendingHumanBlocked))
  }
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const roles = listChatroomRoles(e, hubKey)
  if (roles.length === 0) throw new Error(e.i18n.t(Msg.ChatroomNoRoles))

  // Set up the fan-in barrier BEFORE broadcasting so the first role reply
  // can't race ahead and find no pendingGather. A new round supersedes every
  // outstanding serial ask: those turns route as free replies instead of
  // being absorbed as round answers.
  const seq = chatroomState(hub).chatroomGatherSeq + 1
  chatroomState(hub).chatroomGatherSeq = seq
  const g = new ChatroomGather(q, seq)
  for (const r of roles) g.expected.add(r.name)
  chatroomState(hub).pendingGather = g
  chatroomState(hub).pendingSerialAsks.clear()
  e.sessions.save()

  // Fallback timer: wake the moderator with partial results if a role stalls.
  const gatherTimeout = research
    ? chatroomConfig(e).researchTimeoutDuration()
    : chatroomConfig(e).gatherTimeoutDuration()
  g.timer = setTimeout(() => { fireGatherTimeout(e, hubKey) }, gatherTimeout)
  g.timer.unref()

  // Broadcast the question to every role in parallel. The prefix is generic;
  // research mode uses a different prefix that encourages tool/assistant use.
  const roleQ = research
    ? `[并行研究] 本轮并行研究，各自独立、互不可见。用你的助手（feishu_bridge_subtask 工具 action: send）下数据、跑脚本、算关键指标，基于实证作答（默认不出图，用数值说话）。数据可靠性要求：让助手只用权威一手源，抓取优先照研究 playbook 的已验证配方打（无配方的才用聚合器并登记口径），关键数字两个独立源交叉验证或加总闭合，分歧与缺数如实标注、不编造。不要用 ask-human。研究任务如下：\n\n${q}`
    : `[并行收集] 本轮并行收集各角色独立判断，不要用 ask-human，按下面的问题作答。\n\n${q}`
  for (const r of roles) {
    void askRoleInternal(e, p, hubKey, r.sessionKey, r.name, roleQ, e.i18n.tf(Msg.ChatroomGatherHeader, r.name), g.seq, research)
      .catch((error: unknown) => {
        console.warn(`chatroom: gather broadcast to role failed (role=${r.name}): ${String(error)}`)
        // The role never received the question; drop it from expected so the
        // barrier cannot idle to its full timeout waiting on a reply that
        // can never arrive. Emptying expected here completes the round.
        const { done, wakeContent } = g.forgetFailed(r.name)
        if (!done) return
        updateResearchProgressCard(e, p, g, 'done')
        chatroomState(hub).pendingGather = undefined
        e.sessions.save()
        wakeChatroomModerator(e, hubKey, wakeContent)
        console.info(`chatroom: gather closed after broadcast failure (hub=${hubKey} role=${r.name})`)
      })
  }
  // Research rounds run up to 60m: post a progress card so the user has a
  // live X/N view instead of silence, and heartbeat it with waiting roles
  // and elapsed time so a slow role is visible as "still waiting", not
  // silence.
  if (research) {
    g.startedAt = Date.now()
    sendResearchProgressCard(e, p, hubKey, g)
    g.tickTimer = setInterval(() => { updateResearchProgressCard(e, p, g, '') }, progressCardTickMs)
    g.tickTimer.unref()
  }
  console.info(`chatroom: moderator gathered roles (hub=${hubKey} roles=${roles.length})`)
}

/** Timer callback: wake the moderator with whatever arrived (Go fireGatherTimeout). */
function fireGatherTimeout(e: Engine, hubKey: string): void {
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) return
  const g = chatroomState(hub).pendingGather
  if (g === undefined) return
  // First timeout: re-arm the barrier once for the still-missing roles
  // instead of destroying it (2026-09-06: the 4 late deliveries 5-10
  // minutes past the timeout hit the superseded-ask router — group-visible,
  // never injected, never waking; the supervision net needed 30-60 more
  // minutes). Late replies keep funneling through the gather path; only the
  // next timeout degrades to free relay.
  if (!g.rearmed) {
    g.rearmed = true
    const rearmMs = chatroomConfig(e).gatherRearmDuration()
    g.timer = setTimeout(() => { fireGatherTimeout(e, hubKey) }, rearmMs)
    g.timer.unref()
    e.sessions.save()
    const missing = [...g.expected].sort()
    const wake = buildGatherRearmWake(e, hubKey, missing, g.summary(), Math.round(rearmMs / 60_000))
    wakeChatroomModerator(e, hubKey, wake)
    console.info(`chatroom: gather timed out; re-armed barrier for late replies (hub=${hubKey} missing=${missing.join(',')} rearmMs=${rearmMs})`)
    return
  }
  const { done, wake, missing } = g.timeoutFire()
  if (!done) return // already woken by the last reply
  chatroomState(hub).pendingGather = undefined
  e.sessions.save()
  const p = e.spawnCapablePlatform()
  if (p !== undefined) updateResearchProgressCard(e, p, g, 'timedout')
  const finalWake = missing.length > 0 ? buildGatherTimeoutWake(e, hubKey, missing, wake) : wake
  wakeChatroomModerator(e, hubKey, finalWake)
  console.info(`chatroom: gather timed out; woke moderator with partial replies (hub=${hubKey})`)
}

// ── lightning-round poll ───────────────────────────────────────────────────

/** One in-flight poll round per hub. In-memory by design: the one-shot
 * queries it tracks live in engine memory and cannot survive a restart, so
 * the barrier does not persist either.
 */
interface ChatroomPollRoundState {
  poll: ChatroomPoll
  /** Fallback wake timer; stopped on early completion. */
  timer: ReturnType<typeof setTimeout>
  /** Aborts the still-pending one-shot queries once the round settles. */
  abort: AbortController
}

const pollRounds = new WeakMap<Engine, Map<string, ChatroomPollRoundState>>()

function pollStates(e: Engine): Map<string, ChatroomPollRoundState> {
  let m = pollRounds.get(e)
  if (m === undefined) {
    m = new Map()
    pollRounds.set(e, m)
  }
  return m
}

/**
 * Run a lightning-round poll: one cheap single-turn statement from every
 * non-spawned role (persona dir as cwd, tools masked) so the whole library
 * participates in every discussion while only the core cast keeps resident
 * agents. Non-blocking — the moderator is woken once the barrier completes
 * or the poll timeout degrades it.
 *
 * @param e - Engine carrying the session registry and the one-shot query capability.
 * @param hubKey - Session key of the moderator hub.
 * @param brief - The statement brief forwarded verbatim to every polled role.
 * @param round - Which discussion phase this round serves.
 * @param roleNames - Explicit role subset; omitted polls every non-spawned role.
 */
export function pollRoles(
  e: Engine, hubKey: string, brief: string, round: ChatroomPollRound, roleNames?: string[],
): void {
  const q = brief.trim()
  if (q === '') throw new Error('chatroom: poll brief is required')
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) throw new Error(`chatroom: hub session missing (hub=${hubKey})`)
  if (chatroomState(hub).pendingEndBarrier !== undefined) {
    throw new Error('chatroom: 正在收尾中，无法 poll')
  }
  if (chatroomState(hub).pendingGather !== undefined) {
    throw new Error(e.i18n.t(Msg.ChatroomPollGatherBlocked))
  }
  if (chatroomState(hub).pendingHumanQuestionRole !== '') {
    throw new Error(e.i18n.t(Msg.ChatroomGatherPendingHumanBlocked))
  }
  if (pollStates(e).has(hubKey)) {
    throw new Error(e.i18n.t(Msg.ChatroomPollInFlight))
  }
  const fq = asForkQuerierWithProvider(e.agent)
  if (fq === undefined) throw new Error('chatroom: agent backend cannot run one-shot queries')

  const rolesDir = chatroomConfig(e).rolesDir()
  const spawned = new Set(listChatroomRoles(e, hubKey).map(r => r.name))
  const names = [...new Set((roleNames ?? listRoleNames(rolesDir)).filter(n => !spawned.has(n) && roleExists(rolesDir, n)))].sort()
  if (names.length === 0) throw new Error('chatroom: no unpolled roles available')

  const poll = new ChatroomPoll(q, round)
  for (const n of names) poll.expected.add(n)
  const state: ChatroomPollRoundState = {
    poll,
    abort: new AbortController(),
    timer: setTimeout(() => { firePollTimeout(e, hubKey) }, chatroomConfig(e).pollTimeoutDuration()),
  }
  state.timer.unref()
  pollStates(e).set(hubKey, state)

  const settle = (result: { done: boolean; wakeContent: string }): void => {
    if (!result.done) return
    pollStates(e).delete(hubKey)
    clearTimeout(state.timer)
    state.abort.abort()
    void persistPollStatements(e, hubKey, poll)
    sendPollStatementCard(e, hubKey, poll)
    wakeChatroomModerator(e, hubKey, result.wakeContent)
    console.info(`chatroom: poll round settled (hub=${hubKey} round=${round} statements=${poll.collected.size}/${names.length})`)
  }

  // Worker-pool dispatch: the concurrency cap keeps a 13-role library from
  // hitting the LLM gateway with the full fan-out at once. Snapshot the
  // worker count before dispatching — each dispatch consumes the queue
  // synchronously, so a live queue.length in the loop condition would decay
  // the pool to one worker.
  const queue = names.map(n => ({ name: n, dir: roleDir(rolesDir, n) }))
  const workers = Math.min(chatroomConfig(e).pollMaxConcurrent(), queue.length)
  const provider = chatroomConfig(e).pollProvider()
  const dispatch = (): void => {
    const t = queue.shift()
    if (t === undefined) return
    void fq.pollQuery(q, t.dir, {
      ...(provider !== '' ? { providerName: provider } : {}),
      signal: state.abort.signal,
    })
      .then(
        (text) => { settle(poll.accumulate(t.name, text)) },
        () => { settle(poll.fail(t.name)) },
      )
      .finally(() => { dispatch() })
  }
  for (let i = 0; i < workers; i++) dispatch()
  console.info(`chatroom: moderator polled roles (hub=${hubKey} round=${round} roles=${names.join(',')})`)
}

/** Timer callback: degrade the round with absent-role annotations and wake. */
function firePollTimeout(e: Engine, hubKey: string): void {
  const state = pollStates(e).get(hubKey)
  if (state === undefined) return
  const { done, wake, missing } = state.poll.timeoutFire()
  if (!done) return
  pollStates(e).delete(hubKey)
  state.abort.abort()
  wakeChatroomModerator(e, hubKey, wake)
  console.info(`chatroom: poll timed out; woke moderator with partial statements (hub=${hubKey} missing=${missing.join(',')})`)
}

/**
 * Whether a lightning-round poll is in flight on a hub. The pick watchdog
 * defers while this is true so the opening poll's wake (not a stale
 * five-minute fallback card) carries the moderator into pick-roles.
 *
 * @param e - Engine owning the poll rounds.
 * @param hubKey - Session key of the moderator hub.
 * @returns true when a poll round is armed on the hub.
 */
export function hasActiveChatroomPoll(e: Engine, hubKey: string): boolean {
  return pollStates(e).has(hubKey)
}

/**
 * Persist one ledger RECORD line per polled role (absent roles annotated):
 * the every-role attendance record that makes a lightning round count as
 * participation, independent of the moderator writing anything.
 *
 * @param e - Engine whose chatroom ledger is addressed.
 * @param hubKey - Session key of the moderator hub.
 * @param poll - The settled poll round whose statements are persisted.
 */
async function persistPollStatements(e: Engine, hubKey: string, poll: ChatroomPoll): Promise<void> {
  const dir = pollLedgerDirFor(e, hubKey)
  if (dir === undefined) return
  const tag = poll.round === 'opening' ? '开场快答' : '收尾补盲'
  const names = [...poll.collected.keys(), ...poll.expected].sort()
  for (const n of names) {
    const text = poll.collected.get(n)
    const body = text === undefined || text.trim() === '' ? '（未表态）' : text.trim()
    try {
      await appendChatroomLedger(dir, n, `（${tag}）${body}`)
    } catch (error) {
      console.warn(`chatroom: poll statement ledger append failed (hub=${hubKey} role=${n}): ${String(error)}`)
    }
  }
}

/**
 * The ledger dir a settled poll's attendance lines belong to. Pre-start
 * (moderator flag down — the guided opening round settles before `start`
 * consumes a run number) that is the NEXT run's dir, so a second chatroom on
 * the same hub never appends into the previous run's ledger; once started,
 * the current run's dir is the live ledger.
 *
 * @param e - Engine whose chatroom ledger is addressed.
 * @param hubKey - Session key of the moderator hub.
 * @returns the ledger dir for the poll's attendance lines, or undefined
 * when no moderator dir is configured.
 */
function pollLedgerDirFor(e: Engine, hubKey: string): string | undefined {
  const mod = chatroomConfig(e).moderatorDir()
  if (!mod.ok) return undefined
  const hub = e.sessions.findActive(hubKey)
  const started = hub !== undefined && chatroomState(hub).chatroomModerator
  const run = hub === undefined ? 1 : chatroomState(hub).chatroomLedgerRun + (started ? 0 : 1)
  return chatroomLedgerDir(mod.dir, hubKey, Math.max(run, 1))
}

/**
 * Post one merged statement card to the hub group so the user sees every
 * role's lightning-round appearance without N separate messages.
 *
 * @param e - Engine owning the card sender.
 * @param hubKey - Session key of the moderator hub the card addresses.
 * @param poll - The settled poll round whose summary the card renders.
 */
function sendPollStatementCard(e: Engine, hubKey: string, poll: ChatroomPoll): void {
  const p = e.spawnCapablePlatform()
  if (p === undefined) return
  const cs = asCardSender(p)
  if (cs === undefined) return
  const title = e.i18n.t(poll.round === 'opening' ? Msg.ChatroomPollCardOpening : Msg.ChatroomPollCardClosing)
  const card = newCard().title(title, 'purple').markdown(poll.summary()).build()
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (rctx) => {
      void cs.sendCard(rctx, card).catch((error: unknown) => {
        console.warn(`chatroom: poll statement card send failed (hub=${hubKey}): ${String(error)}`)
      })
    },
    (error: unknown) => {
      console.warn(`chatroom: poll statement card ctx failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

/** The research gather progress card; terminal is '' (X/N), 'done', or 'timedout'.
 *
 * The live card carries the interjection hint: a research round runs up to an
 * hour with the moderator asleep between rounds, and nothing else on the card
 * tells the user their messages reach the moderator.
 *
 * @param e - Engine carrying the i18n surface.
 * @param done - Number of role replies collected so far.
 * @param total - Total number of roles in the gather.
 * @param terminal - Terminal state ('' for live progress, 'done', or 'timedout').
 * @returns The progress card for the current state.
 */
export function buildResearchProgressCard(
  e: Engine,
  done: number,
  total: number,
  terminal: string,
  waiting: readonly string[] = [],
  elapsedMin = 0,
): Card {
  let title = e.i18n.t(Msg.ChatroomResearchProgressTitle)
  let body = e.i18n.tf(Msg.ChatroomResearchProgressBody, done, total)
  if (terminal === '') {
    if (waiting.length > 0) {
      body += `\n\n${e.i18n.tf(Msg.ChatroomResearchProgressWaiting, waiting.join('、'), elapsedMin)}`
    }
    body += `\n\n${e.i18n.t(Msg.ChatroomInterjectHint)}`
  } else if (terminal === 'done') {
    title = e.i18n.t(Msg.ChatroomResearchProgressDone)
  } else if (terminal === 'timedout') {
    title = e.i18n.t(Msg.ChatroomResearchProgressTimedOutTitle)
    body = e.i18n.tf(Msg.ChatroomResearchProgressTimedOut, done, total)
  } else if (terminal === 'restarted') {
    title = e.i18n.t(Msg.ChatroomResearchProgressRestartedTitle)
    body = e.i18n.tf(Msg.ChatroomResearchProgressRestarted, done, total)
  }
  return newCard().title(title, 'indigo').markdown(body).build()
}

/** Post the initial research progress card and store the handle on the barrier. */
function sendResearchProgressCard(e: Engine, p: Platform, hubKey: string, g: ChatroomGather): void {
  const cu = asCardSenderWithUpdate(p)
  if (cu === undefined) return
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      const card = buildResearchProgressCard(e, 0, g.expected.size, '')
      cu.sendCardWithHandle(hubRctx, card).then(
        (handle) => { g.progressHandle = handle },
        (error: unknown) => {
          console.warn(`chatroom: research progress card send failed: ${String(error)}`)
        },
      )
    },
    (error: unknown) => {
      console.warn(`chatroom: reconstruct hub ctx for progress card failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

/**
 * PATCH the research progress card — the single projection of barrier state.
 * Live updates coalesce through a {@link progressCardMergeMs} window (roles
 * replying in a burst produce one trailing PATCH, not N); terminal states
 * land immediately and cancel any pending merge. No-op without a handle
 * (plain gathers post no card).
 *
 * @param e - Engine carrying the i18n surface.
 * @param p - Platform that can update the card by handle.
 * @param g - The armed gather whose state is projected.
 * @param terminal - '' (live), 'done', or 'timedout'.
 */
export function updateResearchProgressCard(e: Engine, p: Platform, g: ChatroomGather, terminal: string): void {
  const handle = g.progressHandle
  if (handle === undefined || handle === null) return
  const cu = asCardSenderWithUpdate(p)
  if (cu === undefined) return
  if (terminal === '') {
    if (Date.now() - g.lastPatchAt < progressCardMergeMs) {
      if (g.mergeTimer === undefined) {
        g.mergeTimer = setTimeout(() => {
          g.mergeTimer = undefined
          patchResearchProgressCard(e, cu, g, '')
        }, progressCardMergeMs)
        g.mergeTimer.unref()
      }
      return
    }
  } else if (g.mergeTimer !== undefined) {
    clearTimeout(g.mergeTimer)
    g.mergeTimer = undefined
  }
  patchResearchProgressCard(e, cu, g, terminal)
}

function patchResearchProgressCard(
  e: Engine,
  cu: NonNullable<ReturnType<typeof asCardSenderWithUpdate>>,
  g: ChatroomGather,
  terminal: string,
): void {
  g.lastPatchAt = Date.now()
  const done = g.collected.size
  const total = g.collected.size + g.expected.size
  const waiting = terminal === '' ? [...g.expected] : []
  const elapsedMin = terminal === '' && g.startedAt !== 0 ? Math.floor((Date.now() - g.startedAt) / 60_000) : 0
  const card = buildResearchProgressCard(e, done, total, terminal, waiting, elapsedMin)
  void cu.updateCardWithHandle(g.progressHandle, card).catch((error: unknown) => {
    console.warn(`chatroom: research progress card update failed: ${String(error)}`)
  })
}

/**
 * Prefix a partial-gather wake with the NAMED list of timed-out roles and
 * each role's state (dispatched assistant / in-flight / never started).
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param hubKey - Session key of the chatroom hub.
 * @param missing - Names of the roles that did not reply in time.
 * @param base - The partial wake text (broadcast question + collected replies).
 * @returns The timeout prefix joined with base, ready to wake the moderator.
 */
/** Each missing role's state line: dispatched assistant / in-flight / never started. */
function missingRoleStateLines(e: Engine, hubKey: string, missing: string[]): string[] {
  const sts: string[] = []
  for (const name of missing) {
    let role: Session | undefined
    const rk = findRoleKeyByName(e, hubKey, name)
    if (rk !== '') role = e.sessions.getOrCreateActive(rk)
    if (role !== undefined && chatroomState(role).researchDispatched) {
      sts.push(e.i18n.tf(Msg.ChatroomGatherTimedOutDispatched, name))
    } else if (role !== undefined && chatroomState(role).chatroomInFlight) {
      sts.push(e.i18n.tf(Msg.ChatroomGatherTimedOutInFlight, name))
    } else {
      sts.push(e.i18n.tf(Msg.ChatroomGatherTimedOutIdle, name))
    }
  }
  return sts
}

export function buildGatherTimeoutWake(e: Engine, hubKey: string, missing: string[], base: string): string {
  const sts = missingRoleStateLines(e, hubKey, missing)
  return `${e.i18n.tf(Msg.ChatroomGatherTimeout, missing.length, sts.join('、'))}\n\n${base}`
}

/**
 * Prefix a re-arm wake: the still-missing roles with their states, plus the
 * re-arm contract — late replies keep funneling into this round and the
 * moderator is woken again on completion or window lapse, so it must not
 * treat the partial set as final (2026-09-06: it reasonably did, and the
 * room idled on an assumption nothing owned).
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param hubKey - Session key of the chatroom hub.
 * @param missing - Names of the roles whose replies are still awaited.
 * @param base - The partial wake text (broadcast question + collected replies).
 * @param minutes - The re-arm window length in minutes.
 * @returns The re-arm prefix joined with base, ready to wake the moderator.
 */
export function buildGatherRearmWake(e: Engine, hubKey: string, missing: string[], base: string, minutes: number): string {
  const sts = missingRoleStateLines(e, hubKey, missing)
  return `${e.i18n.tf(Msg.ChatroomGatherRearmed, missing.length, sts.join('、'), minutes)}\n\n${base}`
}

/** Per-hub moderator wake timestamps (epoch ms), read by {@link lastChatroomWakeAt}. */
const wakeStamps = new WeakMap<Engine, Map<string, number>>()

/**
 * The epoch-ms time of the moderator's most recent wake on a hub (0 when never
 * woken). The role-pick watchdog defers its fallback card while a wake is inside
 * its own window, so the wake→pick-roles ranking leg owns the full timeout.
 *
 * @param e - Engine owning the wake stamps.
 * @param hubKey - Hub session key the wake targeted.
 * @returns Epoch ms of the last wake, or 0 when none is recorded.
 */
export function lastChatroomWakeAt(e: Engine, hubKey: string): number {
  return wakeStamps.get(e)?.get(hubKey) ?? 0
}

/**
 * Deliver a synthetic message to the hub session re-arming the moderator for
 * the next orchestration step (Go wakeChatroomModerator).
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param hubKey - Session key of the chatroom hub to wake.
 * @param content - The wake message text delivered to the moderator.
 * @param metadata - Optional message metadata carried to the opened turn (the
 * stall supervisor tags its wakes so activity tracking skips them).
 */
export function wakeChatroomModerator(e: Engine, hubKey: string, content: string, metadata?: Record<string, unknown>): void {
  let stamps = wakeStamps.get(e)
  if (stamps === undefined) {
    stamps = new Map()
    wakeStamps.set(e, stamps)
  }
  stamps.set(hubKey, Date.now())
  const p = e.spawnCapablePlatform()
  if (p === undefined) return
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      const wake = `${content}\n\n${e.i18n.t(Msg.ChatroomReminder)}`
      e.deliverMachineMessage(p, {
        ...emptyMessage(),
        sessionKey: hubKey,
        platform: p.name(),
        userName: '[聊天室]',
        content: wake,
        replyCtx: hubRctx,
        ...metadata !== undefined ? { metadata } : {},
      })
    },
    (error: unknown) => {
      console.warn(`chatroom: reconstruct hub ctx for wake failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

// ── ask-human / reply routing ─────────────────────────────────────────────

/**
 * A role asks the human a question whose answer only the human knows: mark
 * the hub pending, post a ⏸ card, and do NOT wake the moderator — the
 * discussion is suspended (Go AskHuman).
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param roleSessionKey - Session key of the asking role; must belong to a chatroom.
 * @param question - The question for the human; empty is rejected.
 */
export async function askHuman(e: Engine, roleSessionKey: string, question: string): Promise<void> {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const role = e.sessions.getOrCreateActive(roleSessionKey)
  const hubKey = chatroomState(role).chatroomHubKey
  if (hubKey === '') {
    throw new Error(`chatroom: "${roleSessionKey}" is not a chatroom role session`)
  }
  let roleName = chatroomState(role).chatroomRoleName
  if (roleName === '') roleName = 'role'
  // Reject ask-human while a gather is in flight: the moderator collects
  // role questions centrally and asks the user once via a multi-select card.
  const gatherHub = chatroomHubOf(e, hubKey)
  if (gatherHub !== undefined && chatroomState(gatherHub).pendingGather !== undefined) {
    throw new Error(e.i18n.t(Msg.ChatroomGatherAskHumanBlocked))
  }
  const r = asReplyContextReconstructor(p)
  if (r === undefined) {
    throw new Error(`chatroom: platform "${p.name()}" cannot address the hub group`)
  }
  const hubRctx = await r.reconstructReplyCtx(hubKey)

  // Mark the hub pending — single slot (hub-and-spoke asks one role at a time).
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) throw new Error(`chatroom: hub session missing (hub=${hubKey})`)
  chatroomState(hub).pendingHumanQuestionRole = roleName
  e.sessions.save()

  const body = e.i18n.tf(Msg.ChatroomPendingBody, roleName, q, roleName)
  try {
    await e.sendAsCard(p, hubRctx, body, { title: e.i18n.tf(Msg.ChatroomPendingHeader, roleName), color: 'green' })
  } catch (error) {
    console.warn(`chatroom: pending-question card send failed (role=${roleName}): ${String(error)}`)
  }
  console.info(`chatroom: role asked human; discussion suspended (hub=${hubKey} role=${roleName})`)
}

/**
 * Route the human's reply to a pending ask-human question back to the asking
 * role (via askRole) and clear the pending flag. Returns true when the
 * message was consumed; slash commands pass through untouched.
 *
 * @param e - Engine carrying the session registry.
 * @param _p - Platform of the inbound message (unused; askRole resolves its own).
 * @param hubKey - Session key of the chatroom hub holding the pending flag.
 * @param content - The human's reply text.
 * @returns True when the reply was routed to the pending role; false when no question is pending or the message is a slash command.
 */
export function routePendingHumanReply(e: Engine, _p: Platform, hubKey: string, content: string): boolean {
  const hub = chatroomHubOf(e, hubKey)
  const roleName = hub !== undefined ? chatroomState(hub).pendingHumanQuestionRole.trim() : ''
  if (roleName === '') return false
  if (content.trim().startsWith('/')) return false
  // A stale flag (the chatroom ended or was interrupted before the user
  // replied) must not swallow the message into a dead askRole — hand it
  // back to the normal agent path instead.
  const roleLive = listChatroomRoles(e, hubKey).some(r => r.name === roleName)
  if (!roleLive) {
    if (hub !== undefined) chatroomState(hub).pendingHumanQuestionRole = ''
    e.sessions.save()
    return false
  }
  // Backstop for interleavings armed before the gather-side guard existed
  // (a pending flag plus a live gather): routing now would inject a second
  // in-flight ask into the gathering role, whose first turn-end consumes the
  // one-shot relay gate and drops the reply to the human's answer. The
  // answer goes to the hub's normal path instead — the moderator relays it
  // after the round — and the flag retires: the user did answer.
  if (hub !== undefined && chatroomState(hub).pendingGather !== undefined) {
    chatroomState(hub).pendingHumanQuestionRole = ''
    e.sessions.save()
    console.info(`chatroom: human reply during armed gather routed to hub (hub=${hubKey} role=${roleName})`)
    return false
  }
  // Clear first so a concurrent reply doesn't double-route; askRole re-arms
  // the role's relay gate.
  if (hub !== undefined) chatroomState(hub).pendingHumanQuestionRole = ''
  e.sessions.save()
  const askContent = `人类回答：${content.trim()}\n请基于此继续。`
  void askRole(e, hubKey, roleName, askContent).catch((error: unknown) => {
    console.warn(`chatroom: route pending reply failed (role=${roleName}): ${String(error)}`)
  })
  console.info(`chatroom: routed human reply to pending role (hub=${hubKey} role=${roleName})`)
  return true
}

// ── relay (turn-end hook) ─────────────────────────────────────────────────

/**
 * Whether a research role's dispatched assistant still owes its contribution:
 * its turn is in flight, or its current dispatch cycle has not reported yet
 * (a parent follow-up re-arms the one-shot report). An unresolvable assistant
 * (no pre-provisioned key, session gone) reads as pending so the relay defers
 * conservatively.
 * @param e - Engine carrying the session registry and live-turn states.
 * @param role - Role session whose pre-provisioned assistant to check.
 * @returns True when the assistant's report has not been initiated.
 */
export function assistantReportPending(e: Engine, role: Session): boolean {
  const key = chatroomState(role).researchAssistantKey
  if (key === '') return true
  const assistant = e.sessions.findActive(key)
  if (assistant === undefined) return true
  return (e.interactiveStates.get(key)?.activeTurns ?? 0) > 0 || !assistant.getSubtaskReported()
}

/**
 * The deterministic turn-end hook for a chatroom role session: at the end of
 * each role turn it relays the reply to the hub as 【name】 AND wakes the
 * moderator. One-shot per ask (gated by chatroomAsked). Silent/empty replies
 * are skipped. Disjoint from maybeAutoReportSubtask (roles keep depth=0).
 * An errored turn (an API error interrupted generation) is never relayed as a
 * reply — the barriers record an explicit failure and the wake carries the
 * failure line plus the turn's own partial, mirroring the subtask hook's
 * never-a-stale-earlier-reply discipline.
 *
 * All session/barrier state mutations run synchronously (Go's mutex-guarded
 * sequence); only the platform sends (relay card, ledger append, wake) ride
 * the async reply-context reconstruction.
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param state - Interactive state of the finished turn; its platform addresses the hub.
 * @param session - The role session whose turn just ended.
 * @param baseResponse - The role's reply text for this turn; on an errored
 *   turn, the turn's own partial streamed text.
 * @param isSilent - True when the turn ran in silent mode (no relay card, wake still fires).
 * @param errored - True when an error interrupted the turn; baseResponse is
 *   then a partial, not a final reply.
 * @param errorText - The interrupting error's text when errored.
 */
export function maybeAutoRelayRole(
  e: Engine,
  state: InteractiveState | undefined,
  session: Session,
  baseResponse: string,
  isSilent: boolean,
  errored = false,
  errorText = '',
): void {
  if (chatroomState(session).chatroomHubKey === '' || chatroomState(session).chatroomAsked) return
  // Superseded-turn guard: this turn's ask identity no longer matches any
  // outstanding ask (its gather timed out, or a newer ask to this role
  // superseded it). Judged BEFORE the awaiting defer so a superseded turn
  // can neither consume nor re-defer the current round's
  // ResearchAwaitingAssistant. A stamp of 0 (an armed turn no ask message
  // opened — legacy or a wake before the first stamp) keeps today's
  // best-effort serial semantics.
  const stamp = chatroomState(session).chatroomAskSeq
  let outstanding = stamp === 0
  const staleHub = chatroomHubOf(e, chatroomState(session).chatroomHubKey)
  const b = staleHub !== undefined ? chatroomState(staleHub).pendingGather : undefined
  const roleName = chatroomState(session).chatroomRoleName
  const serialEntry = staleHub !== undefined ? chatroomState(staleHub).pendingSerialAsks.get(roleName) : undefined
  if ((b !== undefined && b.seq === stamp) || (serialEntry !== undefined && serialEntry.id === stamp)) {
    outstanding = true
  }
  // Research mode: the role's first turn after a gather dispatches its
  // assistant and ends without a conclusion. Defer the relay only when the
  // turn dispatched AND the assistant still owes its report — a turn that
  // consumed the assistant's results in-turn (the blocking subtask gather
  // resolving inside the same turn) IS the conclusion, and deferring it would
  // strand the armed gather until the research timeout, because the
  // already-reported assistant never wakes a later turn (2026-09-02 oc_e51a).
  // The dispatched flag itself stays set — the gather timeout report reads it.
  if (outstanding && chatroomState(session).researchAwaitingAssistant) {
    if (chatroomState(session).researchDispatched && assistantReportPending(e, session)) {
      chatroomState(session).researchAwaitingAssistant = false
      e.sessions.save()
      console.info(`chatroom: research role dispatched assistant; deferring relay to conclusion turn (role=${chatroomState(session).chatroomRoleName})`)
      return
    }
    // No dispatch this turn, or the dispatched assistant already reported —
    // this turn IS the conclusion.
    chatroomState(session).researchAwaitingAssistant = false
    e.sessions.save()
  }
  if (state === undefined || state.platform === undefined) return
  const p = state.platform
  const hubKey = chatroomState(session).chatroomHubKey
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  const reply = baseResponse.trim()
  /** Barrier record for an errored turn: the fixed failure brief — raw provider
   * wording must not enter the moderator's context (2026-09-09/10 Zhipu 1301 cascade). */
  const failedNote = errored ? e.i18n.tf(Msg.ChatroomRoleTurnFailedNote, failureBriefForAgentContext(errorText)) : ''

  /**
   * Post the 【Role】 card to the hub and append the ledger. Shared by every
   * relay path (end barrier, gather fan-in, serial, stale). The in-flight
   * flag clears with the relay; the ledger write is serialized inside the
   * ledger module, so the flag ordering vs durability is weaker than Go's
   * synchronous append by one microtask. Resolves once the card send has
   * settled — callers that wake the moderator next must await it so the
   * placeholder card cannot overtake the relay card.
   */
  const relayRoleReply = async (hubRctx: unknown): Promise<void> => {
    if (errored || reply === '' || isSilent) return
    const content = `【${roleName}】${reply}`
    await e.sendAsCard(p, hubRctx, content, { title: e.i18n.tf(Msg.ChatroomRoleReplyHeader, roleName), color: 'green' })
      .catch((error: unknown) => {
        console.warn(`chatroom: relay card failed (role=${roleName}): ${String(error)}`)
      })
    const lp = chatroomLedgerDirFor(e, hubKey)
    if (lp !== undefined) {
      void appendChatroomLedger(lp, roleName, reply).catch((error: unknown) => {
        console.warn(`chatroom: ledger append failed: ${String(error)}`)
      })
    }
  }

  // --- End barrier path (draining in-flight replies before teardown) ---
  // Runs for EVERY stamped turn — including superseded and late ones: the
  // drain owns collection while the room is closing, and a turn whose ask
  // retired at endChatroom must not detour into the free-relay path.
  const barrierHub = chatroomHubOf(e, hubKey)
  const barrier = barrierHub !== undefined ? chatroomState(barrierHub).pendingEndBarrier : undefined
  if (barrier !== undefined) {
    const relayP = r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => { return relayRoleReply(hubRctx) },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    chatroomState(session).chatroomInFlight = false
    const { done, summary } = barrier.accumulate(roleName, errored ? failedNote : reply)
    if (done) {
      // The relay card must land before the closing summary's wake card
      // (same contract as the gather path): finalize only after the relay
      // settles — finalizeChatroomEndAsync still defers itself off the
      // turn-end stack inside.
      void relayP.then(() => { finalizeChatroomEndAsync(e, hubKey, summary) })
      console.info(`chatroom: end barrier complete; finalizing (role=${roleName} hub=${hubKey})`)
    } else {
      console.info(`chatroom: gathered end reply (waiting for more) (role=${roleName} hub=${hubKey})`)
    }
    return
  }

  if (!outstanding) {
    void r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => {
        void relayRoleReply(hubRctx)
      },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    // A superseded turn must not clear the in-flight flag: the newer ask
    // that superseded it owns the flag until its own turn relays.
    e.sessions.save()
    console.info(`chatroom: turn from a superseded ask; relayed as free reply (role=${roleName} askSeq=${stamp} barrierSeq=${b?.seq ?? 0})`)
    return
  }

  // The answering turn ends — with or without a reply — so a later turn on
  // this role does not re-fire. Crucially, we wake the moderator even on a
  // silent/empty reply (NO_REPLY): without that, a role that passes would
  // leave the moderator idle forever and stall the discussion.
  chatroomState(session).chatroomAsked = true
  e.sessions.save()

  // --- Gather fan-in path (two-phase flow) ---
  const hub = chatroomHubOf(e, hubKey)
  const g = hub !== undefined ? chatroomState(hub).pendingGather : undefined
  if (g !== undefined) {
    // The round consumed this role's answer; a serial entry minted after
    // the round armed (a mid-round steer) retires here, not at the serial
    // path — its wake is the round's own.
    if (hub !== undefined) chatroomState(hub).pendingSerialAsks.delete(roleName)
    const relayP = r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => { return relayRoleReply(hubRctx) },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    chatroomState(session).chatroomInFlight = false
    const { done, wakeContent } = g.accumulate(roleName, errored ? failedNote : reply)
    if (!done) {
      updateResearchProgressCard(e, p, g, '')
      console.info(`chatroom: gathered role reply (waiting for more) (role=${roleName} hub=${hubKey})`)
      return
    }
    // Last reply in: flip the progress card to its terminal state, clear the
    // barrier and wake the moderator once — after the relay card settles, so
    // the moderator's placeholder card lands below it.
    updateResearchProgressCard(e, p, g, 'done')
    if (hub !== undefined) chatroomState(hub).pendingGather = undefined
    e.sessions.save()
    void relayP.then(() => { wakeChatroomModerator(e, hubKey, wakeContent) })
    console.info(`chatroom: gather complete; woke moderator with all replies (hub=${hubKey})`)
    return
  }

  // --- Serial path (free-form roundtable) ---
  // The turn's stamp matched this role's outstanding serial ask (or fell
  // through with no gather and no barrier): complete the entry and wake the
  // moderator with the reply.
  if (serialEntry !== undefined && serialEntry.id === stamp) {
    const entryHub = chatroomHubOf(e, hubKey)
    if (entryHub !== undefined) chatroomState(entryHub).pendingSerialAsks.delete(roleName)
    e.sessions.save()
  }
  const reminder = e.i18n.t(Msg.ChatroomReminder)
  let wake: string
  if (errored) {
    // The turn died mid-generation: the wake carries the fixed failure brief
    // — raw provider wording and the partial must not enter the moderator's
    // context (2026-09-09/10 Zhipu 1301 cascade re-tripped moderation).
    const failedWake = e.i18n.tf(Msg.ChatroomRoleTurnFailedWake, roleName, failureBriefForAgentContext(errorText))
    wake = `${failedWake}\n\n${reminder}`
    console.info(`chatroom: role turn failed; woke moderator with the failure brief (role=${roleName} error=${errorText})`)
  } else if (reply !== '' && !isSilent) {
    wake = `[聊天室·${roleName} 发言]\n\n${reply}\n\n${reminder}`
    console.info(`chatroom: relayed role reply to hub (role=${roleName} hub=${hubKey})`)
  } else {
    wake = `[聊天室·${roleName} 本轮未发言（NO_REPLY）]\n\n${reminder}`
    console.info(`chatroom: role passed silently; woke moderator to continue (role=${roleName})`)
  }
  chatroomState(session).chatroomInFlight = false
  void r.reconstructReplyCtx(hubKey).then(
    async (hubRctx) => {
      // The relay card must land before the wake's placeholder card, or the
      // two sends race at the chat tail for the whole moderator turn.
      await relayRoleReply(hubRctx)
      e.deliverMachineMessage(p, {
        ...emptyMessage(),
        sessionKey: hubKey,
        platform: p.name(),
        userName: '[聊天室]',
        content: wake,
        replyCtx: hubRctx,
      })
    },
    (error: unknown) => {
      console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

// ── end ───────────────────────────────────────────────────────────────────

/**
 * Tear down all role groups in a chatroom (children of the hub with a
 * chatroom hub key), reusing /done's recursive cleanup. The hub session
 * itself is left intact.
 *
 * @param e - Engine carrying the session registry and platform.
 * @param hubKey - Session key of the chatroom hub to tear down.
 * @returns 'ended' with the removed-role count, or 'pending' with the in-flight roles being drained.
 */
export function endChatroom(e: Engine, hubKey: string): ChatroomEndResult {
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) throw new Error(`chatroom: hub session missing (hub=${hubKey})`)
  if (chatroomState(hub).pendingGather !== undefined) {
    throw new Error('chatroom: gather 进行中，等其完成再 end；若回复源已死（助手被停止/角色被回收）永远等不齐，改用 force: true 立即中断（用户也可在任意成员群发 /chatroom stop）')
  }
  if (chatroomState(hub).pendingEndBarrier !== undefined) {
    throw new Error('chatroom: 正在收尾中；要立即中断改用 force: true')
  }

  // Phase A: collect in-flight role names without yet installing the barrier.
  // The end barrier owns collection from here: outstanding serial asks retire
  // so their answering turns drain into the barrier instead of waking the
  // moderator for a room already closing.
  chatroomState(hub).pendingSerialAsks.clear()
  const inFlightNames = new Set<string>()
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (chatroomState(sess).chatroomHubKey === '') continue
    if (chatroomState(sess).chatroomInFlight) inFlightNames.add(chatroomState(sess).chatroomRoleName)
  }

  if (inFlightNames.size === 0) {
    const removed = finalizeChatroomEnd(e, hubKey).length
    return { status: 'ended', inFlight: [], timeoutSecs: 0, rolesRemoved: removed }
  }

  // Phase B: atomically install the barrier with Expected already filled.
  const b = new ChatroomEndBarrier()
  for (const n of inFlightNames) b.expected.add(n)
  chatroomState(hub).pendingEndBarrier = b

  // Phase C: drop roles that already relayed via the normal path during the
  // Phase A→B window.
  for (const name of b.expectedSnapshot()) {
    const roleKey = findRoleKeyByName(e, hubKey, name)
    if (roleKey === '') continue
    if (!chatroomState(e.sessions.getOrCreateActive(roleKey)).chatroomInFlight) {
      b.forgetExpected(name)
    }
  }
  const remaining = b.expectedRemaining()
  if (remaining.length === 0) {
    const removed = finalizeChatroomEnd(e, hubKey).length
    return { status: 'ended', inFlight: [], timeoutSecs: 0, rolesRemoved: removed }
  }

  const timeout = chatroomConfig(e).endTimeoutDuration()
  b.timer = setTimeout(() => { fireEndTimeout(e, hubKey) }, timeout)
  b.timer.unref()
  console.info(`chatroom: end pending; draining in-flight role replies (hub=${hubKey} inflight=${remaining.join(',')} timeoutMs=${timeout})`)
  return { status: 'pending', inFlight: remaining, timeoutSecs: Math.round(timeout / 1000), rolesRemoved: 0 }
}

/**
 * Whether a non-role session in the chatroom hub's subtree descends from a
 * chatroom executor — a chatroom role or the research steward: the ancestor
 * that hangs directly off the hub. Descendants at every depth below those
 * (role assistants, the assistants' recursive fetchers, the steward's
 * per-source fetchers) are cleaned with the room; subtrees below other
 * hub-direct children (the end-of-run HTML renderers) are preserved.
 *
 * collectSubtree is deepest-first, so no ancestor has been cleared yet when
 * this runs. A cycle in the parent chain (malformed state) preserves rather
 * than loops.
 *
 * @param e - Engine carrying the session registry.
 * @param sess - The subtree session being classified.
 * @param hubKey - Session key of the chatroom hub.
 * @returns True when the session belongs to a role's or the steward's subtree.
 */
function hangsOffChatroomExecutor(e: Engine, sess: Session, hubKey: string): boolean {
  let cur = sess
  const seen = new Set<string>()
  for (;;) {
    const pk = cur.getParentSessionKey()
    if (pk === '') return false
    if (pk === hubKey) {
      return chatroomState(cur).chatroomHubKey === hubKey || chatroomState(cur).researchAssistant
    }
    if (seen.has(pk)) return false
    seen.add(pk)
    cur = e.sessions.getOrCreateActive(pk)
  }
}

/**
 * Tear down every chatroom role under the hub: stops each role session,
 * clears the chatroom marking, and drops the end barrier. The Session
 * records themselves are kept.
 *
 * @param e - Engine carrying the session registry and platform.
 * @param hubKey - Session key of the chatroom hub whose roles are removed.
 * @param endedStatus - Terminal status stamped into the ledger header.
 * @returns The session keys whose cleanup ran (roles, their assistants, the
 *   research steward and its fetchers); a `/done` skip list consumes these
 *   so the bridge's own descendant loop does not re-clean them.
 */
export function finalizeChatroomEnd(e: Engine, hubKey: string, endedStatus: 'ended' | 'interrupted' = 'ended'): string[] {
  const p = e.spawnCapablePlatform()
  if (p === undefined) return []
  // Native continuable descendants chain through the project state, not the
  // session tree (de-baggage B4) — drain them alongside the role groups.
  void e.drainNativeDescendants([hubKey, ...e.collectSubtree(hubKey)])
  const cleaned: string[] = []
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (chatroomState(sess).chatroomHubKey === '') {
      // Not a chatroom role. Everything in the hub's subtree hangs off the
      // hub through a chatroom role, the research steward, or a preserved
      // hub-direct /spawn child (the end-of-run HTML renderers) — clean the
      // first two families at every depth (role assistants and their
      // recursive fetchers included), preserve the third with its subtree.
      if (!hangsOffChatroomExecutor(e, sess, hubKey)) continue
    }
    void cleanupOneChat(e, p, childKey, undefined, true)
    chatroomState(sess).chatroomHubKey = ''
    chatroomState(sess).chatroomRoleName = ''
    chatroomState(sess).chatroomAsked = false
    chatroomState(sess).chatroomInFlight = false
    chatroomState(sess).researchAssistantKey = ''
    chatroomState(sess).researchAwaitingAssistant = false
    chatroomState(sess).researchAssistant = false
    cleaned.push(childKey)
  }
  const hub = chatroomHubOf(e, hubKey)
  if (hub !== undefined) {
    chatroomState(hub).pendingEndBarrier = undefined
    // Hub returns to a normal session — drop the moderator flag so subsequent
    // turns use the default harness path.
    chatroomState(hub).chatroomModerator = false
    // A pending ask-human the user never answered dies with the room: a
    // surviving durable flag routes the hub's next normal message into a
    // dead askRole (interruptChatroom lands here too).
    chatroomState(hub).pendingHumanQuestionRole = ''
    // Research flags live on the hub; without this a second research chatroom
    // in the same group inherits the previous round count.
    clearChatroomResearchFlags(hub)
  }
  // The hub's own spawned-chat done mark: roles get theirs through
  // cleanupOneChat above, but the moderator-tool end path has no generic
  // /done teardown behind it, so without this the ended hub keeps its
  // discussing avatar and active spawned-state entry (2026-09-07 oc_94b41a).
  void e.markSpawnedChatDone(p, hubKey).catch((error: unknown) => {
    console.warn(`chatroom: hub done-mark failed (${hubKey}): ${String(error)}`)
  })
  e.sessions.save()
  // Stamp the terminal state into the ledger header (best-effort: the write
  // rides the ledger chain; a failure warns and leaves the entry 未收尾,
  // which the history read tolerates).
  const lp = chatroomLedgerDirFor(e, hubKey)
  if (lp !== undefined) {
    void writeChatroomLedgerEnded(lp, endedStatus).catch((error: unknown) => {
      console.warn(`chatroom: ledger ended-line write failed (${lp}): ${String(error)}`)
    })
  }
  console.info(`chatroom: ended (hub=${hubKey} roles_removed=${cleaned.length} status=${endedStatus})`)
  return cleaned
}

/** finalizeChatroomEnd + the closing-summary wake off the turn-end stack (Go finalizeChatroomEndAsync).
 *
 * @param e - Engine carrying the session registry and platform.
 * @param hubKey - Session key of the chatroom hub to finalize.
 * @param summary - The closing summary delivered to the moderator after teardown.
 */
export function finalizeChatroomEndAsync(e: Engine, hubKey: string, summary: string): void {
  void Promise.resolve().then(() => {
    finalizeChatroomEnd(e, hubKey)
    wakeChatroomModerator(e, hubKey, summary)
  })
}

// ── interrupt ─────────────────────────────────────────────────────────────

/** Result of {@link interruptChatroom} for the command/tool surfaces. */
export interface ChatroomInterruptResult {
  /** Roles (and their assistants) removed by the teardown. */
  rolesRemoved: number
  /** Role names whose replies the interrupted barriers were still awaiting. */
  missing: string[]
  /** Session keys whose cleanup ran (the `/done` pre-done skip list). */
  cleanedKeys: string[]
}

/**
 * Hard-stop a chatroom from ANY protocol state (Go had no counterpart: end
 * refuses while a gather is armed, and a gather whose reply sources died —
 * assistants user-stopped, roles reaped — can never complete, deadlocking
 * the teardown until the timeout wakes a chatroom the user abandoned).
 * Interrupt consumes both barriers without waking, stops the moderator turn
 * and every in-flight role/assistant turn instead of draining, then reuses
 * finalizeChatroomEnd's teardown. Member sessions' armed subtask gathers are
 * disarmed as well: their 20-minute fallback timer must not wake a torn-down
 * room's roles as fresh turns (2026-09-01 oc_0e4b incident). The moderator
 * gets no turn: the interrupt card is the only terminal record.
 *
 * @param e - Engine carrying the session registry and platform.
 * @param hubKey - Session key of the chatroom hub to interrupt.
 * @returns The teardown count and the interrupted barriers' missing roles.
 */
export function interruptChatroom(e: Engine, hubKey: string): ChatroomInterruptResult {
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const hub = e.sessions.getOrCreateActive(hubKey)

  // Stop the brain first: a mid-orchestration moderator turn would otherwise
  // keep issuing asks into groups the teardown is about to delete.
  e.stopInteractiveSession(hubKey)
  let clearedGathers = e.clearSubtaskGather(hubKey) ? 1 : 0

  // Consume both barriers without waking: the interrupt card is the only
  // terminal record the user asked for.
  const missing: string[] = []
  const g = chatroomState(hub).pendingGather
  if (g !== undefined) {
    g.stopTimer()
    missing.push(...g.expected)
    chatroomState(hub).pendingGather = undefined
  }
  const b = chatroomState(hub).pendingEndBarrier
  if (b !== undefined) {
    b.clearFallbackTimer()
    missing.push(...b.expected)
    chatroomState(hub).pendingEndBarrier = undefined
  }
  e.sessions.save()

  // Stop every in-flight role/assistant turn instead of draining (end's
  // semantics): interrupt waits for nothing. Each member's armed subtask
  // gather is disarmed after its turn stops (the abort listener settles the
  // blocking tool promise first).
  for (const childKey of e.collectSubtree(hubKey)) {
    e.stopInteractiveSession(childKey)
    if (e.clearSubtaskGather(childKey)) clearedGathers += 1
  }
  const cleanedKeys = finalizeChatroomEnd(e, hubKey, 'interrupted')
  const rolesRemoved = cleanedKeys.length

  const uniqueMissing = [...new Set(missing)].sort()
  const cs = asCardSender(p)
  const r = asReplyContextReconstructor(p)
  if (cs !== undefined && r !== undefined) {
    void r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => {
        const body = [e.i18n.tf(Msg.ChatroomInterruptBody, rolesRemoved)]
        if (uniqueMissing.length > 0) body.push(e.i18n.tf(Msg.ChatroomInterruptMissing, uniqueMissing.join('、')))
        const lp = chatroomLedgerDirFor(e, hubKey)
        if (lp !== undefined) body.push(e.i18n.tf(Msg.ChatroomInterruptLedger, lp))
        const card = newCard().title(e.i18n.t(Msg.ChatroomInterruptTitle), 'red').markdown(body.join('\n')).build()
        void cs.sendCard(hubRctx, card).catch((error: unknown) => {
          console.warn(`chatroom: interrupt card send failed (hub=${hubKey}): ${String(error)}`)
        })
      },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx for interrupt card failed (hub=${hubKey}): ${String(error)}`)
      },
    )
  }
  console.info(`chatroom: interrupted (hub=${hubKey} roles_removed=${rolesRemoved} missing=${uniqueMissing.join(',')} gathers_cleared=${clearedGathers})`)
  return { rolesRemoved, missing: uniqueMissing, cleanedKeys }
}

/**
 * Resolve the chatroom hub a chat belongs to: the hub itself (moderator
 * flag), any role group (chatroomHubKey), or any descendant via the parent
 * chain (pre-spawned assistants). '' when the chat is no chatroom member.
 *
 * @param e - Engine carrying the session registry.
 * @param fromKey - Session key of the invoking chat.
 * @returns The owning hub's session key, or ''.
 */
export function resolveChatroomHubKey(e: Engine, fromKey: string): string {
  let key = fromKey
  for (let hop = 0; hop < 4; hop++) {
    const s = e.sessions.findActive(key)
    if (s === undefined) return ''
    if (chatroomState(s).chatroomModerator) return key
    const hub = chatroomState(s).chatroomHubKey
    if (hub !== '') return hub
    const parent = s.getParentSessionKey()
    if (parent === '' || parent === key) return ''
    key = parent
  }
  return ''
}

/** End-barrier fallback: reconcile once more, then finalize with the partial set. */
function fireEndTimeout(e: Engine, hubKey: string): void {
  const hub = chatroomHubOf(e, hubKey)
  if (hub === undefined) return
  const b = chatroomState(hub).pendingEndBarrier
  if (b === undefined) return
  for (const name of b.expectedSnapshot()) {
    const roleKey = findRoleKeyByName(e, hubKey, name)
    if (roleKey === '') continue
    if (!chatroomState(e.sessions.getOrCreateActive(roleKey)).chatroomInFlight) {
      b.forgetExpected(name)
    }
  }
  const { done, summary } = b.timeoutFire()
  if (!done) return // already finalized by the last reply
  finalizeChatroomEndAsync(e, hubKey, summary)
  console.info(`chatroom: end barrier timed out; finalizing with partial replies (hub=${hubKey})`)
}

// ── restart recovery ──────────────────────────────────────────────────────

/** Rebuild a gather barrier from its on-disk snapshot; malformed data yields undefined. */
function restoreGatherBarrier(raw: unknown): ChatroomGather | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  if (typeof s.question !== 'string' || typeof s.seq !== 'number'
    || !Array.isArray(s.expected) || !s.expected.every(n => typeof n === 'string')
    || typeof s.collected !== 'object' || s.collected === null
    || !Object.values(s.collected).every(v => typeof v === 'string')) return undefined
  const g = new ChatroomGather(s.question, s.seq)
  for (const n of s.expected) g.expected.add(n)
  // The guard above proved every collected value is a string; the cast only carries that into the entries type.
  for (const [k, v] of Object.entries(s.collected) as [string, string][]) g.collected.set(k, v)
  if (typeof s.startedAt === 'number') g.startedAt = s.startedAt
  if (s.rearmed === true) g.rearmed = true
  return g
}

/** Rebuild an end barrier from its on-disk snapshot; malformed data yields undefined. */
function restoreEndBarrier(raw: unknown): ChatroomEndBarrier | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  if (!Array.isArray(s.expected) || !s.expected.every(n => typeof n === 'string')
    || typeof s.collected !== 'object' || s.collected === null
    || !Object.values(s.collected).every(v => typeof v === 'string')) return undefined
  const b = new ChatroomEndBarrier()
  for (const n of s.expected) b.expected.add(n)
  // Same guard-proven string values as restoreGatherBarrier.
  for (const [k, v] of Object.entries(s.collected) as [string, string][]) b.collected.set(k, v)
  return b
}

/**
 * Consume the chatroom barriers restored from disk after a process restart.
 * Every reply a barrier was still waiting on belonged to a role turn that
 * died with the old process, so no expected reply can ever arrive: each
 * restored gather closes immediately with the replies collected so far plus
 * a restart annotation, and each restored end barrier finalizes without its
 * missing final replies. A stale research-awaiting-assistant marker on a
 * role session dies here too — no turn survives a restart.
 *
 * @param e - Engine whose platforms have started (the wakes need them).
 */
export function recoverChatroomBarriers(e: Engine): void {
  const { idToKey } = e.sessions.sessionKeyMap()
  const restored: Array<{ key: string; gather: unknown; end: unknown; serialAsks: unknown }> = []
  for (const s of e.sessions.allSessions()) {
    const cs = chatroomState(s)
    if (cs.pendingGatherData === undefined && cs.pendingEndBarrierData === undefined && cs.pendingSerialAsksData === undefined) continue
    const key = idToKey[s.id] ?? ''
    if (key === '') continue
    restored.push({ key, gather: cs.pendingGatherData, end: cs.pendingEndBarrierData, serialAsks: cs.pendingSerialAsksData })
    chatroomState(s).pendingGatherData = undefined
    chatroomState(s).pendingEndBarrierData = undefined
    chatroomState(s).pendingSerialAsksData = undefined
  }
  if (restored.length === 0) return
  const p = e.spawnCapablePlatform()
  // No role turn survives a restart: a persisted researchAwaitingAssistant
  // marker now describes an assistant that died with the process, and a
  // later re-ask must not treat its first turn as the deferred conclusion.
  for (const s of e.sessions.allSessions()) {
    if (chatroomState(s).chatroomHubKey === '') continue
    if (chatroomState(s).researchAwaitingAssistant) chatroomState(s).researchAwaitingAssistant = false
  }
  for (const { key, gather, end, serialAsks } of restored) {
    if (gather !== undefined) {
      const g = restoreGatherBarrier(gather)
      if (g === undefined) {
        console.warn(`chatroom: dropping corrupt restored gather barrier (hub=${key})`)
      } else {
        const missing = [...g.expected].sort()
        const { wake } = g.timeoutFire()
        const note = e.i18n.tf(Msg.ChatroomRestarted, missing.length, missing.join('、'))
        const restartHub = chatroomHubOf(e, key)
        if (p !== undefined && restartHub !== undefined && chatroomState(restartHub).chatroomResearch) {
          sendRestartedProgressCard(e, p, key, g)
        }
        wakeChatroomModerator(e, key, `${note}\n\n${wake}`)
        console.info(`chatroom: closed restored gather after restart (hub=${key} lost=${missing.join(',')})`)
      }
    }
    if (end !== undefined) {
      const b = restoreEndBarrier(end)
      if (b === undefined) {
        console.warn(`chatroom: dropping corrupt restored end barrier (hub=${key})`)
      } else {
        const missing = [...b.expected].sort()
        const { summary } = b.timeoutFire()
        const note = e.i18n.tf(Msg.ChatroomRestarted, missing.length, missing.join('、'))
        finalizeChatroomEndAsync(e, key, `${note}\n\n${summary}`)
        console.info(`chatroom: finalized restored end barrier after restart (hub=${key} lost=${missing.join(',')})`)
      }
    }
    // Outstanding serial asks never survive a restart: the answering turn
    // died with the process, and a restored entry would read as in-flight
    // and misdirect endChatroom into draining a dead turn. Retire with one
    // bounded wake — the moderator re-asks or moves on (mirror of the
    // barrier recovery: never wait for a reply that cannot arrive).
    if (serialAsks !== undefined) {
      const entries = restoreSerialAsks(serialAsks)
      for (const entry of entries) {
        const note = e.i18n.tf(Msg.ChatroomSerialAskRestarted, entry.roleName, entry.question)
        wakeChatroomModerator(e, key, note)
        console.info('chatroom: retired restored serial ask after restart'
          + ` (hub=${key} role=${entry.roleName} id=${entry.id})`)
      }
    }
  }
  e.sessions.save()
}

/** Validate a restored pendingSerialAsksData payload; malformed entries are dropped. */
function restoreSerialAsks(raw: unknown): SerialAskSnapshot[] {
  if (!Array.isArray(raw)) return []
  const out: SerialAskSnapshot[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'number' || typeof o.question !== 'string' || typeof o.armedAt !== 'number') continue
    if (typeof o.roleName !== 'string' || o.roleName === '') continue
    out.push({
      id: o.id,
      roleName: o.roleName,
      question: o.question,
      armedAt: o.armedAt,
      lastWakeAt: typeof o.lastWakeAt === 'number' ? o.lastWakeAt : 0,
      wakeCount: typeof o.wakeCount === 'number' ? o.wakeCount : 0,
    })
  }
  return out
}

/** Send a fresh terminal research progress card for a restart-closed round (the old handle died with the process). */
function sendRestartedProgressCard(e: Engine, p: Platform, hubKey: string, g: ChatroomGather): void {
  const cu = asCardSender(p)
  const r = asReplyContextReconstructor(p)
  if (cu === undefined || r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      const card = buildResearchProgressCard(e, g.collected.size, g.collected.size + g.expected.size, 'restarted')
      void cu.sendCard(hubRctx, card).catch((error: unknown) => {
        console.warn(`chatroom: restart progress card send failed: ${String(error)}`)
      })
    },
    (error: unknown) => {
      console.warn(`chatroom: reconstruct hub ctx for restart card failed (hub=${hubKey}): ${String(error)}`)
    },
  )
}

/** The session key of the chatroom role with the given name under hubKey, or ''.
 *
 * @param e - Engine carrying the session registry.
 * @param hubKey - Session key of the chatroom hub to search under.
 * @param roleName - The chatroom role name to look up.
 * @returns The role's session key, or '' when no such role exists.
 */
export function findRoleKeyByName(e: Engine, hubKey: string, roleName: string): string {
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (chatroomState(sess).chatroomHubKey !== '' && chatroomState(sess).chatroomRoleName === roleName) {
      return childKey
    }
  }
  return ''
}

// ── note ──────────────────────────────────────────────────────────────────

/**
 * Update the ledger's synthesis (or subproblems) section with the
 * moderator's running synthesis (Go NoteChatroom).
 *
 * @param e - Engine carrying the moderator-dir configuration.
 * @param hubKey - Session key of the chatroom hub whose ledger is updated.
 * @param section - Ledger section to write: 'synthesis' (default) or 'subproblems'.
 * @param text - The synthesis/subproblems text; empty is rejected.
 */
export async function noteChatroom(e: Engine, hubKey: string, section: string, text: string): Promise<void> {
  text = text.trim()
  if (text === '') throw new Error('chatroom: note text is required')
  section = section.trim()
  if (section === '') section = 'synthesis'
  const lp = chatroomLedgerDirFor(e, hubKey)
  if (lp === undefined) {
    throw new Error('chatroom: ledger not available (moderator dir not configured)')
  }
  if (section === 'synthesis') {
    await updateChatroomLedgerSynthesis(lp, text)
  } else if (section === 'subproblems') {
    await updateChatroomSubproblems(lp, text)
  } else if (section === 'report') {
    await updateChatroomReport(lp, text)
  } else {
    throw new Error(`chatroom: note: unknown section "${section}" (want synthesis|subproblems|report)`)
  }
  console.info(`chatroom: moderator updated ledger (hub=${hubKey} section=${section})`)
}

// ── cross-chatroom sharing ─────────────────────────────────────────────────

/** A resolved inherit target: the prior's pointer plus its recorded cast. */
export interface ChatroomInheritTarget extends ChatroomLedgerPrior {
  /** The prior chatroom's recorded roles — the default cast for a continuation. */
  roles: string[]
}

/**
 * Resolve a `--continue`/`inherit` reference against the engine's moderator
 * dir: the matched prior chatroom's topic, ledger dir, and recorded cast,
 * for {@link startChatroom} to seed the new ledger's prior-context pointer.
 *
 * @param e - Engine carrying the moderator-dir configuration and i18n surface.
 * @param ref - Ledger dir name or topic substring; '' means the newest chatroom.
 * @returns the prior chatroom's topic, ledger directory, and roles.
 * @throws When the ledger is off (no moderator dir) or the reference matches nothing.
 */
export function resolveChatroomInheritPrior(e: Engine, ref: string): ChatroomInheritTarget {
  const mod = chatroomConfig(e).moderatorDir()
  if (!mod.ok) throw new Error(e.i18n.t(Msg.ChatroomContinueNoLedger))
  const entry = resolveChatroomInherit(join(mod.dir, 'ledgers'), ref)
  if (entry === undefined) {
    const recent = listChatroomLedgers(join(mod.dir, 'ledgers'), 5).map(l => l.header.topic).join('、')
    throw new Error(e.i18n.tf(Msg.ChatroomContinueNoMatch, ref, recent === '' ? e.i18n.t(Msg.ChatroomHistoryEmpty) : recent))
  }
  return { topic: entry.header.topic, dir: entry.dir, roles: entry.header.roles }
}

// ── research flags / venv ─────────────────────────────────────────────────

/** Reset all research-mode fields on a hub session (Go clearChatroomResearchFlags).
 *
 * @param hub - The hub session whose research flags are reset.
 */
export function clearChatroomResearchFlags(hub: Session): void {
  chatroomState(hub).chatroomResearch = false
  chatroomState(hub).chatroomResearchMode = ''
  chatroomState(hub).researchAssistantKey = ''
}

/**
 * The shared workdir for research-mode assistant subgroups: the configured
 * workspace, else <projectDataDir>/chatroom-research (derived from the
 * sessions store path), else ''. The old <moderatorDir>/research default is
 * gone on purpose: a workspace under the moderator home put the moderator
 * persona on every assistant's cwd-ancestor instruction-discovery chain —
 * the "never pip install" contract contradicted the assistants' own job —
 * and suppression was the blunt fix for what was a placement bug.
 *
 * @param e - Engine carrying the workspace configuration and session store.
 * @returns The shared research workdir, or '' when nothing is configured.
 */
export function chatroomResearchWorkspace(e: Engine): string {
  const ws = chatroomConfig(e).researchWorkspaceCfg.trim()
  if (ws !== '') return ws
  const store = e.sessions.storePath()
  if (store !== '') return join(dirname(store), 'chatroom-research')
  return ''
}

/**
 * Process-level uv hooks so tests can simulate uv being absent (or stub the
 * slow install) without mangling PATH for other tests (Go package vars). The
 * `exec` hook routes createVenv/pipInstall through one overridable seam so a
 * test can observe the real argument lists.
 */
export const uvHooks = {
  /** The execFile promise both uv hooks run through (overridable in tests). */
  exec: execFileP as (file: string, args: readonly string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>,
  /** Resolve the uv binary (execFile rejects when not on PATH). */
  lookupPath: (): Promise<string> => uvHooks.exec('uv', ['--version'], { timeout: 10_000 }).then(() => 'uv'),
  /** Create the venv (<ws>/.venv) via `uv venv --seed` (seed = ship pip, so `-m pip` works on day one). */
  createVenv: (uvPath: string, venv: string): Promise<void> =>
    uvHooks.exec(uvPath, ['venv', '--seed', venv], { timeout: 30_000 }).then(() => undefined),
  /** Install the given packages into <venv>. */
  pipInstall: (uvPath: string, venv: string, packages: readonly string[]): Promise<void> =>
    uvHooks.exec(uvPath, ['pip', 'install', '--quiet', ...packages],
      { timeout: 300_000, env: { ...process.env, VIRTUAL_ENV: venv } }).then(() => undefined),
}

/** The in-venv marker recording which configured base packages are installed. */
const basePackagesMarker = '.dsh-base-packages.txt'

/** Read the installed-base marker inside a venv; unreadable counts as none installed. */
function readBasePackages(venv: string): string[] {
  try {
    return readFileSync(join(venv, basePackagesMarker), 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '')
  } catch {
    return []
  }
}

/** Write the installed-base marker inside a venv (one package per line). */
function writeBasePackages(venv: string, packages: readonly string[]): void {
  writeFileSync(join(venv, basePackagesMarker), `${packages.join('\n')}\n`, 'utf8')
}

/** Serializes shared-venv creation across concurrent chatrooms (Go researchVenvMu). */
let researchVenvChain: Promise<unknown> = Promise.resolve()

/**
 * Pre-provision the shared uv venv at <ws>/.venv for research-mode
 * assistants and return its absolute path (Go ensureResearchPythonEnv).
 * ('', undefined) when the feature switch is off; ('', Error) when uv is
 * unavailable or creation fails — /chatroom --research gates startup on it.
 * Idempotent: an existing .venv is reused, reconciled against the configured
 * base-package list — only packages missing from the in-venv marker are
 * installed, so a later config extension warm-upgrades a live venv without
 * touching packages assistants installed themselves. Each success outcome
 * logs one console.log line (created / delta-installed / reused as-is) so
 * journald can prove the reconcile ran. (A corrupted venv:
 * delete <ws>/.venv to force a rebuild.)
 *
 * @param e - Engine carrying the research-python-env switch and package list.
 * @param ws - The shared research workspace directory; empty rejects.
 * @returns The venv's absolute path, undefined when the switch is off; rejects when creation fails.
 */
export function ensureResearchPythonEnv(e: Engine, ws: string): Promise<string | undefined> {
  if (!chatroomConfig(e).researchPythonEnv) return Promise.resolve(undefined)
  const workspace = ws.trim()
  if (workspace === '') {
    return Promise.reject(new Error('chatroom: research workspace not configured'))
  }
  const packages = chatroomConfig(e).researchVenvPackages()
  const run = researchVenvChain.then(async (): Promise<string | undefined> => {
    try {
      mkdirSync(workspace, { recursive: true })
    } catch (error) {
      throw new Error(`chatroom: research workspace mkdir: ${String(error instanceof Error ? error.message : error)}`)
    }
    let uvPath: string
    try {
      uvPath = await uvHooks.lookupPath()
    } catch {
      throw new Error('chatroom: uv not found on PATH (install uv to enable research mode)')
    }
    const venv = join(workspace, '.venv')
    // Reuse an existing venv; --clear would wipe packages a prior assistant
    // installed. Instead reconcile: install exactly the configured base
    // packages the marker does not record yet.
    let existed = true
    try {
      statSync(venv)
    } catch {
      existed = false
    }
    if (existed) {
      const installed = readBasePackages(venv)
      const missing = packages.filter(p => !installed.includes(p))
      if (missing.length > 0) {
        try {
          await uvHooks.pipInstall(uvPath, venv, missing)
        } catch (error) {
          // The venv predates this call and keeps its value: no teardown,
          // the next startup retries the delta.
          throw new Error(`chatroom: research venv base-package install failed: ${String(error instanceof Error ? error.message : error)}`)
        }
        writeBasePackages(venv, [...new Set([...installed, ...missing])])
        console.log(`chatroom: research venv delta-installed (${missing.join(', ')}, venv=${venv})`)
      } else {
        console.log(`chatroom: research venv reused as-is (${installed.length} base packages recorded, venv=${venv})`)
      }
      return venv
    }
    try {
      await uvHooks.createVenv(uvPath, venv)
    } catch (error) {
      throw new Error(`chatroom: uv venv failed: ${String(error instanceof Error ? error.message : error)}`)
    }
    // Install base data deps once, at creation time. On failure remove the
    // half-created venv so the next startup retries instead of reusing a
    // package-less venv.
    try {
      await uvHooks.pipInstall(uvPath, venv, packages)
    } catch (error) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {
        // Removal failure is non-fatal; the next startup retries creation.
      }
      throw new Error(`chatroom: research venv deps install failed: ${String(error instanceof Error ? error.message : error)}`)
    }
    writeBasePackages(venv, packages)
    console.log(`chatroom: research venv created (${packages.length} base packages, venv=${venv})`)
    return venv
  })
  researchVenvChain = run.catch(() => undefined)
  return run
}

// ── research-manual ask auto-default ──────────────────────────────────────

/**
 * Arm the whole-ask auto-default for a research-manual ask card (feature
 * #57): only a research chatroom hub in manual mode is affected. One timer
 * covers the ENTIRE card — on fire, every unanswered question defaults to
 * its first option while already-collected answers are kept, and the ask
 * settles once through the same settle path as a real user answer.
 *
 * @param e - Engine carrying the session registry and i18n surface.
 * @param p - Platform the pending card was posted on.
 * @param sessionKey - Session key of the moderator hub that issued the card.
 * @param replyCtx - Reply context for the timeout notice message.
 * @param pending - The parked questions ask the timer guards.
 */
export function armResearchManualAskTimeout(
  e: Engine,
  p: Platform,
  sessionKey: string,
  replyCtx: unknown,
  pending: PendingAsk,
): void {
  const sess = e.sessions.findActive(sessionKey)
  if (sess === undefined || !chatroomState(sess).chatroomModerator || !chatroomState(sess).chatroomResearch
    || chatroomState(sess).chatroomResearchMode !== 'manual') {
    return
  }
  if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
  const timer = setTimeout(() => {
    // settlePendingAskDefaults no-ops once the user resolved (the engine's
    // settle clears the parked ask first), so a late fire cannot
    // double-settle — the notice only rides an actual default settlement.
    if (e.settlePendingAskDefaults(sessionKey)) {
      console.info(`chatroom: research manual ask timed out; applying default answers (session=${sessionKey})`)
      void e.reply(p, replyCtx, e.i18n.t(Msg.ChatroomResearchAskTimeout))
    }
  }, chatroomResearchManualAskTimeout.ms)
  pending.autoTimer = timer
  timer.unref()
}
