/**
 * Engine core ported from cc-connect core/engine.go + engine_events.go:
 * routes messages between platforms and the agent for one project. M1 keeps
 * the state shape (interactiveStates map, queued messages, idle/stall timers)
 * and the event loop's result/text/thinking basics; card/streaming surfaces,
 * the watchdog, the unsolicited reader, and multi-workspace arrive with the
 * milestones that port their tests (TODO(M2)/TODO(M3) markers below).
 *
 * Concurrency mapping (plan D7): goroutines become floating promises; Go's
 * select-over-channels becomes Promise.race over the EventChannel receive,
 * the stop signal, the send result, and a cancellable idle sleep re-created
 * each loop iteration (exactly Go's reset-after-event; tools pause it by not
 * arming the sleep while a tool call is in flight).
 *
 * @module dsh-feishu-bridge/engine
 */

import { I18n, langEnglish } from '../i18n/index.js'
import {
  MsgAgentProcessExited,
  MsgAskQuestionMulti,
  MsgAskQuestionTitle,
  MsgDoneReplyParentHeader,
  MsgError,
  MsgFailedToStartAgentSession,
  MsgMessageQueued,
  MsgPermissionDenied,
  MsgPermissionExpired,
  MsgPermissionHint,
  MsgPermissionPrompt,
  MsgPermBtnAllow,
  MsgPermBtnAllowAll,
  MsgPermBtnDeny,
  MsgPermCardBody,
  MsgPermCardTitle,
  MsgPermDenyReasonPlaceholder,
  MsgProcessing,
  MsgPreviousProcessing,
  MsgQueueFull,
  MsgSessionResumeDegraded,
  MsgSilentReply,
  MsgSpawnGroupReady,
  MsgStallRetry,
  MsgStallTimeout,
  MsgSubtaskChildBusy,
  MsgSubtaskDiffSummary,
  MsgSubtaskFollowupHeader,
  MsgSubtaskGatherNoPending,
  MsgSubtaskSendNotChild,
  MsgSubtaskTimeout,
  MsgToolResult,
  MsgTurnCompleted,
  MsgWorktreeCardTitle,
  MsgWorktreeCreateError,
  MsgWorktreeDirtyPrompt,
  MsgWorktreeKeepBtn,
  MsgWorktreeKept,
  MsgWorktreeMemoryWarn,
  MsgWorktreeOrphanCleaned,
  MsgWorktreeOrphanKept,
  MsgWorktreeRemoved,
  MsgWorktreeRemoveBtn,
  MsgWorktreeRemovedShort,
} from '../i18n/index.js'
import type { Language } from '../i18n/index.js'
import { AllowList } from '../feishu/allowlist.js'
import type {
  Agent,
  AgentSession,
  CardSender,
  Event,
  FileAttachment,
  ImageAttachment,
  InlineButtonSender,
  Message,
  PendingPermission,
  PermissionResult,
  Platform,
  UserQuestion,
} from '../core/types.js'
import {
  asCardSender,
  asCardRefresher,
  asChatJumpURLer,
  asCronReplyTargetResolver,
  asForkQuerierWithProvider,
  asForkSessionPreparer,
  asGroupIconAvatarSetter,
  asGroupRenamer,
  asGroupSpawner,
  asGroupSpawnerEx,
  asMessagePinAppender,
  asMessageReactionAdder,
  asProviderSwitcher,
  asReactionAdder,
  asReplyContextReconstructor,
  asSessionEnvInjector,
  asSessionModeInjector,
  asSpawnedChatActiveChecker,
  asSpawnedChatStateUpdater,
  asWorkDirSwitcher,
  asWorktreeOrphanResolver,
  ContinueSession,
  ErrNotSupported,
  ForkSessionPrefix,
  type GroupSpawnOptions,
} from '../core/types.js'
import {
  isAllowResponse,
  isApproveAllResponse,
  isDenyResponse,
  resolveAskQuestionAnswer as resolveAnswerHelper,
  buildAskQuestionResponse as buildAnswerHelper,
  shouldSurfaceUnsolicitedPermission as shouldSurfaceHelper,
  buildDenyMessage,
} from './permission.js'
import { CardButton, CardCheckOption, newCard, type Card, type CardHeader } from '../card.js'
import { Session, SessionManager } from './session.js'
import { childLabel, SubtaskGather } from './subtask.js'
import {
  createWorktree,
  gitDiffShortstat,
  memoryHasContent,
  parseWorktreeMode,
  removeOrphanMemory,
  removeWorktree,
  slugify,
  WorktreeMode,
  worktreeRepoRoot,
  type WorktreeCreateInfo,
} from './worktree.js'
import {
  chatroomHubGroupName,
  defaultGroupNamePrompt,
  fallbackGroupIcon,
  groupIconRecentMax,
  iconsPerCategory,
  maxGroupNameRunes,
  parseGroupIcon,
  sampleAcrossCategories,
  sanitizeGroupName,
  sessionExemptFromSpawnRename,
  truncateGroupName,
} from './groupname.js'
import { MaxPlatformMessageLen, splitMessage, stripTrailingSilent } from './message-split.js'
import { defaultStreamPreviewCfg, newStreamPreview, newToolProgressEntry, StreamPreview, type StreamPreviewCfg } from '../streaming.js'
import { newCompactProgressWriter, suppressStandaloneToolResultEvent, type CompactProgressWriter } from '../progress-compact.js'
import { newAsyncSender, type AsyncSender } from '../async-sender.js'
import { readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join as joinPath } from 'node:path'
import { asCompletionNotifier, asChatAvatarStateSwitcher, asChatroomFamilyAvatarSetter, asChatChangedNotifier, asChatRenamedNotifier } from '../core/types.js'
import { truncateStr, mutePlatform, type CronJob, type CronScheduler } from './cron.js'
import { executeCardAction } from './cron-commands.js'
import type { RelayManager } from './relay.js'

export { MaxPlatformMessageLen, splitMessage, stripTrailingSilent }

/** Default cap for queued messages per session (Go defaultMaxQueuedMessages). */
export const defaultMaxQueuedMessages = 5

/** Default rapid-fire queued-message merge window in ms (Go defaultDebounceInterval). */
export const defaultDebounceInterval = 600

const defaultThinkingMaxLen = 300

/** Default max plan content length before truncation (0 = no truncation, Go defaultPlanMaxLen). */
const defaultPlanMaxLen = 0

/** Default idle timeout before a silent turn is killed (Go defaultEventIdleTimeout = 10min). */
export const defaultEventIdleTimeout = 10 * 60 * 1000

/** Stall retries before the idle kill (Go defaultStallMaxRetries). */
const defaultStallMaxRetries = 1

/** Bounded wait for an agent session to close during cleanup (Go agentCloseTimeout). */
const agentCloseTimeout = 130_000

/** Attachment sends blocked by config (Go ErrAttachmentSendDisabled). */
export class ErrAttachmentSendDisabled extends Error {
  constructor() {
    super('attachment send is disabled by config')
    this.name = 'ErrAttachmentSendDisabled'
  }
}

/** How intermediate messages are surfaced (Go DisplayCfg). */
export interface DisplayCfg {
  thinkingMessages: boolean
  thinkingMaxLen: number
  toolMessages: boolean
  /** In quiet mode, drive one progress card from tool events (Go tool_progress). */
  toolProgress: boolean
  /** Max tool input preview length before truncation (Go ToolMaxLen). */
  toolMaxLen: number
  /** Max plan content length before truncation; 0 disables (Go PlanMaxLen). M3. */
  planMaxLen: number
}

/** A message queued while the session was busy (Go queuedMessage). */
export interface QueuedMessage {
  platform: Platform
  replyCtx: unknown
  messageID: string
  content: string
  images: ImageAttachment[]
  files: FileAttachment[]
  fromVoice: boolean
  isSpawnedGroup: boolean
  userID: string
  userName: string
  msgPlatform: string
  msgSessionKey: string
}

/**
 * A running interactive agent session and its turn state (Go interactiveState,
 * M1 subset). `closing` resolves when cleanup has fully torn the agent down so
 * a new turn for the same key waits instead of concurrently resuming the same
 * agent session id.
 */
export class InteractiveState {
  agentSession: AgentSession | undefined
  platform: Platform | undefined
  replyCtx: unknown
  agent: Agent | undefined
  sessionEnv: string[] = []
  closing: Promise<void> | undefined
  stopped = false
  userStopped = false
  pendingMessages: QueuedMessage[] = []
  inflightMessage: QueuedMessage | undefined
  sideText = ''
  eventsNeedResync = true
  effectiveMode = ''
  effectiveIdleTimeout = 0
  lastActivity = Date.now()
  activeTurns = 0
  lastEventAt = 0
  activeToolCalls = 0
  turnSeq = 0
  fromVoice = false
  lastPrompt = ''
  /** Whether a permission prompt is parked on this state (full object in M3). */
  permissionPending = false
  /** The pending permission/AskUserQuestion prompt (Go state.pending). M3. */
  pending: PendingPermission | undefined
  /** Auto-approve all subsequent permission requests (Go state.approveAll). M3. */
  approveAll = false
  /** Number of auto-compaction events this session (Go state.compactionCount). M3. */
  compactionCount = 0
  /** Per-state async sender serializing platform PATCHes (Go state.sender). */
  sender: AsyncSender | undefined
  /** The turn's active streaming preview (bound for bump routing). */
  preview: StreamPreview | undefined

  private stopWaiters: Array<() => void> = []

  /** The stop signal (Go stopCh): resolves once markStopped fires. */
  stopSignal(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => { this.stopWaiters.push(resolve) })
  }

  isStopped(): boolean {
    return this.stopped
  }

  isUserStopped(): boolean {
    return this.userStopped
  }

  /** Transition to stopped and wake stopSignal waiters (idempotent). */
  markStopped(): void {
    if (this.stopped) return
    this.stopped = true
    const waiters = this.stopWaiters
    this.stopWaiters = []
    for (const w of waiters) w()
  }

  touchActivity(): void {
    this.lastActivity = Date.now()
  }

  beginTurn(): void {
    this.activeTurns++
    this.touchActivity()
  }

  endTurn(): void {
    this.activeTurns--
    this.touchActivity()
  }

  /** Effective per-turn idle timeout, falling back to the engine default. */
  idleTimeout(fallback: number): number {
    if (this.effectiveIdleTimeout > 0) return this.effectiveIdleTimeout
    return fallback
  }
}

/** Cancellable sleep for the idle slot of the event-loop race. */
function cancellableSleep(ms: number): { promise: Promise<'idle'>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<'idle'>((resolve) => {
    timer = setTimeout(() => { resolve('idle') }, ms)
  })
  return {
    promise,
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

function plainSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Render an unknown send failure as a display string. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** The run title a cron reply-target resolver sees (Go cronRunTitle). */
function cronRunTitle(job: CronJob): string {
  const desc = job.description.trim()
  if (desc !== '') return truncateStr(desc, 60)
  if (job.prompt !== '') return truncateStr(job.prompt, 60)
  if (job.exec !== '') return truncateStr(job.exec, 60)
  return 'cron'
}

/**
 * The relay response when the wait aborted: partial text when any arrived,
 * otherwise the abort reason (Go relayPartialResponseOrError).
 */
function relayPartialResponseOrError(signal: AbortSignal, textParts: string[]): string {
  if (textParts.length === 0) {
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'relay: aborted'))
  }
  const resp = textParts.join('')
  console.warn(`relay: context done before final result; returning partial response (response_len ${resp.length})`)
  return resp
}

/** A promise that never resolves, typed as a never-matching race alternative. */
const neverPromise = new Promise<{ kind: 'never' }>((): void => {})

/** A bare NO_REPLY marker (case-insensitive, whitespace-padded). */
export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text)
}

/** Whether the trimmed text is still a case-insensitive prefix of NO_REPLY. */
export function couldBeSilentPrefix(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  return 'NO_REPLY'.startsWith(t.toUpperCase())
}

function isEllipsisOnly(text: string): boolean {
  const t = text.trim()
  return t === '...' || t === '…'
}

/** Channel ID from "platform:chatID[:userID]" (Go extractChannelID). */
export function extractChannelID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 2) return parts[1] ?? ''
  return ''
}

