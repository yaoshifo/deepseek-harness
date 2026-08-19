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
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Engine, InteractiveState } from './engine.js'
import type { Session } from './session.js'
import { emptyMessage, jumpButtonsMarkdown, parentJumpButtons } from './engine.js'
import { chatroomHubGroupName, maxGroupNameRunes } from './groupname.js'
import type { Message, PendingPermission, Platform } from '../core/types.js'
import { asCardSender, asCardSenderWithUpdate, asReplyContextReconstructor } from '../core/types.js'
import { newCard } from '../card.js'
import type { Card } from '../card.js'
import {
  MsgChatroomAskHeader,
  MsgChatroomAskNotInRoom,
  MsgChatroomGatherAskHumanBlocked,
  MsgChatroomGatherHeader,
  MsgChatroomGatherTimeout,
  MsgChatroomGatherTimedOutDispatched,
  MsgChatroomGatherTimedOutIdle,
  MsgChatroomGatherTimedOutInFlight,
  MsgChatroomNoRoles,
  MsgChatroomPendingBody,
  MsgChatroomPendingHeader,
  MsgChatroomReminder,
  MsgChatroomResearchProgressBody,
  MsgChatroomResearchProgressDone,
  MsgChatroomResearchProgressTimedOut,
  MsgChatroomResearchProgressTimedOutTitle,
  MsgChatroomResearchProgressTitle,
  MsgChatroomRoleNotFound,
  MsgChatroomRoleReplyHeader,
} from '../i18n/keys.js'
import {
  appendChatroomLedger,
  chatroomLedgerDir,
  initChatroomLedger,
  updateChatroomLedgerSynthesis,
  updateChatroomSubproblems,
} from './chatroom-ledger.js'
import { listRoleNames, roleDir, roleExists } from './chatroom-roles.js'
import { cleanupOneChat } from './commands.js'

const execFileP = promisify(execFile)

/** Default cap on role agents per chatroom (bounds token cost; Go defaultMaxChatroomRoles). */
export const defaultMaxChatroomRoles = 5

/** Default gather barrier fallback timeout: 20 minutes (Go defaultChatroomGatherTimeout). */
export const defaultChatroomGatherTimeout = 20 * 60 * 1000

/** Default research-mode gather round timeout: 60 minutes (Go defaultChatroomResearchTimeout). */
export const defaultChatroomResearchTimeout = 60 * 60 * 1000

/** Default auto-mode research iteration cap (Go defaultMaxChatroomResearchRounds). */
export const defaultMaxChatroomResearchRounds = 3

/** Research config ranges (Go constants, mirrored from config). */
export const minChatroomResearchTimeout = 60 * 1000
export const maxChatroomResearchTimeout = 24 * 60 * 60 * 1000
export const minChatroomResearchRounds = 1
export const maxChatroomResearchRounds = 20

/** How long a research-manual AskUserQuestion card waits before answering itself (Go var). */
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

/**
 * The in-memory fan-in barrier for a parallel gather (Go chatroomGather):
 * the moderator broadcasts one question to every role and the engine
 * accumulates replies, waking the moderator EXACTLY ONCE (all roles replied
 * or the timeout fired). Held on the hub Session as pendingGather; never
 * persisted.
 */
export class ChatroomGather {
  readonly question: string
  readonly seq: number
  readonly expected = new Set<string>()
  readonly collected = new Map<string, string>()
  /** Fallback wake timer; stopped on early completion. */
  timer: ReturnType<typeof setTimeout> | undefined
  private woken = false
  /** Research progress-card handle (research gathers only). */
  progressHandle: unknown

  constructor(question: string, seq: number) {
    this.question = question
    this.seq = seq
  }

  /**
   * Record a role's reply. done=true means this call completed the barrier
   * (or the timeout already did) — the caller owns the wake and MUST deliver
   * wakeContent to the moderator. An empty/silent reply still counts as
   * "replied" so a NO_REPLY role does not stall the barrier.
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

  /** Timer-side completion; done=false when replies already completed the barrier. */
  timeoutFire(): { done: boolean; wake: string; missing: string[] } {
    if (this.woken) return { done: false, wake: '', missing: [] }
    this.woken = true
    const wake = this.summary()
    const missing = [...this.expected].sort()
    return { done: true, wake, missing }
  }

  stopTimer(): void {
    stopFallbackTimer(this.timer, (t: ReturnType<typeof setTimeout> | undefined) => { this.timer = t })
  }

  /** The wake message: broadcast question + each role's reply, role-tagged. */
  summary(): string {
    const lines: string[] = []
    lines.push('[并行收集完成]\n')
    lines.push('主持人发出的问题：\n')
    lines.push(this.question)
    lines.push('\n\n各角色回复：\n')
    for (const n of [...this.collected.keys()].sort()) {
      const r = this.collected.get(n) ?? ''
      lines.push(`【${n}】${r === '' ? '（NO_REPLY / 无追问）' : r}\n`)
    }
    lines.push('\n请基于以上回复，按你当前所处阶段推进：若在澄清阶段，去重合并后用原生 AskUserQuestion(MultiSelect) 向用户发飞书多选卡提问（若全部「无需追问」则进入阶段 2；否则 note 用户回答后再次 gather，最多 3 轮）；若在拆解阶段，去重合并成子问题列表后用 note（section: subproblems）写入。')
    return lines.join('')
  }
}

/**
 * The soft end barrier (Go chatroomEndBarrier): when the moderator ends the
 * chatroom while roles are in-flight, accumulates their final replies before
 * teardown so none are silently dropped. Same one-shot-wake discipline.
 */
export class ChatroomEndBarrier {
  readonly expected = new Set<string>()
  readonly collected = new Map<string, string>()
  timer: ReturnType<typeof setTimeout> | undefined
  private woken = false

  /**
   * Record a role's final reply; done=true means this was the last expected
   * reply — the caller finalizes the chatroom and wakes the moderator once
   * with the summary.
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

  /** The closing summary (Go summarizeEndLocked). */
  summarizeEnd(): string {
    const lines: string[] = []
    lines.push('[聊天室收尾完成]\n')
    lines.push('各角色末轮回复：\n')
    for (const n of [...this.collected.keys()].sort()) {
      let r = this.collected.get(n) ?? ''
      if (r === '') r = '（NO_REPLY / 无发言）'
      else {
        const runes = Array.from(r)
        if (runes.length > 200) r = `${runes.slice(0, 200).join('')}…`
      }
      lines.push(`【${n}】${r}\n`)
    }
    lines.push('\n请基于以上末轮回复 + 账本（RECORD.md）给出收尾总结。')
    return lines.join('')
  }

  /** Snapshot of outstanding role names (unordered). */
  expectedSnapshot(): string[] {
    return [...this.expected]
  }

  /** Outstanding role names, sorted (for display). */
  expectedRemaining(): string[] {
    return [...this.expected].sort()
  }

  /** Drop a role from the outstanding set (it relayed via the normal path). */
  forgetExpected(roleName: string): void {
    this.expected.delete(roleName)
  }
}

// ── group naming ──────────────────────────────────────────────────────────

/** Role group display name: 「聊天室·<role>」, truncated to the rune ceiling. */
export function chatroomGroupName(role: string): string {
  let name = `聊天室·${role}`
  if (Array.from(name).length > maxGroupNameRunes) {
    name = `${Array.from(name).slice(0, maxGroupNameRunes - 3).join('')}...`
  }
  return name
}

/** Re-exported for the command module (Go chatroomHubGroupName). */
export { chatroomHubGroupName }

/** Research assistant subgroup display name: 「聊天室·助手·<role>」. */
export function chatroomAssistantGroupName(roleName: string): string {
  const name = `聊天室·助手·${roleName}`
  if (Array.from(name).length <= maxGroupNameRunes) return name
  // Keep the prefix, truncate the role-name tail.
  const prefix = '聊天室·助手·'
  const remaining = Math.max(0, maxGroupNameRunes - Array.from(prefix).length - 3)
  const r = Array.from(roleName)
  return `${prefix}${r.slice(0, remaining).join('')}...`
}

// ── roles listing / resolution ────────────────────────────────────────────

/** The ledger directory for a chatroom hub, or undefined when the ledger is off. */
export function chatroomLedgerDirFor(e: Engine, hubKey: string): string | undefined {
  const dir = e.chatroomModeratorDir().dir
  if (dir === '') return undefined
  return chatroomLedgerDir(dir, hubKey)
}

/** The roles in a chatroom (sessions whose chatroomHubKey matches). */
export function listChatroomRoles(e: Engine, hubKey: string): ChatroomRole[] {
  const { idToKey } = e.sessions.sessionKeyMap()
  const out: ChatroomRole[] = []
  for (const s of e.sessions.allSessions()) {
    if (s.getChatroomHubKey() !== hubKey) continue
    const k = idToKey[s.id] ?? ''
    if (k === '') continue
    out.push({
      name: s.getChatroomRoleName(),
      sessionKey: k,
      dir: e.perChatWorkDir(e.dirOverrideKey(k)),
    })
  }
  return out
}

/**
 * Resolve a role reference — a session key or a role name within the
 * chatroom — to the role's session key. Never creates sessions.
 */