/** Strip the trailing user ID: "platform:channel:user" → "platform:channel". */
export function stripUserID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}`
  return sessionKey
}

/** Platform name prefix of a session key. */
export function extractPlatformName(sessionKey: string): string {
  const idx = sessionKey.indexOf(':')
  return idx > 0 ? sessionKey.slice(0, idx) : ''
}

/** Default cap on recursive subtask delegation (Go defaultSubtaskMaxDepth). */
export const defaultSubtaskMaxDepth = 3

/** Default gather barrier fallback timeout: 20 minutes (Go defaultSubtaskGatherTimeout). */
export const defaultSubtaskGatherTimeout = 20 * 60 * 1000

/** A markdown card element body without the discriminator (buildSpawnNotifyCard input). */
interface CardMarkdownLike {
  content: string
}

/** A fully-empty Message template for synthetic injections (Go &Message{}). */
function emptyMessage(): Message {
  return {
    sessionKey: '',
    platform: '',
    messageID: '',
    userID: '',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: undefined,
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    isCardAction: false,
    parentMessageID: '',
    quotedText: '',
  }
}

/** statSync isDirectory probe that reports false on error. */
function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Chat ID from "<platform>:<chatID>[:<userID>]" when the platform segment
 * matches platformName (Go chatIDFromSessionKey).
 */
function chatIDFromSessionKey(sessionKey: string, platformName: string): string {
  const parts = sessionKey.split(':', 3)
  if (parts.length < 2 || parts[0] !== platformName) return ''
  return parts[1] ?? ''
}

/**
 * A single "open parent group" jump button for a spawned child, derived from
 * the originating message (Go parentJumpButtons). Empty array when the
 * parent chat ID cannot be resolved.
 */
function parentJumpButtons(parentSessionKey: string, parentName: string, p: Platform): CardButton[] {
  const pcid = chatIDFromSessionKey(parentSessionKey, p.name())
  if (pcid === '') return []
  let label = '↩ 父群'
  if (parentName !== '') label = `↩ ${parentName}`
  const url = asChatJumpURLer(p)?.chatJumpURL(pcid) ?? ''
  return [{ text: label, type: 'default', value: '', url }]
}

/**
 * Render parent/child jump buttons as a single markdown link line (Go
 * jumpButtonsMarkdown). ok=false when no button carries a URL.
 */
function jumpButtonsMarkdown(buttons: CardButton[]): CardMarkdownLike & { ok: boolean } {
  const parts: string[] = []
  for (const b of buttons) {
    if (b.url !== undefined && b.url !== '') parts.push(`[${b.text}](${b.url})`)
  }
  if (parts.length === 0) return { content: '', ok: false }
  return { content: parts.join('  ·  '), ok: true }
}

function truncateIf(s: string, maxLen: number): string {
  if (maxLen <= 0) return s
  const runes = Array.from(s)
  if (runes.length <= maxLen) return s
  return `${runes.slice(0, maxLen).join('')}…`
}

/** Media capability surface a platform may expose beyond plain text. */
type MediaPlatform = Platform & {
  sendImage?: (replyCtx: unknown, img: ImageAttachment) => Promise<void>
  sendFile?: (replyCtx: unknown, file: FileAttachment) => Promise<void>
}

/** Reply-context reconstruction a platform may expose for proactive sends. */
type ReconstructingPlatform = Platform & {
  reconstructReplyCtx?: (sessionKey: string) => Promise<unknown>
}

/**
 * Engine routes messages between platforms and the agent for a single
 * project (Go Engine, M1 subset).
 */
export class Engine {
  readonly name: string
  readonly agent: Agent
  readonly platforms: Platform[]
  readonly sessions: SessionManager
  readonly i18n: I18n
  readonly startedAt = Date.now()

  display: DisplayCfg = {
    thinkingMessages: true,
    thinkingMaxLen: defaultThinkingMaxLen,
    toolMessages: true,
    toolProgress: false,
    toolMaxLen: 0,
    planMaxLen: defaultPlanMaxLen,
  }
  /** Streaming preview switches (Go e.streamPreview). */
  streamPreview: StreamPreviewCfg = defaultStreamPreviewCfg()
  /** Quiet window after the last im.chat.updated event before a preview bump (Go var). */
  bumpDebounceInterval = 2000
  injectSender = false
  attachmentSendEnabled = true
  eventIdleTimeout = defaultEventIdleTimeout
  stallMaxRetries = defaultStallMaxRetries
  maxQueuedMessages = defaultMaxQueuedMessages
  debounceInterval = defaultDebounceInterval
  interactiveIdleTimeout = 0

  /** Recursive subtask delegation cap override; 0 = defaultSubtaskMaxDepth (Go subtaskMaxDepth). */
  subtaskMaxDepth = 0
  /** Default worktree isolation for /spawn //fork (Go spawnWorktree). */
  spawnWorktree: WorktreeMode = WorktreeMode.ForceOff
  /** /spawn //fork RAM guard thresholds in percent; 0 disables a tier (Go spawnMemWarnPct/BlockPct). */
  spawnMemWarnPct = 0
  spawnMemBlockPct = 0
  /** Hard timeout for subtask sessions; 0 inherits eventIdleTimeout (Go subtaskTimeout). */
  subtaskTimeout = 0
  /** Gather barrier fallback timeout; 0 = defaultSubtaskGatherTimeout (Go subtaskGatherTimeout). */
  subtaskGatherTimeout = 0
  /** LLM group-name generation switches (Go groupName* fields). */
  groupNameEnabled = false
  groupNameProvider = ''
  groupNameTimeout = 0
  groupNamePrompt = ''
  groupNameSetAvatar = false
  /** Monitor-mode config surface; full monitor domain arrives with M6 (Go monitorEnabled). */
  monitorEnabled = false
  /** Cron scheduler shared across engines (Go cronScheduler; null = cron off). */
  cronScheduler: CronScheduler | undefined
  /** Relay manager shared across engines (Go relayManager; null = relay off). */
  relayManager: RelayManager | undefined

  /** Session keys with a manual rename pending in the async LLM window (Go pendingRename). */
  private readonly pendingRename = new Set<string>()
  /** Ring buffer of recently used group icons for prompt dedup (Go recentIcons). */
  private recentIcons: string[] = []
  /** Config-driven monitor chat list (Go monitorChats atomic value). */
  private monitorChatsStr = ''

  /** key = sessionKey (interactiveKey; workspace prefixes arrive in a later M). */
  readonly interactiveStates = new Map<string, InteractiveState>()

  /** Command names → alias targets (trigger → command). */
  readonly aliases = new Map<string, string>()

  /** Command table injected by registerSessionCommands (engine/commands.ts). */
  commandHandlers: Map<string, (p: Platform, msg: Message, args: string[]) => boolean> | undefined
  /** Resolves a typed command word to its canonical ID (commands.ts matchPrefix). */
  commandResolver: ((cmd: string) => string) | undefined
  /** Privileged/disabled command gate; true when it replied and handled the line. */
  commandGate: ((cmdID: string, p: Platform, msg: Message) => boolean) | undefined

  /** Persisted per-project state (/dir overrides). */
  projectState: import('./project-state.js').ProjectStateStore | undefined
  /** Directory switch history (/dir). */
  dirHistory: import('./dir-history.js').DirHistory | undefined
  /** Base working directory for /dir reset. */
  baseWorkDir = ''
  /** Comma-separated admin user IDs ('*' = all allowed users; '' = deny). */
  adminFrom = ''
  /** /list etc. only show cc-connect-tracked sessions when true. */
  filterExternalSessions = false

  private reaperTimer: ReturnType<typeof setInterval> | undefined

  constructor(name: string, agent: Agent, platforms: Platform[], sessionStorePath: string, lang: Language = langEnglish) {
    this.name = name
    this.agent = agent
    this.platforms = platforms
    this.sessions = new SessionManager(sessionStorePath)
    this.i18n = new I18n(lang)
    this.sessions.invalidateForAgent(agent.name())
  }

  // ── configuration setters used by ported tests ─────────────────────────

  /** Override intermediate-message display settings. */
  setDisplayConfig(cfg: Partial<DisplayCfg>): void {
    this.display = { ...this.display, ...cfg }
  }

  /** Idle timeout before a silent turn is killed; 0 disables. */
  setEventIdleTimeout(ms: number): void {
    this.eventIdleTimeout = ms
  }

  /** Stall retries before the idle kill (Go SetStallMaxRetries). */
  setStallMaxRetries(n: number): void {
    this.stallMaxRetries = n
  }

  /** Merge streaming-preview tuning over the current config (Go SetStreamPreviewCfg). */
  setStreamPreviewCfg(cfg: Partial<StreamPreviewCfg>): void {
    this.streamPreview = { ...this.streamPreview, ...cfg }
  }

  /** Rapid-fire queued-message merge window in ms; 0 disables. */
  setDebounceInterval(ms: number): void {
    this.debounceInterval = ms
  }

  /** Per-session queue cap. */
  setMaxQueuedMessages(n: number): void {
    this.maxQueuedMessages = n
  }

  /** Toggle side-channel attachment delivery (Go SetAttachmentSendEnabled). */
  setAttachmentSendEnabled(enabled: boolean): void {
    this.attachmentSendEnabled = enabled
  }

  /** Inject the sender identity header into prompts (Go SetInjectSender). */
  setInjectSender(enabled: boolean): void {
    this.injectSender = enabled
  }

  /**
   * Enable the idle reaper: periodically reclaim interactiveStates idle
   * beyond the threshold by closing the agent session. 0 disables.
   */
  setInteractiveIdleTimeout(ms: number): void {
    this.interactiveIdleTimeout = ms
    if (this.reaperTimer !== undefined) {
      clearInterval(this.reaperTimer)
      this.reaperTimer = undefined
    }
    if (ms <= 0) return
    const period = Math.max(1000, Math.min(ms, 60_000))
    this.reaperTimer = setInterval(() => { this.reapIdleInteractiveStates() }, period)
    this.reaperTimer.unref()
  }

  /** Attach the process-wide cron scheduler (Go SetCronScheduler). */
  setCronScheduler(cs: CronScheduler): void {
    this.cronScheduler = cs
  }

  /** Attach the process-wide relay manager (Go SetRelayManager). */
  setRelayManager(rm: RelayManager): void {
    this.relayManager = rm
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Start every platform with the inbound handler (Go Start, M1 subset). */
  async start(): Promise<void> {
    const startErrs: unknown[] = []
    for (const p of this.platforms) {
      try {
        await p.start((platform, msg) => { this.handleMessage(platform, msg) })
      } catch (error) {
        console.warn(`platform start failed: ${p.name()}: ${String(error)}`)
        startErrs.push(error)
        continue
      }
      // Chat-update wiring (Go engine.go platform startup): renames sync
      // session labels; name/avatar changes bump the active preview back to
      // the chat tail after the change's system notice pushes it off.
      const renamed = asChatRenamedNotifier(p)
      if (renamed !== undefined) {
        renamed.setChatRenamedHandler((sessionKey, newName) => { this.handleChatRenamed(sessionKey, newName) })
      }
      const changed = asChatChangedNotifier(p)
      if (changed !== undefined) {
        changed.setChatChangedHandler((sessionKey) => { this.onChatChanged(sessionKey) })
      }
    }
    if (startErrs.length === this.platforms.length && this.platforms.length > 0) {
      throw startErrs[0]
    }
  }

  /**
   * Reflect a group rename into session state so jump-button labels stay
   * current (Go handleChatRenamed): the renamed chat's own session gets Name
   * updated (parent→child labels), and any child whose ParentSessionKey
   * points at it gets ParentChatName updated (child→parent labels).
   */
  handleChatRenamed(sessionKey: string, newName: string): void {
    if (newName === '') return
    const { idToKey } = this.sessions.sessionKeyMap()
    let changed = false
    for (const s of this.sessions.allSessions()) {
      if (idToKey[s.id] === sessionKey) {
        if (s.getName() !== newName) {
          s.setName(newName)
          changed = true
        }
      }
      if (s.getParentSessionKey() === sessionKey && s.getParentChatName() !== newName) {
        s.setParentChatName(newName)
        changed = true
      }
    }
    if (changed) {
      this.sessions.save()
      console.info(`chat renamed: session labels updated (${sessionKey} → ${newName})`)
    }
  }

  /** Stop platforms and close all interactive agent sessions (Go Stop). */
  async stop(): Promise<void> {
    for (const p of this.platforms) await p.stop()
    const states = [...this.interactiveStates.values()]
    this.interactiveStates.clear()
    for (const state of states) {
      if (state.agentSession !== undefined) await state.agentSession.close()
    }
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer)
    await this.agent.stop()
  }

  /** Deliver a message into the engine (integration-test entry). */
  receiveMessage(p: Platform, msg: Message): void {
    this.handleMessage(p, msg)
  }

  // ── outbound wrappers ───────────────────────────────────────────────────

  /** Reply with error logging (Go reply). */
  reply(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.reply(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: reply failed (${p.name()}): ${String(error)}`)
    })
  }

  /** Send with error logging (Go send). */
  send(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.send(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: send failed (${p.name()}): ${String(error)}`)
    })
  }

  // ── inbound routing ─────────────────────────────────────────────────────

  /** Route one inbound message (Go handleMessage, M1 subset). */
  handleMessage(p: Platform, msg: Message): void {
    const content = msg.content.trim()
    if (content === '' && msg.images.length === 0 && msg.files.length === 0) return

    const resolved = this.resolveAlias(content)
    if (msg.extraContent !== '') {
      msg.content = resolved === '' ? msg.extraContent : `${msg.extraContent}\n${resolved}`
    } else {
      msg.content = resolved
    }

    // M4: card-button actions (act:) run their side effect and update the
    // pressed card in place — before permission handling and long before any
    // agent turn (Go handleCardNav).
    if (msg.isCardAction) {
      void this.handleCardAction(p, msg, content).catch((error: unknown) => {
        console.error(`engine: card action failed (${msg.sessionKey}): ${String(error)}`)
      })
      return
    }

    // M3: Route permission responses to handlePendingPermission before normal
    // dispatch (Go engine.go: every message passes through this check —
    // card-button actions AND free-text answers to a pending question).
    if (this.handlePendingPermission(p, msg, content)) return

    const session = this.sessions.getOrCreateActive(msg.sessionKey)
    this.sessions.updateUserMeta(msg.sessionKey, msg.userName, msg.chatName)
    if (msg.userID !== '' && session.getSpawnUserID() !== msg.userID) {
      session.setSpawnUserID(msg.userID)
      this.sessions.save()
    }

    if (msg.images.length === 0 && content.startsWith('/')) {
      if (this.dispatchCommand(p, msg, content)) return
    }

    if (!session.tryLock()) {
      if (this.queueMessageForBusySession(p, msg, msg.sessionKey)) {
        // Race guard: the drain loop may have finished between our TryLock
        // failure and the queue append — retry and drain the orphans.
        if (session.tryLock()) {
          void this.drainOrphanedQueue(session, this.sessions, msg.sessionKey)
        }
      } else {
        void this.reply(p, msg.replyCtx, this.i18n.t(MsgPreviousProcessing))
      }
      return
    }

    // A real human message resuming a subtask group starts a new work cycle:
    // re-arm the one-shot report flag so the agent's report (and the
    // first-turn auto-report) can deliver again after a prior cycle already
    // reported. No-op for synthetic injections (empty userID) and non-subtask
    // sessions. Runs after the lock is acquired so it only fires on a
    // genuinely new turn (Go rearmSubtaskReportOnHumanTurn).
    this.rearmSubtaskReportOnHumanTurn(msg, session, this.sessions)
    // A real human message into a background session (subtask group /
    // chatroom role) re-enables auto-render for it from this point on.
    this.markUserInterjectedOnHumanTurn(msg, session, this.sessions)

    this.ensureInteractiveStateForQueueing(msg.sessionKey, p, msg.replyCtx)
    void this.processInteractiveMessageWith(p, msg, session)
  }

  /** Resolve aliases on the content or its first word (Go resolveAlias). */
  resolveAlias(content: string): string {
    if (this.aliases.size === 0) return content
    const exact = this.aliases.get(content)
    if (exact !== undefined) return exact
    const spaceIdx = content.indexOf(' ')
    const first = spaceIdx === -1 ? content : content.slice(0, spaceIdx)
    const cmd = this.aliases.get(first)
    if (cmd === undefined) return content
    if (spaceIdx === -1) return cmd
    return `${cmd} ${content.slice(spaceIdx + 1)}`
  }

  /** Text slash-command dispatch; false lets the message reach the agent. */
  dispatchCommand(p: Platform, msg: Message, raw: string): boolean {
    const parts = raw.trim().split(/\s+/)
    const cmd = (parts.shift() ?? '').replace(/^\//, '').toLowerCase()
    const cmdID = this.commandResolver?.(cmd) ?? (this.commandHandlers?.get(cmd) !== undefined ? cmd : '')
    if (cmdID === '') return false
    if (this.commandGate?.(cmdID, p, msg)) return true
    const handler = this.commandHandlers?.get(cmdID)
    if (handler === undefined) return false
    return handler(p, msg, parts)
  }

  /** Per-chat dir override for an interactive key (Go perChatWorkDir, M1 shape). */
  perChatWorkDir(key: string): string {
    return this.projectState?.workspaceDirOverride(this.dirOverrideKey(key)) ?? ''
  }

  /**
   * Channel-level key for dir overrides: single-workspace strips the trailing
   * user ID so card actions and text messages map to the same slot.
   */
  dirOverrideKey(sessionKey: string): string {
    return stripUserID(sessionKey)
  }

  /** Effective work dir for a command context (agent cwd or process cwd). */
  commandWorkDir(msg: Message): string {
    const switcher = this.agent as { getWorkDir?: () => string }
    if (typeof switcher.getWorkDir === 'function') {
      const wd = switcher.getWorkDir().trim()
      if (wd !== '') return wd
    }
    const override = this.perChatWorkDir(this.dirOverrideKey(msg.sessionKey))
    if (override !== '') return override
    return process.cwd()
  }

  /** Register the persisted project-state store (/dir overrides). */
  setProjectStateStore(store: import('./project-state.js').ProjectStateStore): void {
    this.projectState = store
  }

  /** Register the directory history used by /dir. */
  setDirHistory(history: import('./dir-history.js').DirHistory): void {
    this.dirHistory = history
  }

  /** Set the base work dir restored by /dir reset. */
  setBaseWorkDir(dir: string): void {
    this.baseWorkDir = dir
  }

  /** Set the admin user list for privileged commands. */
  setAdminFrom(adminFrom: string): void {
    this.adminFrom = adminFrom
  }

  // ── queueing (#13) ──────────────────────────────────────────────────────

  /**
   * Queue a message for delivery after the running turn. Only metadata is
   * stored — the event loop sends it after the turn's result (Go
   * queueMessageForBusySession).
   */
  queueMessageForBusySession(p: Platform, msg: Message, interactiveKey: string): boolean {
    const state = this.interactiveStates.get(interactiveKey)
    if (state === undefined) return false
    // Allow queueing while agentSession is still starting (issue #565);
    // reject only a session that was established and died.
    if (state.agentSession !== undefined && !state.agentSession.alive()) {
      void this.cleanupInteractiveState(interactiveKey, state)
      return false
    }
    if (state.pendingMessages.length >= this.maxQueuedMessages) {
      void this.reply(p, msg.replyCtx, this.i18n.tf(MsgQueueFull, state.pendingMessages.length))
      return true
    }
    state.pendingMessages.push({
      platform: p,
      replyCtx: msg.replyCtx,
      messageID: msg.messageID,
      content: msg.content,
      images: msg.images,
      files: msg.files,
      fromVoice: msg.fromVoice,
      isSpawnedGroup: msg.isSpawnedGroup,
      userID: msg.userID,
      userName: msg.userName,
      msgPlatform: msg.platform,
      msgSessionKey: msg.sessionKey,
    })
    void this.reply(p, msg.replyCtx, this.i18n.t(MsgMessageQueued))
    return true
  }

  /** Create a placeholder state so startup-window messages queue (issue #565). */
  ensureInteractiveStateForQueueing(key: string, p: Platform, replyCtx: unknown): void {
    if (!this.interactiveStates.has(key)) {
      const state = new InteractiveState()
      state.platform = p
      state.replyCtx = replyCtx
      state.lastActivity = Date.now()
      state.eventsNeedResync = true
      this.interactiveStates.set(key, state)
    }
  }

  // ── turn processing ─────────────────────────────────────────────────────

  /** Run one user turn end-to-end (Go processInteractiveMessageWith, M1 subset). */
  async processInteractiveMessageWith(p: Platform, msg: Message, session: Session, interactiveKey = msg.sessionKey): Promise<void> {
    let unlocked = false
    try {
      this.i18n.detectAndSet(msg.content)
      const historyContent = msg.originalContent !== '' ? msg.originalContent : msg.content
      session.addHistory('user', historyContent)

      this.handleSpawnedGroupFirstMessage(p, msg, session)

      // Go separates the interactive-state slot key from the CC_SESSION_KEY
      // env key: cron new-per-run slots carry a #cron suffix the env must not.
      const state = await this.getOrCreateInteractiveStateWith(interactiveKey, p, msg.replyCtx, session, msg.modeOverride ?? '', msg.sessionKey)
      try {
        state.turnSeq++
        state.platform = p
        state.replyCtx = msg.replyCtx

        if (state.agentSession === undefined) {
          await this.reply(p, msg.replyCtx, this.i18n.t(MsgFailedToStartAgentSession))
          return
        }

        // A /done'd spawned group auto-resumes on the next message, but its
        // dimmed avatar / inactive state only recovers via /undone — mirror
        // that recovery here, off the turn's hot path (Go
        // reactivateSpawnedChatAvatar).
        if (msg.isSpawnedGroup) {
          void this.reactivateSpawnedChatAvatar(p, msg.sessionKey)
        }

        // TODO(M3): per-message mode override via LiveModeSwitcher.
        // TODO(M2): typing-indicator transfer to the event loop.

        if (state.eventsNeedResync) state.agentSession.events().drain()

        const promptContent = this.buildSenderPrompt(msg.content, msg.userID, msg.userName, msg.platform, msg.sessionKey)
        state.fromVoice = msg.fromVoice
        state.sideText = ''
        state.lastPrompt = promptContent

        state.lastEventAt = Date.now()
        const sendDone = state.agentSession.send(promptContent, msg.images, msg.files)
          .then((): undefined => undefined, (error: unknown): unknown => error)

        await this.processInteractiveEvents(state, session, this.sessions, interactiveKey, msg.messageID, sendDone, msg.replyCtx)
      } finally {
        state.endTurn()
      }

      // A message may have queued between the event loop seeing an empty
      // queue and returning (session still locked) — drain the orphans.
      await this.drainPendingMessages(state, session, this.sessions, interactiveKey)
      unlocked = true
    } catch (error) {
      console.error(`engine: turn processing failed (${msg.sessionKey}): ${String(error)}`)
    } finally {
      if (!unlocked) session.unlock()
    }
  }

  /** Sender-injection prompt prefix (Go buildSenderPrompt). */
  buildSenderPrompt(content: string, userID: string, userName: string, platform: string, sessionKey: string): string {
    if (!this.injectSender || userID === '') return content
    const chatID = extractChannelID(sessionKey)
    if (userName !== '') {
      const safeName = userName.replaceAll('"', "'").replaceAll('\n', ' ').replaceAll('\r', '')
      return `[cc-connect sender_id=${userID} sender_name="${safeName}" platform=${platform} chat_id=${chatID}]\n${content}`
    }
    return `[cc-connect sender_id=${userID} platform=${platform} chat_id=${chatID}]\n${content}`
  }

  /**
   * Get or create the interactive state for a session key, recycling a stale
   * agent process whose session ID no longer matches (Go
   * getOrCreateInteractiveStateWith, M1 subset without fork sentinels and
   * workspace overrides).
   */
  async getOrCreateInteractiveStateWith(
    sessionKey: string,
    p: Platform,
    replyCtx: unknown,
    session: Session,
    modeOverride = '',
    envKey = sessionKey,
  ): Promise<InteractiveState> {
    // Wait out a concurrent teardown so two agents never resume the same
    // session id concurrently.
    for (;;) {
      const state = this.interactiveStates.get(sessionKey)
      if (state === undefined || state.closing === undefined) break
      await Promise.race([state.closing, cancellableSleep(agentCloseTimeout + 10_000).promise])
    }

    const existing = this.interactiveStates.get(sessionKey)
    if (existing !== undefined && existing.agentSession !== undefined && existing.agentSession.alive()) {
      const wantID = session.getAgentSessionID()
      const currentID = existing.agentSession.currentSessionID()
      const needRecycle = currentID !== '' && (wantID === '' || wantID !== currentID)
      if (!needRecycle) {
        existing.beginTurn()
        return existing
      }
      console.info(`interactive session mismatch, recycling (${sessionKey}): want=${wantID} have=${currentID}`)
      existing.markStopped()
      await this.closeAgentSessionWithTimeout(sessionKey, existing.agentSession)
      this.interactiveStates.delete(sessionKey)
    }

    const agent = this.agent
    const sessionEnv = this.buildSessionEnv(envKey, session)

    const startSessionID = session.getAgentSessionID()

    // Resolve per-chat workDir override so the agent session starts in the
    // correct directory even in single-workspace mode (Go applyWorkDirOverride).
    const restoreWorkDir = this.applyWorkDirOverride(agent, sessionKey)
    let agentSession: AgentSession | undefined
    try {
      agentSession = await this.startAgentLocked(agent, startSessionID, sessionEnv, modeOverride)
    } catch (error) {
      if (startSessionID !== '') {
        console.error(`session resume failed, falling back to fresh session (${sessionKey}): ${String(error)}`)
        try {
          agentSession = await this.startAgentLocked(agent, '', sessionEnv, modeOverride)
          void this.reply(p, replyCtx, this.i18n.t(MsgSessionResumeDegraded))
        } catch (freshError) {
          console.error(`failed to start interactive session (${sessionKey}): ${String(freshError)}`)
        }
      } else {
        console.error(`failed to start interactive session (${sessionKey}): ${String(error)}`)
      }
    } finally {
      restoreWorkDir()
    }

    if (agentSession === undefined) {
      const newState = new InteractiveState()
      newState.platform = p
      newState.replyCtx = replyCtx
      newState.agent = agent
      newState.eventsNeedResync = true
      this.adoptPendingFromPlaceholder(this.interactiveStates.get(sessionKey), newState)
      this.interactiveStates.set(sessionKey, newState)
      return newState
    }

    const newID = agentSession.currentSessionID()
    if (newID !== '') {
      if (session.compareAndSetAgentSessionID(newID, agent.name())) {
        const pendingName = session.getName()
        if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
          this.sessions.setSessionName(newID, pendingName)
        }
        this.sessions.save()
      }
    }

    const newState = new InteractiveState()
    newState.agentSession = agentSession
    newState.platform = p
    newState.replyCtx = replyCtx
    newState.agent = agent
    newState.sessionEnv = sessionEnv
    newState.eventsNeedResync = true
    newState.effectiveIdleTimeout = this.eventIdleTimeout
    this.adoptPendingFromPlaceholder(this.interactiveStates.get(sessionKey), newState)
    this.interactiveStates.set(sessionKey, newState)

    newState.beginTurn()
    return newState
  }

  /** Carry queued messages from a placeholder state into the live one. */
  private adoptPendingFromPlaceholder(existing: InteractiveState | undefined, fresh: InteractiveState): void {
    if (existing === undefined) return
    if (existing.pendingMessages.length > 0) {
      fresh.pendingMessages = [...existing.pendingMessages, ...fresh.pendingMessages]
      existing.pendingMessages = []
    }
  }

  /**
   * Per-session env (Go buildSessionEnv). CC_SESSION rides alongside
   * CC_SESSION_KEY because dsh scrubs credential-shaped env names (any
   * *KEY*) from Bash-tool children, which would silently drop CC_SESSION_KEY.
   * The PATH/venv and feishu-workspace entries arrive with the chatroom (M5)
   * and workspace (M7) milestones.
   */
  buildSessionEnv(ccKey: string, session: Session): string[] {
    const envVars = [
      `CC_PROJECT=${this.name}`,
      `CC_SESSION_KEY=${ccKey}`,
      `CC_SESSION=${ccKey}`,
    ]
    if (session.getResearchAssistant()) {
      envVars.push('CC_RESEARCH_ASSISTANT=1')
    }
    if (session.getSubtaskDepth() > 0) {
      envVars.push('CC_SUBTASK=1', `CC_SUBTASK_DEPTH=${session.getSubtaskDepth()}`)
      if (session.getSubtaskAttended()) {
        envVars.push('CC_SUBTASK_ATTENDED=1')
      }
      if (session.getSubtaskNoReport()) {
        envVars.push('CC_SUBTASK_NO_REPORT=1')
      }
    }
    if (session.getChatroomHubKey() !== '') {
      envVars.push('CC_CHATROOM_ROLE=1')
      const hub = this.sessions.getOrCreateActive(session.getChatroomHubKey())
      if (hub.getChatroomResearch()) {
        envVars.push('CC_CHATROOM_RESEARCH=1')
        const key = session.getResearchAssistantKey()
        if (key !== '') {
          envVars.push(`CC_RESEARCH_ASSISTANT_KEY=${key}`)
          envVars.push(`CC_RESEARCH_ASSISTANT_CHILD=${key}`)
        }
      }
    }
    return envVars
  }

  /** SetSessionEnv + StartSession, serialized per engine (Go startAgentLocked). Public for the ported env-injection tests. */
  startAgentLocked(agent: Agent, sessionID: string, env: string[], modeOverride: string): Promise<AgentSession> {
    const inj = asSessionEnvInjector(agent)
    if (inj !== undefined && env.length > 0) inj.setSessionEnv(env)
    const modeInj = asSessionModeInjector(agent)
    if (modeInj !== undefined && modeOverride !== '') modeInj.setSessionMode(modeOverride)
    return agent.startSession(sessionID)
  }

  // ── event loop ──────────────────────────────────────────────────────────

  /**
   * Consume agent events for one turn: accumulate text/thinking, deliver the
   * final reply, drain queued messages, and handle process exit (Go
   * processInteractiveEvents, M1 subset without preview cards and the
   * watchdog).
   */
  async processInteractiveEvents(
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    sessionKey: string,
    _msgID: string,
    sendDone: Promise<unknown> | undefined,
    replyCtx: unknown,
  ): Promise<void> {
    let textParts: string[] = []
    let segmentStart = 0
    let toolCount = 0
    let silentHold = false
    let activeToolCalls = 0
    let stallRetries = 0

    const channel = state.agentSession?.events()
    if (channel === undefined) return

    // M2 preview machinery: one streamPreview + compact writer per turn,
    // sharing the state's async sender so PATCHes stay off this loop.
    const platform = state.platform ?? this.platforms[0]
    if (platform === undefined) return
    state.sender ??= newAsyncSender(sessionKey)
    const sender = state.sender
    const sp = newStreamPreview(this.streamPreview, platform, replyCtx, undefined, sender, sessionKey)
    state.preview = sp
    const cp = newCompactProgressWriter(platform, replyCtx, this.agent.name(),
      this.i18n.currentLang(), undefined, sender)
    this.bindActivePreview(sp, sessionKey)
    // Placeholder card so the user sees visual feedback (with push) before
    // the first agent event arrives.
    if (this.display.toolProgress && sp.canPreview()) {
      void sp.showPlaceholder(this.i18n.t(MsgProcessing))
    }
    let thinkingStreamed = false
    let thinkingAccum = ''
    let deltaAccum = ''
    let deltaFlushed = false

    /** Drain queued async PATCHes before a terminal card state. */
    const barrier = (): Promise<void> => sender.barrier()

    let pendingSend = sendDone
    const stopP = state.stopSignal()
    let recvP: Promise<{ done: false; event: Event } | { done: true }> = channel.receive()

    /** One resolved arm of the loop's select (Go's select cases). */
    type LoopOutcome =
      | { kind: 'event'; event: Event }
      | { kind: 'closed' }
      | { kind: 'send'; error: unknown }
      | { kind: 'stop' }
      | { kind: 'idle' }
      | { kind: 'never' }

    for (;;) {
      // Idle timer: re-armed per iteration (Go reset-after-event); not armed
      // while a tool call is in flight (Go stops it on EventToolUse).
      const idleMs = activeToolCalls === 0 ? state.idleTimeout(this.eventIdleTimeout) : 0
      const idleSleep = idleMs > 0 ? cancellableSleep(idleMs) : undefined
      const recvOutcome: Promise<LoopOutcome> = recvP.then(r =>
        r.done ? { kind: 'closed' } : { kind: 'event', event: r.event })
      const sendOutcome: Promise<LoopOutcome> = pendingSend !== undefined
        ? pendingSend.then(e => ({ kind: 'send', error: e }))
        : neverPromise
      const stopOutcome: Promise<LoopOutcome> = stopP.then(() => ({ kind: 'stop' }))
      const idleOutcome: Promise<LoopOutcome> = idleSleep !== undefined
        ? idleSleep.promise.then(() => ({ kind: 'idle' }))
        : neverPromise
      const outcome: LoopOutcome = await Promise.race([recvOutcome, sendOutcome, stopOutcome, idleOutcome])
      idleSleep?.cancel()

      if (outcome.kind === 'stop') {
        await barrier()
        if (state.isUserStopped()) {
          // User stop: stopped terminal card, skipping cp.Finalize(Failed)
          // which would clobber the ⏹ 已停止 card.
          await sp.markStopped()
        } else {
          await sp.markFailed()
        }
        state.eventsNeedResync = true
        return
      }

      if (outcome.kind === 'send') {
        pendingSend = undefined
        if (outcome.error !== undefined) {
          const errText = errorMessage(outcome.error)
          console.error(`failed to send prompt (${sessionKey}): ${errText}`)
          this.notifyDroppedQueuedMessages(state, new Error(errText))
          if (state.agentSession === undefined || !state.agentSession.alive()) {
            await this.cleanupInteractiveState(sessionKey, state)
          }
          const p = state.platform
          if (p !== undefined) {
            await this.send(p, replyCtx, this.i18n.tf(MsgError, errorMessage(outcome.error)))
          }
          return
        }
        continue
      }

      if (outcome.kind === 'idle') {
        // Re-verify against the last event arrival: a fire right after an
        // event resolved is stale — keep waiting (Go stallConfirmed).
        if (!this.stallConfirmed(state, Date.now(), state.idleTimeout(this.eventIdleTimeout))) continue

        stallRetries++
        if (stallRetries <= this.stallMaxRetries) {
          const retry = await this.restartAgentForStallRetry(
            state, state.agent ?? this.agent, sessionKey, channel)
          if (retry !== undefined) {
            const stallPlatform = state.platform
            if (stallPlatform !== undefined) {
              const idleSec = Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000)
              await this.send(stallPlatform, replyCtx,
                this.i18n.tf(MsgStallRetry, idleSec, stallRetries, this.stallMaxRetries))
            }
            textParts = []
            segmentStart = 0
            toolCount = 0
            silentHold = false
            recvP = retry.events().receive()
            const retryChannel = retry
            const nextSend = retryChannel.send('继续', [], [])
              .then((): undefined => undefined, (error: unknown): unknown => error)
            pendingSend = nextSend
            continue
          }
        }

        console.error(`agent session idle timeout: no events for too long, killing session (${sessionKey})`)
        state.eventsNeedResync = true
        const p = state.platform
        if (p !== undefined) {
          await this.send(p, replyCtx,
            this.i18n.tf(MsgStallTimeout, Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000), this.stallMaxRetries))
        }
        await this.cleanupInteractiveState(sessionKey, state)
        return
      }

      if (outcome.kind === 'closed' || outcome.kind === 'never') {
        if (outcome.kind === 'closed') {
          await this.handleChannelClosed(state, session, sessionKey, textParts, segmentStart, toolCount, replyCtx)
        }
        return
      }

      const event = outcome.event
      state.lastEventAt = Date.now()
      recvP = channel.receive()

      if (state.isStopped()) {
        state.eventsNeedResync = true
        return
      }

      const p = state.platform

      switch (event.type) {
        case 'thinking': {
          if (isEllipsisOnly(event.content)) break
          // In quiet mode (thinkingMessages=false), thinking events must not
          // affect the streaming preview — no clearThinking, no
          // completeAndDetach, no text segment flush. Otherwise
          // completeAndDetach sets degraded=true, causing the result handler
          // to fall through to this.send() and duplicate the reply as plain
          // text alongside the already-finalized card.
          if (!this.display.thinkingMessages) {
            thinkingStreamed = false
            thinkingAccum = ''
            break
          }
          // Thinking block complete: drop the streamed 💭 section.
          if (thinkingStreamed && sp.canPreview()) await sp.clearThinking()
          if (textParts.length > segmentStart) {
            if (sp.canPreview()) {
              await sp.completeAndDetach()
              segmentStart = textParts.length
            } else {
              const segment = textParts.slice(segmentStart).join('')
              if (segment !== '' && p !== undefined) {
                for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                  await this.send(p, replyCtx, chunk)
                }
              }
              segmentStart = textParts.length
            }
            if (!sp.inProgressMode()) segmentStart = textParts.length
            silentHold = false
          }
          if (event.content !== '' && p !== undefined) {
            if (textParts.length > segmentStart) {
              if (!sp.canPreview()) {
                const segment = textParts.slice(segmentStart).join('')
                if (segment !== '') {
                  for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                    await this.send(p, replyCtx, chunk)
                  }
                }
              }
              segmentStart = textParts.length
              silentHold = false
            }
            await sp.completeAndDetach()
            const preview = truncateIf(event.content, this.display.thinkingMaxLen)
            const thinkingMsg = this.i18n.tf('thinking', preview)
            if (!await cp.appendEvent('thinking', preview, '', thinkingMsg)) {
              await this.send(p, replyCtx, thinkingMsg)
            }
          }
          thinkingStreamed = false
          thinkingAccum = ''
          break
        }

        case 'text_delta': {
          // Preview-only incremental text; the full block still arrives via
          // EventText and is reconciled at turn end.
          deltaAccum += event.content
          if (couldBeSilentPrefix(deltaAccum)) break
          deltaFlushed = true
          if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(deltaAccum)
          else if (sp.canPreview()) await sp.appendText(event.content)
          break
        }

        case 'thinking_delta': {
          // Preview-only: stream thinking into the 💭 section; the full
          // EventThinking block clears it and dedups.
          thinkingAccum += event.content
          thinkingStreamed = true
          if (this.display.thinkingMessages && sp.canPreview()) await sp.appendThinking(thinkingAccum)
          break
        }

        case 'tool_use': {
          toolCount++
          activeToolCalls++
          state.activeToolCalls = activeToolCalls
          if (this.display.toolProgress && sp.canPreview()) {
            await sp.appendProgress(newToolProgressEntry(event.toolName ?? '', event.toolInput ?? '', event.toolID ?? ''))
          }
          break
        }

        case 'tool_result': {
          if (this.display.toolMessages) {
            const result = (event.toolResult ?? '').trim() || event.content.trim()
            if (result !== '' && p !== undefined) {
              const entry = {
                kind: 'tool_result' as const,
                tool: event.toolName ?? '',
                text: result,
              }
              if (!await cp.appendStructured(entry, result)) {
                if (!suppressStandaloneToolResultEvent(p)) {
                  await this.send(p, replyCtx, result)
                }
              }
            }
          } else if (this.display.toolProgress) {
            // Quiet mode: update the last tool entry with its result.
            const result = (event.toolResult ?? '').trim() || event.content.trim()
            if (result !== '' || event.done) {
              await sp.updateToolResult(event.toolID ?? '', result, true)
            }
          }
          activeToolCalls = Math.max(0, activeToolCalls - 1)
          state.activeToolCalls = activeToolCalls
          break
        }

        case 'text': {
          if (isEllipsisOnly(event.content)) break
          // Real text ends the streaming-thinking state (safety net for
          // agents that only emit thinking deltas); empty content carriers
          // (session ids) must not flip 思考中↔执行中.
          if (thinkingStreamed && event.content !== '') {
            await sp.clearThinking()
            thinkingAccum = ''
          }
          const text = event.content
          if (text !== '' && !isSilentReply(text)) {
            textParts.push(text)
            if (deltaFlushed) {
              // This block was already previewed via deltas; textParts (the
              // final-message source of truth) is still updated.
              deltaAccum = ''
              deltaFlushed = false
            } else {
              const segmentText = textParts.slice(segmentStart).join('')
              if (silentHold) {
                if (!couldBeSilentPrefix(segmentText)) {
                  silentHold = false
                  if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(segmentText)
                  else if (sp.canPreview()) await sp.appendText(segmentText)
                }
              } else if (couldBeSilentPrefix(segmentText)) {
                silentHold = true
              } else if (sp.canPreview() && sp.inProgressMode()) {
                await sp.appendAnalysisText(text)
              } else if (sp.inProgressMode() && p !== undefined) {
                await this.send(p, replyCtx, text)
              } else if (sp.canPreview()) {
                await sp.appendText(text)
              }
            }
          }
          const eventSessionID = event.sessionID ?? ''
          if (eventSessionID !== '') {
            if (session.compareAndSetAgentSessionID(eventSessionID, this.agent.name())) {
              const pendingName = session.getName()
              if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
                sessions.setSessionName(eventSessionID, pendingName)
              }
              sessions.save()
            }
          }
          break
        }

        case 'permission_request': {
          const isAskQuestion = event.toolName === 'AskUserQuestion'
          const autoApprove = state.approveAll

          // Auto-approve: approveAll is set and this is not AskUserQuestion
          // and not ExitPlanMode (the user must always review plan changes).
          if (autoApprove && !isAskQuestion && event.toolName !== 'ExitPlanMode') {
            if (state.agentSession !== undefined) {
              const autoInput = event.toolInputRaw ?? {}
              void state.agentSession.respondPermission(event.requestID ?? '', {
                behavior: 'allow',
                updatedInput: autoInput,
              }).catch(() => {})
            }
            break
          }

          // Check if this unsolicited permission should surface to the user.
          // Non-surfaced permissions (background Bash without approveAll) are
          // auto-denied so the agent can continue without hanging.
          if (!this.shouldSurfaceUnsolicitedPermission(event.toolName ?? '', isAskQuestion, false, autoApprove)) {
            if (state.agentSession !== undefined) {
              void state.agentSession.respondPermission(event.requestID ?? '', {
                behavior: 'deny',
                message: buildDenyMessage(''),
              }).catch(() => {})
            }
            break
          }

          // Surface: create pending permission and send card.
          let resolveFn!: () => void
          const resolved = new Promise<void>((r) => { resolveFn = r })
          const pending: PendingPermission = {
            requestID: event.requestID ?? '',
            toolName: event.toolName ?? '',
            toolInput: event.toolInputRaw ?? {},
            inputPreview: event.toolInput ?? '',
            questions: [],
            answers: new Map<number, string>(),
            currentQuestion: 0,
            denied: false,
            resolved,
            resolve: resolveFn,
          }
          state.pending = pending
          state.permissionPending = true

          // Send the appropriate prompt card.
          if (isAskQuestion && p !== undefined) {
            // Extract questions from toolInputRaw (set by the adapter's
            // userQuestions provider); fall back to a generic question.
            type RawQ = {
              question: string
              header?: string
              options?: Array<{ label: string; description?: string }>
              multiSelect?: boolean
            }
            const rawQs = event.toolInputRaw?.questions as RawQ[] | undefined
            const questions: UserQuestion[] = rawQs !== undefined && rawQs.length > 0
              ? rawQs.map(q => ({
                question: q.question,
                header: q.header ?? '',
                options: (q.options ?? []).map(o => ({
                  label: o.label,
                  description: o.description ?? '',
                })),
                multiSelect: q.multiSelect ?? false,
              }))
              : [{
                question: event.content || 'Question',
                header: '',
                options: [],
                multiSelect: false,
              }]
            pending.questions = questions
            void this.sendAskQuestionPrompt(p, replyCtx, questions, 0)
          } else if (p !== undefined) {
            const permLimit = this.display.toolMaxLen
            const rawInput = event.toolInput ?? ''
            const toolInput = permLimit > 0
              ? truncateIf(rawInput, Math.floor(permLimit * 8 / 5))
              : rawInput
            const toolName = event.toolName ?? ''
            const prompt = this.i18n.tf(MsgPermissionPrompt, toolName, toolInput)
            void this.sendPermissionPrompt(p, replyCtx, prompt, toolName, toolInput)
          }

          // Block on the user's response (Go select on pending.Resolved /
          // stopCh). The loop stays parked here so post-answer events flow
          // through this same loop; the receive-race's channel-closed branch
          // never fires because we await before the next receive.
          await Promise.race([
            resolved,
            state.stopSignal(),
          ])
          state.permissionPending = false
          break
        }

        case 'result': {
          const finished = await this.handleResultEvent(
            state, session, sessions, sessionKey, replyCtx, event,
            textParts, segmentStart, toolCount, pendingSend, sp, cp, barrier)
          if (finished.kind === 'queued') {
            // A queued message takes over this loop as a fresh turn (Go
            // in-loop drain): reset per-turn state and continue.
            textParts = []
            segmentStart = 0
            toolCount = 0
            silentHold = false
            activeToolCalls = 0
            state.activeToolCalls = 0
            thinkingStreamed = false
            thinkingAccum = ''
            deltaAccum = ''
            deltaFlushed = false
            pendingSend = finished.sendDone
            if (state.agentSession !== undefined) recvP = state.agentSession.events().receive()
            state.lastEventAt = Date.now()
            continue
          }
          return
        }

        case 'error': {
          state.eventsNeedResync = true
          await sp.markFailed()
          if (event.error !== undefined && p !== undefined) {
            await this.send(p, replyCtx, this.i18n.tf(MsgError, event.error.message))
          }
          if (state.agentSession === undefined || !state.agentSession.alive()) {
            this.notifyDroppedQueuedMessages(state, event.error ?? new Error('agent error'))
          }
          return
        }

        default:
          break
      }
    }
  }

  /** Whether the idle fire reflects a genuine stall (Go stallConfirmed). */
  stallConfirmed(state: InteractiveState, now: number, idle: number): boolean {
    const last = state.lastEventAt
    if (last === 0) return true
    return now - last >= idle
  }

  /**
   * EventResult handling: persist IDs, silent-marker handling, side-channel
   * dedup, final delivery, and the in-loop queued-turn arm.
   */
  private async handleResultEvent(
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    _sessionKey: string,
    replyCtx: unknown,
    event: Event,
    textParts: string[],
    segmentStart: number,
    toolCount: number,
    pendingSend: Promise<unknown> | undefined,
    sp: StreamPreview,
    cp: CompactProgressWriter,
    barrier: () => Promise<void>,
  ): Promise<{ kind: 'done' } | { kind: 'queued'; sendDone: Promise<unknown> }> {
    // Persist via the live session id (event.sessionID may be empty).
    if (state.agentSession !== undefined) {
      const currentID = state.agentSession.currentSessionID()
      if (currentID !== '') {
        if (session.compareAndSetAgentSessionID(currentID, this.agent.name())) {
          const pendingName = session.getName()
          if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
            sessions.setSessionName(currentID, pendingName)
          }
        }
      }
    }
    state.eventsNeedResync = false
    state.permissionPending = false

    let fullResponse = event.content
    const sdkResult = event.content.trim()
    const joined = textParts.length > 0 ? textParts.join('') : ''
    const preferJoined = (textParts.length > 0 && segmentStart === 0 && !this.display.toolMessages)
      || (fullResponse === '' && textParts.length > 0)
      // A bare NO_REPLY final segment does not retroactively swallow earlier
      // substantive text — fall back to the accumulated reply.
      || (textParts.length > 0 && isSilentReply(fullResponse))
    if (preferJoined) fullResponse = joined
    if (fullResponse === '') {
      fullResponse = event.errorText !== undefined && event.errorText !== ''
        ? this.i18n.tf(MsgError, event.errorText)
        : this.i18n.t(MsgSilentReply)
    }

    const baseResponse = fullResponse.replace(/[ \n]+$/, '')
    session.addHistory('assistant', baseResponse)
    if (sdkResult !== '') session.setLastResult(sdkResult)
    sessions.save()

    let isSilent = isSilentReply(baseResponse)
    let cleanResponse = baseResponse
    if (!isSilent) {
      const [stripped, ok] = stripTrailingSilent(baseResponse)
      if (ok) {
        if (stripped.trim() === '') isSilent = true
        else cleanResponse = stripped
      }
    }

    // First-turn fallback: if this is a delegated subtask session and the
    // agent finished without explicitly reporting, push the result to the
    // parent so it is never lost. One-shot (Go maybeAutoReportSubtask).
    this.maybeAutoReportSubtask(state, session, session.lastResultOrReply(), isSilent)

    const p = state.platform
    const normalizedBase = baseResponse.trim()
    const suppressDuplicate = normalizedBase !== '' && normalizedBase === state.sideText
    state.sideText = ''

    /** Whether the final card landed; the ✅ notification follows it. */
    let sendCompletionNotification = false
    if (isSilent) {
      await sp.setAnalysisText(this.i18n.t(MsgSilentReply))
      await sp.markCompleted()
      await sp.detachPreview()
      sendCompletionNotification = true
    } else if (p !== undefined) {
      if (suppressDuplicate) {
        // The side channel already delivered this exact text; only the
        // appended metadata (footer) is worth sending.
        await sp.discard()
        const metaOnly = cleanResponse.startsWith(baseResponse)
          ? cleanResponse.slice(baseResponse.length).trim()
          : cleanResponse.trim()
        if (metaOnly !== '') {
          for (const chunk of splitMessage(metaOnly, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
        sendCompletionNotification = true
      } else if (toolCount > 0 && segmentStart > 0 && !sp.inProgressMode()) {
        // Prior segments were already surfaced between tools; deliver only
        // the unsent remainder.
        await sp.discard()
        const unsent = textParts.slice(segmentStart).join('')
        const [uStripped, uOk] = stripTrailingSilent(unsent)
        const deliver = uOk ? uStripped : unsent
        if (deliver !== '') {
          for (const chunk of splitMessage(deliver, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
        sendCompletionNotification = true
      } else if (sp.inProgressMode()) {
        if (sp.isDegraded()) {
          await sp.discard()
          await sp.deliverAnswer(fullResponse)
        } else {
          // Keep 实时播报 on the last streamed segment; only fall back to
          // the full response when nothing was streamed live.
          await sp.setAnalysisTextIfEmpty(fullResponse)
          await sp.markCompleted()
          await sp.detachPreview()
        }
        sendCompletionNotification = true
      } else if (await sp.finish(fullResponse)) {
        // Finalized in place via the stream preview.
        sendCompletionNotification = true
      } else if (cleanResponse !== '') {
        for (const chunk of splitMessage(cleanResponse, MaxPlatformMessageLen)) {
          await this.send(p, replyCtx, chunk)
        }
        sendCompletionNotification = true
      }
    }

    // Guarantee the terminal PATCH has landed before the ✅ notification so
    // the progress card is not still mid-state when the push arrives.
    await barrier()
    void cp
    if (sendCompletionNotification && p !== undefined && state.pendingMessages.length === 0) {
      const notifier = asCompletionNotifier(p)
      if (notifier !== undefined) {
        let usageMsg = this.i18n.t(MsgTurnCompleted)
        const inTok = event.totalInputTokens ?? 0
        const outTok = event.outputTokens ?? 0
        if (inTok > 0 || outTok > 0) usageMsg += ` · tokens ${inTok}+${outTok}`
        try {
          await notifier.sendCompletionNotification(replyCtx, usageMsg)
        } catch (error) {
          console.warn(`completion notification failed: ${String(error)}`)
        }
      }
    }

    // Queued messages take over this loop as a fresh turn (Go in-loop drain).
    const queued = state.pendingMessages.shift()
    if (queued !== undefined) {
      state.platform = queued.platform
      state.replyCtx = queued.replyCtx
      state.fromVoice = queued.fromVoice
      state.turnSeq++
      if (this.debounceInterval > 0) await this.debounceWaitAndMerge(state, queued)

      if (state.agentSession === undefined || !state.agentSession.alive()) {
        state.inflightMessage = undefined
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(MsgError, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        return { kind: 'done' }
      }
      state.agentSession.events().drain()
      if (pendingSend !== undefined) await pendingSend.catch(() => undefined)

      const queuedPrompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)
      session.addHistory('user', queued.content)
      state.inflightMessage = queued
      this.i18n.detectAndSet(queued.content)
      const sendDone = state.agentSession.send(queuedPrompt, queued.images, queued.files)
        .then((): undefined => undefined, (error: unknown): unknown => error)
      return { kind: 'queued', sendDone }
    }
    if (pendingSend !== undefined) await pendingSend.catch(() => undefined)
    return { kind: 'done' }
  }

  /** Channel-closed: notify the user and deliver any partial reply (Go channelClosed). */
  private async handleChannelClosed(
    state: InteractiveState,
    session: Session,
    sessionKey: string,
    textParts: string[],
    segmentStart: number,
    toolCount: number,
    replyCtx: unknown,
  ): Promise<void> {
    const unexpectedExit = !state.stopped
    const closedPlatform = state.platform
    state.eventsNeedResync = true
    this.notifyDroppedQueuedMessages(state, new Error('agent process exited'))
    await this.cleanupInteractiveState(sessionKey, state)

    if (unexpectedExit && closedPlatform !== undefined) {
      await this.send(closedPlatform, replyCtx, this.i18n.t(MsgAgentProcessExited))
    }

    if (textParts.length > 0) {
      let fullResponse = textParts.join('')
      session.addHistory('assistant', fullResponse)

      // Mirror the EventResult turn-end hook: without an EventResult (the
      // process exited mid-turn) the subtask result would never report to
      // the parent, deadlocking a gather (Go engine_events.go channel-closed
      // path).
      this.maybeAutoReportSubtask(state, session, fullResponse, isSilentReply(fullResponse))

      if (isSilentReply(fullResponse)) return
      const [stripped, ok] = stripTrailingSilent(fullResponse)
      if (ok && stripped.trim() === '') return
      if (ok) fullResponse = stripped

      const p = closedPlatform
      if (p === undefined) return
      if (toolCount > 0 && segmentStart > 0) {
        const unsent = textParts.slice(segmentStart).join('')
        const [uStripped, uOk] = stripTrailingSilent(unsent)
        const deliver = uOk ? uStripped : unsent
        if (deliver !== '') {
          for (const chunk of splitMessage(deliver, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
      } else {
        for (const chunk of splitMessage(fullResponse, MaxPlatformMessageLen)) {
          await this.send(p, replyCtx, chunk)
        }
      }
    }
  }

  // ── stall retry ─────────────────────────────────────────────────────────

  /**
   * Kill the stalled agent session and start a fresh resume, re-injecting the
   * per-session env and per-chat workDir override (Go
   * restartAgentForStallRetry).
   */
  private async restartAgentForStallRetry(
    state: InteractiveState, replyAgent: Agent, sessionKey: string,
    oldEvents: { drain(): void },
  ): Promise<AgentSession | undefined> {
    const resumeID = state.agentSession?.currentSessionID() ?? ''
    console.info(`stall retry: restarting with re-injected env resume=${resumeID}`)

    try {
      await state.agentSession?.close()
    } catch (error) {
      console.warn(`stall retry: close failed: ${String(error)}`)
    }
    oldEvents.drain()

    const retryEnv = state.sessionEnv
    const retryMode = state.effectiveMode
    // Restore per-chat workDir override so --resume finds the session under
    // the correct directory (Go stall-retry applyWorkDirOverride).
    const restoreWorkDir = this.applyWorkDirOverride(replyAgent, sessionKey)
    try {
      const newSess = await this.startAgentLocked(replyAgent, resumeID, retryEnv, retryMode)
      state.agentSession = newSess
      state.eventsNeedResync = false
      return newSess
    } catch (error) {
      console.error(`stall retry: failed to create new session: ${String(error)}`)
      return undefined
    } finally {
      restoreWorkDir()
    }
  }

  // ── queue drain ─────────────────────────────────────────────────────────

  /**
   * Process queued messages sequentially; each dispatched turn drains further
   * arrivals inside its own event loop. Returns true when the session lock
   * was released here (Go drainPendingMessages semantics).
   */
  async drainPendingMessages(state: InteractiveState, session: Session, sessions: SessionManager, sessionKey: string): Promise<boolean> {
    for (;;) {
      const queued = state.pendingMessages.shift()
      if (queued === undefined) {
        session.unlock()
        return true
      }
      state.inflightMessage = queued
      state.platform = queued.platform
      state.replyCtx = queued.replyCtx
      state.fromVoice = queued.fromVoice

      // Re-arm the one-shot subtask auto-report for a message that queued
      // behind a busy turn: the busy turn's auto-report already consumed any
      // re-arm, so without this the drained turn's result would never report
      // back (Go rearmSubtaskReportOnDrain).
      this.rearmSubtaskReportOnDrain(session, sessions)

      if (this.debounceInterval > 0) await this.debounceWaitAndMerge(state, queued)

      this.i18n.detectAndSet(queued.content)
      const prompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)

      if (state.agentSession === undefined || !state.agentSession.alive()) {
        state.inflightMessage = undefined
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(MsgError, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        session.unlock()
        return false
      }

      state.agentSession.events().drain()
      session.addHistory('user', queued.content)

      const sendDone = state.agentSession.send(prompt, queued.images, queued.files)
        .then((): undefined => undefined, (error: unknown): unknown => error)
      try {
        await this.processInteractiveEvents(state, session, sessions, sessionKey, '', sendDone, queued.replyCtx)
      } catch (error) {
        console.error(`engine: queued turn failed (${sessionKey}): ${String(error)}`)
      }
      state.inflightMessage = undefined
    }
  }

  /** Drain orphaned queue after the turn processor already exited. */
  async drainOrphanedQueue(session: Session, sessions: SessionManager, interactiveKey: string): Promise<void> {
    let unlocked = false
    try {
      const state = this.interactiveStates.get(interactiveKey)
      if (state === undefined || state.agentSession === undefined || !state.agentSession.alive()) {
        if (state !== undefined) {
          this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        }
        session.unlock()
        unlocked = true
        return
      }
      if (await this.drainPendingMessages(state, session, sessions, interactiveKey)) unlocked = true
    } finally {
      if (!unlocked) session.unlock()
    }
  }

  /**
   * Wait up to the debounce interval, merging rapid-fire queued messages
   * into the lead with "\n\n---\n\n" separators; a merge re-arms the window
   * (Go debounceWaitAndMerge).
   */
  private async debounceWaitAndMerge(state: InteractiveState, lead: QueuedMessage): Promise<void> {
    let deadline = Date.now() + this.debounceInterval
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      await Promise.race([plainSleep(Math.min(remaining, 10)), Promise.resolve()])
      const next = state.pendingMessages.shift()
      if (next === undefined) continue
      lead.content += `\n\n---\n\n${next.content}`
      lead.images = [...lead.images, ...next.images]
      lead.files = [...lead.files, ...next.files]
      deadline = Date.now() + this.debounceInterval
    }
  }

  /** Tell each queued sender their message will never be processed. */
  notifyDroppedQueuedMessages(state: InteractiveState, reason: Error): void {
    const remaining = state.pendingMessages
    state.pendingMessages = []
    for (const q of remaining) {
      void this.send(q.platform, q.replyCtx, this.i18n.tf(MsgError, reason.message))
    }
  }

  // ── cleanup ─────────────────────────────────────────────────────────────

  /**
   * Remove the interactive state and close its agent session. With an
   * expected state, cleanup is skipped when the map entry was replaced
   * (stale-goroutine guard, Go cleanupInteractiveState). The map entry is
   * deleted only after the agent session finished closing.
   */
  async cleanupInteractiveState(sessionKey: string, expected?: InteractiveState): Promise<void> {
    const state = this.interactiveStates.get(sessionKey)
    if (expected !== undefined && state !== undefined && state !== expected) return

    let agentSession: AgentSession | undefined
    let closingResolve: (() => void) | undefined
    if (state !== undefined) {
      agentSession = state.agentSession
      state.agentSession = undefined
      if (agentSession !== undefined) {
        state.closing = new Promise<void>((resolve) => { closingResolve = resolve })
      }
    }

    try {
      if (state !== undefined) {
        state.markStopped()
        this.notifyDroppedQueuedMessages(state, new Error('session reset'))
      }
      if (agentSession !== undefined) {
        await this.closeAgentSessionWithTimeout(sessionKey, agentSession)
      }
    } finally {
      if (closingResolve !== undefined) closingResolve()
    }

    const current = this.interactiveStates.get(sessionKey)
    if (expected !== undefined && current !== undefined && current !== expected) return
    this.interactiveStates.delete(sessionKey)
  }

  /** Close with a bounded wait so a hung process cannot wedge cleanup. */
  private async closeAgentSessionWithTimeout(sessionKey: string, agentSession: AgentSession): Promise<void> {
    await Promise.race([
      agentSession.close(),
      cancellableSleep(agentCloseTimeout).promise,
    ]).catch((error: unknown) => {
      console.error(`engine: agent session close failed (${sessionKey}): ${String(error)}`)
    })
  }

  /**
   * User-initiated stop (/stop, /new, /switch): flag userStopped, detach the
   * state, resolve queued senders, and close the agent session
   * asynchronously (Go stopInteractiveSession, M1 subset).
   */
  stopInteractiveSession(sessionKey: string): boolean {
    const state = this.interactiveStates.get(sessionKey)
    if (state === undefined) return false

    state.userStopped = true
    state.markStopped()
    this.interactiveStates.delete(sessionKey)
    this.notifyDroppedQueuedMessages(state, new Error('session reset'))
    if (state.agentSession !== undefined) {
      void state.agentSession.close().catch((error: unknown) => {
        console.error(`engine: stop close failed (${sessionKey}): ${String(error)}`)
      })
    }
    return true
  }

  // ── idle reaper ─────────────────────────────────────────────────────────

  /** Reclaim interactiveStates idle beyond the threshold (Go reaper). */
  reapIdleInteractiveStates(): void {
    if (this.interactiveIdleTimeout <= 0) return
    const cutoff = Date.now() - this.interactiveIdleTimeout
    const targets: Array<[string, InteractiveState]> = []
    for (const [key, state] of this.interactiveStates) {
      if (state.activeTurns > 0) continue
      // Skip sessions waiting for a permission response — the user may take
      // a long time to decide, and reaping would lose the pending prompt.
      if (state.pending !== undefined) continue
      if (state.lastActivity !== 0 && state.lastActivity < cutoff) targets.push([key, state])
    }
    for (const [key, state] of targets) {
      console.info(`reaping idle interactive state (${key})`)
      void this.cleanupInteractiveState(key, state)
    }
  }

  // ── proactive sends (cc-connect send tool surface) ──────────────────────

  /** Send text to a session by key (Go SendToSession). */
  async sendToSession(sessionKey: string, message: string): Promise<void> {
    return this.sendToSessionWithAttachments(sessionKey, message, [], [])
  }

  /**
   * Send text/attachments to a session by key, recording sideText for the
   * result-path duplicate suppression (Go SendToSessionWithAttachments,
   * M1 subset: text + raw image/file sends, no card composition).
   */
  async sendToSessionWithAttachments(
    sessionKey: string, message: string,
    images: ImageAttachment[], files: FileAttachment[],
  ): Promise<void> {
    let state: InteractiveState | undefined
    if (sessionKey !== '') {
      state = this.interactiveStates.get(sessionKey)
    } else if (this.interactiveStates.size === 1) {
      state = [...this.interactiveStates.values()][0]
    } else if (this.interactiveStates.size > 1 && (images.length > 0 || files.length > 0)) {
      throw new Error('multiple active sessions; must specify --session to send attachments')
    } else {
      state = [...this.interactiveStates.values()][0]
    }

    let p = state?.platform
    let replyCtx = state?.replyCtx
    if (p === undefined && sessionKey !== '') {
      const platformName = extractPlatformName(sessionKey)
      const target = this.platforms.find(candidate => candidate.name() === platformName)
      if (target !== undefined) {
        const reconstructed = await (target as ReconstructingPlatform).reconstructReplyCtx?.(sessionKey)
        if (reconstructed !== undefined) {
          p = target
          replyCtx = reconstructed
        }
      }
    }
    if (p === undefined) throw new Error(`no active session found (key="${sessionKey}")`)
    if (message === '' && images.length === 0 && files.length === 0) {
      throw new Error('message or attachment is required')
    }
    if ((images.length > 0 || files.length > 0) && !this.attachmentSendEnabled) {
      throw new ErrAttachmentSendDisabled()
    }

    // Capability checks BEFORE any send so a failure delivers nothing.
    const media = p as MediaPlatform
    if (images.length > 0 && typeof media.sendImage !== 'function') {
      throw new Error(`platform ${p.name()}: operation not supported by this platform`)
    }
    if (files.length > 0 && typeof media.sendFile !== 'function') {
      throw new Error(`platform ${p.name()}: operation not supported by this platform`)
    }

    if (message !== '') {
      await p.send(replyCtx, message)
      if (state !== undefined && (images.length > 0 || files.length > 0)) {
        state.sideText = message.trim()
      }
    }
    for (const img of images) await media.sendImage?.(replyCtx, img)
    for (const file of files) await media.sendFile?.(replyCtx, file)
  }

  // ---------------------------------------------------------------------
  // Active-preview bump routing (chat rename/avatar system notices push the
  // preview card off the tail; bump reissues it as the latest message)
  // ---------------------------------------------------------------------

  private activePreview: StreamPreview | undefined
  private activePreviewSession = ''
  private bumpTimer: ReturnType<typeof setTimeout> | undefined

  /** Bind the session's active preview for bump routing (Go bindActivePreview). */
  // ── cron execution (Go engine.go ExecuteCronJob / executeCronShell) ─────

  /**
   * Run one cron job: resolve the target platform from the stored session
   * key, reconstruct a proactive reply context, notify the chat (unless
   * silent/muted), then either run the shell command or inject the prompt as
   * a synthetic user message. Mute wraps the platform so nothing is sent.
   * Multi-workspace agent selection is not ported (single workspace); an
   * explicit job workDir switches the agent's work dir for the run instead.
   */
  async executeCronJob(job: CronJob): Promise<void> {
    let sessionKey = job.sessionKey
    let platformName = ''
    const idx = sessionKey.indexOf(':')
    if (idx > 0) platformName = sessionKey.slice(0, idx)

    let targetPlatform: Platform | undefined
    for (const p of this.platforms) {
      if (p.name() === platformName) {
        targetPlatform = p
        break
      }
    }
    // Fallback: a stored key may carry a workspace prefix (e.g.
    // "/home/user/project:slack:C123:U456") — locate a known platform name
    // inside the key and strip the prefix.
    if (targetPlatform === undefined) {
      for (const p of this.platforms) {
        const needle = `:${p.name()}:`
        const i = sessionKey.indexOf(needle)
        if (i >= 0) {
          targetPlatform = p
          platformName = p.name()
          sessionKey = sessionKey.slice(i + 1)
          break
        }
      }
    }
    if (targetPlatform === undefined) {
      throw new Error(`platform "${platformName}" not found for session "${job.sessionKey}"`)
    }

    const rc = asReplyContextReconstructor(targetPlatform)
    if (rc === undefined) {
      throw new Error(`platform "${platformName}" does not support proactive messaging (cron)`)
    }

    let runSessionKey = sessionKey
    let replyCtx: unknown
    if (!job.mute) {
      const resolver = asCronReplyTargetResolver(targetPlatform)
      if (resolver !== undefined) {
        try {
          const resolved = await resolver.resolveCronReplyTarget(sessionKey, cronRunTitle(job))
          if (resolved[0] !== '') runSessionKey = resolved[0]
          if (resolved[1] !== undefined) replyCtx = resolved[1]
        } catch (error) {
          if (!(error instanceof ErrNotSupported)) {
            throw new Error(`resolve cron reply target: ${errorMessage(error)}`)
          }
        }
      }
    }
    if (replyCtx === undefined) {
      try {
        replyCtx = await rc.reconstructReplyCtx(runSessionKey)
      } catch (error) {
        throw new Error(`reconstruct reply context: ${errorMessage(error)}`)
      }
    }

    // Wrap the platform to discard all outgoing messages when muted.
    const effectivePlatform = job.mute ? mutePlatform(targetPlatform) : targetPlatform

    // Notify the user that a cron job is executing (unless silent/muted).
    if (!job.mute) {
      const silent = this.cronScheduler !== undefined && this.cronScheduler.isSilent(job)
      if (!silent) {
        let desc = job.description
        if (desc === '') {
          desc = job.isShellJob() ? truncateStr(job.exec, 40) : truncateStr(job.prompt, 40)
        }
        await this.send(targetPlatform, replyCtx, `⏰ ${desc}`)
      }
    }

    if (job.isShellJob()) {
      await this.executeCronShell(effectivePlatform, replyCtx, job)
      return
    }

    const msg: Message = {
      sessionKey,
      platform: platformName,
      messageID: '',
      userID: 'cron',
      userName: 'cron',
      chatName: '',
      chatType: '',
      content: job.prompt,
      originalContent: job.prompt,
      images: [],
      files: [],
      extraContent: '',
      replyCtx,
      fromVoice: false,
      isSpawnedGroup: false,
      isPermissionAction: false,
      isAskqCardAction: false,
      isCardAction: false,
      parentMessageID: '',
      quotedText: '',
      modeOverride: job.mode,
    }

    // An explicit job workDir switches the agent's working directory for
    // this run (Go getOrCreateWorkspaceAgent; single-workspace ceiling — a
    // per-workspace agent instance arrives with the workspace milestone).
    let restoreWorkDir: (() => void) | undefined
    if (job.workDir !== '') {
      const wd = asWorkDirSwitcher(this.agent)
      if (wd !== undefined) {
        const prev = wd.getWorkDir()
        wd.setWorkDir(job.workDir)
        restoreWorkDir = () => { wd.setWorkDir(prev) }
      } else {
        console.warn(`cron: agent cannot switch work dir, using global (${job.workDir} / ${sessionKey})`)
      }
    }

    const useNewSession = this.cronScheduler !== undefined
      ? this.cronScheduler.usesNewSession(job)
      : job.usesNewSessionPerRun()

    try {
      if (useNewSession) {
        msg.sessionKey = runSessionKey
        const session = this.sessions.newSideSession(runSessionKey, `cron-${job.id}`)
        if (!session.tryLock()) {
          throw new Error(`session "${runSessionKey}" is busy`)
        }
        const iKey = `${runSessionKey}#cron:${session.id}`
        await this.processInteractiveMessageWith(effectivePlatform, msg, session, iKey)
        await this.cleanupInteractiveState(iKey)
        return
      }

      const session = this.sessions.getOrCreateActive(sessionKey)
      if (!session.tryLock()) {
        throw new Error(`session "${sessionKey}" is busy`)
      }
      await this.processInteractiveMessageWith(effectivePlatform, msg, session)
    } finally {
      restoreWorkDir?.()
    }
  }

  /** Run a shell cron job and send the output to the chat (Go executeCronShell). */
  async executeCronShell(p: Platform, replyCtx: unknown, job: CronJob): Promise<void> {
    let workDir = job.workDir
    if (workDir === '') {
      const wd = asWorkDirSwitcher(this.agent)
      if (wd !== undefined) workDir = wd.getWorkDir()
    }
    if (workDir === '') workDir = process.cwd()

    const timeoutMs = job.executionTimeoutMs()
    const ac = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => { ac.abort() }, timeoutMs) : undefined
    timer?.unref()
    try {
      const outcome = await new Promise<{ out: string; err: unknown }>((resolve) => {
        let out = ''
        const child = spawn('sh', ['-c', job.exec], { cwd: workDir, signal: ac.signal })
        child.stdout.on('data', (d: Buffer) => { out += d.toString() })
        child.stderr.on('data', (d: Buffer) => { out += d.toString() })
        child.on('error', (err: Error) => { resolve({ out, err }) })
        child.on('close', (code, signal) => {
          if (ac.signal.aborted) {
            resolve({ out, err: new Error('shell command timed out') })
            return
          }
          resolve({ out, err: code === 0 ? undefined : new Error(`exit status ${code ?? signal}`) })
        })
      })
      if (ac.signal.aborted) {
        await this.send(p, replyCtx, `⏰ ⚠️ timeout: \`${truncateStr(job.exec, 60)}\``)
        throw new Error('shell command timed out')
      }
      const result = outcome.out.trim()
      if (outcome.err !== undefined) {
        if (result !== '') {
          await this.send(p, replyCtx, `⏰ ❌ \`${truncateStr(job.exec, 60)}\`\n\n${truncateStr(result, 3000)}\n\nerror: ${errorMessage(outcome.err)}`)
        } else {
          await this.send(p, replyCtx, `⏰ ❌ \`${truncateStr(job.exec, 60)}\`\nerror: ${errorMessage(outcome.err)}`)
        }
        throw new Error(`shell: ${errorMessage(outcome.err)}`)
      }
      const text = result === '' ? '(no output)' : result
      await this.send(p, replyCtx, `⏰ ✅ \`${truncateStr(job.exec, 60)}\`\n\n${truncateStr(text, 3000)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  // ── bot-to-bot relay (Go engine_cmd_relay.go HandleRelay) ───────────────

  /**
   * Handle one relayed message on a dedicated `relay:<from>:<chat>` session:
   * start/resume the agent (falling back to a fresh session on a stale
   * resume), auto-approve every permission, and collect text until the turn
   * result. `signal` only bounds how long the caller waits — the agent
   * finishes its turn in the background via drainRelaySession so the session
   * stays resumable.
   */
  async handleRelay(signal: AbortSignal | undefined, fromProject: string, chatID: string, message: string): Promise<string> {
    const relaySessionKey = `relay:${fromProject}:${chatID}`
    const session = this.sessions.getOrCreateActive(relaySessionKey)

    const relayEnv = this.buildSessionEnv(relaySessionKey, session)

    let agentSession: AgentSession
    try {
      agentSession = await this.startAgentLocked(this.agent, session.getAgentSessionID(), relayEnv, '')
    } catch (error) {
      if (session.getAgentSessionID() !== '') {
        // Resume failed — fall back to a fresh session so the relay is not
        // permanently broken by a corrupted/stale session ID.
        console.warn(`relay: session resume failed, trying fresh session (${relaySessionKey}): ${errorMessage(error)}`)
        session.setAgentSessionID('', this.agent.name())
        this.sessions.save()
        try {
          agentSession = await this.startAgentLocked(this.agent, '', relayEnv, '')
        } catch (freshError) {
          throw new Error(`start relay session: ${errorMessage(freshError)}`)
        }
      } else {
        throw new Error(`start relay session: ${errorMessage(error)}`)
      }
    }

    const newID = agentSession.currentSessionID()
    if (newID !== '') {
      if (session.compareAndSetAgentSessionID(newID, this.agent.name())) {
        const pendingName = session.getName()
        if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
          this.sessions.setSessionName(newID, pendingName)
        }
        this.sessions.save()
      }
    }

    const rememberSessionID = (id: string): void => {
      if (id === '') return
      if (session.compareAndSetAgentSessionID(id, this.agent.name())) {
        const pendingName = session.getName()
        if (pendingName !== '' && pendingName !== 'session' && pendingName !== 'default') {
          this.sessions.setSessionName(id, pendingName)
        }
        this.sessions.save()
      }
    }

    try {
      await agentSession.send(message, [], [])
    } catch (error) {
      await agentSession.close()
      throw new Error(`send relay message: ${errorMessage(error)}`)
    }

    const textParts: string[] = []
    for (;;) {
      const r = await agentSession.events().receive()
      if (r.done) break
      const event = r.event
      switch (event.type) {
        case 'text':
          if (event.content !== '') textParts.push(event.content)
          if (event.sessionID !== undefined) rememberSessionID(event.sessionID)
          break
        case 'tool_result': {
          let out = event.content.trim()
          if (out === '') out = (event.toolResult ?? '').trim()
          if (out !== '') {
            const tn = (event.toolName ?? '').trim() || 'tool'
            textParts.push(`${this.i18n.tf(MsgToolResult, tn, out)}\n\n`)
          }
          break
        }
        case 'result': {
          rememberSessionID(agentSession.currentSessionID())
          let resp = event.content
          if (resp === '' && textParts.length > 0) resp = textParts.join('')
          if (resp === '') resp = '(empty response)'
          console.info(`relay: turn complete (from ${fromProject} to ${this.name}, response_len ${resp.length})`)
          await agentSession.close()
          return resp
        }
        case 'error':
          await agentSession.close()
          if (event.error !== undefined) throw event.error
          if (event.errorText !== undefined && event.errorText !== '') throw new Error(event.errorText)
          throw new Error('agent error (no details)')
        case 'permission_request': {
          // Auto-approve all permissions in relay mode.
          const allow: PermissionResult = { behavior: 'allow' }
          if (event.toolInputRaw !== undefined) allow.updatedInput = event.toolInputRaw
          try {
            await agentSession.respondPermission(event.requestID ?? '', allow)
          } catch (error) {
            console.warn(`relay: auto-approve respond permission failed (${event.requestID ?? ''}): ${String(error)}`)
          }
          break
        }
        default:
          break
      }
      if (signal?.aborted) {
        // Relay timed out. Let the agent finish its turn in the background
        // so the session state is saved cleanly and stays resumable.
        void this.drainRelaySession(agentSession, session, relaySessionKey)
        return relayPartialResponseOrError(signal, textParts)
      }
    }

    // Event channel closed without a result event.
    await agentSession.close()

    if (signal?.aborted) {
      return relayPartialResponseOrError(signal, textParts)
    }

    if (textParts.length > 0) return textParts.join('')
    throw new Error('relay: agent process exited without response')
  }

  /**
   * After a relay timeout, let the agent finish its current turn in the
   * background — saving the session ID for future resumption,
   * auto-approving permissions — with a 10-minute safety timeout so a hung
   * agent cannot leak the session (Go drainRelaySession).
   */
  private async drainRelaySession(agentSession: AgentSession, session: Session, relaySessionKey: string): Promise<void> {
    let timeoutHit: (() => void) | undefined
    const timeoutP = new Promise<'timeout'>((resolve) => { timeoutHit = () => { resolve('timeout') } })
    const timer = setTimeout(() => { timeoutHit?.() }, 10 * 60_000)
    timer.unref()
    try {
      for (;;) {
        const outcome = await Promise.race([
          agentSession.events().receive().then(r => ({ kind: 'recv' as const, r })),
          timeoutP.then(() => ({ kind: 'timeout' as const, r: undefined })),
        ])
        if (outcome.kind === 'timeout') {
          console.warn(`relay: background drain timed out, closing session (${relaySessionKey})`)
          await agentSession.close()
          return
        }
        if (outcome.r.done) {
          // Event channel closed — session ended naturally.
          await agentSession.close()
          return
        }
        const ev = outcome.r.event
        if (ev.sessionID !== undefined && ev.sessionID !== '') {
          session.setAgentSessionID(ev.sessionID, this.agent.name())
          this.sessions.save()
        }
        if (ev.type === 'result') {
          console.info(`relay: background drain completed (agent finished turn) (${relaySessionKey})`)
          await agentSession.close()
          return
        }
        if (ev.type === 'error') {
          console.warn(`relay: background drain got error (${relaySessionKey}): ${String(ev.error ?? ev.errorText ?? '')}`)
          await agentSession.close()
          return
        }
        if (ev.type === 'permission_request') {
          const allow: PermissionResult = { behavior: 'allow' }
          if (ev.toolInputRaw !== undefined) allow.updatedInput = ev.toolInputRaw
          try {
            await agentSession.respondPermission(ev.requestID ?? '', allow)
          } catch (error) {
            console.warn(`relay-drain: auto-approve respond permission failed (${ev.requestID ?? ''}): ${String(error)}`)
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  bindActivePreview(sp: StreamPreview, sessionKey: string): void {
    this.activePreview = sp
    this.activePreviewSession = sessionKey
  }

  /** Reissue the bound preview when it belongs to the given session. */
  bumpActivePreviewForSession(sessionKey: string): void {
    if (this.activePreview === undefined || this.activePreviewSession !== sessionKey) return
    void this.activePreview.bumpToEnd()
  }

  /**
   * Coalesce rapid im.chat.updated events (rename + avatar ~1.4s apart) into
   * one bump after the quiet window; only the last notice matters.
   */
  onChatChanged(sessionKey: string): void {
    if (this.bumpTimer !== undefined) clearTimeout(this.bumpTimer)
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = undefined
      this.bumpActivePreviewForSession(sessionKey)
    }, this.bumpDebounceInterval)
  }

  // ──────────────────────────────────────────────────────────────
  // M3: Permission / AskUserQuestion / ExitPlanMode
  // ──────────────────────────────────────────────────────────────

  /** Whether an unsolicited permission should surface to the user (Go shouldSurfaceUnsolicitedPermission). */
  shouldSurfaceUnsolicitedPermission(_toolName: string, isAskQuestion: boolean, stallRetried: boolean, autoApprove: boolean): boolean {
    return shouldSurfaceHelper(_toolName, isAskQuestion, stallRetried, autoApprove)
  }

  /** Resolve user input into an AskUserQuestion answer (Go resolveAskQuestionAnswer). */
  resolveAskQuestionAnswer(q: UserQuestion, input: string): string {
    return resolveAnswerHelper(q, input)
  }

  /**
   * Build updated tool input with collected answers (Go
   * buildAskQuestionResponse, package-level).
   */
  static buildAskQuestionResponse(
    originalInput: Record<string, unknown>,
    questions: UserQuestion[],
    collected: Map<number, string>,
  ): Record<string, unknown> {
    return buildAnswerHelper(originalInput, questions, collected)
  }

  /**
   * Read a plan file, truncate to `display.planMaxLen` if configured, and send
   * as plain text (Go sendPlanContent). Returns the (possibly truncated)
   * content string. When `planMaxLen` is 0, no truncation is applied.
   */
  sendPlanContent(
    p: Platform,
    replyCtx: unknown,
    _state: InteractiveState | undefined,
    filePath: string,
    _revision: number,
    _exportKey: string,
  ): string {
    let content = ''
    try {
      content = readFileSync(filePath, 'utf8').trim()
    } catch {
      return ''
    }
    // Plan truncation uses "..." (three ASCII dots) to match the Go plan card
    // rendering, distinct from truncateIf's unicode ellipsis.
    const maxLen = this.display.planMaxLen
    if (maxLen > 0) {
      const runes = Array.from(content)
      if (runes.length > maxLen) {
        content = `${runes.slice(0, maxLen).join('')}...`
      }
    }
    void this.send(p, replyCtx, content)
    return content
  }

  /**
   * Send a permission prompt card with Allow/Deny/AllowAll buttons
   * (Go sendPermissionPrompt). Falls back to inline buttons, then plain text.
   */
  async sendPermissionPrompt(p: Platform, replyCtx: unknown, prompt: string, toolName: string, toolInput: string): Promise<void> {
    // Try inline buttons first (Telegram-style platforms)
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function') {
      const buttons = [
        [
          { text: this.i18n.t(MsgPermBtnAllow), data: 'perm:allow' },
          { text: this.i18n.t(MsgPermBtnDeny), data: 'perm:deny' },
        ],
        [
          { text: this.i18n.t(MsgPermBtnAllowAll), data: 'perm:allow_all' },
        ],
      ]
      try {
        await ibs.sendWithButtons(replyCtx, prompt, buttons)
        return
      } catch {
        // fall through to card
      }
    }

    // Try card with buttons (Feishu-style platforms)
    const cs = p as Platform & CardSender
    if (typeof cs.sendCard === 'function') {
      const body = this.i18n.tf(MsgPermCardBody, toolName, toolInput)
      const allowBtn: CardButton = { text: this.i18n.t(MsgPermBtnAllow), type: 'primary', value: 'perm:allow', name: 'perm_allow', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(MsgPermBtnAllow)}`, perm_color: 'green', perm_body: body } }
      const denyBtn: CardButton = { text: this.i18n.t(MsgPermBtnDeny), type: 'danger', value: 'perm:deny', name: 'perm_deny', actionType: 'form_submit', extra: { perm_label: `❌ ${this.i18n.t(MsgPermBtnDeny)}`, perm_color: 'red', perm_body: body } }
      const allowAllBtn: CardButton = { text: this.i18n.t(MsgPermBtnAllowAll), type: 'default', value: 'perm:allow_all', name: 'perm_allow_all', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(MsgPermBtnAllowAll)}`, perm_color: 'green', perm_body: body } }

      const card = newCard()
        .title(`‼️ ${this.i18n.t(MsgPermCardTitle)}`, 'red')
        .form('perm_form',
          { kind: 'markdown', content: body },
          { kind: 'input', name: 'deny_reason', placeholder: this.i18n.t(MsgPermDenyReasonPlaceholder), maxLength: 1000 },
          { kind: 'actions', buttons: [allowBtn, allowAllBtn, denyBtn], layout: 'equal_columns' },
        )
        .build()
      card.permBody = body
      try {
        await cs.sendCard(replyCtx, card)
        return
      } catch {
        // fall through to plain text
      }
    }

    // Plain text fallback
    await this.send(p, replyCtx, prompt)
  }

  /**
   * Send an AskUserQuestion prompt card with option buttons
   * (Go sendAskQuestionPrompt). Falls back to inline buttons, then plain text.
   */
  async sendAskQuestionPrompt(p: Platform, replyCtx: unknown, questions: UserQuestion[], qIdx: number): Promise<void> {
    if (qIdx >= questions.length) return
    const q = questions[qIdx]
    if (q === undefined) return
    const total = questions.length
    const titleSuffix = total > 1 ? ` (${qIdx + 1}/${total})` : ''

    // Build option buttons for single-select
    const optionButtons: CardButton[] = q.options.map((opt, i) => ({
      text: opt.label,
      type: 'default',
      value: `askq:${qIdx}:${i + 1}`,
      extra: { askq_label: opt.label, askq_question: q.question },
    }))

    // Try card (Feishu-style platforms)
    const cs = p as Platform & CardSender
    if (typeof cs.sendCard === 'function') {
      const cardTitle = q.header !== '' ? q.header : this.i18n.t(MsgAskQuestionTitle)
      const cb = newCard().title(`‼️ ${cardTitle}${titleSuffix}`, 'blue')

      if (q.multiSelect) {
        // Multi-select: use checker + form for native checkbox experience
        const opts: CardCheckOption[] = q.options.map((opt, i) => ({
          label: opt.label,
          description: opt.description,
          value: String(i + 1),
        }))
        cb.checkOptions(q.question, opts, `askq_multi:${qIdx}`, { askq_question: q.question })
      } else {
        // Single-select: markdown question + option buttons
        cb.markdown(q.question)
        cb.buttonsEqual(...optionButtons)
      }

      try {
        await cs.sendCard(replyCtx, cb.build())
        return
      } catch {
        // fall through to inline buttons
      }
    }

    // Try inline buttons
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function') {
      const questionText = total > 1 ? `${q.question} (${qIdx + 1}/${total})` : q.question
      const buttons = optionButtons.map(b => [{ text: b.text, data: b.value }])
      try {
        await ibs.sendWithButtons(replyCtx, questionText, buttons)
        return
      } catch {
        // fall through to plain text
      }
    }

    // Plain text fallback
    const lines = [q.question]
    if (q.multiSelect) lines.push(this.i18n.t(MsgAskQuestionMulti))
    for (let i = 0; i < q.options.length; i++) {
      const opt = q.options[i]
      if (opt === undefined) continue
      lines.push(`${i + 1}) ${opt.label}${opt.description !== '' ? ` — ${opt.description}` : ''}`)
    }
    await this.send(p, replyCtx, lines.join('\n'))
  }

  /**
   * Route a permission response (allow/deny/approveAll/AskUserQuestion answer)
   * from the user or card callback (Go handlePendingPermission). Returns true
   * if the message was consumed as a permission response. Synchronous like the
   * Go original — async side-effects (reply, respondPermission) fire as
   * floating promises.
   */
  handlePendingPermission(p: Platform, msg: Message, content: string): boolean {
    // Parse optional deny reason: feishu encodes as "deny\x00<reason>"
    let denyReason = ''
    const nulIdx = content.indexOf('\x00')
    if (nulIdx >= 0) {
      denyReason = content.slice(nulIdx + 1).trim()
      content = content.slice(0, nulIdx)
    }

    const iKey = msg.sessionKey
    const state = this.interactiveStates.get(iKey)
    if (state === undefined) {
      if (msg.isPermissionAction) {
        const lower = content.toLowerCase().trim()
        if (isAllowResponse(lower) || isDenyResponse(lower) || isApproveAllResponse(lower)) {
          void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionExpired))
          return true
        }
      }
      return false
    }

    const pending = state.pending
    if (pending === undefined) {
      if (msg.isPermissionAction) {
        const lower = content.toLowerCase().trim()
        if (isAllowResponse(lower) || isDenyResponse(lower) || isApproveAllResponse(lower)) {
          void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionExpired))
          return true
        }
      }
      return false
    }

    // AskUserQuestion: interpret user response as an answer, not a permission decision
    if (pending.questions.length > 0) {
      if (content === '' && (msg.files.length > 0 || msg.images.length > 0)) {
        return false
      }

      const curIdx = pending.currentQuestion
      const q = pending.questions[curIdx]
      if (q === undefined) return false
      const answer = this.resolveAskQuestionAnswer(q, content)
      pending.answers.set(curIdx, answer)

      // More questions remaining — advance to next
      if (curIdx + 1 < pending.questions.length) {
        pending.currentQuestion = curIdx + 1
        if (!msg.isAskqCardAction) {
          void this.reply(p, msg.replyCtx, `✅ ${q.question}: **${answer}**`)
        }
        void this.sendAskQuestionPrompt(p, msg.replyCtx, pending.questions, curIdx + 1)
        return true
      }

      // All questions answered — build response and resolve
      const updatedInput = buildAnswerHelper(pending.toolInput, pending.questions, pending.answers)
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput }).catch(() => {})
      }
      if (!msg.isAskqCardAction) {
        void this.reply(p, msg.replyCtx, `✅ ${q.question}: **${answer}**`)
      }

      state.pending = undefined
      pending.resolve()
      state.lastEventAt = Date.now()
      return true
    }

    const lower = content.toLowerCase().trim()

    if (isApproveAllResponse(lower)) {
      state.approveAll = true
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput: pending.toolInput }).catch(() => {})
      }
    } else if (isAllowResponse(lower)) {
      // ExitPlanMode approval grants blanket approval for the rest of the turn
      if (pending.toolName === 'ExitPlanMode') {
        state.approveAll = true
        state.effectiveMode = 'default'
      }
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'allow', updatedInput: pending.toolInput }).catch(() => {})
      }
    } else if (isDenyResponse(lower)) {
      pending.denied = true
      const denyMessage = buildDenyMessage(denyReason)
      if (state.agentSession !== undefined) {
        void state.agentSession.respondPermission(pending.requestID, { behavior: 'deny', message: denyMessage }).catch(() => {})
      }
      // Denying ExitPlanMode resets approveAll
      if (pending.toolName === 'ExitPlanMode') {
        state.approveAll = false
      }
      // Card button deny: header already shows "❌ 已拒绝"; only send text for non-card deny
      if (!msg.isPermissionAction) {
        void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionDenied))
      }
    } else {
      void this.reply(p, msg.replyCtx, this.i18n.t(MsgPermissionHint))
      return true
    }

    state.pending = undefined
    pending.resolve()
    state.lastEventAt = Date.now()
    return true
  }

  // ──────────────────────────────────────────────────────────────
  // M4: subtask orchestration (Go engine_subtask.go + engine_cmd_session.go)
  // ──────────────────────────────────────────────────────────────

  /** Override the recursive delegation cap (Go SetSubtaskMaxDepth). */
  setSubtaskMaxDepth(n: number): void {
    if (n > 0) this.subtaskMaxDepth = n
  }

  /** Override default worktree isolation for /spawn //fork (Go SetSpawnWorktreeMode). */
  setSpawnWorktreeMode(s: string): void {
    this.spawnWorktree = parseWorktreeMode(s)
  }

  /** Configure the /spawn //fork RAM guard; 0 disables a tier (Go SetSpawnMemoryGuard). */
  setSpawnMemoryGuard(warnPct: number, blockPct: number): void {
    this.spawnMemWarnPct = warnPct
    this.spawnMemBlockPct = blockPct
  }

  /** Override the hard timeout for subtask sessions (Go SetSubtaskTimeout). */
  setSubtaskTimeout(ms: number): void {
    this.subtaskTimeout = ms
  }

  /** Override the gather barrier fallback timeout (Go SetSubtaskGatherTimeout). */
  setSubtaskGatherTimeout(ms: number): void {
    if (ms > 0) this.subtaskGatherTimeout = ms
  }

  /** Effective recursive delegation cap (Go maxSubtaskDepth). */
  maxSubtaskDepth(): number {
    return this.subtaskMaxDepth > 0 ? this.subtaskMaxDepth : defaultSubtaskMaxDepth
  }

  /** The first registered group-capable platform, or undefined (Go spawnCapablePlatform). */
  spawnCapablePlatform(): Platform | undefined {
    return this.platforms.find(p => asGroupSpawner(p) !== undefined)
  }

  /** Any platform that can reconstruct a reply context (report fallback). */
  private reportCapablePlatform(): Platform | undefined {
    const spawner = this.spawnCapablePlatform()
    if (spawner !== undefined) return spawner
    return this.platforms.find(p => asReplyContextReconstructor(p) !== undefined)
  }

  /**
   * Completion-card elements surfacing a subtask's code-change footprint
   * (one-line `git diff --shortstat`). Empty for depth-0 sessions and clean
   * working trees (Go subtaskDiffElements).
   */
  async subtaskDiffElements(session: Session | undefined, workspaceDir: string): Promise<CardMarkdownLike[]> {
    if (session === undefined || session.getSubtaskDepth() <= 0) return []
    const s = await gitDiffShortstat(workspaceDir)
    if (s === '') return []
    return [{ content: `${this.i18n.t(MsgSubtaskDiffSummary)}: ${s}` }]
  }

  /**
   * Create an isolated child group + session that runs a delegated piece of
   * work in parallel, woken from the agent via the subtask tool (Go
   * SpawnSubtask). Records parent linkage + delegation depth for the
   * event-driven result reinjection (see reportSubtask) and auto-isolates
   * the child in a git worktree when it shares the parent's repository.
   * @returns The child group's display name and session key.
   */
  async spawnSubtask(
    parentSessionKey: string,
    dir: string,
    wtPref: WorktreeMode,
    forkContext: boolean,
    message: string,
    images: ImageAttachment[],
    attended: boolean,
  ): Promise<{ childName: string; childKey: string }> {
    const p = this.spawnCapablePlatform()
    if (p === undefined) {
      throw new Error('subtask: no group-capable platform available')
    }
    const spawner = asGroupSpawner(p)
    if (spawner === undefined) {
      throw new Error(`subtask: platform "${p.name()}" cannot spawn groups`)
    }

    const firstMsg = message.trim()
    // Idle spawn (empty message): create the group + session record but do
    // NOT fire a first agent turn. Used by chatroom --research to pre-spawn
    // an assistant that idles until the role sends it a real task.
    const idle = firstMsg === ''
    if (idle && wtPref !== WorktreeMode.ForceOff) {
      throw new Error('subtask: idle spawn (empty message) requires --no-worktree')
    }

    const parent = this.sessions.getOrCreateActive(parentSessionKey)
    const depth = parent.getSubtaskDepth() + 1
    if (depth > this.maxSubtaskDepth()) {
      throw new Error(`subtask: delegation depth limit reached (max ${this.maxSubtaskDepth()}) — complete this part yourself`)
    }

    // Fork mode: the child inherits the parent's conversation context.
    // Require a real, started session to fork from — mirror cmdFork's guard.
    let forkOrigID = ''
    if (forkContext) {
      forkOrigID = parent.getAgentSessionID()
      if (forkOrigID === '' || forkOrigID === ContinueSession || forkOrigID.startsWith(ForkSessionPrefix)) {
        throw new Error('subtask: --fork needs a started parent conversation to copy context from')
      }
    }

    // Owning user for the new group: top-level chat keys embed it as the
    // third segment; recursive subtasks store it on the parent session.
    let userID = parent.getSpawnUserID()
    if (userID === '') {
      const parts = parentSessionKey.split(':')
      if (parts.length >= 3) {
        const third = parts.slice(2).join(':')
        if (!third.startsWith('thread:') && !third.startsWith('root:')) userID = third
      }
    }

    let groupName = firstMsg
    // With LLM rename on, create the group under a neutral placeholder (the
    // LLM overwrites it later, falling back to the first message); idle
    // spawns have no first message and use the placeholder too.
    if (this.groupNameEnabled || idle) {
      groupName = `${this.name} 副本`
    }
    if (Array.from(groupName).length > maxGroupNameRunes) {
      groupName = `${Array.from(groupName).slice(0, maxGroupNameRunes - 3).join('')}...`
    }

    // Resolve the child work dir, mirroring /dir resolution: parent's
    // per-chat override (or agent base dir), then an explicit --dir.
    let workDir = ''
    const override = this.perChatWorkDir(this.dirOverrideKey(parentSessionKey))
    if (override !== '') workDir = override
    else workDir = this.agentWorkDir()
    if (dir !== '') {
      const resolved = this.resolveDirPath(dir)
      if (resolved === undefined) {
        throw new Error(`subtask: --dir path invalid: ${dir}`)
      }
      workDir = resolved
    }

    // Worktree isolation: in auto mode, isolate only when the child shares
    // the parent's git repository. Fail fast before creating the group.
    let wtPath = ''
    let wtBranch = ''
    let wtBase = ''
    let wtRoot = ''
    let useWorktree = wtPref === WorktreeMode.ForceOn
    if (wtPref === WorktreeMode.Auto && workDir !== '') {
      const childRoot = await worktreeRepoRoot(workDir)
      if (childRoot !== undefined) {
        const parentDir = this.perChatWorkDir(this.dirOverrideKey(parentSessionKey))
        const parentRoot = parentDir === '' ? await worktreeRepoRoot(this.agentWorkDir()) : await worktreeRepoRoot(parentDir)
        if (parentRoot === childRoot) useWorktree = true
      }
    }
    if (useWorktree) {
      const root = await worktreeRepoRoot(workDir)
      if (root === undefined) {
        throw new Error(`subtask: --worktree requires a git repository, but ${workDir} is not inside one`)
      }
      let created: WorktreeCreateInfo
      try {
        created = await createWorktree(root, slugify(firstMsg))
      } catch (error) {
        throw new Error(`subtask: worktree create failed: ${String(error instanceof Error ? error.message : error)}`)
      }
      wtPath = created.path
      wtBranch = created.branch
      wtBase = created.baseSHA
      wtRoot = root
      workDir = created.path
    }

    // Cross-workdir fork guard: fail fast BEFORE creating the group so the
    // agent learns to drop -f and retry, leaving no orphan group (Go
    // SpawnSubtask's PrepareForkSession check).
    if (forkOrigID !== '') {
      const prep = asForkSessionPreparer(this.agent)
      if (prep !== undefined) {
        let parentWorkDir = this.perChatWorkDir(this.dirOverrideKey(parentSessionKey))
        if (parentWorkDir === '') parentWorkDir = this.agentWorkDir()
        try {
          await prep.prepareForkSession(forkOrigID, parentWorkDir, workDir)
        } catch (error) {
          throw new Error(`subtask: --fork 跨目录不可达：${String(error instanceof Error ? error.message : error)}（父群目录 "${parentWorkDir}" ≠ 子任务目录 "${workDir}"；跨目录请去掉 -f 用全新上下文派发）`)
        }
      }
    }

    const spawnMsg: Message = {
      ...emptyMessage(),
      sessionKey: parentSessionKey,
      platform: p.name(),
      userID,
    }
    const spawnOpts: GroupSpawnOptions = { topicGroup: false, workDir }

    const spawnerEx = asGroupSpawnerEx(p)
    let syntheticMsg: Message | undefined
    try {
      syntheticMsg = spawnerEx !== undefined
        ? await spawnerEx.spawnGroupWithOptions(spawnMsg, groupName, firstMsg, spawnOpts)
        : await spawner.spawnGroup(spawnMsg, groupName, firstMsg)
    } catch (error) {
      throw new Error(`subtask: spawn group: ${String(error instanceof Error ? error.message : error)}`)
    }

    if (workDir !== '' && this.projectState !== undefined) {
      this.projectState.setWorkspaceDirOverride(this.dirOverrideKey(syntheticMsg.sessionKey), workDir)
      this.projectState.save()
    }

    // Record parent linkage + delegation depth so the child's report can
    // push its result back and wake the parent.
    const ns = this.sessions.getOrCreateActive(syntheticMsg.sessionKey)
    ns.setParentSessionKey(parentSessionKey)
    if (forkOrigID !== '') {
      // Plant the fork sentinel; the session-start path expands it into a
      // fork resume on the child's first turn and compareAndSet later
      // overwrites it with the real ID.
      ns.setAgentSessionID(`${ForkSessionPrefix}${forkOrigID}`, this.agent.name())
    }
    ns.setParentChatName(this.subtaskParentLabel(parent))
    ns.setName(groupName)
    ns.setSubtaskDepth(depth)
    ns.setSubtaskAttended(attended)
    if (userID !== '') ns.setSpawnUserID(userID)
    if (wtPath !== '') ns.setWorktreeInfo(wtPath, wtBranch, wtBase, wtRoot)
    this.sessions.save()

    // Fold a late-spawned child into an armed gather barrier so gather also
    // awaits it; without a barrier this is a no-op.
    const gg = parent.getPendingSubtaskGather()
    if (gg !== undefined) {
      if (gg.addExpected(syntheticMsg.sessionKey, childLabel(ns))) {
        console.info(`subtask: added late-spawned child to armed gather (parent=${parentSessionKey} child=${syntheticMsg.sessionKey})`)
      }
    }

    // Notification card in the new group.
    const cs = asCardSender(p)
    if (cs !== undefined) {
      const jumpMD = jumpButtonsMarkdown(parentJumpButtons(parentSessionKey, this.subtaskParentLabel(parent), p))
      const card = this.buildSpawnNotifyCard(workDir, this.i18n.t(MsgSpawnGroupReady), '', jumpMD)
      try {
        await cs.sendCard(syntheticMsg.replyCtx, card)
      } catch (error) {
        console.warn(`subtask: card send failed (${p.name()}): ${String(error)}`)
      }
    }

    if (!idle) {
      // The synthetic first message never went through platform dispatch
      // (which normally sets isSpawnedGroup), so mark it here — otherwise
      // the pin panel and the first-message rename gate never fire for
      // subtask groups.
      syntheticMsg.isSpawnedGroup = true
      if (images.length > 0) syntheticMsg.images = images
      this.receiveMessageSafe(p, syntheticMsg)
    }

    console.info(`subtask: spawned (parent=${parentSessionKey} child=${syntheticMsg.sessionKey} depth=${depth} worktree=${wtPath !== ''} dir=${workDir})`)
    this.markResearchDispatch(parent)
    return { childName: groupName, childKey: syntheticMsg.sessionKey }
  }

  /** Fire-and-forget inbound delivery (Go SafeGo ReceiveMessage). */
  private receiveMessageSafe(p: Platform, msg: Message): void {
    try {
      this.receiveMessage(p, msg)
    } catch (error) {
      console.error(`engine: receive-message failed (${msg.sessionKey}): ${String(error)}`)
    }
  }

  /** The agent's base work dir, or '' when it has none (Go GetWorkDir probe). */
  agentWorkDir(): string {
    const switcher = asWorkDirSwitcher(this.agent)
    if (switcher !== undefined) return switcher.getWorkDir()
    return (this.agent as { getWorkDir?: () => string }).getWorkDir?.().trim() ?? ''
  }

  /**
   * Temporarily switch the shared agent's workDir to this chat's override
   * (Go applyWorkDirOverride). Returns the restore closure; callers invoke
   * it after StartSession. Agents without WorkDirSwitcher are a no-op.
   */
  private applyWorkDirOverride(agent: Agent, sessionKey: string): () => void {
    const override = this.perChatWorkDir(this.dirOverrideKey(sessionKey))
    if (override === '') return () => {}
    const switcher = asWorkDirSwitcher(agent)
    if (switcher === undefined) return () => {}
    const saved = switcher.getWorkDir()
    switcher.setWorkDir(override)
    return () => { switcher.setWorkDir(saved) }
  }

  /** Resolve a user-supplied dir argument (Go Engine.resolveDir, engine-side copy). */
  private resolveDirPath(arg: string): string | undefined {
    let newDir = arg.trim()
    const home = process.env.HOME ?? ''
    if (newDir === '~') newDir = home
    else if (newDir.startsWith('~/')) newDir = joinPath(home, newDir.slice(2))
    try {
      if (!statIsDir(newDir)) return undefined
    } catch {
      return undefined
    }
    return newDir
  }

  /** Flag a research-mode role that dispatched its assistant this turn (Go markResearchDispatch). */
  markResearchDispatch(parent: Session): void {
    if (parent.getChatroomHubKey() === '' || !parent.getResearchAwaitingAssistant()) return
    parent.setResearchDispatched(true)
    this.sessions.save()
  }

  /** Human label for the parent chat on jump buttons (Go subtaskParentLabel). */
  subtaskParentLabel(parent: Session): string {
    const n = parent.getName().trim()
    if (n !== '' && n !== 'session' && n !== 'default') return n
    return this.name
  }

  /**
   * Push a child subtask's result back into its parent session, waking the
   * parent agent to synthesize. Unlike `/done --reply`, it does NOT stop the
   * child session (Go ReportSubtask). Empty result falls back to the child's
   * last assistant reply.
   */
  reportSubtask(childSessionKey: string, result: string): void {
    const p = this.reportCapablePlatform()
    if (p === undefined) {
      throw new Error('subtask: no platform available to deliver report')
    }

    const sess = this.sessions.getOrCreateActive(childSessionKey)
    if (sess.getSubtaskReported()) {
      // Already delivered: skip idempotently so a model re-calling report
      // cannot flood the parent. Nil (not an error) so the agent does not retry.
      console.info(`subtask: report already delivered, skipping duplicate (child=${childSessionKey})`)
      return
    }
    // Fire-and-forget child (monitor no_report rule): never push a result
    // card to the parent.
    if (sess.getSubtaskNoReport()) {
      console.info(`subtask: report skipped (no-report child=${childSessionKey})`)
      return
    }
    if (result.trim() === '') result = sess.lastResultOrReply()
    if (result.trim() === '') {
      throw new Error('subtask: no result to report')
    }
    if (!this.replyToParent(p, sess, result)) {
      throw new Error('subtask: this chat has no parent session to report back to')
    }
    // Consume the one-shot auto-fallback so the first-turn result does not
    // also reinject this result.
    sess.setSubtaskReported(true)
    this.sessions.save()
    console.info(`subtask: reported to parent (child=${childSessionKey})`)
  }

  /**
   * Inject a follow-up message from a parent agent into one of its live
   * subtask groups (Go SendToSubtask). Non-blocking; the child's reply folds
   * back via the normal report path. Re-arms the one-shot auto-report.
   */
  async sendToSubtask(callerSessionKey: string, childSessionKey: string, message: string): Promise<void> {
    const msg = message.trim()
    if (msg === '') throw new Error('subtask: message is required')
    if (childSessionKey.trim() === '') throw new Error('subtask: child session key is required')

    const p = this.reportCapablePlatform()
    if (p === undefined) throw new Error('subtask: no platform available to deliver follow-up')

    const child = this.sessions.getOrCreateActive(childSessionKey)
    if (child.getParentSessionKey() !== callerSessionKey) {
      throw new Error(this.i18n.t(MsgSubtaskSendNotChild))
    }
    // Backpressure: a queued follow-up's answer would never report back (the
    // in-flight turn's auto-report consumes any re-arm); reject instead.
    if (child.isBusy()) {
      throw new Error(this.i18n.t(MsgSubtaskChildBusy))
    }

    const r = asReplyContextReconstructor(p)
    if (r === undefined) {
      throw new Error(`subtask: platform "${p.name()}" cannot address the subtask group`)
    }
    let childRctx: unknown
    try {
      childRctx = await r.reconstructReplyCtx(childSessionKey)
    } catch (error) {
      throw new Error(`subtask: reconstruct child reply ctx: ${String(error instanceof Error ? error.message : error)}`)
    }

    // Re-arm the one-shot auto-report so the child's answer to this
    // follow-up folds back to the parent.
    child.setSubtaskReported(false)
    this.sessions.save()

    // Post the follow-up as a visible card in the child group first, so
    // members see WHAT the parent asked (the injected message is silent).
    await this.sendAsCard(p, childRctx, msg, { title: this.i18n.t(MsgSubtaskFollowupHeader), color: 'indigo' })

    const childMsg: Message = {
      ...emptyMessage(),
      sessionKey: childSessionKey,
      platform: p.name(),
      userName: '[父任务追问]',
      content: `[父任务追问] ${msg}`,
      replyCtx: childRctx,
    }
    this.receiveMessageSafe(p, childMsg)

    console.info(`subtask: parent sent follow-up to child (parent=${callerSessionKey} child=${childSessionKey})`)
    this.markResearchDispatch(this.sessions.getOrCreateActive(callerSessionKey))
  }

  /**
   * First-turn fallback: a subtask session that finishes its initial turn
   * without an explicit report still pushes that turn's reply to the parent.
   * One-shot per subtask (Go maybeAutoReportSubtask).
   */
  maybeAutoReportSubtask(state: InteractiveState | undefined, session: Session, baseResponse: string, isSilent: boolean): void {
    if (session.getSubtaskDepth() <= 0 || session.getSubtaskReported() || session.getSubtaskAutoReportSuppressed() || isSilent) return
    if (baseResponse.trim() === '' || state === undefined || state.platform === undefined) return
    if (this.replyToParent(state.platform, session, baseResponse)) {
      session.setSubtaskReported(true)
      this.sessions.save()
      console.info(`subtask: auto-reported first-turn result to parent (child=${session.id})`)
    }
  }

  /**
   * Disarm the one-shot first-turn auto-report when a user manually stops a
   * delegated subtask group's turn (Go suppressSubtaskAutoReport). Explicit
   * report paths ignore this flag.
   */
  suppressSubtaskAutoReport(sessionKey: string): void {
    const sess = this.sessions.getOrCreateActive(sessionKey)
    if (sess.getSubtaskDepth() > 0 && !sess.getSubtaskAutoReportSuppressed()) {
      // Disarm only the one-shot auto-report; SubtaskReported gates explicit
      // reports too and must not be touched here.
      sess.setSubtaskAutoReportSuppressed(true)
      this.sessions.save()
      console.info(`subtask: user stopped turn, auto-report suppressed (child=${sess.id})`)
    }
  }

  /**
   * Reset the one-shot reported flag when a real human message starts a new
   * turn in a subtask session, so a later explicit report is not silently
   * dropped (Go rearmSubtaskReportOnHumanTurn). Synthetic injections carry
   * an empty userID and are skipped.
   */
  rearmSubtaskReportOnHumanTurn(msg: Message, session: Session, sessions: SessionManager): void {
    if (msg.userID === '' || session.getSubtaskDepth() <= 0 || !session.getSubtaskReported()) return
    session.setSubtaskReported(false)
    sessions.save()
    console.info(`subtask: re-armed report on new human turn (child=${msg.sessionKey})`)
  }

  /**
   * Re-arm the one-shot auto-report when a message that queued behind a busy
   * subtask turn is drained (Go rearmSubtaskReportOnDrain).
   */
  rearmSubtaskReportOnDrain(session: Session, sessions: SessionManager): void {
    if (session.getSubtaskDepth() <= 0 || !session.getSubtaskReported()) return
    session.setSubtaskReported(false)
    sessions.save()
    console.info(`subtask: re-armed report on drained queued message (child=${session.id})`)
  }

  /**
   * Consume chatroom ask metadata at the moment a role's turn actually
   * starts (Go stampChatroomAskOnTurnStart). The chatroom gather flow that
   * arms these lands with M5; kept for the turn-start contract.
   */
  stampChatroomAskOnTurnStart(session: Session, askSeq: number, awaitAssistant: boolean): void {
    if (session.getChatroomHubKey() === '') return
    if (askSeq !== 0) session.setChatroomAskSeq(askSeq)
    if (awaitAssistant) session.setResearchAwaitingAssistant(true)
    this.sessions.save()
  }

  /**
   * Flip userInterjected when a real human sends a message into an otherwise
   * background session (subtask group or chatroom role), re-enabling
   * auto-render from that point (Go markUserInterjectedOnHumanTurn).
   */
  markUserInterjectedOnHumanTurn(msg: Message, session: Session, sessions: SessionManager): void {
    if (msg.userID === '' || msg.isSpawnedGroup) return
    if (session.getSubtaskDepth() <= 0 && session.getChatroomHubKey() === '') return
    if (session.getUserInterjected()) return
    session.setUserInterjected(true)
    sessions.save()
    console.info(`auto-render: user took over background session; render re-enabled (${msg.sessionKey})`)
  }

  /**
   * A subtask session's interactive state was cleaned up without the subtask
   * reporting — send a synthetic failure notification so the parent does not
   * wait forever (Go reportSubtaskTimeout).
   */
  reportSubtaskTimeout(sessionKey: string): void {
    const sess = this.sessions.getOrCreateActive(sessionKey)
    if (sess.getSubtaskDepth() <= 0 || sess.getSubtaskReported() || sess.getParentSessionKey() === '') return

    const p = this.reportCapablePlatform()
    if (p === undefined) {
      console.warn(`subtask timeout: no platform to deliver failure report (child=${sess.id})`)
      sess.setSubtaskReported(true)
      this.sessions.save()
      return
    }

    // Monitor/dispatch parent: drop the timeout notice entirely — the
    // monitored chat is an input-only surface and re-posting there risks
    // re-triage as a fresh alert.
    if (this.isMonitorChat({ ...emptyMessage(), sessionKey: sess.getParentSessionKey(), platform: p.name() })) return

    const failureMsg = this.i18n.t(MsgSubtaskTimeout)
    if (this.replyToParent(p, sess, failureMsg)) {
      sess.setSubtaskReported(true)
      this.sessions.save()
      console.info(`subtask: reported timeout failure to parent (child=${sess.id})`)
    }
  }

  /** Gather barrier fallback timeout (Go subtaskGatherTimeoutDuration). */
  subtaskGatherTimeoutDuration(): number {
    return this.subtaskGatherTimeout > 0 ? this.subtaskGatherTimeout : defaultSubtaskGatherTimeout
  }

  /**
   * Install a fan-in barrier on the parent session so reports from its
   * in-flight children accumulate and the parent is woken EXACTLY ONCE with
   * the full set (or partial on timeout) (Go GatherSubtasks).
   */
  gatherSubtasks(parentSessionKey: string): void {
    const p = this.reportCapablePlatform()
    if (p === undefined) throw new Error('subtask: no platform available')
    const parent = this.sessions.getOrCreateActive(parentSessionKey)
    if (parent.getPendingSubtaskGather() !== undefined) {
      throw new Error('subtask: a gather is already in progress on this session')
    }
    const { idToKey } = this.sessions.sessionKeyMap()
    const g = new SubtaskGather()
    for (const s of this.sessions.allSessions()) {
      if (s.getParentSessionKey() !== parentSessionKey) continue
      if (s.getSubtaskReported()) continue
      const ck = idToKey[s.id] ?? ''
      if (ck === '') continue
      g.expected.set(ck, true)
      g.labels.set(ck, childLabel(s))
    }
    if (g.expected.size === 0) {
      throw new Error(this.i18n.t(MsgSubtaskGatherNoPending))
    }
    parent.setPendingSubtaskGather(g)
    this.sessions.save()
    const timeout = this.subtaskGatherTimeoutDuration()
    g.timer = setTimeout(() => { this.fireSubtaskGatherTimeout(parentSessionKey) }, timeout)
    g.timer.unref()
    const timeoutS = Math.round(timeout / 1000)
    console.info(`subtask: gather armed on parent (parent=${parentSessionKey} expected=${g.expected.size} timeoutS=${timeoutS})`)
  }

  /** Inject a synthetic [子任务汇总] message into the parent (Go wakeParentWithGather). */
  private wakeParentWithGather(parentKey: string, summary: string): void {
    const p = this.reportCapablePlatform()
    if (p === undefined) {
      console.warn(`subtask: no platform to deliver gather wake (parent=${parentKey})`)
      return
    }
    const r = asReplyContextReconstructor(p)
    if (r === undefined) return
    void r.reconstructReplyCtx(parentKey).then(
      (parentRctx) => {
        this.receiveMessageSafe(p, {
          ...emptyMessage(),
          sessionKey: parentKey,
          platform: p.name(),
          userName: '[子任务]',
          content: summary,
          replyCtx: parentRctx,
        })
      },
      (error: unknown) => {
        console.warn(`subtask: reconstruct parent ctx for gather wake failed (parent=${parentKey}): ${String(error)}`)
      },
    )
  }

  /** Timer fallback: wake the parent with whatever arrived (Go fireSubtaskGatherTimeout). */
  private fireSubtaskGatherTimeout(parentKey: string): void {
    const parent = this.sessions.getOrCreateActive(parentKey)
    const g = parent.getPendingSubtaskGather()
    if (g === undefined) return
    const { done, summary } = g.timeoutFire()
    if (!done) return // already woken by the last report
    parent.setPendingSubtaskGather(undefined)
    this.sessions.save()
    this.wakeParentWithGather(parentKey, summary)
    console.info(`subtask: gather timed out; woke parent with partial results (parent=${parentKey})`)
  }

  /**
   * Session keys of all descendants of rootKey, deepest-first so a caller
   * can tear children down before parents. rootKey itself is excluded; a
   * visited set guards against cycles (Go collectSubtree).
   */
  collectSubtree(rootKey: string): string[] {
    const { idToKey } = this.sessions.sessionKeyMap()
    const childrenOf = new Map<string, string[]>()
    for (const s of this.sessions.allSessions()) {
      const pk = s.getParentSessionKey()
      if (pk === '') continue
      const ck = idToKey[s.id] ?? ''
      if (ck === '') continue
      const list = childrenOf.get(pk)
      if (list === undefined) childrenOf.set(pk, [ck])
      else list.push(ck)
    }
    const visited = new Set<string>([rootKey])
    const queue: string[] = []
    for (const c of childrenOf.get(rootKey) ?? []) {
      if (!visited.has(c)) {
        visited.add(c)
        queue.push(c)
      }
    }
    const ordered: string[] = []
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]
      if (cur === undefined) continue
      ordered.push(cur)
      for (const gc of childrenOf.get(cur) ?? []) {
        if (!visited.has(gc)) {
          visited.add(gc)
          queue.push(gc)
        }
      }
    }
    return ordered.reverse()
  }

  /**
   * Push content from a child (spawned/forked/subtask) session back into its
   * parent: show the result as a card in the parent chat and inject a
   * synthetic "[子任务完成]" message that wakes the parent agent (Go
   * replyToParent). Returns false when the child has no parent link or no
   * reply-context reconstruction.
   */
  replyToParent(p: Platform, sess: Session, content: string): boolean {
    const parentKey = sess.getParentSessionKey()
    if (parentKey === '' || content.trim() === '') return false
    const r = asReplyContextReconstructor(p)
    if (r === undefined) return false
    void r.reconstructReplyCtx(parentKey).then(
      (parentRctx) => {
        void this.deliverParentReply(p, sess, parentKey, parentRctx, content)
      },
      (error: unknown) => {
        console.warn(`replyToParent: reconstruct reply ctx failed (parent=${parentKey}): ${String(error)}`)
      },
    )
    return true
  }

  /** Async half of replyToParent once the parent reply ctx resolved. */
  private async deliverParentReply(p: Platform, sess: Session, parentKey: string, parentRctx: unknown, content: string): Promise<void> {
    await this.sendAsCard(p, parentRctx, content, {
      title: this.i18n.tf(MsgDoneReplyParentHeader, childLabel(sess)),
      color: 'indigo',
    })

    // Monitor-mode parent: the monitored chat has no interactive agent —
    // post the card only, never inject the wake message.
    const parentSess = this.sessions.getOrCreateActive(parentKey)
    if (parentSess.getMonitorGroup()) {
      const msgID = parentSess.getMonitorOriginMessageID()
      if (msgID !== '') {
        const mr = asMessageReactionAdder(p)
        if (mr !== undefined) {
          void mr.addReactionToMessage(chatIDFromSessionKey(parentKey, p.name()), msgID, 'Done')
        }
      }
      return
    }

    // Gather barrier: bank this report and wake the parent only when all
    // expected children have reported (or the timeout fires).
    const childKey = this.sessions.sessionKeyMap().idToKey[sess.id] ?? ''
    const g = parentSess.getPendingSubtaskGather()
    if (g !== undefined) {
      const { done, summary, alreadyWoken } = g.accumulate(childKey, childLabel(sess), content)
      if (done) {
        parentSess.setPendingSubtaskGather(undefined)
        this.sessions.save()
        this.wakeParentWithGather(parentKey, summary)
        return
      }
      if (!alreadyWoken) return // banked; parent woken once when all report
      // Barrier already completed but not yet cleared — fall through to a
      // normal wake so this late report is not lost.
    }

    // The card body stays clean; the synthetic message the parent agent sees
    // carries a hint with the child's session key so it can follow up via
    // `subtask send --child <key>` even after context compaction.
    let agentContent = `[子任务完成] ${childLabel(sess)}:\n\n${content}`
    if (childKey !== '') {
      agentContent += `\n\n(如需追问该子任务: cc-connect subtask send --child ${childKey} "...")`
    }
    this.receiveMessageSafe(p, {
      ...emptyMessage(),
      sessionKey: parentKey,
      platform: p.name(),
      userName: '[子任务]',
      content: agentContent,
      replyCtx: parentRctx,
    })
  }

  /** Config-driven monitor chat check (Go isMonitorChat). */
  isMonitorChat(msg: Message): boolean {
    if (!this.monitorEnabled) return false
    if (this.monitorChatsStr === '') return false
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (chatID === '') return false
    return AllowList(this.monitorChatsStr, chatID)
  }

  /** Set the monitor chat list (Go setMonitorChats; full monitor domain is M6). */
  setMonitorChats(chats: string): void {
    this.monitorChatsStr = chats
  }

  // ──────────────────────────────────────────────────────────────
  // M4: group-name generation (Go engine_predict.go + engine_events.go)
  // ──────────────────────────────────────────────────────────────

  /** Configure LLM group-name generation (Go SetGroupNameConfig). */
  setGroupNameConfig(enabled: boolean, provider: string, timeoutMs: number, prompt: string): void {
    this.groupNameEnabled = enabled
    this.groupNameProvider = provider
    this.groupNameTimeout = timeoutMs
    this.groupNamePrompt = prompt
  }

  /** Toggle the group-icon avatar follow-up after rename (Go SetGroupNameAvatarEnabled). */
  setGroupNameAvatarEnabled(enabled: boolean): void {
    this.groupNameSetAvatar = enabled
  }

  /** Mark a manual rename inside the async LLM window (Go markPendingRename). */
  markPendingRename(sessionKey: string): void {
    this.pendingRename.add(sessionKey)
  }

  /** Consume the manual-rename mark (Go clearPendingRename). */
  clearPendingRename(sessionKey: string): void {
    this.pendingRename.delete(sessionKey)
  }

  /** Whether a manual rename is pending for the session (Go hasPendingRename). */
  hasPendingRename(sessionKey: string): boolean {
    return this.pendingRename.has(sessionKey)
  }

  /** Snapshot of recently used group icons, oldest first (Go recentGroupIcons). */
  recentGroupIcons(): string[] {
    return [...this.recentIcons]
  }

  /** Record an icon into the recent ring buffer; empty and duplicates ignored (Go recordGroupIcon). */
  recordGroupIcon(icon: string): void {
    if (icon === '') return
    if (this.recentIcons.includes(icon)) return
    this.recentIcons.push(icon)
    if (this.recentIcons.length > groupIconRecentMax) {
      this.recentIcons = this.recentIcons.slice(this.recentIcons.length - groupIconRecentMax)
    }
  }

  /**
   * Build the full group-name prompt: pick the base (user custom or default
   * template), fill {{icon_pool}} and {{recent_icons_rule}}, append the seed
   * (Go buildGroupNamePrompt).
   */
  buildGroupNamePrompt(seed: string): string {
    const base = this.groupNamePrompt === '' ? defaultGroupNamePrompt : this.groupNamePrompt
    let out = base
    if (out.includes('{{icon_pool}}')) {
      out = out.replaceAll('{{icon_pool}}', sampleAcrossCategories(iconsPerCategory).join(', '))
    }
    if (out.includes('{{recent_icons_rule}}')) {
      let rule = ''
      const recent = this.recentGroupIcons()
      if (recent.length > 0) {
        rule = `- 避免重复：最近用过的图标有 ${recent.join('、')}，本次尽量换别的。`
      }
      out = out.replaceAll('{{recent_icons_rule}}', rule)
    }
    return out + seed.trim()
  }

  /**
   * Fork an isolated lightweight query that produces a concise group name +
   * Lucide icon from the seed (Go generateGroupName). Returns
   * [name, icon]; the icon falls back to a deterministic pick when the LLM
   * omits the second line.
   */
  async generateGroupName(seed: string, signal?: AbortSignal): Promise<[string, string]> {
    const fq = asForkQuerierWithProvider(this.agent)
    if (fq === undefined) {
      throw new Error('group-name: agent does not implement ForkQuerierWithProvider')
    }

    let provider = this.groupNameProvider
    if (provider === '') {
      const sw = asProviderSwitcher(this.agent)
      const ap = sw?.getActiveProvider()
      if (ap !== undefined) provider = ap.name
    }
    if (provider === '') {
      throw new Error('group-name: no provider configured and no active provider')
    }

    const fullPrompt = this.buildGroupNamePrompt(seed)
    const resp = await fq.lightweightQuery(fullPrompt, provider, signal)

    const name = sanitizeGroupName(resp)
    let icon = parseGroupIcon(resp)
    if (icon === '' && name !== '') {
      // LLM occasionally omits the icon line — fall back by name hash so the
      // avatar is always set rather than silently skipped.
      icon = fallbackGroupIcon(name)
    }
    return [name, icon]
  }

  /**
   * Generate a group name with the LLM and rename via the given renamer,
   * optionally setting the icon avatar after a successful rename (Go
   * renameGroupWithLLM). The rename uses its own 30s deadline, NOT the LLM
   * query's — a slow LLM that exhausts the query deadline must not fail the
   * rename HTTP call that actually reached the platform.
   */
  private async renameGroupWithLLM(
    p: Platform,
    sessionKey: string,
    seed: string,
    renamer: (key: string, name: string, signal?: AbortSignal) => Promise<void>,
    querySignal: AbortSignal | undefined,
    setAvatar: boolean,
  ): Promise<{ name: string; icon: string }> {
    const [name, icon] = await this.generateGroupName(seed, querySignal)
    if (name === '') return { name: '', icon: '' }
    const renameSignal = AbortSignal.timeout(30_000)
    await renamer(sessionKey, name, renameSignal)
    // After a successful rename, set the group avatar from the LLM's icon
    // name; failure only warns. Icon validity is checked by the platform's
    // sprite lookup, which silently skips unknown names.
    if (setAvatar && this.groupNameSetAvatar && icon !== '') {
      const setter = asGroupIconAvatarSetter(p)
      if (setter !== undefined) {
        try {
          await setter.setGroupIconAvatar(sessionKey, icon, name)
          this.recordGroupIcon(icon)
        } catch (error) {
          console.warn(`group-name: set icon avatar failed (${icon}): ${String(error)}`)
        }
      }
    }
    return { name, icon }
  }

  /**
   * Async first-message rename for spawned groups: LLM-generate a concise
   * name, falling back to the first message on failure/empty (Go
   * handleGroupNameGenerate). Skips when a manual rename landed inside the
   * LLM window; the mark is one-shot.
   */
  handleGroupNameGenerate(p: Platform, sessionKey: string, firstMessage: string, interactiveKey: string): void {
    if (firstMessage === '') return
    const timeout = this.groupNameTimeout > 0 ? this.groupNameTimeout : 30_000
    void this.groupNameGenerateTask(p, sessionKey, firstMessage, timeout, interactiveKey)
  }

  private async groupNameGenerateTask(
    p: Platform, sessionKey: string, seed: string, timeout: number, _interactiveKey: string,
  ): Promise<void> {
    // The mark means "a manual rename landed inside this window"; the window
    // ends with this callback, so consume it one-shot — otherwise a /new
    // first message would be wrongly skipped by an orphan mark.
    try {
      if (this.hasPendingRename(sessionKey)) {
        console.info(`group-name: skipped async rename, group was manually renamed (${sessionKey})`)
        return
      }
      const renamer = asGroupRenamer(p)
      if (renamer === undefined) return
      const queryCtl = new AbortController()
      const timer = setTimeout(() => { queryCtl.abort() }, timeout)
      try {
        const { name } = await this.renameGroupWithLLM(
          p, sessionKey, seed,
          (key, n, signal) => renamer.renameGroup(key, n, signal),
          queryCtl.signal, true,
        )
        if (name === '') {
          await this.fallbackRename(renamer, sessionKey, seed)
        }
      } catch {
        await this.fallbackRename(renamer, sessionKey, seed)
      } finally {
        clearTimeout(timer)
      }
    } finally {
      this.clearPendingRename(sessionKey)
    }
  }

  /** LLM failure/empty fallback: name the group after the user's first message (no avatar). */
  private async fallbackRename(
    renamer: { renameGroup(key: string, name: string, signal?: AbortSignal): Promise<void> },
    sessionKey: string, seed: string,
  ): Promise<void> {
    console.warn(`group-name: generate failed, falling back to first message (${sessionKey})`)
    const fallback = truncateGroupName(seed)
    if (fallback === '') return
    try {
      await renamer.renameGroup(sessionKey, fallback)
    } catch (error) {
      console.warn(`group-name: fallback rename failed (${sessionKey}): ${String(error)}`)
    }
  }

  /**
   * First-message handling for spawned groups: pin-panel accumulation, the
   * plain first-message rename when LLM naming is off, and the async LLM
   * rename trigger when it is on (the pin/notice block in Go
   * processInteractiveMessageWith; the top-notice banner stays disabled by
   * default exactly like Go's spawnTopNoticeEnabled=false).
   */
  private handleSpawnedGroupFirstMessage(p: Platform, msg: Message, session: Session): void {
    if (!msg.isSpawnedGroup) return
    if (msg.messageID !== '') {
      const appender = asMessagePinAppender(p)
      if (appender !== undefined) {
        const chatID = extractChannelID(msg.sessionKey)
        const msgID = msg.messageID
        void appender.addMessagePin(chatID, msgID).catch((error: unknown) => {
          console.warn(`failed to add message pin (${msgID}): ${String(error)}`)
        })
      }
    }
    if (!session.isFirstMessage() || sessionExemptFromSpawnRename(session)) return
    const raw = msg.originalContent !== '' ? msg.originalContent : msg.content
    if (!this.groupNameEnabled) {
      // Plain sync rename to the first message; with LLM naming on, the
      // group is created under a placeholder and the LLM path is the sole
      // naming source (its fallback covers failure).
      const renamer = asGroupRenamer(p)
      if (renamer === undefined) return
      const name = truncateGroupName(raw)
      if (name === '') return
      void renamer.renameGroup(msg.sessionKey, name).catch((error: unknown) => {
        console.warn(`failed to rename group (${msg.sessionKey}): ${String(error)}`)
      })
      return
    }
    const nameSeed = raw.trim()
    if (nameSeed !== '') this.handleGroupNameGenerate(p, msg.sessionKey, nameSeed, msg.sessionKey)
  }

  /**
   * Rename the user's own hub group to the chatroom topic (sync fallback),
   * then overwrite with a concise LLM name a few seconds later (Go
   * renameHubToTopic). With set_avatar on, the LLM's icon is stamped across
   * the whole family via setChatroomFamilyAvatar.
   */
  renameHubToTopic(p: Platform, sessionKey: string, chatType: string, topic: string, childKeys: string[]): void {
    if (chatType === 'p2p') return
    const renamer = asGroupRenamer(p)
    if (renamer === undefined) return
    const name = chatroomHubGroupName(topic)
    // Synchronous fallback: rename the hub to the topic text immediately.
    void renamer.renameGroupAny(sessionKey, name).catch((error: unknown) => {
      console.warn(`chatroom: failed to rename hub group to topic (${sessionKey}): ${String(error)}`)
    })

    // Async LLM overwrite; RenameGroupAny bypasses the spawned-chat guard
    // because the hub may be a user-owned group.
    const seed = topic.trim()
    if (!this.groupNameEnabled || seed === '') return
    const timeout = this.groupNameTimeout > 0 ? this.groupNameTimeout : 30_000
    const capturedChildren = childKeys
    void (async () => {
      const queryCtl = new AbortController()
      const timer = setTimeout(() => { queryCtl.abort() }, timeout)
      try {
        const { name: hubName, icon } = await this.renameGroupWithLLM(
          p, sessionKey, seed,
          (key, n, signal) => renamer.renameGroupAny(key, n, signal),
          queryCtl.signal, false,
        )
        if (hubName === '' || icon === '' || !this.groupNameSetAvatar) return
        const setter = asChatroomFamilyAvatarSetter(p)
        if (setter === undefined) return
        try {
          await setter.setChatroomFamilyAvatar(sessionKey, capturedChildren, icon, hubName)
          this.recordGroupIcon(icon)
        } catch (error) {
          console.warn(`chatroom: set family avatar failed (hub=${sessionKey}): ${String(error)}`)
        }
      } catch (error) {
        console.warn(`chatroom: group-name LLM rename failed (${sessionKey}): ${String(error)}`)
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  // ──────────────────────────────────────────────────────────────
  // M4: spawn-notify / worktree cards + platform helpers
  // ──────────────────────────────────────────────────────────────

  /** Chat-jump URL for chatID when the platform can produce one (Go chatJumpURL). */
  chatJumpURL(p: Platform | undefined, chatID: string): string {
    if (p === undefined) return ''
    return asChatJumpURLer(p)?.chatJumpURL(chatID) ?? ''
  }

  /** Build the spawn/fork readiness card (Go buildSpawnNotifyCard, purple header). */
  buildSpawnNotifyCard(workDir: string, fallbackTitle: string, extraNote: string, jumpMD: CardMarkdownLike): Card {
    const builder = newCard().title(fallbackTitle, 'purple')
    // TODO(M7): the full status footer (model/ctx%/git branch/RAM) lands with
    // the usage domain; the notify body is the note + jump links for now.
    if (extraNote !== '') builder.markdown(extraNote)
    if (jumpMD.content !== '') builder.markdown(jumpMD.content)
    if (workDir !== '') builder.note(`📁 ${workDir}`)
    return builder.build()
  }

  /**
   * Send content as a card with the given header, falling back to bold-title
   * plain text when the platform has no card support or the card send fails
   * (Go sendAsCard).
   */
  async sendAsCard(p: Platform, replyCtx: unknown, content: string, header: CardHeader): Promise<void> {
    const cs = asCardSender(p)
    if (cs !== undefined) {
      const card = newCard().title(header.title, header.color).markdown(content).build()
      try {
        await cs.sendCard(replyCtx, card)
        return
      } catch (error) {
        console.error(`platform send card failed; falling back to plain send (${p.name()}): ${String(error)}`)
      }
    }
    const fallback = header.title !== '' ? `**${header.title}**\n\n${content}` : content
    await this.send(p, replyCtx, fallback)
  }

  /** Render a card through the CardSender path with a plain-text fallback (Go replyWithCard). */
  async replyWithCard(p: Platform, replyCtx: unknown, card: Card): Promise<void> {
    const cs = asCardSender(p)
    if (cs !== undefined) {
      try {
        await cs.sendCard(replyCtx, card)
        return
      } catch (error) {
        console.error(`platform send card failed; falling back to plain send (${p.name()}): ${String(error)}`)
      }
    }
    await this.send(p, replyCtx, card.renderText())
  }

  /** The /done Keep/Remove prompt card for a dirty worktree (Go renderWorktreeCard). */
  renderWorktreeCard(sessionKey: string): Card {
    const [path, branch] = this.sessions.getOrCreateActive(sessionKey).getWorktreeInfo()
    let md = this.i18n.tf(MsgWorktreeDirtyPrompt, branch, path)
    const memDir = this.resolveOrphanMemoryDir(path)
    if (memDir !== '') {
      md += `\n${this.i18n.tf(MsgWorktreeMemoryWarn, joinPath(memDir, 'memory'))}`
    }
    return newCard()
      .title(this.i18n.t(MsgWorktreeCardTitle), 'orange')
      .markdown(md)
      .buttons(
        { text: this.i18n.t(MsgWorktreeKeepBtn), type: 'default', value: 'act:/wt keep' },
        { text: this.i18n.t(MsgWorktreeRemoveBtn), type: 'danger', value: 'act:/wt remove' },
      )
      .build()
  }

  /** Terminal card after the user picks keep/remove (Go renderWorktreeDoneCard). */
  renderWorktreeDoneCard(action: string, memNote: string): Card {
    let msg = this.i18n.t(MsgWorktreeKept)
    if (action.startsWith('remove')) msg = this.i18n.t(MsgWorktreeRemovedShort)
    if (memNote !== '') msg += `\n${memNote}`
    return newCard().title(this.i18n.t(MsgWorktreeCardTitle), 'turquoise').markdown(msg).build()
  }

  /**
   * Handle the keep/remove choice from the worktree prompt card (Go
   * executeWorktreeAction). Card-action routing arrives with the Wave-2
   * integration; the engine-side action execution is this method.
   */
  async executeWorktreeAction(sessionKey: string, args: string): Promise<string> {
    const sess = this.sessions.getOrCreateActive(sessionKey)
    const [path, branch, , root] = sess.getWorktreeInfo()
    if (path === '') return ''
    // Resolve the orphan memory dir before clearing fields so both outcomes
    // can report it. Memory fate follows the folder.
    const memDir = this.resolveOrphanMemoryDir(path)
    if (args.startsWith('remove')) {
      try {
        await removeWorktree(root, path, branch, true)
      } catch (error) {
        console.warn(`worktree: remove failed (${sessionKey}): ${String(error)}`)
        // Folder not removed; fields preserved for retry, memory kept.
        return memDir !== '' ? this.i18n.tf(MsgWorktreeOrphanKept, memDir) : ''
      }
      sess.setWorktreeInfo('', '', '', '')
      this.sessions.save()
      const cleaned = removeOrphanMemory(memDir === '' ? '' : memDir)
      if (cleaned !== '') return this.i18n.tf(MsgWorktreeOrphanCleaned, cleaned)
      return ''
    }
    // keep: folder stays on disk → memory stays.
    sess.setWorktreeInfo('', '', '', '')
    this.sessions.save()
    return memDir !== '' ? this.i18n.tf(MsgWorktreeOrphanKept, memDir) : ''
  }

  /**
   * Handle one card-button action dispatched by a platform (Go handleCardNav,
   * M4 subset: the worktree Keep/Remove card). `action` is the full act:
   * value; the command runs its side effect and the pressed card is replaced
   * in place via the platform's card refresher, falling back to a new card.
   * Other act: commands are consumed silently — their render domains arrive
   * with later milestones.
   */
  async handleCardAction(p: Platform, msg: Message, action: string): Promise<void> {
    const body = action.slice('act:'.length)
    const spaceIdx = body.indexOf(' ')
    const cmd = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
    if (cmd === '/cron') {
      // Cron card buttons only flip scheduler state; no card is re-rendered
      // (Go executeCardAction's "/cron" case returns an empty string).
      executeCardAction(this, cmd, args, msg.sessionKey)
      return
    }
    if (cmd !== '/wt') {
      console.info(`engine: card action has no handler yet, ignoring (${msg.sessionKey}: ${cmd})`)
      return
    }
    const notification = await this.executeWorktreeAction(msg.sessionKey, args)
    const card = this.renderWorktreeDoneCard(args, notification)
    const refresher = asCardRefresher(p)
    if (refresher !== undefined) {
      try {
        await refresher.refreshCard(msg.sessionKey, card)
        return
      } catch (error) {
        console.warn(`engine: card refresh failed, sending a new card (${msg.sessionKey}): ${String(error)}`)
      }
    }
    await this.replyWithCard(p, msg.replyCtx, card)
  }

  /** Resolve the agent's orphan project-data dir for a worktree path (Go resolveOrphanMemoryDir). */
  resolveOrphanMemoryDir(worktreePath: string): string {
    const r = asWorktreeOrphanResolver(this.agent)
    if (r === undefined) return ''
    const dir = r.orphanProjectDir(worktreePath)
    if (dir === undefined || dir === '') return ''
    if (!memoryHasContent(dir)) return ''
    return dir
  }

  /** Resolve and delete the orphan memory for a worktree path (Go cleanupWorktreeOrphanMemory). */
  cleanupWorktreeOrphanMemory(worktreePath: string): string {
    const dir = this.resolveOrphanMemoryDir(worktreePath)
    if (dir === '') return ''
    return removeOrphanMemory(dir)
  }

  /**
   * Remove the worktree owned by sessionKey, clear the session's worktree
   * metadata, and report the outcome (Go finishWorktreeRemoval).
   */
  async finishWorktreeRemoval(p: Platform, replyCtx: unknown, sessionKey: string, force: boolean): Promise<void> {
    const sess = this.sessions.getOrCreateActive(sessionKey)
    const [path, branch, , root] = sess.getWorktreeInfo()
    if (path === '') return
    const memDir = this.resolveOrphanMemoryDir(path)
    let err: unknown
    try {
      await removeWorktree(root, path, branch, force)
    } catch (error) {
      err = error
    }
    // Always clear the Session worktree fields, even on error: a git failure
    // must not leave the metadata permanently stuck.
    sess.setWorktreeInfo('', '', '', '')
    this.sessions.save()
    if (err !== undefined) {
      console.warn(`worktree removal failed; cleared session fields anyway (${sessionKey} ${path}): ${errorMessage(err)}`)
      let msg = this.i18n.tf(MsgWorktreeCreateError, errorMessage(err))
      if (memDir !== '') msg += `\n${this.i18n.tf(MsgWorktreeOrphanKept, memDir)}`
      await this.reply(p, replyCtx, msg)
      return
    }
    let msg = this.i18n.tf(MsgWorktreeRemoved, branch)
    const cleaned = removeOrphanMemory(memDir === '' ? '' : memDir)
    if (cleaned !== '') msg += `\n${this.i18n.tf(MsgWorktreeOrphanCleaned, cleaned)}`
    await this.reply(p, replyCtx, msg)
  }

  /**
   * Restore a /done'd spawned group's color avatar on the next message when
   * the platform reports it inactive (Go reactivateSpawnedChatAvatar). The
   * active-check guard keeps idempotent resumes from spamming avatar-update
   * system messages.
   */
  async reactivateSpawnedChatAvatar(p: Platform, sessionKey: string): Promise<void> {
    const checker = asSpawnedChatActiveChecker(p)
    const switcher = asChatAvatarStateSwitcher(p)
    if (checker === undefined || switcher === undefined) return
    if (checker.isSpawnedChatActive(sessionKey)) return
    try {
      await switcher.setChatAvatarActive(sessionKey, true)
    } catch (error) {
      console.warn(`reactivate avatar failed (${sessionKey}): ${String(error)}`)
    }
  }

  /** Mark a spawned chat done on the platform side (avatar axis owner). */
  markSpawnedChatDone(p: Platform, sessionKey: string): void {
    asSpawnedChatStateUpdater(p)?.markSpawnedChatDone(sessionKey)
  }

  /** Add an emoji reaction to the replied message when the platform can (Go AddReaction probe). */
  addReaction(p: Platform, replyCtx: unknown, emoji: string): void {
    asReactionAdder(p)?.addReaction(replyCtx, emoji)
  }
}