export function resolveChatroomRole(e: Engine, hubKey: string, ref: string): string {
  const trimmed = ref.trim()
  if (trimmed === '') throw new Error('chatroom: role reference is required')
  const { idToKey } = e.sessions.sessionKeyMap()
  for (const s of e.sessions.allSessions()) {
    if (s.getChatroomHubKey() !== hubKey) continue
    const k = idToKey[s.id] ?? ''
    if (k === '') continue
    if (k === trimmed || (s.getChatroomRoleName() !== '' && s.getChatroomRoleName() === trimmed)) {
      return k
    }
  }
  throw new Error(e.i18n.tf(MsgChatroomRoleNotFound, trimmed))
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
 */
export async function startChatroom(
  e: Engine, hubSessionKey: string, roleNames: string[] | undefined, topic: string,
): Promise<ChatroomRole[]> {
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no group-capable platform available')
  const spawner = groupSpawnerOf(p)
  if (spawner === undefined) {
    throw new Error(`chatroom: platform "${p.name()}" cannot spawn groups`)
  }
  topic = topic.trim()
  if (topic === '') throw new Error('chatroom: topic is required')
  const rolesDir = e.chatroomRolesDir()
  let names = roleNames ?? []
  if (names.length === 0) {
    // No roles specified → default to every role under the roles dir
    // (single source of truth shared by the command and the tool surface).
    names = [...listRoleNames(rolesDir)].sort()
    if (names.length === 0) {
      throw new Error(e.i18n.tf('chatroom_no_roles_configured', rolesDir))
    }
  }
  if (names.length > e.maxChatroomRoles()) {
    throw new Error(`chatroom: too many roles (${names.length} > max ${e.maxChatroomRoles()})`)
  }
  // Validate all roles up front (fail fast → no partial spawn with orphans).
  for (const name of names) {
    if (!roleExists(rolesDir, name)) {
      throw new Error(e.i18n.tf('chatroom_unknown_role', name, name))
    }
  }

  const parent = e.sessions.getOrCreateActive(hubSessionKey)
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
    ns.setChatroomHubKey(hubSessionKey)
    ns.setChatroomRoleName(name)
    ns.setName(groupName)
    ns.setParentChatName(hubLabel)
    if (userID !== '') ns.setSpawnUserID(userID)
    e.sessions.save()

    // Ready card in the role group (mirrors cmdSpawn).
    const cs = asCardSender(p)
    if (cs !== undefined) {
      const note = `${name} · ${dir}\n${e.i18n.t('chatroom_topic_label')} ${topic}`
      const jumpMD = jumpButtonsMarkdown(parentJumpButtons(hubSessionKey, hubLabel, p))
      const card = e.buildSpawnNotifyCard(dir, e.i18n.t('chatroom_ready'), note, jumpMD)
      void cs.sendCard(syntheticMsg.replyCtx, card).catch((error: unknown) => {
        console.warn(`chatroom: ready card send failed (role=${name}): ${String(error)}`)
      })
    }
    out.push({ name, sessionKey: syntheticMsg.sessionKey, dir })
  }
  const ledgerDir = chatroomLedgerDirFor(e, hubSessionKey)
  if (ledgerDir !== undefined) {
    void initChatroomLedger(ledgerDir, topic, names).catch((error: unknown) => {
      console.warn(`chatroom: ledger init failed (${ledgerDir}): ${String(error)}`)
    })
  }
  console.info(`chatroom: started (hub=${hubSessionKey} roles=${names.join(',')} topic=${topic})`)
  return out
}

// ── asking / gathering ────────────────────────────────────────────────────

/**
 * Post the moderator's question to a role's group (visible card) and inject
 * it into the role session as a new turn, re-arming the one-shot relay.
 * Non-blocking. The role is addressed by name or session key.
 */
export async function askRole(e: Engine, callerHubKey: string, roleRef: string, question: string): Promise<void> {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  if (e.sessions.getOrCreateActive(callerHubKey).getPendingEndBarrier() !== undefined) {
    throw new Error('chatroom: 正在收尾中，无法 ask')
  }
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const roleKey = resolveChatroomRole(e, callerHubKey, roleRef)
  const role = e.sessions.getOrCreateActive(roleKey)
  if (role.getChatroomHubKey() !== callerHubKey) {
    throw new Error(e.i18n.t(MsgChatroomAskNotInRoom))
  }
  const roleName = role.getChatroomRoleName()
  await askRoleInternal(e, p, callerHubKey, roleKey, roleName, q, e.i18n.tf(MsgChatroomAskHeader, roleName), 0, false)
  console.info(`chatroom: moderator asked role (hub=${callerHubKey} role=${roleKey})`)
}

/**
 * The shared "post question card to the role group + inject the question as
 * a new role turn + re-arm the one-shot relay" path (Go askRoleInternal).
 * askSeq is the gather round stamp; 0 for serial asks. awaitAssistant arms
 * the research dispatch-defer at turn start.
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

  // Re-arm the one-shot relay so this role's next reply forwards to the
  // hub. Mark in-flight so endChatroom can detect a generating role.
  const role = e.sessions.getOrCreateActive(roleKey)
  role.setChatroomAsked(false)
  role.setChatroomInFlight(true)
  // Research mode: new round — clear the previous round's sticky dispatch
  // flag. ResearchAwaitingAssistant arms at turn start.
  if (e.sessions.getOrCreateActive(hubKey).getChatroomResearch()) {
    role.setResearchDispatched(false)
  }
  e.sessions.save()

  void e.sendAsCard(p, roleRctx, question, { title: headerTitle, color: 'blue' })

  let roleContent = `[主持] ${question}`
  const lp = chatroomLedgerDirFor(e, hubKey)
  if (lp !== undefined) {
    roleContent += `\n\n（完整上下文见账本目录：${lp}；SYNTHESIS.md/SUBPROBLEMS.md/RECORD.md，回答前先读）`
  }
  const roleMsg: Message = {
    ...emptyMessage(),
    sessionKey: roleKey,
    platform: p.name(),
    userName: '[主持]',
    content: roleContent,
    replyCtx: roleRctx,
    chatroomAskSeq: askSeq,
    chatroomAwaitAssistant: awaitAssistant,
  }
  try {
    e.receiveMessage(p, roleMsg)
  } catch (error) {
    console.error(`engine: receive-message failed (${roleKey}): ${String(error)}`)
  }
}

/**
 * GatherRoles broadcasts the SAME question to every role at once (each in its
 * own group) and sets up a barrier on the hub so the moderator is woken
 * EXACTLY ONCE with all replies collected. Non-blocking.
 */
export function gatherRoles(e: Engine, hubKey: string, question: string, research: boolean): void {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  if (e.sessions.getOrCreateActive(hubKey).getPendingEndBarrier() !== undefined) {
    throw new Error('chatroom: 正在收尾中，无法 gather')
  }
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const roles = listChatroomRoles(e, hubKey)
  if (roles.length === 0) throw new Error(e.i18n.t(MsgChatroomNoRoles))

  // Set up the fan-in barrier BEFORE broadcasting so the first role reply
  // can't race ahead and find no pendingGather.
  const hub = e.sessions.getOrCreateActive(hubKey)
  const seq = hub.getChatroomGatherSeq() + 1
  hub.setChatroomGatherSeq(seq)
  const g = new ChatroomGather(q, seq)
  for (const r of roles) g.expected.add(r.name)
  hub.setPendingGather(g)
  e.sessions.save()

  // Research round tracking: increment the counter and enforce the auto-mode
  // hard cap. Manual mode is uncapped (the user decides).
  if (research) {
    const round = hub.getChatroomResearchRound() + 1
    hub.setChatroomResearchRound(round)
    e.sessions.save()
    const mode = hub.getChatroomResearchMode()
    if (mode === 'auto' || mode === '') {
      let cap = e.maxChatroomResearchRoundsValue()
      const override = hub.getChatroomResearchMaxRounds()
      if (override > 0) cap = override
      if (round > cap) {
        throw new Error(`chatroom: research 已达自动模式上限 ${cap} 轮，请用 note 写最终综合后 end 收尾（或切 --mode manual 手动继续）`)
      }
    }
  }

  // Fallback timer: wake the moderator with partial results if a role stalls.
  const gatherTimeout = research
    ? e.chatroomResearchTimeoutDuration()
    : e.chatroomGatherTimeoutDuration()
  g.timer = setTimeout(() => { fireGatherTimeout(e, hubKey) }, gatherTimeout)
  g.timer.unref()

  // Broadcast the question to every role in parallel. The prefix is generic;
  // research mode uses a different prefix that encourages tool/assistant use.
  const roleQ = research
    ? `[并行研究] 本轮并行研究，各自独立、互不可见。用你的助手（feishu_bridge_subtask 工具 action: send）下数据、跑脚本、算关键指标，基于实证作答（默认不出图，用数值说话）。不要用 ask-human。研究任务如下：\n\n${q}`
    : `[并行收集] 本轮并行收集各角色独立判断，不要用 ask-human，按下面的问题作答。\n\n${q}`
  for (const r of roles) {
    void askRoleInternal(e, p, hubKey, r.sessionKey, r.name, roleQ, e.i18n.tf(MsgChatroomGatherHeader, r.name), g.seq, research)
      .catch((error: unknown) => {
        console.warn(`chatroom: gather broadcast to role failed (role=${r.name}): ${String(error)}`)
      })
  }
  // Research rounds run up to 60m: post a progress card so the user has a
  // live X/N view instead of silence.
  if (research) sendResearchProgressCard(e, p, hubKey, g)
  console.info(`chatroom: moderator gathered roles (hub=${hubKey} roles=${roles.length})`)
}

/** Timer callback: wake the moderator with whatever arrived (Go fireGatherTimeout). */
function fireGatherTimeout(e: Engine, hubKey: string): void {
  const hub = e.sessions.getOrCreateActive(hubKey)
  const g = hub.getPendingGather()
  if (g === undefined) return
  const { done, wake, missing } = g.timeoutFire()
  if (!done) return // already woken by the last reply
  hub.setPendingGather(undefined)
  e.sessions.save()
  const p = e.spawnCapablePlatform()
  if (p !== undefined) updateResearchProgressCard(e, p, g, 'timedout')
  const finalWake = missing.length > 0 ? buildGatherTimeoutWake(e, hubKey, missing, wake) : wake
  wakeChatroomModerator(e, hubKey, finalWake)
  console.info(`chatroom: gather timed out; woke moderator with partial replies (hub=${hubKey})`)
}

/** The research gather progress card; terminal is '' (X/N), 'done', or 'timedout'. */
export function buildResearchProgressCard(e: Engine, done: number, total: number, terminal: string): Card {
  let title = e.i18n.t(MsgChatroomResearchProgressTitle)
  let body = e.i18n.tf(MsgChatroomResearchProgressBody, done, total)
  if (terminal === 'done') {
    title = e.i18n.t(MsgChatroomResearchProgressDone)
  } else if (terminal === 'timedout') {
    title = e.i18n.t(MsgChatroomResearchProgressTimedOutTitle)
    body = e.i18n.tf(MsgChatroomResearchProgressTimedOut, done, total)
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

/** PATCH the research progress card to X/N (or a terminal state); no-op for plain gathers. */
function updateResearchProgressCard(e: Engine, p: Platform, g: ChatroomGather, terminal: string): void {
  const handle = g.progressHandle
  if (handle === undefined || handle === null) return
  const cu = asCardSenderWithUpdate(p)
  if (cu === undefined) return
  const done = g.collected.size
  const total = g.collected.size + g.expected.size
  const card = buildResearchProgressCard(e, done, total, terminal)
  void cu.updateCardWithHandle(handle, card).catch((error: unknown) => {
    console.warn(`chatroom: research progress card update failed: ${String(error)}`)
  })
}

/**
 * Prefix a partial-gather wake with the NAMED list of timed-out roles and
 * each role's state (dispatched assistant / in-flight / never started).
 */
export function buildGatherTimeoutWake(e: Engine, hubKey: string, missing: string[], base: string): string {
  const sts: string[] = []
  for (const name of missing) {
    let role: Session | undefined
    const rk = findRoleKeyByName(e, hubKey, name)
    if (rk !== '') role = e.sessions.getOrCreateActive(rk)
    if (role !== undefined && role.getResearchDispatched()) {
      sts.push(e.i18n.tf(MsgChatroomGatherTimedOutDispatched, name))
    } else if (role !== undefined && role.getChatroomInFlight()) {
      sts.push(e.i18n.tf(MsgChatroomGatherTimedOutInFlight, name))
    } else {
      sts.push(e.i18n.tf(MsgChatroomGatherTimedOutIdle, name))
    }
  }
  return `${e.i18n.tf(MsgChatroomGatherTimeout, missing.length, sts.join('、'))}\n\n${base}`
}

/**
 * Deliver a synthetic message to the hub session re-arming the moderator for
 * the next orchestration step (Go wakeChatroomModerator).
 */
export function wakeChatroomModerator(e: Engine, hubKey: string, content: string): void {
  const p = e.spawnCapablePlatform()
  if (p === undefined) return
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      const wake = `${content}\n\n${e.i18n.t(MsgChatroomReminder)}`
      try {
        e.receiveMessage(p, {
          ...emptyMessage(),
          sessionKey: hubKey,
          platform: p.name(),
          userName: '[聊天室]',
          content: wake,
          replyCtx: hubRctx,
        })
      } catch (error) {
        console.error(`engine: receive-message failed (${hubKey}): ${String(error)}`)
      }
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
 */
export async function askHuman(e: Engine, roleSessionKey: string, question: string): Promise<void> {
  const q = question.trim()
  if (q === '') throw new Error('chatroom: question is required')
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const role = e.sessions.getOrCreateActive(roleSessionKey)
  const hubKey = role.getChatroomHubKey()
  if (hubKey === '') {
    throw new Error(`chatroom: "${roleSessionKey}" is not a chatroom role session`)
  }
  let roleName = role.getChatroomRoleName()
  if (roleName === '') roleName = 'role'
  // Reject ask-human while a gather is in flight: the moderator collects
  // role questions centrally and asks the user once via a multi-select card.
  if (e.sessions.getOrCreateActive(hubKey).getPendingGather() !== undefined) {
    throw new Error(e.i18n.t(MsgChatroomGatherAskHumanBlocked))
  }
  const r = asReplyContextReconstructor(p)
  if (r === undefined) {
    throw new Error(`chatroom: platform "${p.name()}" cannot address the hub group`)
  }
  const hubRctx = await r.reconstructReplyCtx(hubKey)

  // Mark the hub pending — single slot (hub-and-spoke asks one role at a time).
  const hub = e.sessions.getOrCreateActive(hubKey)
  hub.setPendingHumanQuestionRole(roleName)
  e.sessions.save()

  const body = e.i18n.tf(MsgChatroomPendingBody, roleName, q, roleName)
  try {
    await e.sendAsCard(p, hubRctx, body, { title: e.i18n.tf(MsgChatroomPendingHeader, roleName), color: 'green' })
  } catch (error) {
    console.warn(`chatroom: pending-question card send failed (role=${roleName}): ${String(error)}`)
  }
  console.info(`chatroom: role asked human; discussion suspended (hub=${hubKey} role=${roleName})`)
}

/**
 * Route the human's reply to a pending ask-human question back to the asking
 * role (via askRole) and clear the pending flag. Returns true when the
 * message was consumed; slash commands pass through untouched.
 */
export function routePendingHumanReply(e: Engine, _p: Platform, hubKey: string, content: string): boolean {
  const roleName = e.sessions.getOrCreateActive(hubKey).getPendingHumanQuestionRole().trim()
  if (roleName === '') return false
  if (content.trim().startsWith('/')) return false
  // Clear first so a concurrent reply doesn't double-route; askRole re-arms
  // the role's relay gate.
  e.sessions.getOrCreateActive(hubKey).setPendingHumanQuestionRole('')
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
 * The deterministic turn-end hook for a chatroom role session: at the end of
 * each role turn it relays the reply to the hub as 【name】 AND wakes the
 * moderator. One-shot per ask (gated by chatroomAsked). Silent/empty replies
 * are skipped. Disjoint from maybeAutoReportSubtask (roles keep depth=0).
 *
 * All session/barrier state mutations run synchronously (Go's mutex-guarded
 * sequence); only the platform sends (relay card, ledger append, wake) ride
 * the async reply-context reconstruction.
 */
export function maybeAutoRelayRole(
  e: Engine,
  state: InteractiveState | undefined,
  session: Session,
  baseResponse: string,
  isSilent: boolean,
): void {
  if (session.getChatroomHubKey() === '' || session.getChatroomAsked()) return
  // Stale-turn guard: this turn was stamped with a PREVIOUS gather round at
  // its start. Judged BEFORE the awaiting defer so a stale turn can neither
  // consume nor re-defer the current round's ResearchAwaitingAssistant.
  let stale = false
  const b = e.sessions.getOrCreateActive(session.getChatroomHubKey()).getPendingGather()
  if (b !== undefined && session.getChatroomAskSeq() !== 0 && session.getChatroomAskSeq() !== b.seq) {
    stale = true
  }
  // Research mode: the role's first turn after a gather dispatches its
  // assistant and ends without a conclusion. Defer the relay only if the
  // turn ACTUALLY dispatched (researchDispatched); the dispatched flag stays
  // set — the gather timeout report reads it.
  if (!stale && session.getResearchAwaitingAssistant()) {
    if (session.getResearchDispatched()) {
      session.setResearchAwaitingAssistant(false)
      e.sessions.save()
      console.info(`chatroom: research role dispatched assistant; deferring relay to conclusion turn (role=${session.getChatroomRoleName()})`)
      return
    }
    // No dispatch happened this turn — this IS the conclusion.
    session.setResearchAwaitingAssistant(false)
    e.sessions.save()
  }
  if (state === undefined || state.platform === undefined) return
  const p = state.platform
  const hubKey = session.getChatroomHubKey()
  const r = asReplyContextReconstructor(p)
  if (r === undefined) return
  const roleName = session.getChatroomRoleName()
  const reply = baseResponse.trim()

  /**
   * Post the 【Role】 card to the hub and append the ledger. Shared by every
   * relay path (end barrier, gather fan-in, serial, stale). The in-flight
   * flag clears with the relay; the ledger write is serialized inside the
   * ledger module, so the flag ordering vs durability is weaker than Go's
   * synchronous append by one microtask.
   */
  const relayRoleReply = (hubRctx: unknown): void => {
    if (reply === '' || isSilent) return
    const content = `【${roleName}】${reply}`
    void e.sendAsCard(p, hubRctx, content, { title: e.i18n.tf(MsgChatroomRoleReplyHeader, roleName), color: 'green' })
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

  if (stale) {
    void r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => {
        relayRoleReply(hubRctx)
      },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    session.setChatroomInFlight(false)
    e.sessions.save()
    console.info(`chatroom: stale turn from previous gather round; relayed as free reply (role=${roleName} askSeq=${session.getChatroomAskSeq()} barrierSeq=${b?.seq ?? 0})`)
    return
  }

  // Always consume the one-shot gate at turn end — with or without a reply —
  // so a later turn on this role does not re-fire. Crucially, we wake the
  // moderator even on a silent/empty reply (NO_REPLY): without that, a role
  // that passes would leave the moderator idle forever and stall the
  // discussion.
  session.setChatroomAsked(true)
  e.sessions.save()

  // --- End barrier path (draining in-flight replies before teardown) ---
  const barrier = e.sessions.getOrCreateActive(hubKey).getPendingEndBarrier()
  if (barrier !== undefined) {
    void r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => { relayRoleReply(hubRctx) },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    session.setChatroomInFlight(false)
    const { done, summary } = barrier.accumulate(roleName, reply)
    if (done) {
      finalizeChatroomEndAsync(e, hubKey, summary)
      console.info(`chatroom: end barrier complete; finalizing (role=${roleName} hub=${hubKey})`)
    } else {
      console.info(`chatroom: gathered end reply (waiting for more) (role=${roleName} hub=${hubKey})`)
    }
    return
  }

  // --- Gather fan-in path (two-phase flow) ---
  const g = e.sessions.getOrCreateActive(hubKey).getPendingGather()
  if (g !== undefined) {
    void r.reconstructReplyCtx(hubKey).then(
      (hubRctx) => { relayRoleReply(hubRctx) },
      (error: unknown) => {
        console.warn(`chatroom: reconstruct hub ctx failed (hub=${hubKey}): ${String(error)}`)
      },
    )
    session.setChatroomInFlight(false)
    const { done, wakeContent } = g.accumulate(roleName, reply)
    if (!done) {
      updateResearchProgressCard(e, p, g, '')
      console.info(`chatroom: gathered role reply (waiting for more) (role=${roleName} hub=${hubKey})`)
      return
    }
    // Last reply in: flip the progress card to its terminal state, clear the
    // barrier and wake the moderator once.
    updateResearchProgressCard(e, p, g, 'done')
    e.sessions.getOrCreateActive(hubKey).setPendingGather(undefined)
    e.sessions.save()
    wakeChatroomModerator(e, hubKey, wakeContent)
    console.info(`chatroom: gather complete; woke moderator with all replies (hub=${hubKey})`)
    return
  }

  // --- Serial path (free-form roundtable) ---
  const reminder = e.i18n.t(MsgChatroomReminder)
  let wake: string
  if (reply !== '' && !isSilent) {
    wake = `[聊天室·${roleName} 发言]\n\n${reply}\n\n${reminder}`
    console.info(`chatroom: relayed role reply to hub (role=${roleName} hub=${hubKey})`)
  } else {
    wake = `[聊天室·${roleName} 本轮未发言（NO_REPLY）]\n\n${reminder}`
    console.info(`chatroom: role passed silently; woke moderator to continue (role=${roleName})`)
  }
  session.setChatroomInFlight(false)
  void r.reconstructReplyCtx(hubKey).then(
    (hubRctx) => {
      relayRoleReply(hubRctx)
      try {
        e.receiveMessage(p, {
          ...emptyMessage(),
          sessionKey: hubKey,
          platform: p.name(),
          userName: '[聊天室]',
          content: wake,
          replyCtx: hubRctx,
        })
      } catch (error) {
        console.error(`engine: receive-message failed (${hubKey}): ${String(error)}`)
      }
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
 */
export function endChatroom(e: Engine, hubKey: string): ChatroomEndResult {
  const p = e.spawnCapablePlatform()
  if (p === undefined) throw new Error('chatroom: no platform available')
  const hub = e.sessions.getOrCreateActive(hubKey)
  if (hub.getPendingGather() !== undefined) {
    throw new Error('chatroom: gather 进行中，等其完成再 end')
  }
  if (hub.getPendingEndBarrier() !== undefined) {
    throw new Error('chatroom: 正在收尾中')
  }

  // Phase A: collect in-flight role names without yet installing the barrier.
  const inFlightNames = new Set<string>()
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (sess.getChatroomHubKey() === '') continue
    if (sess.getChatroomInFlight()) inFlightNames.add(sess.getChatroomRoleName())
  }

  if (inFlightNames.size === 0) {
    const removed = finalizeChatroomEnd(e, hubKey)
    return { status: 'ended', inFlight: [], timeoutSecs: 0, rolesRemoved: removed }
  }

  // Phase B: atomically install the barrier with Expected already filled.
  const b = new ChatroomEndBarrier()
  for (const n of inFlightNames) b.expected.add(n)
  hub.setPendingEndBarrier(b)

  // Phase C: drop roles that already relayed via the normal path during the
  // Phase A→B window.
  for (const name of b.expectedSnapshot()) {
    const roleKey = findRoleKeyByName(e, hubKey, name)
    if (roleKey === '') continue
    if (!e.sessions.getOrCreateActive(roleKey).getChatroomInFlight()) {
      b.forgetExpected(name)
    }
  }
  const remaining = b.expectedRemaining()
  if (remaining.length === 0) {
    const removed = finalizeChatroomEnd(e, hubKey)
    return { status: 'ended', inFlight: [], timeoutSecs: 0, rolesRemoved: removed }
  }

  const timeout = e.chatroomEndTimeoutDuration()
  b.timer = setTimeout(() => { fireEndTimeout(e, hubKey) }, timeout)
  b.timer.unref()
  console.info(`chatroom: end pending; draining in-flight role replies (hub=${hubKey} inflight=${remaining.join(',')} timeoutMs=${timeout})`)
  return { status: 'pending', inFlight: remaining, timeoutSecs: Math.round(timeout / 1000), rolesRemoved: 0 }
}

/**
 * Tear down every chatroom role under the hub: stops each role session,
 * clears the chatroom marking, and drops the end barrier. The Session
 * records themselves are kept. Returns the number of roles removed.
 */
export function finalizeChatroomEnd(e: Engine, hubKey: string): number {
  const p = e.spawnCapablePlatform()
  if (p === undefined) return 0
  let removed = 0
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (sess.getChatroomHubKey() === '') {
      // Not a chatroom role. It may still be a research-mode role's
      // pre-spawned assistant (child of a role). Clean it up iff its parent
      // is a role in THIS chatroom; leave the hub's direct /spawn children
      // alone. collectSubtree is deepest-first, so the parent role's hub key
      // has not been cleared yet.
      const pk = sess.getParentSessionKey()
      if (pk === '') continue
      if (e.sessions.getOrCreateActive(pk).getChatroomHubKey() !== hubKey) continue
    }
    void cleanupOneChat(e, p, childKey, undefined, true)
    sess.setChatroomHubKey('')
    sess.setChatroomRoleName('')
    sess.setChatroomAsked(false)
    sess.setChatroomInFlight(false)
    sess.setResearchAssistantKey('')
    sess.setResearchAwaitingAssistant(false)
    sess.setResearchAssistant(false)
    removed++
  }
  const hub = e.sessions.getOrCreateActive(hubKey)
  hub.setPendingEndBarrier(undefined)
  // Hub returns to a normal session — drop the moderator flag so subsequent
  // turns use the default harness path.
  hub.setChatroomModerator(false)
  // Research flags live on the hub; without this a second research chatroom
  // in the same group inherits the previous round count.
  clearChatroomResearchFlags(hub)
  e.sessions.save()
  console.info(`chatroom: ended (hub=${hubKey} roles_removed=${removed})`)
  return removed
}

/** finalizeChatroomEnd + the closing-summary wake off the turn-end stack (Go finalizeChatroomEndAsync). */
export function finalizeChatroomEndAsync(e: Engine, hubKey: string, summary: string): void {
  void Promise.resolve().then(() => {
    finalizeChatroomEnd(e, hubKey)
    wakeChatroomModerator(e, hubKey, summary)
  })
}

/** End-barrier fallback: reconcile once more, then finalize with the partial set. */
function fireEndTimeout(e: Engine, hubKey: string): void {
  const hub = e.sessions.getOrCreateActive(hubKey)
  const b = hub.getPendingEndBarrier()
  if (b === undefined) return
  for (const name of b.expectedSnapshot()) {
    const roleKey = findRoleKeyByName(e, hubKey, name)
    if (roleKey === '') continue
    if (!e.sessions.getOrCreateActive(roleKey).getChatroomInFlight()) {
      b.forgetExpected(name)
    }
  }
  const { done, summary } = b.timeoutFire()
  if (!done) return // already finalized by the last reply
  finalizeChatroomEndAsync(e, hubKey, summary)
  console.info(`chatroom: end barrier timed out; finalizing with partial replies (hub=${hubKey})`)
}

/** The session key of the chatroom role with the given name under hubKey, or ''. */
export function findRoleKeyByName(e: Engine, hubKey: string, roleName: string): string {
  for (const childKey of e.collectSubtree(hubKey)) {
    const sess = e.sessions.getOrCreateActive(childKey)
    if (sess.getChatroomHubKey() !== '' && sess.getChatroomRoleName() === roleName) {
      return childKey
    }
  }
  return ''
}

// ── note ──────────────────────────────────────────────────────────────────

/**
 * Update the ledger's synthesis (or subproblems) section with the
 * moderator's running synthesis (Go NoteChatroom).
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
  } else {
    throw new Error(`chatroom: note: unknown section "${section}" (want synthesis|subproblems)`)
  }
  console.info(`chatroom: moderator updated ledger (hub=${hubKey} section=${section})`)
}

// ── research flags / venv ─────────────────────────────────────────────────

/** Reset all research-mode fields on a hub session (Go clearChatroomResearchFlags). */
export function clearChatroomResearchFlags(hub: Session): void {
  hub.setChatroomResearch(false)
  hub.setChatroomResearchMode('')
  hub.setChatroomResearchRound(0)
  hub.setChatroomResearchMaxRounds(0)
}

/**
 * The shared workdir for research-mode assistant subgroups: the configured
 * workspace, else <moderatorDir>/research, else '' (Go chatroomResearchWorkspace).
 */
export function chatroomResearchWorkspace(e: Engine): string {
  const ws = e.chatroomResearchWorkspaceCfg.trim()
  if (ws !== '') return ws
  const dir = e.chatroomModeratorDir().dir
  if (dir !== '') return join(dir, 'research')
  return ''
}

/**
 * Process-level uv hooks so tests can simulate uv being absent (or stub the
 * slow install) without mangling PATH for other tests (Go package vars).
 */
export const uvHooks = {
  /** Resolve the uv binary (execFile rejects when not on PATH). */
  lookupPath: (): Promise<string> => execFileP('uv', ['--version'], { timeout: 10_000 }).then(() => 'uv'),
  /** Create the venv (<ws>/.venv) via `uv venv`. */
  createVenv: (uvPath: string, venv: string): Promise<void> =>
    execFileP(uvPath, ['venv', venv], { timeout: 30_000 }).then(() => undefined),
  /** Install the base research data deps into <venv>. */
  pipInstall: (uvPath: string, venv: string): Promise<void> =>
    execFileP(uvPath, ['pip', 'install', '--quiet', 'akshare', 'pandas', 'numpy', 'requests'],
      { timeout: 180_000, env: { ...process.env, VIRTUAL_ENV: venv } }).then(() => undefined),
}

/** Serializes shared-venv creation across concurrent chatrooms (Go researchVenvMu). */
let researchVenvChain: Promise<unknown> = Promise.resolve()

/**
 * Pre-provision the shared uv venv at <ws>/.venv for research-mode
 * assistants and return its absolute path (Go ensureResearchPythonEnv).
 * ('', undefined) when the feature switch is off; ('', Error) when uv is
 * unavailable or creation fails — /chatroom --research gates startup on it.
 * Idempotent: an existing .venv is reused without re-installing.
 */
export function ensureResearchPythonEnv(e: Engine, ws: string): Promise<string | undefined> {
  if (!e.chatroomResearchPythonEnv) return Promise.resolve(undefined)
  const workspace = ws.trim()
  if (workspace === '') {
    return Promise.reject(new Error('chatroom: research workspace not configured'))
  }
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
    // installed. (A corrupted venv: delete <ws>/.venv to force a rebuild.)
    try {
      statSync(venv)
      return venv
    } catch {
      // fall through to creation
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
      await uvHooks.pipInstall(uvPath, venv)
    } catch (error) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {
        // Removal failure is non-fatal; the next startup retries creation.
      }
      throw new Error(`chatroom: research venv deps install failed: ${String(error instanceof Error ? error.message : error)}`)
    }
    return venv
  })
  researchVenvChain = run.catch(() => undefined)
  return run
}

// ── research-manual AskUserQuestion auto-default ──────────────────────────

/**
 * Arm the auto-default for a research-manual AskUserQuestion card (feature
 * #57): only a research chatroom hub in manual mode is affected. The timer
 * synthesizes a click on the first option and routes it through the SAME
 * handlePendingPermission path as a real user answer.
 */
export function armResearchManualAskTimeout(
  e: Engine,
  p: Platform,
  sessionKey: string,
  replyCtx: unknown,
  pending: PendingPermission,
  qIdx: number,
): void {
  const sess = e.sessions.findActive(sessionKey)
  if (sess === undefined || !sess.getChatroomModerator() || !sess.getChatroomResearch()
    || sess.getChatroomResearchMode() !== 'manual') {
    return
  }
  if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
  // Track resolution without touching the pending object's resolve closure:
  // the settled flag is what the timer polls (Go's select on Resolved).
  const settled = { done: false }
  void pending.resolved.then(() => {
    settled.done = true
    if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
  })
  const timer = setTimeout(() => {
    // The user answered in the meantime — don't double-resolve.
    if (settled.done) return
    if (pending.autoFired) return
    pending.autoFired = true
    console.info(`chatroom: research manual ask timed out; answering with default option (session=${sessionKey} questionIndex=${qIdx})`)
    void e.reply(p, replyCtx, e.i18n.t('chatroom_research_ask_timeout'))
    const synth = `askq:${qIdx}:1`
    e.handlePendingPermission(p, {
      ...emptyMessage(),
      sessionKey,
      platform: p.name(),
      content: synth,
      isAskqCardAction: true,
      replyCtx,
    }, synth)
  }, chatroomResearchManualAskTimeout.ms)
  pending.autoTimer = timer
  timer.unref()
}
