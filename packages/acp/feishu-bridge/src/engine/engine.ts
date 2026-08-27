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

import { Msg, I18n, langEnglish } from '../i18n/index.js'
import type { Language } from '../i18n/index.js'
import { bareBridgeDispatch, type BridgeDispatch } from '../bridge-service.js'
import { AllowList } from '../feishu/allowlist.js'
import type {
  Agent,
  AgentSession,
  AskDecision,
  AskRequest,
  CardSender,
  Event,
  FeishuWorkspaceInfo,
  FileAttachment,
  HistoryEntry,
  ImageAttachment,
  InlineButtonSender,
  Message,
  PendingAsk,
  Platform,
  SessionStartOptions,
  UserQuestion,
} from '../core/types.js'
import {
  asAgentInterrupter,
  asCardSender,
  asCardRefresher,
  asCardSenderWithUpdate,
  asChatJumpURLer,
  asContinuableDelegator,
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
  asRecentTurnsReader,
  asReplyContextReconstructor,
  asSessionModeInjector,
  asSpawnedChatActiveChecker,
  asSpawnedChatLister,
  asSpawnedChatStateUpdater,
  asSubagentActivitySource,
  asWorkDirSwitcher,
  asWorktreeOrphanResolver,
  ContinueSession,
  ErrNotSupported,
  ForkAtSessionPrefix,
  ForkSessionPrefix,
  type GroupSpawnOptions,
} from '../core/types.js'
import type { NativeChildRecord } from './project-state.js'
import { shouldSurfaceUnsolicitedPermission as shouldSurfaceHelper } from './permission.js'
import {
  askAnswerDisplay,
  buildAskQuestionsCard,
  finalAskAnswers,
  parseAskqSelection,
  parsePermissionVerdict,
  resolveAskAnswer,
} from './ask.js'
import { CardButton, newCard, appendIntoLastCollapsible, type Card, type CardElement, type CardHeader } from '../card.js'
import {
  appendReplyFooter,
  buildCompletionUsage as buildCompletionUsageFields,
  parseSelfReportedCtx,
  stripCtxSelfReport,
  buildReplyFooter as buildReplyFooterText,
  buildStatusFooter as buildStatusFooterText,
  buildStatusFooterElements as buildFooterElements,
  CompletionUsageFields,
  replyFooterContextText,
  setCompletionDurations as setDurations,
  setTokenRate as setTokenRateMsg,
  unionDuration,
  type BuildCompletionUsageArgs,
  type ContextUsage,
  type Interval,
} from './status-footer.js'
import type { UsageProvider } from './usage.js'
import { Session, SessionManager } from './session.js'
import { pendingDirFor, saveFilesToDir, saveImagesToDir, spliceStagedAttachments, type StagedAttachment } from './attachments.js'
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
  worktreeDirtyDetail,
  worktreeMergedInto,
  worktreeRepoRoot,
  type WorktreeCreateInfo,
} from './worktree.js'
import {
  defaultGroupNamePrompt,
  fallbackGroupIcon,
  groupIconRecentMax,
  iconsPerCategory,
  maxGroupNameRunes,
  parseGroupIcon,
  sampleAcrossCategories,
  sanitizeGroupName,
  truncateGroupName,
} from './groupname.js'
import { MaxPlatformMessageLen, splitMessage, stripTrailingSilent } from './message-split.js'
import { defaultStreamPreviewCfg, newStreamPreview, newToolProgressEntry, ProgressEntry, StreamPreview, type StreamPreviewCfg } from '../streaming.js'
import { isTodoToolName, parseTodoItems } from '../progress.js'
import { newCompactProgressWriter, suppressStandaloneToolResultEvent, type CompactProgressWriter } from '../progress-compact.js'
import { newAsyncSender, type AsyncSender } from '../async-sender.js'
import { RateLimiter } from '../ratelimit.js'
import { readFileSync, statSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { join as joinPath } from 'node:path'
import { asCompletionNotifier, asChatPhasePainter, asGroupFamilyAvatarSetter, asChatChangedNotifier, asChatRenamedNotifier, asHintClickReporter, asRecallNotifier, asReplyExporter, type ChatBasePhase, type ChatPhase } from '../core/types.js'
import { truncateStr, mutePlatform, type CronJob, type CronScheduler } from './cron.js'
import { commandContext, dirApply, collectAgentSessions, matchSession } from './commands.js'
import { renderHelpGroupCard } from './misc-commands.js'
import { executeDeleteModeAction, renderDeleteModeCard, renderListCardSafe, renderStatusCard } from './session-card.js'
import { runBangShell } from './shell-commands.js'
import { renderDirCardSafe } from './dir-card.js'
import { executeCardAction } from './cron-commands.js'
import { cancelQueuedByMessageID, markRecalledPreview } from './recall.js'
import { renderSubtaskPanelCard } from './subtask-panel.js'
import { triggerInsights } from './predict.js'
import { defaultAutoCompressMinGapMs, estimateTokensWithPendingAssistant, maybeAutoResetSessionOnIdle, runCompress } from './session-misc.js'
import type { RelayManager } from './relay.js'
import { MonitorCore, isMonitorCommand } from './monitor.js'
import {
  cancelRenders,
  captureReplyForExport,
  cleanupRenderedReplyHTML,
  defaultReplyPreRenderLen,
  displayReplyText,
  launchPlanRender,
  renderAndDeliverReply,
  sendPlanCard,
  shouldDiscardPreviewBeforeReplyRender,
  shouldRenderPlan,
  storePlanExport,
  type PlanCardHandle,
  type RenderCancelHandle,
  type RenderStatusEntry,
} from './plan-render.js'
import { savePlanFile } from './plan-file.js'

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

/** Default bounded wait for an agent session to close during cleanup (Go agentCloseTimeout). */
const defaultAgentCloseTimeout = 130_000

/**
 * Whether a resume error is dsh's live guard: the persisted session is still
 * registered live, typically because its previous holder's teardown is still
 * in flight (2026-08-21 oc_6ee6 incident).
 * @param error - The error thrown by an agent session start.
 * @returns True when retrying after the teardown completes may succeed.
 */
function isSessionLiveError(error: unknown): boolean {
  return String(error).includes('while it is live')
}

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
  /** Editor base URL linked from status footers (Go EditorURL; '' disables). M7. */
  editorUrl: string
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
  /** Opaque per-message metadata carried through the queue to the drained turn (consumed at feishuBridge/turn-start). */
  metadata: Record<string, unknown> | undefined
}

/**
 * Stop handle for the unsolicited reader parked on an interactive state: the
 * reader checks `stopped` between wake-ups and `cancelRecv` removes its parked
 * channel receive so a disarmed reader never steals the next event from the
 * turn taking the channel over.
 */
interface UnsolicitedReaderHandle {
  stopped: boolean
  cancelRecv(): void
}

/**
 * Read a reader handle's stopped flag through a call: `stopUnsolicitedReader`
 * flips it from outside this module's control flow (across awaits), which
 * control-flow narrowing of the property access cannot see.
 */
function readerStopped(handle: UnsolicitedReaderHandle): boolean {
  return handle.stopped
}

/**
 * A running interactive agent session and its turn state (Go interactiveState,
 * M1 subset). `closing` resolves when cleanup has fully torn the agent down so
 * a new turn for the same key waits instead of concurrently resuming the same
 * agent session id.
 */
export class InteractiveState {
  /** The live agent session handle; undefined before the first turn or after cleanup. */
  agentSession: AgentSession | undefined
  /** Platform that carried the latest message for this session. */
  platform: Platform | undefined
  /** Platform reply context for the latest message. */
  replyCtx: unknown
  /** The agent this state's session was started against. */
  agent: Agent | undefined
  /** Session-start options the agent session was started with; undefined on placeholder states (Go state.env). */
  sessionStartOptions: SessionStartOptions | undefined
  /** Resolves once a concurrent cleanup finished closing the agent session. */
  closing: Promise<void> | undefined
  /** Whether markStopped fired (engine stop or session teardown). */
  stopped: boolean = false
  /** Whether the user requested the stop (/stop, /new, /switch). */
  userStopped: boolean = false
  /** Whether engine.stop() is closing this turn (plugin reload or shutdown), not an agent crash. */
  engineStopped: boolean = false
  /** Whether the engine-stop reload notice already went out for this state. */
  stopNoticeSent: boolean = false
  /** Messages queued while a turn was running. */
  pendingMessages: QueuedMessage[] = []
  /** The queued message currently driving a drained turn, if any. */
  inflightMessage: QueuedMessage | undefined
  /** Last proactive side-channel text, for result-path duplicate suppression. */
  sideText: string = ''
  /** Whether the event channel must be drained before the next turn. */
  eventsNeedResync: boolean = true
  /** Mode override injected at session start; '' = none. */
  effectiveMode: string = ''
  /** Per-state idle-timeout override; 0 falls back to the engine default. */
  effectiveIdleTimeout: number = 0
  /** Timestamp of the last activity, feeding the idle reaper. */
  lastActivity: number = Date.now()
  /** Turns currently in flight on this state. */
  activeTurns: number = 0
  /** Timestamp of the last agent event, for stall confirmation. */
  lastEventAt: number = 0
  /** Tool calls in flight; a positive count pauses the idle timer. */
  activeToolCalls: number = 0
  /** Monotonic per-state turn counter. */
  turnSeq: number = 0
  /** Whether the current turn's message arrived via voice. */
  fromVoice: boolean = false
  /** The current turn's fully built prompt. */
  lastPrompt: string = ''
  /** The parked ask awaiting the user's card or text response (B2). */
  pendingAsk: PendingAsk | undefined
  /** Number of auto-compaction events this session (Go state.compactionCount). M3. */
  compactionCount: number = 0
  /** Cumulative non-cached input tokens across turns (Go state.cumulativeInputTokens). M7. */
  cumulativeInputTokens: number = 0
  /** Cumulative cache-hit input tokens across turns (Go state.cumulativeCacheInputTokens). M7. */
  cumulativeCacheInputTokens: number = 0
  /** Handle of the last ✅ completion notification card (Go state.notificationHandle). M7. */
  notificationHandle: unknown
  /** Footer text of the last completion notification (Go state.notificationFooterMsg). M7. */
  notificationFooterMsg: string = ''
  /** Footer elements of the last completion notification (Go state.notificationFooterElements). M7. */
  notificationFooterElements: CardElement[] = []
  /** Header suffix of the last completion notification (Go state.notificationHeaderSuffix). M7. */
  notificationHeaderSuffix: string = ''
  /** True while a predict-next fork is in-flight for this session (Go state). */
  predictNextRunning: boolean = false
  /** True once the user clicked 屏蔽; reset on /new (Go state.predictNextDisabled). */
  predictNextDisabled: boolean = false
  /** True while a turn-summary fork is in-flight for this session (Go state). */
  turnSummaryRunning: boolean = false
  /** Timestamp of the last auto compression (Go state.lastAutoCompressAt). */
  lastAutoCompressAt: number = 0
  /** Token estimate recorded when the last auto compression armed. */
  lastAutoCompressTokens: number = 0
  /** Per-state async sender serializing platform PATCHes (Go state.sender). */
  sender: AsyncSender | undefined
  /** The turn's active streaming preview (bound for bump routing). */
  preview: StreamPreview | undefined
  /** The turn's compact progress writer; an ask resolution swaps it with the preview. */
  progressWriter: CompactProgressWriter | undefined
  /** The delete-mode picker state machine (session-card.ts); undefined when idle. */
  deleteMode: import('./session-card.js').DeleteModeState | undefined
  /** run_in_background tool calls whose completion turn has not arrived yet. */
  backgroundTasksPending: number = 0
  /** When the unsolicited reader began waiting past idle for pending background tasks. */
  bgWaitStartedAt: number = 0
  /** When the last foreground (user-driven) turn completed; anchors spillover. */
  lastForegroundCompletionAt: number = 0
  /** The unsolicited reader parked on this state; undefined when disarmed. */
  unsolicitedReader: UnsolicitedReaderHandle | undefined

  // ── turn surfaces shared with the ask delegate (B2) ──
  // The event loop owns these per turn, but an askUser running from the
  // adapter's answerer must flush/detach the same surfaces before its card
  // and restart them after the decision, so they live on the state instead
  // of loop locals. The loop re-reads them at every event boundary.
  /** Text segments accumulated this turn (the final-reply source). */
  textParts: string[] = []
  /** Index of the first unflushed text segment. */
  segmentStart: number = 0
  /** Tool calls seen this turn. */
  toolCount: number = 0
  /** Whether the current text segment may still turn out silent. */
  silentHold: boolean = false
  /** Completion-footer timing; generation spans feed the token rate. */
  timing: TurnTiming = { turnStart: 0, agentStart: 0, generationSpans: [] }
  /** Plan .md path written by the agent (promoted on tool success). */
  planFilePath: string = ''
  /** Plan .md path candidate until its write tool call settles. */
  pendingPlanFilePath: string = ''
  /** Tool call id of the pending plan write; the result event carries no tool name, so the match rides the id. */
  pendingPlanToolID: string = ''
  /** Plan content last sent as the plan card (dedup across asks). */
  sentPlanContent: string = ''
  /** Plan revision counter for export keys and (vN) card headers. */
  planRevisionCount: number = 0
  /** Staging dir for pure-attachment messages awaiting the next text (#8). */
  pendingDir: string = ''
  /** Staged attachments to splice into the next prompt (Go pendingAttachments). */
  pendingAttachments: StagedAttachment[] = []

  // ── M7 plan/reply HTML render state (Go interactiveState plan-render fields) ──
  /** A plan render fork is running for this session (Go planRenderRunning). */
  planRenderRunning: boolean = false
  /** sha256 of the last rendered plan content (Go lastRenderedPlanHash). */
  lastRenderedPlanHash: string = ''
  /** Timestamp of the last plan render (Go lastRenderedPlanAt). */
  lastRenderedPlanAt: number = 0
  /** A speculative reply pre-render is running (Go preRenderRunning). */
  preRenderRunning: boolean = false
  /** exportKey of the running reply pre-render (Go preRenderingKey). */
  preRenderingKey: string = ''
  /** In-flight render fork cancels, drained by cancelRenders (Go renderCancels). */
  renderCancels: RenderCancelHandle[] = []
  /** exportKey → rendered reply HTML temp path; teardown reaps them (Go renderedReplyHTML). */
  renderedReplyHTML: Map<string, string> | undefined
  /** Latest render-task status per exportKey (Go renderStatuses). */
  renderStatuses: Map<string, RenderStatusEntry> | undefined
  /** Sent plan cards by exportKey for status PATCHes (Go planCardRender). */
  planCardRender: Map<string, PlanCardHandle> | undefined
  /** Full reply/plan content per export key for the export buttons (Go exportContent). */
  exportContent: Map<string, string> | undefined
  /** Clean reply text fallback for the export buttons (Go lastBaseResponse). */
  lastBaseResponse: string = ''

  private stopWaiters: Array<() => void> = []

  /** The stop signal (Go stopCh): resolves once markStopped fires. */
  stopSignal(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => { this.stopWaiters.push(resolve) })
  }

  /**
   * Whether the state already transitioned to stopped.
   * @returns true once `markStopped` has run.
   */
  isStopped(): boolean {
    return this.stopped
  }

  /**
   * Whether the user (not the engine) requested the stop.
   * @returns true when the stop originated from a user action.
   */
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

  /** Record now as the latest activity, restarting the idle-reaper window. */
  touchActivity(): void {
    this.lastActivity = Date.now()
  }

  /**
   * Extract staged attachment paths and clear them so they are consumed
   * exactly once (Go drainStagedAttachmentPaths); pendingDir is preserved
   * for cleanup.
   * @returns Staged image paths and file paths, each consumed exactly once.
   */
  drainStagedAttachmentPaths(): { imagePaths: string[]; filePaths: string[] } {
    const imagePaths: string[] = []
    const filePaths: string[] = []
    for (const a of this.pendingAttachments) {
      if (a.kind === 'image') imagePaths.push(a.path)
      else filePaths.push(a.path)
    }
    this.pendingAttachments = []
    return { imagePaths, filePaths }
  }

  /** Enter a turn: bump the in-flight count and touch activity. */
  beginTurn(): void {
    this.activeTurns++
    this.touchActivity()
  }

  /** Leave a turn: drop the in-flight count and touch activity. */
  endTurn(): void {
    this.activeTurns--
    this.touchActivity()
  }

  /**
   * Effective per-turn idle timeout, falling back to the engine default.
   * @param fallback - Timeout used when no per-state override is set.
   * @returns The idle timeout in ms for this state's turns.
   */
  idleTimeout(fallback: number): number {
    if (this.effectiveIdleTimeout > 0) return this.effectiveIdleTimeout
    return fallback
  }
}

/**
 * Per-turn timing anchors feeding the completion footer (Go turnStart /
 * agentStartTime): the token rate's thinking time is the union of the turn's
 * streamed generation spans — each opens at the first text/reasoning delta of
 * a model step and closes at the next parent tool call or the result. Spans
 * measured off deltas deliberately exclude first-token latency, dispatch
 * overhead before turn/start, tool execution, and delegated-subagent model
 * time, which the Go wall-clock-minus-tool-intervals formula charged against
 * the rate (measured 5-9 t/s displayed vs 90-130 t/s actual decode on
 * 2026-08-24; see the M7-b divergence note in docs/MIGRATION.md). Providers
 * that do not stream deltas produce no spans and the rate line is omitted.
 */
export interface TurnTiming {
  turnStart: number
  agentStart: number
  generationSpans: Interval[]
}

/** Whether every workspace field is empty (Go FeishuWorkspaceInfo.IsEmpty). */
function feishuWorkspaceIsEmpty(info: FeishuWorkspaceInfo | undefined): boolean {
  return info === undefined
    || (info.wikiSpaceId === '' && info.folderToken === '' && info.wikiNodeToken === '' && info.description === '')
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

/**
 * A bare NO_REPLY marker (case-insensitive, whitespace-padded).
 * @param text - Candidate reply text.
 * @returns True when the text is exactly the silent-reply marker.
 */
export function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/i.test(text)
}

/**
 * Whether the trimmed text is still a case-insensitive prefix of NO_REPLY.
 * @param text - Streaming text accumulated so far.
 * @returns True when the text could still grow into a silent-reply marker.
 */
export function couldBeSilentPrefix(text: string): boolean {
  const t = text.trim()
  if (t === '') return true
  return 'NO_REPLY'.startsWith(t.toUpperCase())
}

function isEllipsisOnly(text: string): boolean {
  const t = text.trim()
  return t === '...' || t === '…'
}

/**
 * Whether an event represents real turn content the unsolicited reader should
 * open a turn on, versus stream noise it must drop (Go
 * isSubstantiveUnsolicitedEvent): a bare empty or silent-marker text frame
 * (typical stray blip) and preview-only deltas never open one.
 * @param event - The candidate event.
 * @returns True for real content: non-silent text, tool calls, results, and errors.
 */
function isSubstantiveUnsolicitedEvent(event: Event): boolean {
  switch (event.type) {
    case 'text':
      return event.content !== '' && !isSilentReply(event.content)
    case 'tool_use':
    case 'tool_result':
    case 'result':
    case 'error':
      return true
    default:
      // Deltas, thinking blocks, compaction, and todo snapshots are handled
      // by the turn pumps only (Go handles EventCompaction foreground-only).
      return false
  }
}

/**
 * Channel ID from "platform:chatID[:userID]" (Go extractChannelID).
 * @param sessionKey - Session key to split.
 * @returns The chat ID segment, or '' when the key has no second segment.
 */
export function extractChannelID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 2) return parts[1] ?? ''
  return ''
}

/**
 * Parse a 1-based card page argument ('' and invalid values fall back to 1).
 * @param args - Raw card-action argument text.
 * @returns The positive integer it names, or 1.
 */
function parsePositiveInt(args: string): number {
  const n = Number.parseInt(args, 10)
  return Number.isInteger(n) && n > 0 ? n : 1
}

/**
 * Strip the trailing user ID: "platform:channel:user" → "platform:channel".
 * @param sessionKey - Session key to strip.
 * @returns The key without the user segment, or unchanged when it has none.
 */
export function stripUserID(sessionKey: string): string {
  const parts = sessionKey.split(':')
  if (parts.length >= 3) return `${parts[0]}:${parts[1]}`
  return sessionKey
}

/**
 * Platform name prefix of a session key.
 * @param sessionKey - Session key to split.
 * @returns The platform segment, or '' when the key carries no colon.
 */
export function extractPlatformName(sessionKey: string): string {
  const idx = sessionKey.indexOf(':')
  return idx > 0 ? sessionKey.slice(0, idx) : ''
}

/** Default cap on recursive subtask delegation (Go defaultSubtaskMaxDepth). */
export const defaultSubtaskMaxDepth = 3

/**
 * Plain-text rendering of every question in an ask (the card-less platform
 * fallback): numbered options per question; a free-text reply answers the
 * first unanswered question with its number or text.
 *
 * @param e - Engine supplying the multi-select hint text.
 * @param questions - All questions of the ask, in order.
 * @returns The message text.
 */
function askQuestionsPlainText(e: Engine, questions: UserQuestion[]): string {
  const lines: string[] = []
  for (const [i, q] of questions.entries()) {
    const prefix = questions.length > 1 ? `${i + 1}. ` : ''
    const header = q.header !== '' ? `[${q.header}] ` : ''
    lines.push(`${header}❓ ${prefix}${q.question}${q.multiSelect ? e.i18n.t(Msg.AskQuestionMulti) : ''}`)
    for (const [j, opt] of q.options.entries()) {
      lines.push(`  ${j + 1}) ${opt.label}${opt.description !== '' ? ` — ${opt.description}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** Default gather barrier fallback timeout: 20 minutes (Go defaultSubtaskGatherTimeout). */
export const defaultSubtaskGatherTimeout = 20 * 60 * 1000

/** A markdown card element body without the discriminator (buildSpawnNotifyCard input). */
interface CardMarkdownLike {
  content: string
}

/**
 * A fully-empty Message template for synthetic injections (Go &Message{}).
 * @returns A Message with every field at its empty default.
 */
export function emptyMessage(): Message {
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
 * @param sessionKey - Session key to split.
 * @param platformName - Platform segment the key must start with.
 * @returns The chat ID, or '' on a platform mismatch or missing segment.
 */
export function chatIDFromSessionKey(sessionKey: string, platformName: string): string {
  const parts = sessionKey.split(':', 3)
  if (parts.length < 2 || parts[0] !== platformName) return ''
  return parts[1] ?? ''
}

/**
 * A single "open parent group" jump button for a spawned child, derived from
 * the originating message (Go parentJumpButtons). Empty array when the
 * parent chat ID cannot be resolved.
 * @param parentSessionKey - Session key of the originating parent chat.
 * @param parentName - Parent chat display name; '' uses the default label.
 * @param p - Platform the parent chat lives on.
 * @returns A zero- or one-element button array.
 */
export function parentJumpButtons(parentSessionKey: string, parentName: string, p: Platform): CardButton[] {
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
 * @param buttons - Jump buttons to render.
 * @returns The markdown line and whether any button rendered.
 */
export function jumpButtonsMarkdown(buttons: CardButton[]): CardMarkdownLike & { ok: boolean } {
  const parts: string[] = []
  for (const b of buttons) {
    if (b.url !== undefined && b.url !== '') parts.push(`[${b.text}](${b.url})`)
  }
  if (parts.length === 0) return { content: '', ok: false }
  return { content: parts.join('  ·  '), ok: true }
}

/** Session's display name: its own name, the chat's user meta, or the key (Go sessionDisplayName). */
function sessionDisplayName(s: Session | undefined, sessions: SessionManager, sessionKey: string): string {
  const own = s?.getName().trim()
  if (own !== undefined && own !== '') return own
  const meta = sessions.getUserMeta(sessionKey)
  const chatName = meta?.chatName.trim() ?? ''
  if (chatName !== '') return chatName
  return sessionKey
}

/** Breadcrumb of ancestor chats ending in the current chat's name (Go breadcrumbMarkdown). */
function breadcrumbMarkdown(
  chain: Array<{ chatID: string; name: string }>,
  currentName: string,
  p: Platform,
): CardMarkdownLike | undefined {
  if (chain.length === 0) return undefined
  const parts: string[] = []
  for (const n of chain) {
    const name = n.name !== '' ? n.name : n.chatID
    const url = asChatJumpURLer(p)?.chatJumpURL(n.chatID) ?? ''
    parts.push(`[${name}](${url})`)
  }
  parts.push(currentName !== '' ? currentName : '本群')
  return { content: `📍 ${parts.join(' › ')}` }
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

/** Help-card group a registered command lists under (misc-commands' four tabs). */
export type CommandHelpGroup = 'session' | 'agent' | 'tools' | 'system'

/** One slash-command registration handed to {@link Engine.registerCommand}. */
export interface CommandRegistration {
  /** Canonical command id, without the leading slash. */
  id: string
  /** Handler invoked with the delivering platform, message, and raw args. */
  handler: (p: Platform, msg: Message, args: string[]) => boolean
  /** Extra resolver step mapping a typed command token to the id ('' = no match). */
  match?: (cmd: string) => string
  /** Help-card group; 'session' applies when omitted. */
  group?: CommandHelpGroup
}

/**
 * One card-button action handler handed to {@link Engine.registerCardAction}:
 * run the feature's state machine for a pressed card and return the card to
 * swap in for the pressed one (undefined = leave the pressed card alone).
 */
export type CardActionHandler = (sessionKey: string, cmd: string, args: string) => Card | undefined

/** Live state of one background-subtask panel (card handle, refresh timer, post time). */
interface SubtaskPanelState {
  handle: unknown
  timer: ReturnType<typeof setInterval>
  startedAt: number
}

/**
 * Engine routes messages between platforms and the agent for a single
 * project (Go Engine, M1 subset).
 */
export class Engine {
  /** Project name this engine serves. */
  readonly name: string
  /** The agent every interactive session starts from. */
  readonly agent: Agent
  /** Platforms routed between the chats and the agent. */
  readonly platforms: Platform[]
  /** Session manager persisting per-chat session metadata. */
  readonly sessions: SessionManager
  /** Message catalog for user-facing strings. */
  readonly i18n: I18n
  /** Engine creation timestamp. */
  readonly startedAt: number = Date.now()
  /**
   * The `feishuBridge/*` dispatch face: the mounted {@link FeishuBridgeService}
   * in production, or the bare listener-less face when constructed outside a
   * Cordis tree (unit tests) — with no listener the built-in base runs.
   */
  readonly bridge: BridgeDispatch

  /** Intermediate-message display settings (Go e.display). */
  display: DisplayCfg = {
    thinkingMessages: true,
    thinkingMaxLen: defaultThinkingMaxLen,
    toolMessages: true,
    toolProgress: false,
    toolMaxLen: 0,
    planMaxLen: defaultPlanMaxLen,
    editorUrl: '',
  }
  /** Streaming preview switches (Go e.streamPreview). */
  streamPreview: StreamPreviewCfg = defaultStreamPreviewCfg()
  /** Quiet window after the last im.chat.updated event before a preview bump (Go var). */
  bumpDebounceInterval: number = 2000
  /** Whether prompts get a sender-identity header prepended (Go injectSender). */
  injectSender: boolean = false
  /** Whether proactive attachment sends are allowed (Go attachmentSendEnabled). */
  attachmentSendEnabled: boolean = true
  /** Bot's default Feishu workspace routing (#18); undefined = feature off. */
  feishuWorkspace: FeishuWorkspaceInfo | undefined
  /** Idle timeout before a silent turn is killed; 0 disables. */
  eventIdleTimeout: number = defaultEventIdleTimeout
  /** Stall retries before the idle kill. */
  stallMaxRetries: number = defaultStallMaxRetries
  /** Explicit per-turn wall-clock cap in ms; used only when set (Go absoluteTurnTimeout). */
  private absoluteTurnTimeout = 0
  /** Whether absoluteTurnTimeout was set explicitly (false = 2× idle fallback). */
  private absoluteTurnTimeoutSet = false
  /** Per-session queued-message cap. */
  maxQueuedMessages: number = defaultMaxQueuedMessages
  /** Rapid-fire queued-message merge window in ms; 0 disables. */
  debounceInterval: number = defaultDebounceInterval
  /** Idle-reaper threshold reclaiming quiet interactive states; 0 disables. */
  interactiveIdleTimeout: number = 0
  /** Live-guard resume retry budget in ms; a resume racing an in-flight agent teardown polls within it. */
  private liveGuardRetryBudgetMs = defaultAgentCloseTimeout
  /** Live-guard resume retry poll interval in ms. */
  private liveGuardRetryIntervalMs = 500

  /** Recursive subtask delegation cap override; 0 = defaultSubtaskMaxDepth (Go subtaskMaxDepth). */
  subtaskMaxDepth: number = 0
  /** Default worktree isolation for /spawn //fork (Go spawnWorktree). */
  spawnWorktree: WorktreeMode = WorktreeMode.ForceOff
  /** Integrate-branch override for /done merged auto-removal; '' uses each worktree's recorded base branch. */
  private spawnIntegrateBranch = ''
  /** /spawn //fork RAM guard thresholds in percent; 0 disables a tier (Go spawnMemWarnPct/BlockPct). */
  spawnMemWarnPct: number = 0
  /** RAM percentage at which /spawn //fork rejects the spawn outright (Go spawnMemBlockPct). */
  spawnMemBlockPct: number = 0
  /** Hard timeout for subtask sessions; 0 inherits eventIdleTimeout (Go subtaskTimeout). */
  subtaskTimeout: number = 0
  /** Suppress settlement cards for unattended native subtasks (features.subtaskQuiet). */
  subtaskQuiet: boolean = false
  /** Background-subtask live panel: enabled flag (features.subtaskLivePanel). */
  subtaskPanelEnabled: boolean = true
  /** Background-subtask live panel refresh interval ms (features.subtaskLivePanelIntervalMs; 0 disables). */
  subtaskPanelIntervalMs: number = 15_000
  /** Silence window after which a panel row flags a child as stalled. */
  subtaskPanelStallMs: number = 120_000
  /** Gather barrier fallback timeout; 0 = defaultSubtaskGatherTimeout (Go subtaskGatherTimeout). */
  subtaskGatherTimeout: number = 0
  /** LLM group-name generation switches (Go groupName* fields). */
  groupNameEnabled: boolean = false
  /** Provider route for group-name queries; '' = the active provider. */
  groupNameProvider: string = ''
  /** Group-name LLM query deadline in ms; 0 = 30s default. */
  groupNameTimeout: number = 0
  /** Custom group-name prompt template; '' = the default template. */
  groupNamePrompt: string = ''
  /** Whether the LLM's icon is stamped as the group avatar after rename. */
  groupNameSetAvatar: boolean = false
  /** The monitor domain state machine (Go engine_monitor.go; reached as engine.monitor). */
  readonly monitor: MonitorCore
  /** Cron scheduler shared across engines (Go cronScheduler; null = cron off). */
  cronScheduler: CronScheduler | undefined
  /** Relay manager shared across engines (Go relayManager; null = relay off). */
  relayManager: RelayManager | undefined

  // ── M7 plan/reply HTML render config (Go planRender* fields) ────────────
  /** plan_render enabled (Go planRenderEnabled; opt-in, default off). */
  planRenderEnabled: boolean = false
  /** Provider route override for render sessions; '' = active provider (Go planRenderProvider). */
  planRenderProvider: string = ''
  /** Render-session fork timeout; 0 = 600s default (Go planRenderTimeout). */
  planRenderTimeoutMs: number = 0
  /** HTML→PNG rasterizer script path; '' = fall back to the .html file (Go planRenderPngScript). */
  planRenderPngScript: string = ''
  /**
   * Resolves the feishu-bridge-render skill body from the dsh skill registry
   * (the single source the render-session prompts inline); undefined = not
   * wired, which fails loud at fork time.
   */
  planRenderSkillSource: (() => Promise<string | undefined>) | undefined
  // ── plan-file persistence (Claude-Code-aligned plan .md records) ────────
  /** Directory presented plans are written to; '' disables writing. */
  planDir: string = joinPath(homedir(), '.claude', 'plans')
  // ── usage + status footer (Go engine usage* fields, M7) ─────────────────
  /** Generic fallback context window for heuristic ctx estimates (Go modelContextWindow). */
  readonly modelContextWindow = 200_000 as const
  /** Whether the ctx/cache lines are shown on the completion footer (Go showContextIndicator). */
  showContextIndicator: boolean = true
  /** Effective context window in tokens (Go contextWindow). */
  contextWindow: 200000 = this.modelContextWindow
  /** Project-level fallback window (Go projectContextWindow). */
  projectContextWindow: 200000 = this.modelContextWindow
  /** Provider quota summaries appended to the completion footer (Go usageProviders). */
  usageProviders: UsageProvider[] = []
  /** Per-turn completion footer fields (Go completionUsage* fields). */
  readonly usage: CompletionUsageFields = new CompletionUsageFields()
  /** Whether the Codex-style reply footer is appended to replies (Go replyFooterEnabled). */
  replyFooterEnabled: boolean = false
  /** Agent-level usage fetch cache for the reply footer (Go replyFooterUsageCache). */
  private readonly replyFooterUsageCache = { text: '', fetchedAt: 0 }

  /** Session keys with a manual rename pending in the async LLM window (Go pendingRename). */
  private readonly pendingRename = new Set<string>()
  /** Ring buffer of recently used group icons for prompt dedup (Go recentIcons). */
  private recentIcons: string[] = []

  /** key = sessionKey (interactiveKey; workspace prefixes arrive in a later M). */
  readonly interactiveStates: Map<string, InteractiveState> = new Map<string, InteractiveState>()

  /**
   * Live background-subtask panels: parent session key → card handle, timer,
   * and post time. A panel exists only while a settled parent turn has
   * unreported native children (the no-gather escape path); it PATCHes in
   * place and dies when the set settles, the chat drains, or the engine stops.
   */
  readonly subtaskPanels: Map<string, SubtaskPanelState> = new Map<string, SubtaskPanelState>()

  /** Command names → alias targets (trigger → command). */
  readonly aliases: Map<string, string> = new Map<string, string>()

  /** Command table injected by registerSessionCommands (engine/commands.ts). */
  commandHandlers: Map<string, (p: Platform, msg: Message, args: string[]) => boolean> | undefined
  /** Resolves a typed command word to its canonical ID (commands.ts matchPrefix). */
  commandResolver: ((cmd: string) => string) | undefined
  /** Privileged/disabled command gate; true when it replied and handled the line. */
  commandGate: ((cmdID: string, p: Platform, msg: Message) => boolean) | undefined
  /** Help-card group per command registered through registerCommand; the static misc-commands table covers the rest. */
  readonly commandGroups: Map<string, CommandHelpGroup> = new Map<string, CommandHelpGroup>()
  /** Card-button action handlers by command path (registerCardAction registry). */
  private readonly cardActionHandlers = new Map<string, CardActionHandler>()

  /**
   * Register one slash command on this engine: the handler map gains the
   * entry, the resolver chain gains the registration's prefix matcher, and
   * the help card lists the command under the declared group. Requires the
   * session command table (registerSessionCommands) to be installed first.
   *
   * @param reg - The command registration (id, handler, matcher, group).
   * @returns Disposer removing the registration and restoring the resolver.
   */
  registerCommand(reg: CommandRegistration): () => void {
    const handlers = this.commandHandlers
    if (handlers === undefined) {
      throw new Error(`engine: registerCommand(${reg.id}) requires the session command table (registerSessionCommands) to be installed first`)
    }
    handlers.set(reg.id, reg.handler)
    if (reg.group !== undefined) this.commandGroups.set(reg.id, reg.group)
    const prevResolver = this.commandResolver
    if (reg.match !== undefined) {
      const match = reg.match
      this.commandResolver = (cmd: string): string => {
        const id = prevResolver?.(cmd) ?? ''
        if (id !== '') return id
        return match(cmd)
      }
    }
    return () => {
      handlers.delete(reg.id)
      this.commandGroups.delete(reg.id)
      this.commandResolver = prevResolver
    }
  }

  /**
   * Register one card-button action family on this engine: a button whose
   * action path equals one of `names` runs `handler` instead of falling
   * through to the engine's own card routes. The handler returns the card to
   * swap in for the pressed one (undefined leaves it); either way the action
   * is consumed. Registering a name again replaces its handler.
   *
   * @param names - Full command paths the handler claims ('/chatroom-pick').
   * @param handler - Runs the feature's state machine for the pressed card.
   * @returns Disposer removing the registration.
   */
  registerCardAction(names: readonly string[], handler: CardActionHandler): () => void {
    for (const name of names) this.cardActionHandlers.set(name, handler)
    return () => {
      for (const name of names) this.cardActionHandlers.delete(name)
    }
  }

  /** Persisted per-project state (/dir overrides). */
  projectState: import('./project-state.js').ProjectStateStore | undefined
  /** Directory switch history (/dir). */
  dirHistory: import('./dir-history.js').DirHistory | undefined
  /** Compact hint commands shown on status footers and /hint (Go e.hints). */
  hints: string[] = []
  /** Hints whose input field value appends to the command (Go e.hintsWithParam). */
  hintsWithParam: string[] = []
  /** Always-visible hint commands (Go e.hintsCommon). */
  hintsCommon: string[] = []
  /** Click counts ordering the hint buttons; undefined keeps config order (Go e.hintUsage). */
  hintUsage: import('./hint-usage.js').HintUsage | undefined
  /** Base working directory for /dir reset. */
  baseWorkDir: string = ''
  /** Comma-separated admin user IDs ('*' = all allowed users; '' = deny). */
  adminFrom: string = ''
  /** Quiet period after which the unsolicited reader disarms (0 = never). */
  unsolicitedIdleTimeout: number = 60_000
  /** How long a quiet in-flight tool keeps the unsolicited reader alive (0 = unbounded). */
  unsolicitedToolInFlightTimeout: number = 30 * 60_000
  /** How long pending background tasks keep the unsolicited reader alive (0 = no grace). */
  unsolicitedBackgroundGrace: number = 30 * 60_000
  /** Events this soon after a foreground completion relay as plain text (0 = disabled). */
  unsolicitedSpilloverGrace: number = 0
  /** Bounded wait for an agent session to close during cleanup and stall retry (Go agentCloseTimeout). */
  agentCloseTimeout: number = defaultAgentCloseTimeout
  /** Per-session inbound rate limiter; undefined = unlimited (Go e.rateLimiter). */
  private rateLimiter: RateLimiter | undefined
  /** Quick provider commands (/strong → provider name; Go providerShortcuts). */
  providerShortcuts: Record<string, string> = {}
  /** Executor for a provider shortcut (armed by registerProviderCommands). */
  providerShortcutHandler: ((p: Platform, msg: Message, providerName: string) => void) | undefined
  /** Persists the active provider name across restarts (Go providerSaveFunc). */
  providerSaveFunc: ((name: string) => void) | undefined
  /** Predict-next config (#33, Go SetPredictNextConfig). */
  predictNextEnabled: boolean = false
  /** Provider route for predict-next forks; '' = the active provider. */
  predictNextProvider: string = ''
  /** Model override for predict-next forks; '' = the provider default. */
  predictNextModel: string = ''
  /** Predict-next fork deadline in ms; 0 = the default timeout. */
  predictNextTimeout: number = 0
  /** Prompt template for predict-next forks. */
  predictNextPrompt: string = ''
  /** true = fork the live transcript (resume); false = one-shot compact query. */
  predictNextResume: boolean = false
  /** Turn-summary config (Go SetTurnSummaryConfig). */
  turnSummaryEnabled: boolean = false
  /** Provider route for turn-summary forks; '' = the active provider. */
  turnSummaryProvider: string = ''
  /** Turn-summary fork deadline in ms; 0 = the default timeout. */
  turnSummaryTimeout: number = 0
  /** Prompt template for turn-summary forks. */
  turnSummaryPrompt: string = ''
  /** Auto session rotation after idle (Go SetResetOnIdle); 0 disables. */
  resetOnIdle: number = 0
  /** Auto context compression (Go SetAutoCompressConfig). */
  autoCompressEnabled: boolean = false
  /** Token estimate that triggers auto compression; 0 = off. */
  autoCompressMaxTokens: number = 0
  /** Minimum gap between auto compressions in ms. */
  autoCompressMinGap: number = 0

  private reaperTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    name: string,
    agent: Agent,
    platforms: Platform[],
    sessionStorePath: string,
    lang: Language = langEnglish,
    bridge?: BridgeDispatch,
  ) {
    this.name = name
    this.agent = agent
    this.platforms = platforms
    this.bridge = bridge ?? bareBridgeDispatch()
    this.sessions = new SessionManager(sessionStorePath)
    this.i18n = new I18n(lang)
    this.sessions.invalidateForAgent(agent.name())
    this.monitor = new MonitorCore(this)
  }

  // ── configuration setters used by ported tests ─────────────────────────

  /**
   * Override intermediate-message display settings.
   * @param cfg - Display fields to merge over the current config.
   */
  setDisplayConfig(cfg: Partial<DisplayCfg>): void {
    this.display = { ...this.display, ...cfg }
  }

  /**
   * Configure the plan/reply HTML render domain (Go [projects.plan_render]):
   * enabled opt-in, an optional provider-route override, a fork timeout in
   * ms (0 = 600s default), and the HTML→PNG rasterizer script path.
   * @param cfg - Render config fields; optional members fall back to defaults.
   */
  setPlanRenderConfig(cfg: { enabled: boolean; provider?: string; timeoutMs?: number; pngScript?: string }): void {
    this.planRenderEnabled = cfg.enabled
    this.planRenderProvider = cfg.provider ?? ''
    this.planRenderTimeoutMs = cfg.timeoutMs ?? 0
    this.planRenderPngScript = cfg.pngScript ?? ''
  }

  /**
   * Wire the render-skill body source behind `ctx.skills.get` — the
   * render-session prompts inline the resolved body; an unwired or empty
   * source makes the next render fork throw with registration guidance.
   * @param source - Async resolver for the skill body; undefined marks the feature unwired.
   */
  setPlanRenderSkillSource(source: (() => Promise<string | undefined>) | undefined): void {
    this.planRenderSkillSource = source
  }

  /**
   * Set the plans directory presented plans are persisted to.
   * @param dir - Absolute directory; '' disables plan-file persistence.
   */
  setPlanDir(dir: string): void {
    this.planDir = dir
  }

  /**
   * Toggle the ctx/cache lines on the completion footer (Go SetShowContextIndicator).
   * @param show - Whether the lines are appended.
   */
  setShowContextIndicator(show: boolean): void {
    this.showContextIndicator = show
  }

  /**
   * Set the project-level context window fallback (Go SetContextWindow).
   * @param w - Context window size in tokens.
   */
  setContextWindow(w: number): void {
    this.contextWindow = w
    this.projectContextWindow = w
  }

  /** Re-resolve the context window from the active provider (Go ApplyActiveProviderContextWindow). */
  applyActiveProviderContextWindow(): void {
    const active = asProviderSwitcher(this.agent)?.getActiveProvider()
    this.contextWindow = active?.contextWindow && active.contextWindow > 0
      ? active.contextWindow
      : this.projectContextWindow
  }

  /**
   * Set the provider quota list appended to the completion footer (Go
   * SetUsageProviders). Implementations of the optional active-detection
   * capability are seeded with the current active provider name so their
   * gate holds from the first turn.
   * @param providers - Providers whose quota lines are appended.
   */
  setUsageProviders(providers: UsageProvider[]): void {
    this.usageProviders = providers
    this.syncUsageProvidersActive()
  }

  /**
   * Push the active provider name into every usage provider implementing the
   * optional active-detection capability (Go SetUsageProviders +
   * engine_provider.go's switch/flip paths). Detectors gate their ⌛ summary
   * on the name, so it must follow every active-route change — otherwise a
   * matching provider's summary never appears.
   */
  syncUsageProvidersActive(): void {
    const name = asProviderSwitcher(this.agent)?.getActiveProvider()?.name ?? ''
    for (const up of this.usageProviders) {
      const detector = up as UsageProvider & { setActiveProvider?: (name: string) => void }
      if (typeof detector.setActiveProvider === 'function') detector.setActiveProvider(name)
    }
  }

  /**
   * Toggle the Codex-style reply footer (Go SetReplyFooterEnabled).
   * @param show - Whether the footer is appended to replies.
   */
  setReplyFooterEnabled(show: boolean): void {
    this.replyFooterEnabled = show
  }

  /**
   * Idle timeout before a silent turn is killed; 0 disables.
   * @param ms - Timeout in milliseconds.
   */
  setEventIdleTimeout(ms: number): void {
    this.eventIdleTimeout = ms
  }

  /**
   * Stall retries before the idle kill (Go SetStallMaxRetries).
   * @param n - Retry count.
   */
  setStallMaxRetries(n: number): void {
    this.stallMaxRetries = n
  }

  /**
   * Bounded wait for an agent session to close during cleanup and stall
   * retry (Go agentCloseTimeout). A close exceeding it is abandoned: the
   * session may stay live in the registry and force the next resume
   * through the live-guard retry/degrade chain.
   * @param ms - Timeout in milliseconds.
   */
  setAgentCloseTimeout(ms: number): void {
    this.agentCloseTimeout = ms
  }

  /**
   * Live-guard resume retry budget and poll interval; a resume failing with
   * "while it is live" (the session is still tearing down) is retried within
   * the budget before the engine degrades to a fresh session.
   * @param budgetMs - Total retry window in milliseconds.
   * @param intervalMs - Delay between attempts in milliseconds.
   */
  setLiveGuardRetryBudgetMs(budgetMs: number, intervalMs: number): void {
    this.liveGuardRetryBudgetMs = budgetMs
    this.liveGuardRetryIntervalMs = intervalMs
  }

  /**
   * Explicit per-turn wall-clock cap (Go SetAbsoluteTurnTimeout); an explicit
   * 0 disables the cap, unset falls back to 2× idle.
   * @param secs - Cap in seconds.
   */
  setAbsoluteTurnTimeoutSecs(secs: number): void {
    this.absoluteTurnTimeout = secs * 1000
    this.absoluteTurnTimeoutSet = true
  }

  /**
   * Per-turn absolute wall-clock cap (Go absoluteTurnMax).
   * @param idle - The session's idle timeout in ms.
   * @returns The cap in ms; 0 disables.
   */
  absoluteTurnMax(idle: number): number {
    if (this.absoluteTurnTimeoutSet) return this.absoluteTurnTimeout
    return idle * 2
  }

  /**
   * Merge streaming-preview tuning over the current config (Go SetStreamPreviewCfg).
   * @param cfg - Preview fields to merge over the current config.
   */
  setStreamPreviewCfg(cfg: Partial<StreamPreviewCfg>): void {
    this.streamPreview = { ...this.streamPreview, ...cfg }
  }

  /**
   * Configure per-session message rate limiting (Go SetRateLimitCfg).
   * @param maxMessages - Messages allowed per window; 0 disables limiting.
   * @param windowMs - Sliding window length in milliseconds.
   */
  setRateLimitCfg(maxMessages: number, windowMs: number): void {
    this.rateLimiter?.stop()
    this.rateLimiter = maxMessages > 0 ? new RateLimiter(maxMessages, windowMs) : undefined
  }

  /**
   * Whether one inbound message is within the rate limit (Go checkRateLimit;
   * the [users] role path is not ported, so the global limiter keys by
   * sessionKey like Go's legacy path).
   * @param msg - The inbound message.
   * @returns True when the message is allowed.
   */
  checkRateLimit(msg: Message): boolean {
    return this.rateLimiter?.allow(msg.sessionKey) ?? true
  }

  /**
   * Rapid-fire queued-message merge window in ms; 0 disables.
   * @param ms - Merge window in milliseconds.
   */
  setDebounceInterval(ms: number): void {
    this.debounceInterval = ms
  }

  /**
   * Per-session queue cap.
   * @param n - Maximum queued messages per session.
   */
  setMaxQueuedMessages(n: number): void {
    this.maxQueuedMessages = n
  }

  /**
   * Toggle side-channel attachment delivery (Go SetAttachmentSendEnabled).
   * @param enabled - Whether attachment sends are allowed.
   */
  setAttachmentSendEnabled(enabled: boolean): void {
    this.attachmentSendEnabled = enabled
  }

  /**
   * Record the bot's default Feishu workspace location (Go SetFeishuWorkspace,
   * #18). Non-empty fields surface as the workspace routing section when a
   * session starts; nil or all-empty disables the feature.
   * @param info - Workspace fields; undefined or all-empty disables the feature.
   */
  setFeishuWorkspace(info: FeishuWorkspaceInfo | undefined): void {
    this.feishuWorkspace = feishuWorkspaceIsEmpty(info) ? undefined : info
  }

  /**
   * Inject the sender identity header into prompts (Go SetInjectSender).
   * @param enabled - Whether prompts carry the sender header.
   */
  setInjectSender(enabled: boolean): void {
    this.injectSender = enabled
  }

  /**
   * Enable the idle reaper: periodically reclaim interactiveStates idle
   * beyond the threshold by closing the agent session. 0 disables.
   * @param ms - Idle threshold in milliseconds; 0 disables the reaper.
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

  /**
   * Attach the process-wide cron scheduler (Go SetCronScheduler).
   * @param cs - Scheduler to attach; drives job execution and silence flags.
   */
  setCronScheduler(cs: CronScheduler): void {
    this.cronScheduler = cs
  }

  /**
   * Attach the process-wide relay manager (Go SetRelayManager).
   * @param rm - Manager to attach; routes bot-to-bot relay messages.
   */
  setRelayManager(rm: RelayManager): void {
    this.relayManager = rm
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Start every platform with the inbound handler (Go Start, M1 subset). */
  async start(): Promise<void> {
    const startErrs: unknown[] = []
    for (const p of this.platforms) {
      try {
        await p.start((platform, msg) => { void this.handleMessage(platform, msg) })
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
      // Export-button wiring (Go initPlatformCapabilities ReplyExporter): the
      // 📄 导出文件 / 💬 查看完整回复 buttons look their content up here. Plan
      // keys ("plan:<rev>") never fall back to the last reply — a missing plan
      // key reports "session expired" instead of exporting the wrong content.
      const exporter = asReplyExporter(p)
      if (exporter !== undefined) {
        exporter.setExportHandler((sessionKey, exportKey) => {
          const state = this.interactiveStates.get(sessionKey)
          if (state === undefined) return { text: '', ok: false }
          if (exportKey !== '') {
            const text = state.exportContent?.get(exportKey)
            if (text !== undefined) return { text, ok: text !== '' }
            if (exportKey.startsWith('plan:')) return { text: '', ok: false }
          }
          return { text: state.lastBaseResponse, ok: state.lastBaseResponse !== '' }
        })
      }

      // Hint-button click counting (Go engine.go SetHintClickHandler): each
      // click feeds the shared HintUsage so buttons reorder by frequency.
      const hintClick = asHintClickReporter(p)
      if (hintClick !== undefined) {
        hintClick.setHintClickHandler((hintText, category) => { this.hintUsage?.increment(category, hintText) })
      }

      // Recall wiring (#30, Go engine.go platform startup): a recalled
      // message is cancelled from whichever session's queue holds it, and a
      // recalled preview card stops updating and tail-guarding — the guard
      // must not resurrect a card the user deleted.
      const recall = asRecallNotifier(p)
      if (recall !== undefined) {
        recall.setRecallHandler((messageID) => {
          cancelQueuedByMessageID(this, messageID)
          markRecalledPreview(this, messageID)
        })
      }
    }
    if (startErrs.length === this.platforms.length && this.platforms.length > 0) {
      throw startErrs[0]
    }
    // Feature barriers restored from disk close here, once platforms can
    // deliver the wakes: every reply they awaited died with the old process.
    this.recoverInterruptedNativeChildren()
    this.platformsStartedValue = true
    this.bridge.emit('feishuBridge/platforms-ready', { engine: this })
  }

  private platformsStartedValue = false

  /**
   * Whether {@link Engine.start} brought this engine's platforms live (the
   * `feishuBridge/platforms-ready` emit). Sibling-plugin wiring that missed
   * the event (registered after start finished) reads this to run its own
   * recovery exactly once.
   */
  get platformsStarted(): boolean {
    return this.platformsStartedValue
  }

  /**
   * Restart recovery for native subtasks — the subtask counterpart of the
   * feature barrier recovery riding platforms-ready. A child epoch runs in this process, so
   * a daemon restart kills it silently: `subagent/end` never fires, the
   * parentage record keeps `reported: false` forever, the live card counts
   * phantom children, and a gather armed on them blocks to its timeout
   * naming children that can never report. At platforms-ready (once cards
   * and wakes can be delivered) every unreported child that has no live
   * agent is accounted for: its record is settled, and the parent chat
   * receives a warning card plus a machine-message notice through
   * {@link deliverMachineMessage} so the parent agent knows the children
   * can be resumed (`send`) or abandoned. A child that IS live — an HMR
   * rebuild that kept the subagent runtime alive — is left untouched.
   */
  private recoverInterruptedNativeChildren(): void {
    const entries = this.nativeChildEntries()
    const delegator = asContinuableDelegator(this.agent)
    const interrupted = new Map<string, Array<{ childId: string; label: string; worktree: string }>>()
    for (const [childId, rec] of Object.entries(entries)) {
      if (rec.reported) continue
      if (delegator?.childLive?.(childId) === true) continue
      // Settle the record first. A later `send` re-arms `reported: false` on
      // its own, so a child resumed after this recovery still reports its
      // new epoch; but a settlement racing this loop must not fire after the
      // notice already declared the child interrupted.
      this.updateNativeChild(childId, { reported: true })
      const bucket = interrupted.get(rec.parent_key) ?? []
      bucket.push({ childId, label: rec.label, worktree: rec.worktree_path })
      interrupted.set(rec.parent_key, bucket)
    }
    if (interrupted.size === 0) return
    this.projectState?.save()
    const p = this.reportCapablePlatform()
    if (p === undefined) {
      console.warn('subtask: restart recovery has no platform to deliver notices')
      return
    }
    const r = asReplyContextReconstructor(p)
    for (const [parentKey, children] of interrupted) {
      // Non-creating lookup: a parent chat with no session record cannot be
      // woken; its children stay settled and /done still drains the records.
      if (this.sessions.findActive(parentKey) === undefined) {
        console.warn(`subtask: restart recovery skipped a parent with no session (${parentKey}: ${children.length} child/children)`)
        continue
      }
      const listing = children
        .map(c => `- ${c.label} (session ${c.childId}${c.worktree !== '' ? `, worktree ${c.worktree}` : ''})`)
        .join('\n')
      void r?.reconstructReplyCtx(parentKey).then(
        (parentRctx) => {
          void this.sendAsCard(p, parentRctx, this.i18n.tf(Msg.SubtaskRestartNotice, listing), {
            title: this.i18n.t(Msg.SubtaskRestartCardTitle),
            color: 'red',
          }).catch((error: unknown) => {
            console.warn(`subtask: restart recovery card failed (${parentKey}): ${String(error)}`)
          })
          this.deliverMachineMessage(p, {
            ...emptyMessage(),
            sessionKey: parentKey,
            platform: p.name(),
            userName: '[子任务]',
            content: this.i18n.tf(Msg.SubtaskRestartNotice, listing),
            replyCtx: parentRctx,
          })
        },
        (error: unknown) => {
          console.warn(`subtask: restart recovery reconstruct ctx failed (${parentKey}): ${String(error)}`)
        },
      )
    }
    console.info(`subtask: restart recovery settled ${interrupted.size} parent chat(s) with interrupted children`)
  }

  /**
   * Reflect a group rename into session state so jump-button labels stay
   * current (Go handleChatRenamed): the renamed chat's own session gets Name
   * updated (parent→child labels), and any child whose ParentSessionKey
   * points at it gets ParentChatName updated (child→parent labels).
   * @param sessionKey - Session key of the renamed chat.
   * @param newName - The new chat name; empty renames are ignored.
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
    this.monitor.stopMonitorPoll()
    // Panel timers are engine-owned; a dead engine must not keep ticking.
    for (const panel of this.subtaskPanels.values()) clearInterval(panel.timer)
    this.subtaskPanels.clear()
    // An in-flight turn's event loop may never resume before process exit
    // (2026-08-22 oc_610e incident: exit_plan_mode interrupted mid-call, the
    // loop never ran, no notice) — notify its chat here, while the platform
    // can still send. The flag keeps the channel-closed path from repeating
    // the notice when the loop does drain.
    for (const state of this.interactiveStates.values()) {
      if (state.activeTurns === 0 || state.stopNoticeSent) continue
      state.stopNoticeSent = true
      state.engineStopped = true
      // Fire the stop signal too: a pump or parked ask awaiting it must
      // settle promptly instead of relying on the channel-close drain —
      // the close itself can only complete once the parked ask returns.
      state.markStopped()
      const platform = state.platform
      if (platform !== undefined) {
        await this.send(platform, state.replyCtx, this.i18n.t(Msg.PluginReloaded))
      }
      // The stopped state never reaches the event loop's stop arm — the loop
      // drains channel-close instead. Finalize the active preview card here,
      // before platforms stop, or it freezes in its Running state across the
      // reload.
      const preview = state.preview
      if (preview !== undefined) {
        try {
          await preview.markStoppedSync()
        } catch (error) {
          console.warn(`engine: stop preview finalize failed: ${String(error)}`)
        }
      }
    }
    for (const p of this.platforms) await p.stop()
    const states = [...this.interactiveStates.entries()]
    this.interactiveStates.clear()
    for (const [key, state] of states) {
      // Distinguish the deliberate teardown from an agent crash so the turn's
      // channel-closed path reports the reload, not a process exit.
      state.engineStopped = true
      if (state.agentSession !== undefined) {
        await this.closeAgentSessionWithTimeout(key, state.agentSession)
      }
    }
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer)
    this.rateLimiter?.stop()
    await this.agent.stop()
  }

  /**
   * Deliver a message into the engine (integration-test entry).
   * @param p - Platform the message arrived on.
   * @param msg - The inbound message.
   */
  receiveMessage(p: Platform, msg: Message): void {
    void this.handleMessage(p, msg)
  }

  // ── outbound wrappers ───────────────────────────────────────────────────

  /**
   * Reply with error logging (Go reply).
   * @param p - Platform to reply on.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param content - Text to send.
   * @returns The platform send, with failures logged instead of thrown.
   */
  reply(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.reply(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: reply failed (${p.name()}): ${String(error)}`)
    })
  }

  /**
   * Send with error logging (Go send).
   * @param p - Platform to send on.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param content - Text to send.
   * @returns The platform send, with failures logged instead of thrown.
   */
  send(p: Platform, replyCtx: unknown, content: string): Promise<void> {
    return p.send(replyCtx, content).catch((error: unknown) => {
      console.debug(`engine: send failed (${p.name()}): ${String(error)}`)
    })
  }

  // ── inbound routing ─────────────────────────────────────────────────────

  /**
   * Route one inbound message (Go handleMessage, M1 subset).
   * @param p - Platform the message arrived on.
   * @param msg - The inbound message.
   */
  async handleMessage(p: Platform, msg: Message): Promise<void> {
    const content = msg.content.trim()
    if (content === '' && msg.images.length === 0 && msg.files.length === 0) return

    // Monitor mode (#53): route monitored-chat messages to triage instead of
    // an interactive agent session. The monitored chat never runs an agent.
    // /monitor is exempted so it reaches the normal command dispatcher.
    if (!isMonitorCommand(msg.content) && this.isMonitorChat(msg)) {
      this.monitor.handleMonitorMessage(p, msg)
      return
    }

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

    // Rate limit check (Go engine.go: after content merge, before permission
    // and pending-human-reply routing).
    if (!this.checkRateLimit(msg)) {
      console.info(`engine: message rate limited (session=${msg.sessionKey} user=${msg.userID})`)
      void this.reply(p, msg.replyCtx, this.i18n.t(Msg.RateLimited))
      return
    }

    // Pure attachment (no text) — stage to disk and wait for the next text
    // message instead of firing an empty-intent agent turn (#8, Go
    // stageAttachments): Feishu image/file messages cannot carry text. Go
    // stages before session creation and pending-question routing, so an
    // image-only message never resolves a pending human question.
    if (content === '' && (msg.images.length > 0 || msg.files.length > 0)) {
      this.stageAttachments(p, msg, msg.sessionKey)
      return
    }

    const session = this.sessions.getOrCreateActive(msg.sessionKey)
    this.sessions.updateUserMeta(msg.sessionKey, msg.userName, msg.chatName)
    // Capture the interacting user's ID before command dispatch: a session
    // whose first message is a slash command must still record its spawner
    // (Go engine.go — only persist on change to avoid a disk write per
    // message).
    if (msg.userID !== '' && session.getSpawnUserID() !== msg.userID) {
      session.setSpawnUserID(msg.userID)
      this.sessions.save()
    }

    // Pending-human replies to feature questions outrank
    // both command dispatch and permission handling (Go orders
    // routePendingHumanReply before handleCommand). Slash commands pass
    // through untouched (the listener halves decide).
    if (this.bridge.waterfall('feishuBridge/route-human-reply', { engine: this, platform: p, sessionKey: msg.sessionKey, content }, () => false)) return

    // Slash commands dispatch BEFORE permission handling (Go engine.go fix
    // 60e20ef6): a registered command like /done must run while a permission
    // card is pending instead of being swallowed as a non-keyword reply —
    // /done tears the session down, unblocking the parked permission wait
    // via its stop signal. AskUserQuestion card answers are exempt: an
    // option label may start with "/" (e.g. "/chatroom 不带任何参数") and
    // must resolve the pending question, never run as a command. Unregistered
    // commands fall through to permission handling, then to the agent as a
    // normal message.
    if (!msg.isAskqCardAction && msg.images.length === 0 && content.startsWith('/')) {
      if (this.dispatchCommand(p, msg, content)) return
    }

    // Permission responses route here after command dispatch (Go engine.go:
    // every message passes through this check — card-button actions AND
    // free-text answers to a pending question).
    if (this.routeAskResponse(p, msg, content)) return

    // "!" prefix: treat as a shell command (same as /shell). Placed after
    // permission handling so "!yes" answers a pending permission instead
    // (Go engine.go "!" branch).
    if (msg.images.length === 0 && content.startsWith('!')) {
      const shellCmd = content.slice(1).trim()
      if (shellCmd !== '') {
        runBangShell(this, p, msg, shellCmd)
        return
      }
    }

    if (!session.tryLock()) {
      if (this.queueMessageForBusySession(p, msg, msg.sessionKey)) {
        // Race guard: the drain loop may have finished between our TryLock
        // failure and the queue append — retry and drain the orphans.
        if (session.tryLock()) {
          void this.drainOrphanedQueue(session, this.sessions, msg.sessionKey)
        }
      } else {
        void this.reply(p, msg.replyCtx, this.i18n.t(Msg.PreviousProcessing))
      }
      return
    }

    // reset_on_idle: rotate a stale chat to a fresh session before the turn
    // runs (Go maybeAutoResetSessionOnIdle). The old session keeps its
    // agent id for /switch back.
    const activeSession = (await maybeAutoResetSessionOnIdle(this, p, msg, session)) ?? session

    // A real human message resuming a subtask group starts a new work cycle:
    // re-arm the one-shot report flag so the agent's report (and the
    // first-turn auto-report) can deliver again after a prior cycle already
    // reported. No-op for synthetic injections (empty userID) and non-subtask
    // sessions. Runs after the lock is acquired so it only fires on a
    // genuinely new turn (Go rearmSubtaskReportOnHumanTurn).
    this.rearmSubtaskReportOnHumanTurn(msg, activeSession, this.sessions)
    // A real human message into a background session (subtask child or
    // feature session) re-enables auto-render for it from this point on.
    this.markUserInterjectedOnHumanTurn(msg, activeSession, this.sessions)

    this.ensureInteractiveStateForQueueing(msg.sessionKey, p, msg.replyCtx)
    void this.processInteractiveMessageWith(p, msg, activeSession)
  }

  /**
   * Resolve aliases on the content or its first word (Go resolveAlias).
   * @param content - Raw message content.
   * @returns The content with any matched alias substituted.
   */
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

  /**
   * Text slash-command dispatch; false lets the message reach the agent.
   * @param p - Platform the command arrived on.
   * @param msg - The inbound message.
   * @param raw - Raw command line, including the leading slash.
   * @returns True when a command consumed the message.
   */
  dispatchCommand(p: Platform, msg: Message, raw: string): boolean {
    const parts = raw.trim().split(/\s+/)
    const cmd = (parts.shift() ?? '').replace(/^\//, '').toLowerCase()
    const cmdID = this.commandResolver?.(cmd) ?? (this.commandHandlers?.get(cmd) !== undefined ? cmd : '')
    if (cmdID === '') {
      // Provider shortcuts (/strong → provider + new session) claim unknown
      // commands before they fall through to the agent (Go handleCommand).
      const shortcut = this.providerShortcuts[cmd]
      if (shortcut !== undefined && this.providerShortcutHandler !== undefined) {
        this.providerShortcutHandler(p, msg, shortcut)
        return true
      }
      return false
    }
    if (this.commandGate?.(cmdID, p, msg)) return true
    const handler = this.commandHandlers?.get(cmdID)
    if (handler === undefined) return false
    return handler(p, msg, parts)
  }

  /**
   * Per-chat dir override for an interactive key (Go perChatWorkDir, M1 shape).
   * @param key - Interactive session key.
   * @returns The persisted workdir override, or '' when none is set.
   */
  perChatWorkDir(key: string): string {
    return this.projectState?.workspaceDirOverride(this.dirOverrideKey(key)) ?? ''
  }

  /**
   * The session's effective working directory: its per-chat /dir override,
   * else the agent's base work dir (the send tool resolves relative
   * attachment paths against this, the way the Go CLI resolved against the
   * agent subprocess's cwd).
   * @param sessionKey - Interactive session key.
   * @returns The resolved working directory; '' when neither is set.
   */
  sessionWorkDir(sessionKey: string): string {
    const override = this.perChatWorkDir(this.dirOverrideKey(sessionKey))
    if (override !== '') return override
    return this.agentWorkDir()
  }

  /**
   * Channel-level key for dir overrides: single-workspace strips the trailing
   * user ID so card actions and text messages map to the same slot.
   * @param sessionKey - Interactive session key.
   * @returns The channel-level key for the override slot.
   */
  dirOverrideKey(sessionKey: string): string {
    return stripUserID(sessionKey)
  }

  /**
   * Effective work dir for a command context (agent cwd or process cwd).
   * @param msg - Message whose session key selects the per-chat override.
   * @returns The resolved working directory.
   */
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

  /**
   * Register the persisted project-state store (/dir overrides).
   * @param store - Store that persists per-project state.
   */
  setProjectStateStore(store: import('./project-state.js').ProjectStateStore): void {
    this.projectState = store
  }

  /**
   * Register the directory history used by /dir.
   * @param history - History that records directory switches.
   */
  setDirHistory(history: import('./dir-history.js').DirHistory): void {
    this.dirHistory = history
  }

  /**
   * Set the compact hint commands (Go SetHints).
   * @param hints - Hint command texts.
   */
  setHints(hints: string[]): void {
    this.hints = hints
  }

  /**
   * Set the hints that append their input field's value (Go SetHintsWithParam).
   * @param hints - Hint command texts.
   */
  setHintsWithParam(hints: string[]): void {
    this.hintsWithParam = hints
  }

  /**
   * Set the always-visible hint commands (Go SetHintsCommon).
   * @param hints - Hint command texts.
   */
  setHintsCommon(hints: string[]): void {
    this.hintsCommon = hints
  }

  /**
   * Register the shared hint click counts (Go SetHintUsage).
   * @param usage - Count store shared across engines.
   */
  setHintUsage(usage: import('./hint-usage.js').HintUsage): void {
    this.hintUsage = usage
  }

  /**
   * Set the base work dir restored by /dir reset.
   * @param dir - Directory path.
   */
  setBaseWorkDir(dir: string): void {
    this.baseWorkDir = dir
  }

  /**
   * Set the admin user list for privileged commands.
   * @param adminFrom - Comma-separated admin user IDs ('*' = all, '' = deny).
   */
  setAdminFrom(adminFrom: string): void {
    this.adminFrom = adminFrom
  }

  /**
   * Register provider shortcut commands, e.g. { strong: 'glm' } (Go SetProviderShortcuts).
   * @param shortcuts - Command word → provider name.
   */
  setProviderShortcuts(shortcuts: Record<string, string>): void {
    this.providerShortcuts = shortcuts
  }

  /**
   * Set the active-provider persistence hook (Go SetProviderSaveFunc).
   * @param fn - Hook invoked with the provider name on every switch.
   */
  setProviderSaveFunc(fn: (name: string) => void): void {
    this.providerSaveFunc = fn
  }

  /**
   * Configure predict-next (#33, Go SetPredictNextConfig). mode 'resume'
   * forks the live transcript; anything else uses the lightweight one-shot
   * query.
   * @param enabled - Whether next-message prediction runs after turns.
   * @param provider - Provider route; '' = the active provider.
   * @param model - Model override; '' = the provider default.
   * @param timeoutMs - Fork deadline in ms; 0 = the default timeout.
   * @param prompt - Prompt template for the prediction query.
   * @param mode - 'resume' forks the live transcript; anything else is one-shot.
   */
  setPredictNextConfig(enabled: boolean, provider: string, model: string, timeoutMs: number, prompt: string, mode: string): void {
    this.predictNextEnabled = enabled
    this.predictNextProvider = provider
    this.predictNextModel = model
    this.predictNextTimeout = timeoutMs
    this.predictNextPrompt = prompt
    this.predictNextResume = mode === 'resume'
  }

  /**
   * Configure turn-summary generation (Go SetTurnSummaryConfig).
   * @param enabled - Whether turn summaries run after turns.
   * @param provider - Provider route; '' = the active provider.
   * @param timeoutMs - Fork deadline in ms; 0 = the default timeout.
   * @param prompt - Prompt template for the summary query.
   */
  setTurnSummaryConfig(enabled: boolean, provider: string, timeoutMs: number, prompt: string): void {
    this.turnSummaryEnabled = enabled
    this.turnSummaryProvider = provider
    this.turnSummaryTimeout = timeoutMs
    this.turnSummaryPrompt = prompt
  }

  /**
   * Auto session rotation after idle (Go SetResetOnIdle); <= 0 disables.
   * @param ms - Idle threshold in ms; <= 0 disables rotation.
   */
  setResetOnIdle(ms: number): void {
    this.resetOnIdle = ms > 0 ? ms : 0
  }

  /**
   * Auto context compression (Go SetAutoCompressConfig); minGap <= 0 falls back to 30min.
   * @param enabled - Whether auto compression is armed.
   * @param maxTokens - Token estimate that triggers compression; 0 = off.
   * @param minGapMs - Minimum gap between compressions; <= 0 uses the 30min default.
   */
  setAutoCompressConfig(enabled: boolean, maxTokens: number, minGapMs: number): void {
    this.autoCompressEnabled = enabled
    this.autoCompressMaxTokens = maxTokens
    this.autoCompressMinGap = minGapMs > 0 ? minGapMs : defaultAutoCompressMinGapMs
  }

  /**
   * Agent session id a session-scoped recent-turn read should use: the live
   * agent's id when one is up (the bridge mapping can lag mid-turn), else the
   * bridge session's persisted mapping.
   *
   * @param sessionKey - Interactive-state slot key of the chat.
   * @param session - The bridge session the read belongs to.
   * @returns the live agent session id, the session's mapping, or ''.
   */
  activeAgentSessionID(sessionKey: string, session: Session): string {
    const live = this.interactiveStates.get(sessionKey)?.agentSession
    if (live !== undefined && live.alive()) {
      const id = live.currentSessionID()
      if (id !== '') return id
    }
    return session.getAgentSessionID()
  }

  /**
   * Recent conversation window of a native session, projected by the agent
   * from the native session log (RecentTurnsReader). Backends without the
   * capability return [] — window readers are advisory surfaces (estimates,
   * summaries), never turn-taking logic.
   *
   * @param agentSessionID - the native session id to read; '' returns [].
   * @param limit - trailing-entry bound; <= 0 returns the whole window.
   * @returns the trailing window entries, oldest first.
   */
  async recentTurns(agentSessionID: string, limit: number = 0): Promise<HistoryEntry[]> {
    if (agentSessionID === '') return []
    const reader = asRecentTurnsReader(this.agent)
    if (reader === undefined) return []
    return reader.recentTurns(agentSessionID, limit)
  }

  /**
   * {@link recentTurns} for a chat's current session, resolving the native id
   * from the live agent when one is up.
   *
   * @param sessionKey - Interactive-state slot key of the chat.
   * @param session - The bridge session the read belongs to.
   * @param limit - trailing-entry bound; <= 0 returns the whole window.
   * @returns the trailing window entries, oldest first.
   */
  async recentTurnsOf(sessionKey: string, session: Session, limit: number = 0): Promise<HistoryEntry[]> {
    return this.recentTurns(this.activeAgentSessionID(sessionKey, session), limit)
  }

  /**
   * Clean SDK final result when available, else the last assistant reply
   * from the session's recent-turn window (Go Session.lastResultOrReply).
   *
   * @param sessionKey - Interactive-state slot key of the chat.
   * @param session - The bridge session the read belongs to.
   * @returns lastResult when non-blank, else the last assistant entry's content.
   */
  async lastResultOrReply(sessionKey: string, session: Session): Promise<string> {
    if (session.getLastResult().trim() !== '') return session.getLastResult()
    const entries = await this.recentTurnsOf(sessionKey, session)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.role === 'assistant') return entries[i]?.content ?? ''
    }
    return ''
  }

  /**
   * Configure the unsolicited reader's four budgets (Go
   * SetUnsolicitedSpilloverGrace / SetUnsolicitedToolInFlightTimeout /
   * SetUnsolicitedBackgroundGrace; the idle timeout has no Go setter because
   * Go hardwires its default). Zero disables a budget.
   * @param cfg - Timeout fields; each 0 falls back to the engine default.
   */
  setUnsolicitedConfig(cfg: {
    idleTimeoutMs?: number | undefined
    toolInFlightTimeoutMs?: number | undefined
    backgroundGraceMs?: number | undefined
    spilloverGraceMs?: number | undefined
  }): void {
    if (cfg.idleTimeoutMs !== undefined) this.unsolicitedIdleTimeout = cfg.idleTimeoutMs
    if (cfg.toolInFlightTimeoutMs !== undefined) this.unsolicitedToolInFlightTimeout = cfg.toolInFlightTimeoutMs
    if (cfg.backgroundGraceMs !== undefined) this.unsolicitedBackgroundGrace = cfg.backgroundGraceMs
    if (cfg.spilloverGraceMs !== undefined) this.unsolicitedSpilloverGrace = cfg.spilloverGraceMs
  }

  /**
   * Disable predict-next for one session (the 屏蔽 button; Go SetPredictNextDisabled).
   * @param sessionKey - Session to stop predicting for; unknown keys are ignored.
   */
  setPredictNextDisabled(sessionKey: string): void {
    const st = this.interactiveStates.get(sessionKey)
    if (st === undefined) return
    st.predictNextDisabled = true
  }

  // ── queueing (#13) ──────────────────────────────────────────────────────

  /**
   * Queue a message for delivery after the running turn. Only metadata is
   * stored — the event loop sends it after the turn's result (Go
   * queueMessageForBusySession).
   * @param p - Platform the message arrived on.
   * @param msg - The inbound message to queue.
   * @param interactiveKey - Interactive-state slot key.
   * @returns True when the message was queued or the queue reported full; false when the session cannot queue.
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
      void this.reply(p, msg.replyCtx, this.i18n.tf(Msg.QueueFull, state.pendingMessages.length))
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
      metadata: msg.metadata,
    })
    void this.reply(p, msg.replyCtx, this.i18n.t(Msg.MessageQueued))
    return true
  }

  /**
   * Create a placeholder state so startup-window messages queue (issue #565).
   * @param key - Interactive-state slot key.
   * @param p - Platform the message arrived on.
   * @param replyCtx - Platform reply context for later notifications.
   */
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

  /**
   * Stage a pure-attachment message (no text) to the per-state pending
   * directory and record the paths so the next text message attaches them
   * (Go stageAttachments, #8). Feishu image/file messages cannot carry text,
   * so this buffers them until the user follows up instead of firing an
   * empty-intent agent turn.
   * @param p - Platform the attachment arrived on.
   * @param msg - The attachment-only message.
   * @param interactiveKey - Interactive-state slot key.
   */
  stageAttachments(p: Platform, msg: Message, interactiveKey: string): void {
    const workDir = this.effectiveWorkDirForPending(interactiveKey)
    if (workDir === '') {
      console.warn(`stageAttachments: no workDir resolvable; cannot stage (${interactiveKey})`)
      return
    }
    const dir = pendingDirFor(workDir, interactiveKey)
    const imagePaths = saveImagesToDir(dir, msg.images)
    const filePaths = saveFilesToDir(dir, msg.files)

    this.ensureInteractiveStateForQueueing(interactiveKey, p, msg.replyCtx)
    const st = this.interactiveStates.get(interactiveKey)
    if (st === undefined) return

    let fileList = ''
    if (st.pendingDir === '') st.pendingDir = dir
    for (const imgPath of imagePaths) {
      st.pendingAttachments.push({ messageID: msg.messageID, kind: 'image', path: imgPath })
    }
    for (const filePath of filePaths) {
      st.pendingAttachments.push({ messageID: msg.messageID, kind: 'file', path: filePath })
    }
    if (msg.files.length > 0) {
      const names = msg.files.map(f => f.fileName).filter(n => n !== '')
      if (names.length > 0) fileList = `: ${names.join(', ')}`
    }
    st.touchActivity()
    let imgN = 0
    let fileN = 0
    for (const a of st.pendingAttachments) {
      if (a.kind === 'image') imgN++
      else fileN++
    }
    void this.reply(p, msg.replyCtx, this.i18n.tf(Msg.AttachmentsStaged, imgN, fileN, fileList))
  }

  /**
   * Clear all staged attachment state and asynchronously remove the pending
   * dir (Go discardStagedAttachments). notify=true also tells the user the
   * staged attachments were dropped; /stop passes false because its stop card
   * is already user feedback.
   * @param state - State holding the staged attachments.
   * @param notify - Whether to tell the user the attachments were dropped.
   * @returns Whether anything had been staged.
   */
  discardStagedAttachments(state: InteractiveState, notify: boolean): boolean {
    const pendingDir = state.pendingDir
    const hasStaged = state.pendingAttachments.length > 0
    state.pendingDir = ''
    state.pendingAttachments = []
    if (notify && hasStaged) {
      const platform = state.platform
      if (platform !== undefined) void this.reply(platform, state.replyCtx, this.i18n.t(Msg.AttachmentsDiscarded))
    }
    if (pendingDir !== '') {
      void rm(pendingDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(`discardStagedAttachments: remove pending dir failed (${pendingDir}): ${String(error)}`)
      })
    }
    return hasStaged
  }

  /**
   * The directory the agent session will run in, so staged attachments land
   * where the agent can later read them (Go effectiveWorkDirForPending,
   * single-workspace shape: per-chat override, then the agent's workDir,
   * then the engine base).
   */
  private effectiveWorkDirForPending(interactiveKey: string): string {
    const override = this.perChatWorkDir(this.dirOverrideKey(interactiveKey))
    if (override !== '') return override
    const switcher = this.agent as { getWorkDir?: () => string }
    if (typeof switcher.getWorkDir === 'function') {
      const wd = switcher.getWorkDir().trim()
      if (wd !== '') return wd
    }
    return this.baseWorkDir
  }

  // ── turn processing ─────────────────────────────────────────────────────

  /**
   * Run one user turn end-to-end (Go processInteractiveMessageWith, M1 subset).
   * @param p - Platform the message arrived on.
   * @param msg - The inbound message driving the turn.
   * @param session - Locked session the turn runs under.
   * @param interactiveKey - Interactive-state slot key; defaults to msg.sessionKey.
   */
  async processInteractiveMessageWith(p: Platform, msg: Message, session: Session, interactiveKey: string = msg.sessionKey): Promise<void> {
    let unlocked = false
    try {
      // A new user turn takes the event channel back from the unsolicited
      // reader (Go stopUnsolicitedReader at turn entry): cancel its parked
      // receive so it cannot steal this turn's first event.
      this.stopUnsolicitedReader(this.interactiveStates.get(interactiveKey))
      this.i18n.detectAndSet(msg.content)

      // Feature ask metadata is consumed at turn START: a queued ask behind
      // a busy turn must not take effect until the turn actually begins.
      await this.bridge.serial('feishuBridge/turn-start', { engine: this, session, metadata: msg.metadata })

      await this.handleSpawnedGroupFirstMessage(p, msg, session)

      // Go separates the interactive-state slot key from the session-key
      // start option: cron new-per-run slots carry a #cron suffix the option
      // must not.
      const state = await this.getOrCreateInteractiveStateWith(interactiveKey, p, msg.replyCtx, session, msg.modeOverride ?? '', msg.sessionKey)
      try {
        state.turnSeq++
        state.platform = p
        state.replyCtx = msg.replyCtx
        // The user is back with a new turn — abort in-flight HTML renders
        // (Go cancelRenders at new-turn entry): a stale render is no longer
        // worth burning tokens on.
        cancelRenders(state)

        if (state.agentSession === undefined) {
          await this.reply(p, msg.replyCtx, this.i18n.t(Msg.FailedToStartAgentSession))
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

        let promptContent = this.buildSenderPrompt(msg.content, msg.userID, msg.userName, msg.platform, msg.sessionKey)
        // Splice staged attachment paths from earlier pure-attachment
        // messages into this turn's prompt (#8).
        const { imagePaths, filePaths } = state.drainStagedAttachmentPaths()
        promptContent = spliceStagedAttachments(promptContent, imagePaths, filePaths)
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
      this.startUnsolicitedReader(session, this.sessions, interactiveKey)
      unlocked = true
    } catch (error) {
      console.error(`engine: turn processing failed (${msg.sessionKey}): ${String(error)}`)
    } finally {
      if (!unlocked) session.unlock()
    }
  }

  // ── unsolicited reader (engine-woken turns between user turns) ───────────

  /**
   * Start the unsolicited reader after every event pump exited: engine turns
   * woken without a user message (background job completion, background
   * subagent report) push events onto a channel nobody reads, so their reply,
   * progress card, and permission bridging were silently dropped and the idle
   * reaper later disposed the parked turn (2026-08-23 oc_9956 incident). The
   * reader parks on the live channel for as long as it stays quiet (idle
   * timeout), keeps itself alive while an ask is parked, a tool call is in
   * flight, or a background task is pending (each bounded by its grace), and
   * runs a full pump over the first substantive event it consumes. Idempotent
   * while a reader is already parked.
   * @param session - Session the orphan turn runs on; tryLock arbitrates
   *   against a message-path pump.
   * @param sessions - Session manager for persistence.
   * @param interactiveKey - Interactive-state slot key.
   */
  startUnsolicitedReader(session: Session, sessions: SessionManager, interactiveKey: string): void {
    const state = this.interactiveStates.get(interactiveKey)
    if (state === undefined) return
    if (state.unsolicitedReader !== undefined && !state.unsolicitedReader.stopped) return
    if (state.agentSession === undefined || !state.agentSession.alive()) return
    if (state.isStopped() || state.closing !== undefined) return
    const handle: UnsolicitedReaderHandle = { stopped: false, cancelRecv: () => {} }
    state.unsolicitedReader = handle
    void this.runUnsolicitedReader(handle, state, session, sessions, interactiveKey)
  }

  /**
   * Disarm a state's unsolicited reader so the next turn takes sole ownership
   * of the event channel (Go stopUnsolicitedReader): the parked receive is
   * cancelled so it cannot steal the new turn's first event.
   * @param state - State whose reader is disarmed; undefined is a no-op.
   */
  stopUnsolicitedReader(state: InteractiveState | undefined): void {
    if (state === undefined) return
    const handle = state.unsolicitedReader
    if (handle === undefined) return
    handle.stopped = true
    handle.cancelRecv()
    if (state.unsolicitedReader === handle) state.unsolicitedReader = undefined
  }

  /**
   * The unsolicited reader loop (Go runUnsolicitedReader, adapted to the
   * bridge's pump architecture): consumes agent events between user turns,
   * relays spillover duplicate frames as plain text, and runs full orphan-turn
   * pumps for genuine engine-woken turns. Exits on idle (after the keep-alive
   * graces), channel close, state replacement, or disarm.
   */
  private async runUnsolicitedReader(
    handle: UnsolicitedReaderHandle,
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    interactiveKey: string,
  ): Promise<void> {
    try {
      for (;;) {
        if (handle.stopped) return
        if (this.interactiveStates.get(interactiveKey) !== state) return
        const agentSession = state.agentSession
        if (agentSession === undefined || !agentSession.alive()) return
        const channel = agentSession.events()
        const arm = channel.receiveArmed()
        handle.cancelRecv = () => { arm.cancel() }
        const idleSleep = this.unsolicitedIdleTimeout > 0 ? cancellableSleep(this.unsolicitedIdleTimeout) : undefined
        type Outcome =
          | { kind: 'closed' }
          | { kind: 'idle' }
          | { kind: 'event'; event: Event }
          | { kind: 'never' }
        const outcome: Outcome = await Promise.race([
          arm.promise.then(r => (r.done ? { kind: 'closed' } as const : { kind: 'event' as const, event: r.event })),
          idleSleep !== undefined ? idleSleep.promise.then(() => ({ kind: 'idle' } as const)) : neverPromise,
        ])
        idleSleep?.cancel()
        if (readerStopped(handle)) {
          arm.cancel()
          return
        }

        if (outcome.kind === 'closed' || outcome.kind === 'never') return

        if (outcome.kind === 'idle') {
          arm.cancel()
          // A parked ask is the user thinking, not silence (Go hasPending).
          if (state.pendingAsk !== undefined) continue
          // A tool in flight emits no events while running; keep waiting up to
          // the tool-in-flight budget so its result is not abandoned, unless
          // the tool is genuinely hung.
          if (state.activeToolCalls > 0 && this.unsolicitedToolInFlightTimeout > 0
            && !this.stallConfirmed(state, Date.now(), this.unsolicitedToolInFlightTimeout)) continue
          // A pending background task completes as a later engine-woken turn;
          // keep the reader alive up to the background grace so the completion
          // is consumed, then give up on a task that never completes.
          if (state.backgroundTasksPending > 0 && this.unsolicitedBackgroundGrace > 0) {
            if (state.bgWaitStartedAt === 0) state.bgWaitStartedAt = Date.now()
            if (Date.now() - state.bgWaitStartedAt < this.unsolicitedBackgroundGrace) continue
            console.info(`engine: unsolicited reader background-task grace exhausted (${interactiveKey}: ${state.backgroundTasksPending} pending)`)
            state.backgroundTasksPending = 0
            state.bgWaitStartedAt = 0
          }
          // Exit and mark resync: any event buffered after this point is
          // drained by the next foreground turn instead of leaking into it.
          state.eventsNeedResync = true
          return
        }

        const event = outcome.event
        state.lastEventAt = Date.now()
        if (!isSubstantiveUnsolicitedEvent(event)) continue

        // Spillover: duplicate frames right after a foreground turn's ✅
        // completion are relayed as plain text — never a second streaming and
        // completion card (Go unsolicitedSpilloverGrace).
        const fgAt = state.lastForegroundCompletionAt
        if (this.unsolicitedSpilloverGrace > 0 && fgAt > 0 && Date.now() - fgAt < this.unsolicitedSpilloverGrace) {
          if (await this.relaySpilloverTurn(handle, state, session, sessions, event)) return
          continue
        }

        if (!session.tryLock()) {
          // A message-path turn owns the session; its pump reads this event.
          channel.push(event)
          handle.stopped = true
          if (state.unsolicitedReader === handle) state.unsolicitedReader = undefined
          return
        }
        console.info(`engine: orphan turn pump started (${interactiveKey}, first event ${event.type}${event.toolName !== undefined ? ` ${event.toolName}` : ''})`)
        state.beginTurn()
        try {
          await this.processInteractiveEvents(
            state, session, sessions, interactiveKey, '', undefined, state.replyCtx, event, true)
          await this.drainPendingMessages(state, session, sessions, interactiveKey)
        } catch (error) {
          console.error(`engine: orphan turn failed (${interactiveKey}): ${String(error)}`)
          session.unlock()
        } finally {
          state.endTurn()
        }
        // Loop: re-arm for the next engine-woken turn.
      }
    } finally {
      if (state.unsolicitedReader === handle) state.unsolicitedReader = undefined
    }
  }

  /**
   * Relay one spillover turn as plain text: consume events until the result,
   * forwarding the final text without any card (Go's reader spillover
   * branches). Tool calls are counted only; an error relays its message and
   * ends the reader.
   * @returns True when the reader must exit (error or channel close).
   */
  private async relaySpilloverTurn(
    handle: UnsolicitedReaderHandle,
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    firstEvent: Event,
  ): Promise<boolean> {
    const channel = state.agentSession?.events()
    if (channel === undefined) return true
    const p = state.platform
    const parts: string[] = []
    let pending: Event | undefined = firstEvent
    for (;;) {
      if (pending === undefined) {
        const arm = channel.receiveArmed()
        handle.cancelRecv = () => { arm.cancel() }
        const idleSleep = this.unsolicitedIdleTimeout > 0 ? cancellableSleep(this.unsolicitedIdleTimeout) : undefined
        const raced = await Promise.race([
          arm.promise.then(r => (r.done ? { kind: 'closed' as const } : { kind: 'event' as const, event: r.event })),
          idleSleep !== undefined ? idleSleep.promise.then(() => ({ kind: 'idle' } as const)) : neverPromise,
        ])
        idleSleep?.cancel()
        if (readerStopped(handle)) {
          arm.cancel()
          return true
        }
        if (raced.kind === 'idle') {
          // Quiet mid-relay: abandon the partial turn (Go retires on idle).
          arm.cancel()
          return false
        }
        if (raced.kind === 'closed' || raced.kind === 'never') return true
        pending = raced.event
      }
      const event = pending
      pending = undefined
      state.lastEventAt = Date.now()
      switch (event.type) {
        case 'text': {
          if (event.content !== '' && !isSilentReply(event.content)) parts.push(event.content)
          break
        }
        case 'tool_use': {
          state.activeToolCalls++
          break
        }
        case 'tool_result': {
          state.activeToolCalls = Math.max(0, state.activeToolCalls - 1)
          break
        }
        case 'result': {
          let full = event.content
          if (parts.length > 0 && (full === '' || isSilentReply(full))) full = parts.join('')
          if (full !== '' && !isSilentReply(full) && p !== undefined) {
            for (const chunk of splitMessage(full, MaxPlatformMessageLen)) {
              await this.send(p, state.replyCtx, chunk)
            }
          }
          if (event.content.trim() !== '') session.setLastResult(event.content.trim())
          sessions.save()
          return false
        }
        case 'error': {
          const text = event.errorText ?? event.error?.message ?? 'agent error'
          if (p !== undefined) await this.send(p, state.replyCtx, this.i18n.tf(Msg.Error, text))
          state.eventsNeedResync = true
          return true
        }
        default:
          break
      }
    }
  }

  /**
   * Sender-injection prompt prefix (Go buildSenderPrompt).
   * @param content - The message content.
   * @param userID - Sender's platform user ID; '' disables injection.
   * @param userName - Sender's display name; '' omits it from the header.
   * @param platform - Platform name the message arrived on.
   * @param sessionKey - Session key the chat ID is extracted from.
   * @returns The content, with the sender header prepended when enabled.
   */
  buildSenderPrompt(content: string, userID: string, userName: string, platform: string, sessionKey: string): string {
    if (!this.injectSender || userID === '') return content
    const chatID = extractChannelID(sessionKey)
    if (userName !== '') {
      const safeName = userName.replaceAll('"', "'").replaceAll('\n', ' ').replaceAll('\r', '')
      return `[feishu-bridge sender_id=${userID} sender_name="${safeName}" platform=${platform} chat_id=${chatID}]\n${content}`
    }
    return `[feishu-bridge sender_id=${userID} platform=${platform} chat_id=${chatID}]\n${content}`
  }

  /**
   * Get or create the interactive state for a session key, recycling a stale
   * agent process whose session ID no longer matches (Go
   * getOrCreateInteractiveStateWith, M1 subset without fork sentinels and
   * workspace overrides).
   * @param sessionKey - Interactive-state slot key.
   * @param p - Platform the message arrived on.
   * @param replyCtx - Platform reply context for error replies.
   * @param session - Session whose agent-session ID arbitrates recycling.
   * @param modeOverride - Mode injected at session start; '' = none.
   * @param envKey - sessionKey option handed to startSession; may differ from sessionKey (cron slots).
   * @returns The live state, with a turn already begun.
   */
  async getOrCreateInteractiveStateWith(
    sessionKey: string,
    p: Platform,
    replyCtx: unknown,
    session: Session,
    modeOverride: string = '',
    envKey: string = sessionKey,
  ): Promise<InteractiveState> {
    // Wait out a concurrent teardown so two agents never resume the same
    // session id concurrently.
    for (;;) {
      const state = this.interactiveStates.get(sessionKey)
      if (state === undefined || state.closing === undefined) break
      await Promise.race([state.closing, cancellableSleep(this.agentCloseTimeout + 10_000).promise])
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
    const startOptions = this.buildSessionStartOptions(envKey, session)
    // Cron new-per-run slots key their interactive state as
    // `<sessionKey>#cron:<side>`; the ask surfaces must render and route
    // under that slot, not the bare session key (a bare lookup finds no
    // state and answers unattended).
    if (envKey !== sessionKey) startOptions.interactiveSlotKey = sessionKey

    const startSessionID = session.getAgentSessionID()

    // Resolve per-chat workDir override so the agent session starts in the
    // correct directory even in single-workspace mode (Go applyWorkDirOverride).
    const restoreWorkDir = this.applyWorkDirOverride(agent, sessionKey)
    let agentSession: AgentSession | undefined
    let degradedToFresh = false
    try {
      try {
        agentSession = await this.startAgentLocked(agent, startSessionID, startOptions, modeOverride)
      } catch (error) {
        // A live-guard rejection means the persisted session is still being
        // torn down (e.g. the user stopped it moments ago): the disposal is
        // in flight, not gone, so poll within the budget before degrading.
        if (startSessionID !== '' && isSessionLiveError(error)) {
          console.warn(`session resume blocked by in-flight teardown, retrying (${sessionKey}): ${String(error)}`)
          agentSession = await this.retryResumePastLiveGuard(agent, startSessionID, startOptions, modeOverride)
        }
        if (agentSession === undefined) {
          if (startSessionID !== '') {
            console.error(`session resume failed, falling back to fresh session (${sessionKey}): ${String(error)}`)
            try {
              agentSession = await this.startAgentLocked(agent, '', startOptions, modeOverride)
              degradedToFresh = true
              // A rollback fork whose truncated transcript cannot be resumed gets
              // the fork-degrade wording (Go's __forkat__ guard replies
              // MsgForkCrossWorkDirDegraded); every other resume keeps the
              // generic message.
              const degradeKey = startSessionID.startsWith(ForkAtSessionPrefix)
                ? Msg.ForkCrossWorkDirDegraded
                : Msg.SessionResumeDegraded
              void this.reply(p, replyCtx, this.i18n.t(degradeKey))
            } catch (freshError) {
              console.error(`failed to start interactive session (${sessionKey}): ${String(freshError)}`)
            }
          } else {
            console.error(`failed to start interactive session (${sessionKey}): ${String(error)}`)
          }
        }
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
      // The degraded fallback REPLACES the unresumable id: compareAndSet's
      // sticky concrete id would keep the chat pinned to the poisoned
      // session, failing every later message the same way.
      let bound: boolean
      if (degradedToFresh) {
        session.setAgentSessionID(newID, agent.name())
        bound = true
      } else {
        bound = session.compareAndSetAgentSessionID(newID, agent.name())
      }
      if (bound) {
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
    newState.sessionStartOptions = startOptions
    newState.eventsNeedResync = true
    newState.effectiveIdleTimeout = this.eventIdleTimeout
    this.adoptPendingFromPlaceholder(this.interactiveStates.get(sessionKey), newState)
    this.interactiveStates.set(sessionKey, newState)

    newState.beginTurn()
    return newState
  }

  /**
   * Carry queued messages and staged attachments from a placeholder state
   * into the live one (Go adoptPendingFromPlaceholder): a pure-attachment
   * message creates a placeholder via stageAttachments, and the next text
   * message swaps in the real state here.
   */
  private adoptPendingFromPlaceholder(existing: InteractiveState | undefined, fresh: InteractiveState): void {
    if (existing === undefined) return
    if (existing.pendingMessages.length > 0) {
      fresh.pendingMessages = [...existing.pendingMessages, ...fresh.pendingMessages]
      existing.pendingMessages = []
    }
    if (existing.pendingAttachments.length > 0) {
      fresh.pendingAttachments = [...existing.pendingAttachments, ...fresh.pendingAttachments]
      existing.pendingAttachments = []
    }
    if (existing.pendingDir !== '') {
      fresh.pendingDir = existing.pendingDir
      existing.pendingDir = ''
    }
  }

  /**
   * Typed per-session start options (Go buildSessionEnv): the engine session
   * key plus the persona/workspace/venv metadata the adapter consumes at
   * startSession. The engine fills the subtask (attended/no-report) and
   * workspace sections; feature sections (research-assistant flag, persona
   * block, shared research venv) are decorated by
   * `feishuBridge/session-start-options` listeners.
   * @param ccKey - Value used as the options' sessionKey.
   * @param session - Session whose subtask flags expand the options.
   * @returns The typed start options for the agent session.
   */
  buildSessionStartOptions(ccKey: string, session: Session): SessionStartOptions {
    const options: SessionStartOptions = {
      sessionKey: ccKey,
      ...(session.getSubtaskDepth() > 0
        ? {
          subtask: {
            attended: session.getSubtaskAttended(),
            noReport: session.getSubtaskNoReport(),
          },
        }
        : {}),
      ...(this.feishuWorkspace !== undefined ? { feishuWorkspace: this.feishuWorkspace } : {}),
    }
    this.bridge.waterfall('feishuBridge/session-start-options', { engine: this, session, options }, () => undefined)
    return options
  }

  /**
   * StartSession with a one-shot mode override, serialized per engine (Go
   * startAgentLocked). Public for the ported start-injection tests.
   * @param agent - Agent to start the session on.
   * @param sessionID - Session to resume; '' starts a fresh session.
   * @param options - Typed start options handed through to the agent; undefined = plain session.
   * @param modeOverride - Mode injected before the start; '' = none.
   * @returns The started agent session.
   */
  startAgentLocked(agent: Agent, sessionID: string, options: SessionStartOptions | undefined, modeOverride: string): Promise<AgentSession> {
    const modeInj = asSessionModeInjector(agent)
    if (modeInj !== undefined && modeOverride !== '') modeInj.setSessionMode(modeOverride)
    return agent.startSession(sessionID, options)
  }

  /**
   * Poll-resume a session whose live-guard rejection may clear once an
   * in-flight teardown finishes. Any non-live-guard error aborts the polling
   * (the caller degrades); success returns the resumed session.
   * @param agent - Agent to start the session on.
   * @param sessionID - Session to resume.
   * @param options - Typed start options handed to each attempt.
   * @param modeOverride - Mode injected at session start; '' = none.
   * @returns The resumed agent session, or undefined when the budget ends.
   */
  private async retryResumePastLiveGuard(
    agent: Agent, sessionID: string, options: SessionStartOptions, modeOverride: string,
  ): Promise<AgentSession | undefined> {
    const deadline = Date.now() + this.liveGuardRetryBudgetMs
    for (;;) {
      await cancellableSleep(this.liveGuardRetryIntervalMs).promise
      try {
        return await this.startAgentLocked(agent, sessionID, options, modeOverride)
      } catch (error) {
        if (!isSessionLiveError(error)) {
          console.error(`session resume retry failed with a permanent error: ${String(error)}`)
          return undefined
        }
        if (Date.now() >= deadline) {
          console.error(`session resume retry budget exhausted (session ${sessionID})`)
          return undefined
        }
      }
    }
  }

  // ── event loop ──────────────────────────────────────────────────────────

  /**
   * Consume agent events for one turn: accumulate text/thinking, deliver the
   * final reply, drain queued messages, and handle process exit (Go
   * processInteractiveEvents, M1 subset without preview cards and the
   * watchdog).
   * @param state - Interactive state the turn runs on.
   * @param session - Session accumulating the turn's history.
   * @param sessions - Session manager for ID persistence.
   * @param sessionKey - Interactive-state slot key.
   * @param _msgID - Message ID retained for Go parity; unused.
   * @param sendDone - Settled prompt-send promise; an error value fails the turn.
   * @param replyCtx - Platform reply context for outgoing messages.
   * @param firstEvent - Event the unsolicited reader already consumed off the
   *   channel; the loop processes it before arming its own receive.
   * @param background - True when the reader woke this turn with no user
   *   message: the placeholder distinguishes background-task completions and
   *   the result consumes a pending background-task slot.
   */
  async processInteractiveEvents(
    state: InteractiveState,
    session: Session,
    sessions: SessionManager,
    sessionKey: string,
    _msgID: string,
    sendDone: Promise<unknown> | undefined,
    replyCtx: unknown,
    firstEvent?: Event,
    background: boolean = false,
  ): Promise<void> {
    // Turn surfaces live on the state (see InteractiveState): the ask
    // delegate running from the adapter's answerer shares them with the
    // loop. Each loop invocation owns one turn and resets them here.
    state.textParts = []
    state.segmentStart = 0
    state.toolCount = 0
    state.silentHold = false
    let activeToolCalls = 0
    let stallRetries = 0
    let turnStartedBg = false
    // Completion-footer state.timing (Go turnStart/agentStartTime): streamed
    // generation spans accumulate here; the token rate divides the turn's
    // output tokens by their union (see TurnTiming).
    state.timing = { turnStart: Date.now(), agentStart: Date.now(), generationSpans: [] }
    let generationStart: number | undefined

    const channel = state.agentSession?.events()
    if (channel === undefined) return

    // M2 preview machinery: one streamPreview + compact writer per turn,
    // sharing the state's async sender so PATCHes stay off this loop.
    const platform = state.platform ?? this.platforms[0]
    if (platform === undefined) return
    state.sender ??= newAsyncSender(sessionKey)
    const sender = state.sender
    let sp = newStreamPreview(this.streamPreview, platform, replyCtx, undefined, sender, sessionKey)
    state.preview = sp
    let cp = newCompactProgressWriter(platform, replyCtx, this.agent.name(),
      this.i18n.currentLang(), undefined, sender)
    state.progressWriter = cp
    // Placeholder card so the user sees visual feedback (with push) before
    // the first agent event arrives. A reader-woken turn with pending
    // background tasks is likely a completion: distinct header (Go
    // placeholderText), with the pending count riding the hint line.
    if (this.display.toolProgress && sp.canPreview()) {
      void sp.showPlaceholder(this.i18n.t(
        background && state.backgroundTasksPending > 0 ? Msg.BgTaskProcessing : Msg.Processing))
      if (background && state.backgroundTasksPending > 0) {
        void sp.setBackgroundHint(this.i18n.tf(Msg.BgTaskRunning, state.backgroundTasksPending))
      }
    }
    let thinkingStreamed = false
    let thinkingAccum = ''
    let deltaAccum = ''
    let deltaFlushed = false

    // Plan-mode tracking (Go engine_events.go): the plan .md path written by
    // the agent, the content last sent as the plan card, and the revision
    // counter for export keys / render artifacts.
    state.planFilePath = ''
    state.pendingPlanFilePath = ''
    state.pendingPlanToolID = ''
    state.sentPlanContent = ''
    state.planRevisionCount = 0

    /** Drain queued async PATCHes before a terminal card state. */
    const barrier = (): Promise<void> => sender.barrier()

    let pendingSend = sendDone
    const stopP = state.stopSignal()
    // Hard cap (Go watchdog watchdogKillHard): a turn whose events keep
    // trickling in resets the idle timer forever, so the cap is enforced on
    // event arrival. Research sessions lift it (Go isResearchSession). The
    // cap is per turn, not per run: a queued-message takeover resets
    // turnStart below — a deliberate deviation from Go's per-run clock, where
    // a follow-up message after a near-cap long turn inherits a nearly
    // exhausted budget and is killed within minutes.
    let turnStart = Date.now()
    const softCap = this.absoluteTurnMax(state.idleTimeout(this.eventIdleTimeout))
    const hardCapMs = softCap > 0 && !this.bridge.waterfall('feishuBridge/hard-cap-exemption', { engine: this, session }, () => false) ? softCap * 3 : 0
    // The live session's event channel; swapped when a stall retry restarts
    // the agent — re-arming recvP on the pre-retry channel would read its
    // close as an agent exit on the very next event.
    let events = channel
    // Re-armed before each event is processed; the loop's finally cancels the
    // leftover parked waiter so an exited loop never steals the next event
    // from a later receiver (orphan watch or the next turn's pump).
    let recvArm = firstEvent !== undefined
      ? { promise: Promise.resolve({ done: false as const, event: firstEvent }), cancel: (): void => {} }
      : events.receiveArmed()
    let recvP = recvArm.promise

    /** One resolved arm of the loop's select (Go's select cases). */
    type LoopOutcome =
      | { kind: 'event'; event: Event }
      | { kind: 'closed' }
      | { kind: 'send'; error: unknown }
      | { kind: 'stop' }
      | { kind: 'idle' }
      | { kind: 'never' }

    try {
      for (;;) {
      // Idle timer: re-armed per iteration (Go reset-after-event); not armed
      // while an ask is parked (the user deciding is not a stall — the old
      // loop parked on the ask's resolution with the timer cancelled) or a
      // tool call is in flight on a user-driven turn (Go stops it on
      // EventToolUse). A reader-woken background turn arms the tool-in-flight
      // budget instead of disarming entirely, so a hung background tool
      // cannot pin the processing card forever (Go
      // unsolicitedToolInFlightTimeout).
        const idleMs = state.pendingAsk !== undefined
          ? 0
          : activeToolCalls > 0
            ? (background ? this.unsolicitedToolInFlightTimeout : 0)
            : state.idleTimeout(this.eventIdleTimeout)
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

        // Re-sync the surface locals: an askUser that resolved while the
        // loop was parked on this select has already swapped the state's
        // preview and progress writer for fresh ones.
        sp = state.preview
        cp = state.progressWriter

        if (outcome.kind === 'stop') {
          await barrier()
          if (state.isUserStopped() || state.engineStopped) {
          // User stop or engine teardown: stopped terminal card, skipping
          // cp.Finalize(Failed) which would clobber the ⏹ 已停止 card.
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
              // The dead child owes its parent a settlement it can no longer deliver.
              this.reportSubtaskTimeout(sessionKey)
            }
            const p = state.platform
            if (p !== undefined) {
              await this.send(p, replyCtx, this.i18n.tf(Msg.Error, errorMessage(outcome.error)))
              await this.applyChatPhase(p, sessionKey, 'attention')
            }
            return
          }
          continue
        }

        if (outcome.kind === 'idle') {
        // Re-verify against the last event arrival: a fire right after an
        // event resolved is stale — keep waiting (Go stallConfirmed). The
        // window is the armed budget (turn idle, or tool-in-flight on a
        // background turn).
          if (idleMs <= 0 || !this.stallConfirmed(state, Date.now(), idleMs)) continue

          stallRetries++
          if (stallRetries <= this.stallMaxRetries) {
            const retry = await this.restartAgentForStallRetry(
              state, state.agent ?? this.agent, sessionKey, channel)
            if (retry !== undefined) {
              const stallPlatform = state.platform
              if (stallPlatform !== undefined) {
                const idleSec = Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000)
                await this.send(stallPlatform, replyCtx,
                  this.i18n.tf(Msg.StallRetry, idleSec, stallRetries, this.stallMaxRetries))
              }
              // Go parity: retire the stalled card with a failed render (the
              // stalled turn did not complete) and give the resumed 「继续」
              // turn a fresh card instead of PATCHing the stale one.
              await sp.markFailed()
              sp = newStreamPreview(this.streamPreview, platform, replyCtx, undefined, sender, sessionKey)
              cp = newCompactProgressWriter(platform, replyCtx, this.agent.name(),
                this.i18n.currentLang(), undefined, sender)
              state.preview = sp
              state.progressWriter = cp
              if (this.display.toolProgress && sp.canPreview()) {
                void sp.showPlaceholder(this.i18n.t(Msg.Processing))
              }
              state.textParts = []
              state.segmentStart = 0
              state.toolCount = 0
              state.silentHold = false
              events = retry.events()
              recvArm = events.receiveArmed()
              recvP = recvArm.promise
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
              this.i18n.tf(Msg.StallTimeout, Math.round(state.idleTimeout(this.eventIdleTimeout) / 1000), this.stallMaxRetries))
            await this.applyChatPhase(p, sessionKey, 'attention')
          }
          // Go parity: fail the card before the kill so it cannot freeze in
          // its Running state next to the stall-timeout notice.
          await sp.markFailed()
          await this.cleanupInteractiveState(sessionKey, state)
          // A stalled-out child never reports; the parent gets the synthetic
          // timeout notice instead of waiting forever.
          this.reportSubtaskTimeout(sessionKey)
          return
        }

        if (outcome.kind === 'closed' || outcome.kind === 'never') {
          if (outcome.kind === 'closed') {
            await this.handleChannelClosed(state, session, sessionKey, replyCtx)
          }
          return
        }

        const event = outcome.event
        state.lastEventAt = Date.now()
        recvArm = events.receiveArmed()
        recvP = recvArm.promise

        if (hardCapMs > 0 && Date.now() - turnStart > hardCapMs) {
          console.error(`watchdog: hard turn cap exceeded, force cleanup (${sessionKey})`)
          state.eventsNeedResync = true
          const p = state.platform
          if (p !== undefined) {
            await this.send(p, replyCtx, this.i18n.t(Msg.WatchdogReset))
          }
          await this.cleanupInteractiveState(sessionKey, state)
          // The capped child owes its parent a settlement it can no longer deliver.
          this.reportSubtaskTimeout(sessionKey)
          return
        }

        if (state.isStopped()) {
        // Go parity: the post-stop event arrival renders the terminal card
        // (user or engine stop → ⏹; any other stop → failed) instead of
        // returning silently and freezing the card mid-state.
          await barrier()
          if (state.isUserStopped() || state.engineStopped) await sp.markStopped()
          else await sp.markFailed()
          state.eventsNeedResync = true
          return
        }

        const p = state.platform

        switch (event.type) {
          case 'thinking': {
            if (isEllipsisOnly(event.content)) break
            // Thinking block complete: drop the streamed 💭 section. Runs even
            // in quiet mode (Go parity — clearThinking precedes the
            // !ThinkingMessages branch) so the 思考中 header does not linger.
            if (thinkingStreamed && sp.canPreview()) await sp.clearThinking()
            // In quiet mode (thinkingMessages=false), thinking events must not
            // affect the streaming preview — no completeAndDetach, no text
            // segment flush. Otherwise completeAndDetach sets degraded=true,
            // causing the result handler to fall through to this.send() and
            // duplicate the reply as plain text alongside the already-finalized
            // card.
            if (!this.display.thinkingMessages) {
              thinkingStreamed = false
              thinkingAccum = ''
              break
            }
            if (state.textParts.length > state.segmentStart) {
              if (sp.canPreview()) {
                await sp.completeAndDetach()
                state.segmentStart = state.textParts.length
              } else {
                const segment = state.textParts.slice(state.segmentStart).join('')
                if (segment !== '' && p !== undefined) {
                  for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                    await this.send(p, replyCtx, chunk)
                  }
                }
                state.segmentStart = state.textParts.length
              }
              if (!sp.inProgressMode()) state.segmentStart = state.textParts.length
              state.silentHold = false
            }
            if (event.content !== '' && p !== undefined) {
              if (state.textParts.length > state.segmentStart) {
                if (!sp.canPreview()) {
                  const segment = state.textParts.slice(state.segmentStart).join('')
                  if (segment !== '') {
                    for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                      await this.send(p, replyCtx, chunk)
                    }
                  }
                }
                state.segmentStart = state.textParts.length
                state.silentHold = false
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
            if (generationStart === undefined) generationStart = Date.now()
            deltaAccum += event.content
            if (couldBeSilentPrefix(deltaAccum)) break
            deltaFlushed = true
            if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(deltaAccum)
            else if (sp.canPreview()) await sp.appendText(event.content)
            break
          }

          case 'thinking_delta': {
          // Preview-only: stream thinking into the 💭 section; the full
          // EventThinking block clears it and dedups. Not gated on
          // thinkingMessages (Go parity): quiet mode suppresses thinking
          // *messages*, not the streaming 思考中 header.
            if (generationStart === undefined) generationStart = Date.now()
            thinkingAccum += event.content
            thinkingStreamed = true
            if (sp.canPreview()) await sp.appendThinking(thinkingAccum)
            break
          }

          case 'tool_use': {
            state.toolCount++
            activeToolCalls++
            state.activeToolCalls = activeToolCalls
            if (event.toolBackground === true) {
              // A run_in_background call returns immediately; its completion
              // arrives as a later engine-woken turn. Count it so the reader
              // stays alive for that turn and the card shows the running count
              // (Go EventToolUse ToolBackground).
              state.backgroundTasksPending++
              turnStartedBg = true
              if (this.display.toolProgress && sp.canPreview()) {
                await sp.setBackgroundHint(this.i18n.tf(Msg.BgTaskRunning, state.backgroundTasksPending))
              }
            }
            // Clear streaming-thinking state when a tool starts — the agent is
            // no longer thinking once it invokes a tool (Go safety net for
            // agents that only emit thinking_delta and never a full block).
            if (thinkingStreamed && sp.canPreview()) await sp.clearThinking()
            if (thinkingStreamed) thinkingAccum = ''
            // Track plan file path for plan-mode support (Go): raw
            // toolInputRaw.file_path, not the summarized toolInput. A subagent
            // child's write never promotes on the parent — the child runs its
            // own plan lifecycle. The tool name is dsh's lowercase 'write';
            // the Go-era capitalized 'Write' branch never matched.
            if (event.toolName === 'write' && event.fromSubagent !== true) {
              const fp = event.toolInputRaw?.file_path
              if (typeof fp === 'string' && fp.includes('.claude/plans/')) {
                state.pendingPlanFilePath = fp
                state.pendingPlanToolID = event.toolID ?? ''
              }
            }
            // The parent's own tool call ends its model step; a delegated
            // subagent child's call must not close the parent's span — the
            // parent may keep generating while the child runs.
            if (event.fromSubagent !== true && generationStart !== undefined) {
              state.timing.generationSpans.push({ start: generationStart, end: Date.now() })
              generationStart = undefined
            }
            // A todo-list tool call replaces the pinned todo section (dsh
            // `todo_write`, Claude-style `TodoWrite`); an unparseable input
            // keeps the last list. A subagent child's todo list stays on the
            // child transcript — it must not overwrite the parent's section.
            if (isTodoToolName(event.toolName ?? '') && event.fromSubagent !== true) {
              const items = parseTodoItems(event.toolInput ?? '')
              if (items !== undefined) {
                if (sp.canPreview()) await sp.updateTodoSection(items)
                cp.setTodos(items)
              }
            }
            if (this.display.toolProgress && sp.canPreview()) {
            // Subagent child calls show the delegation label on the header
            // line; the real tool name rides the code block as `name -> input`.
              const entry = newToolProgressEntry(
                event.fromSubagent === true ? 'subagent' : (event.toolName ?? ''),
                event.toolInput ?? '',
                event.toolID ?? '',
              )
              if (event.fromSubagent === true) entry.fullName = event.toolName ?? ''
              await sp.appendProgress(entry)
            }
            break
          }

          case 'tool_result': {
          // Promote the plan file path once its write call settles (Go): on
          // denial the agent must still be able to revise the same file. The
          // result event carries no tool name, so the match rides the call
          // id captured on the pending write.
            if (state.pendingPlanFilePath !== '' && event.toolID !== undefined
              && event.toolID !== '' && event.toolID === state.pendingPlanToolID) {
              state.planFilePath = state.pendingPlanFilePath
              state.pendingPlanFilePath = ''
              state.pendingPlanToolID = ''
            }

            if (this.display.toolMessages) {
              const result = (event.toolResult ?? '').trim() || event.content.trim()
              if (result !== '' && p !== undefined) {
                const entry = {
                  kind: 'tool_result' as const,
                  tool: event.fromSubagent === true ? 'subagent' : (event.toolName ?? ''),
                  text: result,
                }
                // A subagent child's result stays on the progress card; the
                // standalone-message fallback would drop child tool output
                // straight into the chat.
                if (!await cp.appendStructured(entry, result) && event.fromSubagent !== true) {
                  if (!suppressStandaloneToolResultEvent(p)) {
                    await this.send(p, replyCtx, result)
                  }
                }
              }
            } else if (this.display.toolProgress) {
            // Quiet mode: update the last tool entry with its result.
              const result = (event.toolResult ?? '').trim() || event.content.trim()
              if (result !== '' || event.done) {
                await sp.updateToolResult(event.toolID ?? '', result, event.toolSuccess !== false)
              }
            }
            activeToolCalls = Math.max(0, activeToolCalls - 1)
            state.activeToolCalls = activeToolCalls
            break
          }

          case 'subagent_status': {
          // Cumulative delegated-subagent count from the adapter's lineage
          // projection; the card's pinned stats section renders it.
            const count = Number.parseInt(event.content, 10)
            if (Number.isFinite(count) && count >= 0 && sp.canPreview()) {
              await sp.setSubagentCount(count)
            }
            break
          }

          case 'compaction': {
          // Native compaction lifecycle replaces Go's stream-json text mining
          // (Go engine_events.go EventCompaction).
            state.compactionCount++
            const summary = this.i18n.t(Msg.ContextCompacted)
            if (this.display.toolProgress && sp.canPreview()) {
              await sp.appendProgress(new ProgressEntry({ text: summary, isCompact: true }))
            } else if (p !== undefined) {
              await this.send(p, replyCtx, summary)
            }
            break
          }

          case 'todo_update': {
          // Whole-list snapshot from a native todo producer; same handling as a
          // todo_write tool call. A subagent child's list stays on the child.
            if (event.fromSubagent !== true && event.todos !== undefined) {
              if (sp.canPreview()) await sp.updateTodoSection(event.todos)
              cp.setTodos(event.todos)
            }
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
              state.textParts.push(text)
              if (deltaFlushed) {
              // This block was already previewed via deltas; state.textParts (the
              // final-message source of truth) is still updated.
                deltaAccum = ''
                deltaFlushed = false
              } else {
                const segmentText = state.textParts.slice(state.segmentStart).join('')
                if (state.silentHold) {
                  if (!couldBeSilentPrefix(segmentText)) {
                    state.silentHold = false
                    if (sp.canPreview() && sp.inProgressMode()) await sp.appendAnalysisText(segmentText)
                    else if (sp.canPreview()) await sp.appendText(segmentText)
                  }
                } else if (couldBeSilentPrefix(segmentText)) {
                  state.silentHold = true
                } else if (sp.canPreview() && sp.inProgressMode()) {
                  await sp.appendAnalysisText(text)
                } else if (sp.inProgressMode() && p !== undefined) {
                  await this.send(p, replyCtx, text)
                } else if (sp.canPreview()) {
                  await sp.appendText(text)
                }
              }
            }
            break
          }


          case 'result': {
          // Close the tail generation span so its decode time still counts
          // (Go closed dangling tool intervals at result).
            if (generationStart !== undefined) {
              state.timing.generationSpans.push({ start: generationStart, end: Date.now() })
              generationStart = undefined
            }
            const finished = await this.handleResultEvent(
              state, session, sessions, sessionKey, replyCtx, event,
              pendingSend, sp, cp, barrier, background, turnStartedBg)
            if (finished.kind === 'queued') {
            // A queued message takes over this loop as a fresh turn (Go
            // in-loop drain): reset per-turn state and continue. The watchdog
            // clock resets too — the new turn is a different user instruction
            // and must not inherit the previous long turn's spent budget.
            // The stall-retry path deliberately does NOT reset it: it serves
            // the same logical turn, and resetting would let an infinitely
            // stalling/retrying session dodge the hard cap forever.
              turnStart = Date.now()
              state.textParts = []
              state.segmentStart = 0
              state.toolCount = 0
              state.silentHold = false
              activeToolCalls = 0
              state.activeToolCalls = 0
              turnStartedBg = false
              thinkingStreamed = false
              thinkingAccum = ''
              deltaAccum = ''
              deltaFlushed = false
              pendingSend = finished.sendDone
              // The finished turn's completion degraded its preview (a terminal
              // card accepts no further PATCHes); the queued turn must not keep
              // PATCHing it or silently drop its tool progress — start a fresh
              // card, mirroring the post-permission restart below.
              sp = newStreamPreview(this.streamPreview, platform, replyCtx, undefined, sender, sessionKey)
              cp = newCompactProgressWriter(platform, replyCtx, this.agent.name(),
                this.i18n.currentLang(), undefined, sender)
              state.preview = sp
              if (this.display.toolProgress && sp.canPreview()) {
                void sp.showPlaceholder(this.i18n.t(Msg.Processing))
              }
              // recvP keeps the receive armed at the top of this iteration:
              // re-arming here would orphan that waiter, which then steals the
              // queued turn's first event.
              state.lastEventAt = Date.now()
              continue
            }
            return
          }

          case 'error': {
            state.eventsNeedResync = true
            await sp.markFailed()
            if (event.error !== undefined && p !== undefined) {
              await this.send(p, replyCtx, this.i18n.tf(Msg.Error, event.error.message))
              await this.applyChatPhase(p, sessionKey, 'attention')
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
    } finally {
      recvArm.cancel()
    }
  }

  /**
   * Whether the idle fire reflects a genuine stall (Go stallConfirmed).
   * The agent session's own stream activity arbitrates, but only while it is
   * fresh: events it projected after the pump's last receive mean the pump —
   * not the agent — went silent (a degraded/reload handoff left it holding a
   * dead channel), and a healthy stream must never be killed by a blind
   * watchdog (2026-08-25 oc_29bb incident: three 200s-cadence kills of a turn
   * that was streaming the whole window). A stream that itself went quiet for
   * the whole idle window is a frozen clock pair, not streaming — it must not
   * shield the pump forever (2026-08-26 oc_b46da incident: one late projection
   * froze `streamLast` 8s newer than the pump's last receive and pinned the
   * session lock behind a pump turn no watchdog would kill).
   * @param state - State whose last event timestamp is checked.
   * @param now - Current timestamp in ms.
   * @param idle - Effective idle timeout in ms.
   * @returns True when no live stream nor pump event arrived within the idle window.
   */
  stallConfirmed(state: InteractiveState, now: number, idle: number): boolean {
    const last = state.lastEventAt
    if (last === 0) return true
    const streamLast = state.agentSession?.lastStreamActivity?.() ?? 0
    if (streamLast > last && now - streamLast < idle) {
      const pumpIdleSec = Math.round((now - last) / 1000)
      const streamIdleSec = Math.round((now - streamLast) / 1000)
      console.warn(`stall check overridden: agent is streaming but the pump saw no event (last pump event ${pumpIdleSec}s ago, last stream event ${streamIdleSec}s ago) — blind pump, not a stall`)
      return false
    }
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
    sessionKey: string,
    replyCtx: unknown,
    event: Event,
    pendingSend: Promise<unknown> | undefined,
    sp: StreamPreview,
    cp: CompactProgressWriter,
    barrier: () => Promise<void>,
    background = false,
    turnStartedBg = false,
  ): Promise<{ kind: 'done' } | { kind: 'queued'; sendDone: Promise<unknown> }> {
    // Persist via the live session id.
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
    // A user-driven turn's completion anchors the spillover window: duplicate
    // frames the model emits right after it relay as plain text, never as a
    // second completion card (Go lastForegroundCompletionAt).
    if (!background) state.lastForegroundCompletionAt = Date.now()
    // A completed background turn consumes one pending run_in_background slot
    // — but not the turn that started the task (its completion comes later),
    // and the count clears the hint when it reaches zero (Go reader
    // EventResult; the clear is the bridge's fix for the count never dropping).
    if (background && !turnStartedBg && state.backgroundTasksPending > 0) {
      state.backgroundTasksPending--
      state.bgWaitStartedAt = 0
      if (this.display.toolProgress && sp.canPreview()) {
        await sp.setBackgroundHint(state.backgroundTasksPending > 0
          ? this.i18n.tf(Msg.BgTaskRunning, state.backgroundTasksPending)
          : '')
      }
    }
    // Unreported native subtasks stay visible on the settled card: the body
    // hint plus the title suffix count children still running in the
    // background (the turn itself is done — the header stays terminal).
    // Subtasks take the hint over a run_in_background count; both pending is
    // rare and the suffix already carries the subtask half.
    const pendingChildren = this.pendingNativeChildrenOf(sessionKey)
    if (this.display.toolProgress && sp.canPreview()) {
      if (pendingChildren > 0) {
        await sp.setBackgroundHint(this.i18n.tf(Msg.SubtasksRunningHint, pendingChildren))
      } else if (state.backgroundTasksPending === 0) {
        await sp.setBackgroundHint('')
      }
      await sp.setPendingSubtasks(pendingChildren)
    }
    // The turn settled with children still running: open the background
    // panel so the chat keeps showing their liveness (a zero pending set
    // finalizes an existing panel).
    this.ensureSubtaskPanel(sessionKey)
    state.eventsNeedResync = false
    let fullResponse = event.content
    // An error-reasoned turn reports its failure; interim narration it
    // produced on the way is not the turn's reply.
    const errored = event.errorText !== undefined && event.errorText !== ''
    const sdkResult = event.content.trim()
    const joined = state.textParts.length > 0 ? state.textParts.join('') : ''
    const preferJoined = (state.textParts.length > 0 && state.segmentStart === 0 && !this.display.toolMessages)
      || (fullResponse === '' && state.textParts.length > 0)
      // A bare NO_REPLY final segment does not retroactively swallow earlier
      // substantive text — fall back to the accumulated reply.
      || (state.textParts.length > 0 && isSilentReply(fullResponse))
    if (preferJoined && !errored) fullResponse = joined
    if (errored) {
      fullResponse = this.i18n.tf(Msg.Error, event.errorText)
    } else if (fullResponse === '') {
      fullResponse = this.i18n.t(Msg.SilentReply)
    }

    // Phase avatar: an errored turn needs the user's eyes (red); a completed
    // turn clears any attention overlay back to the baseline.
    const phasePlatform = state.platform ?? this.platforms[0]
    if (phasePlatform !== undefined) {
      await this.applyChatPhase(phasePlatform, sessionKey, errored ? 'attention' : this.chatBasePhase(phasePlatform, sessionKey))
    }

    // Context usage indicator: prefer SDK tokens, fall back to the agent's
    // self-reported [ctx: ~N%] line — which is stripped from the delivered
    // reply and surfaced on the ✅ notification instead (Go sdkPlausible /
    // selfPct + ctxSelfReportRe).
    const sdkPlausible = (event.inputTokens ?? 0) >= 100
    const selfPct = parseSelfReportedCtx(fullResponse)
    const baseResponse = stripCtxSelfReport(fullResponse).replace(/[\n ]+$/, '')
    if (sdkResult !== '' && !errored) session.setLastResult(sdkResult)
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

    // Turn token accounting feeds the ✅ footer's ctx/hit lines (Go turnDelta
    // / cumulative counters at engine_events.go:4630).
    const turnDelta = event.inputTokens ?? 0
    state.cumulativeInputTokens += turnDelta
    const totalInput = event.totalInputTokens !== undefined && event.totalInputTokens > 0
      ? event.totalInputTokens
      : turnDelta
    const cacheDelta = Math.max(0, totalInput - turnDelta)
    state.cumulativeCacheInputTokens += cacheDelta
    await this.buildCompletionUsage({
      totalInputTokens: totalInput,
      sdkPlausible,
      selfPct,
      nonCachedDelta: turnDelta,
      nonCachedCum: state.cumulativeInputTokens,
      cachedDelta: cacheDelta,
      cachedCum: state.cumulativeCacheInputTokens,
      numTurns: event.numTurns ?? 0,
      compactionCount: state.compactionCount,
    })
    // The rate's thinking time is the union of the turn's streamed generation
    // spans — a deliberate divergence from Go's wall-clock-minus-tool-intervals
    // formula, which charged first-token latency and dispatch overhead against
    // the rate (see TurnTiming).
    this.setTokenRate(event.outputTokens ?? 0, unionDuration(state.timing.generationSpans))

    // Codex-style reply footer rides the delivered reply (Go buildReplyFooter).
    if (!isSilent) {
      const replyAgent = state.agent ?? this.agent
      const footer = await this.buildReplyFooter(
        replyAgent,
        state.agentSession,
        '',
        replyFooterContextText(this.replyFooterSessionContextUsage(state.agentSession), this.i18n),
      )
      if (footer !== '') cleanResponse = appendReplyFooter(cleanResponse, footer)
    }
    fullResponse = cleanResponse

    // First-turn fallback: if this is a delegated subtask session and the
    // agent finished without explicitly reporting, push the result to the
    // parent so it is never lost. One-shot (Go maybeAutoReportSubtask). An
    // error-reasoned turn reports its failure explicitly — with this turn's
    // own partial streamed text, never a stale earlier reply.
    const resultOrReply = await this.lastResultOrReply(sessionKey, session)
    if (errored) {
      const partial = joined.trim()
      const failed = this.i18n.tf(Msg.SubtaskTurnFailed, event.errorText)
      this.maybeAutoReportSubtask(state, session, partial !== '' ? `${failed}\n\n${partial}` : failed, false)
    } else {
      this.maybeAutoReportSubtask(state, session, resultOrReply, isSilent)
    }
    // Feature role turn-end: the listener relays the role's reply to its hub
    // and wakes the moderator. Disjoint from the subtask hook above
    // (feature roles keep depth=0).
    this.bridge.waterfall('feishuBridge/turn-end', { engine: this, state, session, response: resultOrReply, isSilent }, () => undefined)

    // Export-button + speculative reply-HTML auto-deliver (Go engine_events.go
    // EventResult export block, #48): cache the full reply under the green
    // card's export key, then fork a render when the display text (trailing
    // 实时播报 segment, falling back to the full reply) clears the threshold.
    {
      let exportKey = ''
      const ekp = sp.previewMsgID as { exportKey?: () => string } | undefined
      if (ekp !== undefined && typeof ekp.exportKey === 'function') exportKey = ekp.exportKey()
      if (shouldDiscardPreviewBeforeReplyRender(state.toolCount, state.segmentStart, sp.inProgressMode(), sp.isDegraded())) {
        exportKey = ''
      }
      const displayText = displayReplyText(sp, baseResponse)
      if (exportKey !== '') {
        if (state.exportContent === undefined) state.exportContent = new Map()
        state.exportContent.set(exportKey, baseResponse)
      }
      state.lastBaseResponse = baseResponse
      if (this.planRenderEnabled && Array.from(displayText).length >= defaultReplyPreRenderLen) {
        renderAndDeliverReply(this, state, sessionKey, displayText, exportKey)
      }
    }

    const p = state.platform
    const normalizedBase = baseResponse.trim()
    const suppressDuplicate = normalizedBase !== '' && normalizedBase === state.sideText
    state.sideText = ''

    /** Whether the final card landed; the ✅ notification follows it. */
    let sendCompletionNotification = false
    if (errored && p !== undefined) {
      // Ahead of every completion branch: red header with the error in place
      // of the 实时播报 section on an active card, else a plain message.
      if (sp.inProgressMode() && !sp.isDegraded()) {
        await sp.setAnalysisText(fullResponse)
        await sp.markFailed()
        await sp.detachPreview()
      } else {
        await sp.discard()
        for (const chunk of splitMessage(fullResponse, MaxPlatformMessageLen)) {
          await this.send(p, replyCtx, chunk)
        }
      }
    } else if (isSilent) {
      await sp.setAnalysisText(this.i18n.t(Msg.SilentReply))
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
      } else if (state.toolCount > 0 && state.segmentStart > 0 && !sp.inProgressMode()) {
        // Prior segments were already surfaced between tools; deliver only
        // the unsent remainder.
        await sp.discard()
        const unsent = state.textParts.slice(state.segmentStart).join('')
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
      this.setCompletionDurations(Math.max(0, Date.now() - state.timing.agentStart), Date.now() - state.timing.turnStart)
      await this.sendTurnCompletionCard(
        state, p, replyCtx, session, sessionKey,
        this.perChatWorkDir(this.dirOverrideKey(sessionKey)))
    }

    // Insight card (#33 + turn_summary, Go engine_events.go's post-turn
    // block): fire-and-forget forks for the turn summary and next-message
    // prediction; both skip silent turns and turns with queued follow-ups.
    void triggerInsights(this, state, session, p, replyCtx, sessionKey, sendCompletionNotification, isSilent)

    // Auto-compress (Go triggerAutoCompress): when the token estimate
    // crosses the configured cap outside the min gap, compact the live
    // session's context before the queued messages continue this loop.
    if (this.autoCompressEnabled && this.autoCompressMaxTokens > 0) {
      const estimate = estimateTokensWithPendingAssistant(await this.recentTurnsOf(sessionKey, session), '')
      const last = state.lastAutoCompressAt
      if (estimate >= this.autoCompressMaxTokens && (last === 0 || Date.now() - last >= this.autoCompressMinGap)) {
        state.lastAutoCompressAt = Date.now()
        state.lastAutoCompressTokens = estimate
        if (pendingSend !== undefined) await pendingSend.catch(() => undefined)
        await runCompress(this, state, p, replyCtx, true)
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
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(Msg.Error, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        return { kind: 'done' }
      }
      state.agentSession.events().drain()
      if (pendingSend !== undefined) await pendingSend.catch(() => undefined)

      const queuedPrompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)
      const { imagePaths: qImgs, filePaths: qFiles } = state.drainStagedAttachmentPaths()
      const splicedPrompt = spliceStagedAttachments(queuedPrompt, qImgs, qFiles)
      // Feature ask metadata is consumed at drain time — the queued ask's
      // turn is starting now.
      await this.bridge.serial('feishuBridge/turn-start', { engine: this, session, metadata: queued.metadata })
      state.inflightMessage = queued
      this.i18n.detectAndSet(queued.content)
      const sendDone = state.agentSession.send(splicedPrompt, queued.images, queued.files)
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
    replyCtx: unknown,
  ): Promise<void> {
    const unexpectedExit = !state.stopped
    const closedPlatform = state.platform
    state.eventsNeedResync = true
    this.notifyDroppedQueuedMessages(state, new Error('agent process exited'))
    await this.cleanupInteractiveState(sessionKey, state)

    if (unexpectedExit && !state.engineStopped) {
      // Go parity (cp.Finalize(Failed) on the unexpected-exit path, after its
      // 2026-08-17 incident where the card froze mid-state until the user
      // resent): fail the preview card rather than leaving it Running.
      // Engine.stop deliberately leaves `stopped` unset (it distinguishes a
      // reload from a crash) and already rendered its ⏹ card — skip it.
      await state.preview?.markFailed()
    }

    if (unexpectedExit && closedPlatform !== undefined && !state.stopNoticeSent) {
      state.stopNoticeSent = true
      await this.send(closedPlatform, replyCtx, state.engineStopped
        ? this.i18n.t(Msg.PluginReloaded)
        : this.i18n.t(Msg.AgentProcessExited))
    }

    if (state.textParts.length === 0) {
      // Crash before any streamed text: nothing to auto-report, but the
      // parent still gets the synthetic settlement notice.
      this.reportSubtaskTimeout(sessionKey)
      return
    }

    {
      let fullResponse = state.textParts.join('')

      // Mirror the EventResult turn-end hook: without an EventResult (the
      // process exited mid-turn) the subtask result would never report to
      // the parent, deadlocking a gather (Go engine_events.go channel-closed
      // path). The interruption prefix marks partial output as partial, so a
      // crash with no streamed text still settles as a notice.
      const prefixed = `${this.i18n.t(Msg.SubtaskTurnInterrupted)}\n\n${fullResponse}`
      this.maybeAutoReportSubtask(state, session, prefixed, isSilentReply(prefixed))
      this.bridge.waterfall('feishuBridge/turn-end', { engine: this, state, session, response: fullResponse, isSilent: isSilentReply(fullResponse) }, () => undefined)
      // No-op when the auto-report delivered; covers the silent-reply skip.
      this.reportSubtaskTimeout(sessionKey)

      if (isSilentReply(fullResponse)) return
      const [stripped, ok] = stripTrailingSilent(fullResponse)
      if (ok && stripped.trim() === '') return
      if (ok) fullResponse = stripped

      const p = closedPlatform
      if (p === undefined) return
      if (state.toolCount > 0 && state.segmentStart > 0) {
        const unsent = state.textParts.slice(state.segmentStart).join('')
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

    const oldSession = state.agentSession
    if (oldSession !== undefined) {
      await this.closeAgentSessionWithTimeout(sessionKey, oldSession)
    }
    oldEvents.drain()

    const retryOptions = state.sessionStartOptions
    const retryMode = state.effectiveMode
    // Restore per-chat workDir override so --resume finds the session under
    // the correct directory (Go stall-retry applyWorkDirOverride).
    const restoreWorkDir = this.applyWorkDirOverride(replyAgent, sessionKey)
    try {
      const newSess = await this.startAgentLocked(replyAgent, resumeID, retryOptions, retryMode)
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
   * @param state - State holding the pending queue.
   * @param session - Locked session the drained turns run under.
   * @param sessions - Session manager for persistence.
   * @param sessionKey - Interactive-state slot key.
   * @returns True when the session lock was released here.
   */
  async drainPendingMessages(state: InteractiveState, session: Session, sessions: SessionManager, sessionKey: string): Promise<boolean> {
    for (;;) {
      const queued = state.pendingMessages.shift()
      if (queued === undefined) {
        session.unlock()
        this.startUnsolicitedReader(session, sessions, sessionKey)
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
      let prompt = this.buildSenderPrompt(queued.content, queued.userID, queued.userName, queued.msgPlatform, queued.msgSessionKey)
      const { imagePaths: dImgs, filePaths: dFiles } = state.drainStagedAttachmentPaths()
      prompt = spliceStagedAttachments(prompt, dImgs, dFiles)

      if (state.agentSession === undefined || !state.agentSession.alive()) {
        state.inflightMessage = undefined
        await this.send(queued.platform, queued.replyCtx, this.i18n.tf(Msg.Error, 'agent session ended'))
        this.notifyDroppedQueuedMessages(state, new Error('agent session ended'))
        session.unlock()
        return false
      }

      state.agentSession.events().drain()
      // Feature ask metadata is consumed at drain time — the queued ask's
      // turn is starting now.
      await this.bridge.serial('feishuBridge/turn-start', { engine: this, session, metadata: queued.metadata })

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

  /**
   * Drain orphaned queue after the turn processor already exited.
   * @param session - Locked session whose queue is drained.
   * @param sessions - Session manager for persistence.
   * @param interactiveKey - Interactive-state slot key.
   */
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

  /**
   * Tell each queued sender their message will never be processed.
   * @param state - State whose pending queue is dropped.
   * @param reason - Failure surfaced to each queued sender.
   */
  notifyDroppedQueuedMessages(state: InteractiveState, reason: Error): void {
    const remaining = state.pendingMessages
    state.pendingMessages = []
    for (const q of remaining) {
      void this.send(q.platform, q.replyCtx, this.i18n.tf(Msg.Error, reason.message))
    }
  }

  // ── cleanup ─────────────────────────────────────────────────────────────

  /**
   * Remove the interactive state and close its agent session. With an
   * expected state, cleanup is skipped when the map entry was replaced
   * (stale-goroutine guard, Go cleanupInteractiveState). The map entry is
   * deleted only after the agent session finished closing.
   * @param sessionKey - Interactive-state slot key to clean up.
   * @param expected - State the caller believes is mapped; cleanup is skipped when the slot holds a different one.
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
      // The reader must not consume off a channel whose agent is closing.
      this.stopUnsolicitedReader(state)
      // Abort in-flight renders and reap recorded reply-HTML temp dirs (Go
      // cancelRenders + the renderedReplyHTML drain in cleanupInteractiveState).
      cancelRenders(state)
      void cleanupRenderedReplyHTML(state)
    }

    try {
      if (state !== undefined) {
        state.markStopped()
        this.notifyDroppedQueuedMessages(state, new Error('session reset'))
        this.discardStagedAttachments(state, true)
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
    // Boxed so the sleep's callback assignment escapes literal-type narrowing.
    const timeout = { hit: false }
    await Promise.race([
      agentSession.close().catch((error: unknown) => {
        console.error(`engine: agent session close failed (${sessionKey}): ${String(error)}`)
      }),
      cancellableSleep(this.agentCloseTimeout).promise.then(() => {
        timeout.hit = true
      }),
    ])
    if (timeout.hit) {
      // Abandoned mid-close: the agent session may stay live in the agent's
      // registry and block later resumes of the same id.
      console.warn(`engine: agent session close timed out after ${String(this.agentCloseTimeout)}ms (${sessionKey})`)
    }
  }

  /**
   * User-initiated stop (/stop, /new, /switch): flag userStopped, detach the
   * state, resolve queued senders, close the agent session, and finalize the
   * active preview card asynchronously (Go stopInteractiveSession, M1
   * subset). The entry stays in the map with `closing` set until the close
   * settles, so a message racing the teardown waits it out instead of
   * resuming the still-live session (2026-08-21 oc_6ee6 incident: stop →
   * 「继续」 degraded to a fresh session).
   * @param sessionKey - Interactive-state slot key to stop.
   * @returns True when a state was found and torn down.
   */
  stopInteractiveSession(sessionKey: string): boolean {
    const state = this.interactiveStates.get(sessionKey)
    if (state === undefined) return false

    state.userStopped = true
    state.markStopped()
    // Post-teardown rename/avatar notices must not reissue the dying preview
    // as a fresh running card (2026-08-25 oc_d22d incident): bump routing
    // reads state.preview, and markStoppedSync below degrades/stops it, so
    // the bump guard rejects the reissue without any unbinding step.
    this.stopUnsolicitedReader(state)
    // Finalize the active preview card here, not only in the event loop's
    // stop arm: a loop parked mid-handler when the stop lands exits via
    // channel-close and skips that arm, which froze the card in its Running
    // state while the preview's throttled flush timers kept PATCHing
    // (2026-08-22 oc_74a7 incident). markStoppedSync degrades the preview
    // first (late flushes become no-ops) and queues on the preview lock, so
    // in-flight and already-queued Running PATCHes still land before the ⏹
    // card.
    const preview = state.preview
    if (preview !== undefined) {
      void preview.markStoppedSync().catch((error: unknown) => {
        console.warn(`engine: stop preview finalize failed (${sessionKey}): ${String(error)}`)
      })
    }
    // Abort in-flight renders so their cancel handles don't orphan with the
    // state and keep burning tokens on a stale HTML (Go cancelRenders).
    cancelRenders(state)
    this.notifyDroppedQueuedMessages(state, new Error('session reset'))
    // Staged attachments die with the session: without this the pendingDir
    // leaks on disk (Go regression test for /new and /stop).
    this.discardStagedAttachments(state, false)
    console.info(`stopping interactive session (${sessionKey})`)
    const agentSession = state.agentSession
    state.agentSession = undefined
    if (agentSession === undefined) {
      this.interactiveStates.delete(sessionKey)
      return true
    }
    // Fast user-stop cancellation (Go interruptAgentSessionWithTimeout's
    // Interrupt preference): abort the in-flight turn with the user cause so
    // the durable turn/end records `aborted/user`, not `aborted/disposed`.
    // Unlike Go's either-or — where Interrupt kills the subprocess outright —
    // the dsh cancel keeps the handle alive, so close() still owns teardown.
    asAgentInterrupter(agentSession)?.cancelTurn()
    // Bounded like every other close site: a dispose parked on a turn that
    // cannot quiesce must surface a warn and be abandoned, not hang silently
    // and leak the session live in the runtime registry (2026-08-26 oc_b46da
    // incident — the resume then degraded to a fresh session for nothing).
    state.closing = this.closeAgentSessionWithTimeout(sessionKey, agentSession).finally(() => {
      // A newer state may already have claimed the slot after the concurrent
      // teardown wait; only the exact entry removes itself.
      if (this.interactiveStates.get(sessionKey) === state) this.interactiveStates.delete(sessionKey)
    })
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
      if (state.pendingAsk !== undefined) continue
      // Skip sessions with pending background tasks: the unsolicited reader
      // is holding the channel open for the completion turn (bounded by the
      // background grace, which zeroes the count when it exhausts).
      if (state.backgroundTasksPending > 0) continue
      if (state.lastActivity !== 0 && state.lastActivity < cutoff) targets.push([key, state])
    }
    for (const [key, state] of targets) {
      console.info(`reaping idle interactive state (${key})`)
      void this.cleanupInteractiveState(key, state)
    }
  }

  // ── proactive sends (cc-connect send tool surface) ──────────────────────

  /**
   * Send text to a session by key (Go SendToSession).
   * @param sessionKey - Target session key; '' uses the single active session.
   * @param message - Text to send.
   */
  async sendToSession(sessionKey: string, message: string): Promise<void> {
    return this.sendToSessionWithAttachments(sessionKey, message, [], [])
  }

  /**
   * Send text/attachments to a session by key, recording sideText for the
   * result-path duplicate suppression (Go SendToSessionWithAttachments,
   * M1 subset: text + raw image/file sends, no card composition).
   * @param sessionKey - Target session key; '' uses the single active session.
   * @param message - Text to send; may be empty when attachments are present.
   * @param images - Images delivered via the platform's sendImage.
   * @param files - Files delivered via the platform's sendFile.
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
  // preview card off the tail; bump reissues it as the latest message).
  // Per-session: each interactive state's own preview is the bump target, so
  // concurrent streams (a feature hub and its roles, plus research
  // assistants) route correctly — a single global binding would let the
  // latest-started turn steal every other session's bump.
  // ---------------------------------------------------------------------

  /** Pending per-session bump debounce timers (coalesce rename+avatar bursts). */
  private bumpTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ── cron execution (Go engine.go ExecuteCronJob / executeCronShell) ─────

  /**
   * Run one cron job: resolve the target platform from the stored session
   * key, reconstruct a proactive reply context, notify the chat (unless
   * silent/muted), then either run the shell command or inject the prompt as
   * a synthetic user message. Mute wraps the platform so nothing is sent.
   * Prompt runs start in 'default' mode unless the job sets its own mode:
   * an unattended run cannot approve an ExitPlanMode card, so a plan-mode
   * project default must not apply. Multi-workspace agent selection is not
   * ported (single workspace); an explicit job workDir switches the agent's
   * work dir for the run instead.
   * @param job - The cron job to execute.
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
      // An unattended run cannot approve an ExitPlanMode card: an unset job
      // mode must not inherit a plan-mode project default (the stall this
      // default exists to prevent); an explicit job.mode wins.
      modeOverride: job.mode !== '' ? job.mode : 'default',
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

  /**
   * Run a shell cron job and send the output to the chat (Go executeCronShell).
   * @param p - Platform the output is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param job - The shell cron job to run.
   */
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
   * @param signal - Bounds the caller's wait only; the agent finishes in the background.
   * @param fromProject - Originating project of the relayed message.
   * @param chatID - Chat the message was relayed from.
   * @param message - Relayed message content.
   * @returns The relayed turn's response text.
   */
  async handleRelay(signal: AbortSignal | undefined, fromProject: string, chatID: string, message: string): Promise<string> {
    const relaySessionKey = `relay:${fromProject}:${chatID}`
    const session = this.sessions.getOrCreateActive(relaySessionKey)

    const relayOptions = this.buildSessionStartOptions(relaySessionKey, session)

    let agentSession: AgentSession
    try {
      agentSession = await this.startAgentLocked(this.agent, session.getAgentSessionID(), relayOptions, '')
    } catch (error) {
      if (session.getAgentSessionID() !== '') {
        // Resume failed — fall back to a fresh session so the relay is not
        // permanently broken by a corrupted/stale session ID.
        console.warn(`relay: session resume failed, trying fresh session (${relaySessionKey}): ${errorMessage(error)}`)
        session.setAgentSessionID('', this.agent.name())
        this.sessions.save()
        try {
          agentSession = await this.startAgentLocked(this.agent, '', relayOptions, '')
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
          break
        case 'tool_result': {
          let out = event.content.trim()
          if (out === '') out = (event.toolResult ?? '').trim()
          if (out !== '') {
            const tn = (event.toolName ?? '').trim() || 'tool'
            textParts.push(`${this.i18n.tf(Msg.ToolResult, tn, out)}\n\n`)
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
        default:
          break
      }
      if (signal?.aborted) {
        // Relay timed out. Let the agent finish its turn in the background
        // so the session state is saved cleanly and stays resumable.
        void this.drainRelaySession(agentSession, relaySessionKey)
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
  private async drainRelaySession(agentSession: AgentSession, relaySessionKey: string): Promise<void> {
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
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reissue the session's active preview when its state still owns one
   * (Go bindActivePreview + bumpActivePreviewForSession, made per-session:
   * state.preview is the binding). Terminal previews (finished/stopped/
   * degraded) are rejected inside bumpToEnd, so a lookup racing teardown is
   * a safe no-op.
   * @param sessionKey - Session whose preview is bumped.
   */
  bumpActivePreviewForSession(sessionKey: string): void {
    const sp = this.interactiveStates.get(sessionKey)?.preview
    if (sp !== undefined) void sp.bumpToEnd()
  }

  /**
   * Coalesce rapid chat-change events for one session (rename + avatar
   * ~1.4s apart) into one bump after the quiet window; only the last notice
   * matters. Timers are per-session: concurrent chats' notices never eat
   * each other.
   * @param sessionKey - Session whose chat changed.
   */
  onChatChanged(sessionKey: string): void {
    const prev = this.bumpTimers.get(sessionKey)
    if (prev !== undefined) clearTimeout(prev)
    const id = setTimeout(() => {
      this.bumpTimers.delete(sessionKey)
      this.bumpActivePreviewForSession(sessionKey)
    }, this.bumpDebounceInterval)
    this.bumpTimers.set(sessionKey, id)
  }

  // ──────────────────────────────────────────────────────────────
  // M3: Permission / AskUserQuestion / ExitPlanMode
  // ──────────────────────────────────────────────────────────────

  /**
   * Whether an unsolicited permission should surface to the user (Go shouldSurfaceUnsolicitedPermission).
   * @param _toolName - Tool requesting permission; retained for Go parity, unused.
   * @param isAskQuestion - Whether the request is an AskUserQuestion.
   * @param stallRetried - Whether the turn already went through a stall retry.
   * @param autoApprove - Whether the user enabled blanket approval.
   * @returns True when the prompt card should be sent.
   */
  shouldSurfaceUnsolicitedPermission(_toolName: string, isAskQuestion: boolean, stallRetried: boolean, autoApprove: boolean): boolean {
    return shouldSurfaceHelper(_toolName, isAskQuestion, stallRetried, autoApprove)
  }

  /**
   * The ask delegate the adapter's native listeners call (B2): render ONE
   * card for the ask, park it on the interactive state, and resolve with the
   * user's decision in the native structures — `allowed-always` for
   * allow-all (the B1 standing grant), `rejected` plus note for a deny with
   * card input, answers with the selected/custom split. A session without an
   * interactive state (relay, background shells) auto-allows permission asks
   * and returns empty answers: nobody can respond on them. The engine's
   * event loop keeps running independently and re-syncs its preview and
   * progress surfaces from the state when the ask resolves.
   * @param sessionKey - Interactive-state slot the ask renders on.
   * @param request - What to ask (permission, plan review, or questions).
   * @param signal - Abort; settles the decision as cancelled.
   * @returns The user's decision.
   */
  async askUser(sessionKey: string, request: AskRequest, signal?: AbortSignal): Promise<AskDecision> {
    const state = this.interactiveStates.get(sessionKey)
    if (state === undefined) {
      // Relay and background shells legitimately land here; any other caller
      // means the ask routed under the wrong key and the asker silently got
      // an unattended answer (2026-08-26 cron-fbe6d268 incident).
      console.warn(`engine: ask on session without interactive state (${sessionKey}), answering unattended`)
      return this.unattendedAskDecision(request)
    }
    // Feature role-pick: the moderator's plan review is a formality (priming
    // pre-bakes a trivial plan). A listener auto-approves so the user isn't
    // prompted just to green-light reading role files + pick-roles. Only in
    // the pick window (the listener short-circuits; no listener falls
    // through to the ask).
    if (request.kind === 'plan-review') {
      const override = await this.bridge.waterfall(
        'feishuBridge/ask-approval',
        { engine: this, sessionKey, request, signal },
        () => Promise.resolve(undefined),
      )
      if (override !== undefined) return override
    }
    const p = state.platform ?? this.platforms[0]
    if (p === undefined) {
      console.warn(`engine: ask on session without a platform (${sessionKey}), answering unattended`)
      return this.unattendedAskDecision(request)
    }
    const replyCtx = state.replyCtx

    // Arm the stop/abort races before any delivery await — pre-card flush,
    // park, and card sends alike: an engine stop or turn abort landing while
    // the ask is still being delivered must settle the ask immediately, not
    // after the platform sends resolve. The parked tool call otherwise never
    // returns, the agent's dispose waits on it forever, and the session leaks
    // live in the persistence coordinator — every later resume of the chat
    // then degrades to a fresh session (2026-08-25 oc_29bb incident: a
    // plugin reload stopped the platform mid plan-card send and the ask
    // never settled).
    const stopP = state.stopSignal().then(() => 'stopped' as const)
    let onAbort: (() => void) | undefined
    const abortP = signal?.aborted === true
      ? Promise.resolve('aborted' as const)
      : signal !== undefined
        ? new Promise<'aborted'>((resolve) => {
          onAbort = () => { resolve('aborted') }
          signal.addEventListener('abort', onAbort, { once: true })
        })
        : neverPromise

    // Plan review: the ask carries the plan markdown; a plan file the agent
    // wrote this round wins when it is readable (fresher than the submitted
    // copy, Go engine_events.go plan extraction).
    let planContent = ''
    if (request.kind === 'plan-review') {
      state.planRevisionCount++
      planContent = request.plan.trim()
      if (state.planFilePath !== '') {
        try {
          const fromFile = readFileSync(state.planFilePath, 'utf8').trim()
          if (fromFile !== '') planContent = fromFile
        } catch {
          console.warn(`plan file read failed (${state.planFilePath})`)
        }
      }
    }

    // Park bookkeeping lives outside the delivery closure so the decision
    // race below can settle it after the cards land.
    let resolveDecision!: (decision: AskDecision) => void
    const decisionP = new Promise<AskDecision>((resolve) => { resolveDecision = resolve })
    const pending: PendingAsk = { request, answers: new Map(), resolve: resolveDecision }
    const settle = (decision: AskDecision): void => {
      if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
      if (state.pendingAsk === pending) state.pendingAsk = undefined
      state.lastEventAt = Date.now()
      resolveDecision(decision)
    }
    pending.resolve = settle

    const deliverCards = async (): Promise<void> => {
      // Pre-card flush + detach (Go engine_events.go ~4192-4225): with the
      // preview degraded the accumulated text segment goes out as plain
      // messages now — the live card cannot carry it — and segmentStart
      // advances either way. The live card is completed and detached BEFORE
      // the ask card reaches the user.
      if (planContent !== '') {
        // The plan card owns the exact plan text: strip it from the final
        // reply source so it is not delivered twice.
        for (let i = state.segmentStart; i < state.textParts.length; i++) {
          const part = state.textParts[i]
          if (part !== undefined && part.includes(planContent)) {
            state.textParts[i] = part.replace(planContent, '').trim()
            break
          }
        }
      }
      const sp = state.preview
      if (sp !== undefined) {
        if (planContent !== '') await sp.removeText(planContent)
        if (state.textParts.length > state.segmentStart) {
          if (!sp.canPreview()) {
            const segment = state.textParts.slice(state.segmentStart).join('')
            if (segment !== '') {
              for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
                await this.send(p, replyCtx, chunk)
              }
            }
          }
          state.segmentStart = state.textParts.length
          state.silentHold = false
        }
        // Pre-detach speculative reply render (Go captureReplyForExport +
        // renderAndDeliverReply at a permission/AskUserQuestion): the
        // pre-interaction segment over the threshold renders now — the
        // turn-end render would otherwise drop it. A plan review is excluded:
        // the plan render covers this turn's product.
        const session = this.sessions.findActive(sessionKey)
        const captured = captureReplyForExport(sp, state)
        const triggered = this.planRenderEnabled && request.kind !== 'plan-review'
          && captured.text !== '' && Array.from(captured.text).length >= defaultReplyPreRenderLen
          && !(session?.shouldSuppressAutoRender(this.bridge) ?? false)
        // Drain async preview updates so a stale running PATCH cannot overwrite
        // the completed card (Go barrier before detach).
        await state.sender?.barrier()
        await sp.completeAndDetach()
        if (triggered) {
          renderAndDeliverReply(this, state, sessionKey, captured.text, captured.exportKey)
        }
      }

      // Phase avatar: the parked card is the signal — blue for a plan awaiting
      // approval, red for anything else awaiting the user.
      await this.applyChatPhase(p, sessionKey, request.kind === 'plan-review' ? 'plan-review' : 'attention')

      // Park the ask, then render the card(s).
      state.pendingAsk = pending
      if (request.kind === 'plan-review' && planContent !== '') {
        // Plan card + HTML render (Go engine_events.go ExitPlanMode branch,
        // #47): the markdown card (with export button) is the always-on
        // fallback; the render fork runs in addition and delivers an image.
        const exportKey = `plan:${String(state.planRevisionCount)}`
        storePlanExport(state, exportKey, planContent)
        if (planContent !== state.sentPlanContent) state.sentPlanContent = planContent
        let activePlanFilePath = state.planFilePath
        if (activePlanFilePath !== '' && !existsSync(activePlanFilePath)) activePlanFilePath = ''
        if (activePlanFilePath === '') {
          activePlanFilePath = this.persistPlanFile(planContent)
        }
        if (activePlanFilePath !== '') {
          await this.sendPlanContent(p, replyCtx, state, activePlanFilePath, state.planRevisionCount, exportKey)
        } else {
          await this.sendInlinePlanContent(p, replyCtx, state, planContent, state.planRevisionCount, exportKey)
        }
        if (this.planRenderEnabled && shouldRenderPlan(state, planContent, state.planRevisionCount)) {
          launchPlanRender(this, state, sessionKey, planContent, activePlanFilePath, state.planRevisionCount, exportKey)
        }
      }

      if (request.kind === 'questions') {
        // Feature guards on the whole ask ride the ask-parked emit (a
        // research-manual hub arms the auto-default timer).
        this.bridge.emit('feishuBridge/ask-parked', { engine: this, platform: p, sessionKey, replyCtx, pending })
        await this.sendAskQuestionsCard(p, replyCtx, request.questions, sessionKey)
      } else {
        const toolName = request.kind === 'plan-review' ? 'ExitPlanMode' : request.toolName
        const preview = request.kind === 'plan-review'
          ? (request.heading !== '' ? request.heading : planContent)
          : request.preview
        const permLimit = this.display.toolMaxLen
        const toolInput = permLimit > 0 ? truncateIf(preview, Math.floor(permLimit * 8 / 5)) : preview
        const prompt = this.i18n.tf(Msg.PermissionPrompt, toolName, toolInput)
        await this.sendPermissionPrompt(p, replyCtx, prompt, toolName, toolInput)
      }
    }

    // Late sends from an interrupted delivery still land harmlessly (the
    // ask is already unsettled and stray answers route nowhere); only the
    // parked wait below must not outlive the interruption.
    const interrupted = await Promise.race([
      deliverCards().then(() => false as const),
      Promise.race([stopP, abortP]).then(() => true as const),
    ])
    if (interrupted) {
      // The abort listener dies with this ask; the stop signal is
      // state-scoped and needs no removal.
      if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
      if (state.pendingAsk === pending) state.pendingAsk = undefined
      resolveDecision({ outcome: 'cancelled' })
      return { outcome: 'cancelled' }
    }

    // Wait for the user's decision, a session stop, or an abort (Go select
    // on pending.Resolved / stopCh).
    const outcome = await Promise.race([
      decisionP.then(decision => ({ kind: 'decided' as const, decision })),
      stopP.then(() => ({ kind: 'stopped' as const, decision: undefined as AskDecision | undefined })),
      abortP.then(() => ({ kind: 'aborted' as const, decision: undefined as AskDecision | undefined })),
    ])
    if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort)
    const decided: AskDecision = outcome.kind === 'decided' ? outcome.decision : { outcome: 'cancelled' }
    if (outcome.kind !== 'decided') {
      if (pending.autoTimer !== undefined) clearTimeout(pending.autoTimer)
      if (state.pendingAsk === pending) state.pendingAsk = undefined
      resolveDecision(decided)
    }

    // Phase avatar: plan approval moves the baseline to green, rejection (or a
    // withdrawal) back to yellow; every other ask returns to the chat's
    // baseline once answered.
    if (request.kind === 'plan-review') {
      const approved = decided.outcome === 'allowed-once' || decided.outcome === 'allowed-always'
      await this.applyChatPhase(p, sessionKey, approved ? 'approved' : 'discussing')
    } else {
      await this.applyChatPhase(p, sessionKey, this.chatBasePhase(p, sessionKey))
    }

    // After the interaction, finalize the old card and start fresh (Go
    // engine_events.go post-permission block): flush the un-flushed text
    // segment, complete + detach the interaction card, then create new
    // surfaces so post-decision execution lands on a new card instead of
    // appending to the pre-interaction one. The event loop picks these up at
    // its next event boundary. Stopped/aborted skips the restart: every
    // stopSignal trigger (stopInteractiveSession teardown, interactive-state
    // recycling, cleanup) discards or replaces this state, so fresh surfaces
    // could only send a running placeholder card nobody will ever finalize
    // (2026-08-25 oc_d22d incident: /done during a parked ask left a stray
    // 执行中 card).
    if (outcome.kind === 'decided') await this.restartAskSurfaces(state, sessionKey, p, replyCtx)
    return decided
  }

  /**
   * The decision for an ask nobody can answer: permission asks auto-allow
   * (Go relay auto-approve), question asks return empty answers.
   * @param request - The unanswered ask.
   * @returns The unattended decision.
   */
  private unattendedAskDecision(request: AskRequest): AskDecision {
    return request.kind === 'questions'
      ? { answers: request.questions.map(q => ({ id: q.id ?? q.question, selected: [] })) }
      : { outcome: 'allowed-once' }
  }

  /**
   * Post-ask surface restart (Go post-permission block): flush the un-flushed
   * text segment as plain messages when the preview cannot carry it, complete
   * and detach the interaction card, create fresh preview/progress writers,
   * and reset the turn accumulation so post-decision execution starts clean.
   * @param state - State whose surfaces restart.
   * @param sessionKey - Interactive-state slot key.
   * @param p - Platform for the new surfaces.
   * @param replyCtx - Platform reply context for the new surfaces.
   */
  private async restartAskSurfaces(
    state: InteractiveState, sessionKey: string, p: Platform, replyCtx: unknown,
  ): Promise<void> {
    const old = state.preview
    state.sender ??= newAsyncSender(sessionKey)
    if (old !== undefined && old.hasStarted()) {
      if (state.textParts.length > state.segmentStart) {
        const segment = state.textParts.slice(state.segmentStart).join('')
        if (segment !== '') {
          for (const chunk of splitMessage(segment, MaxPlatformMessageLen)) {
            await this.send(p, replyCtx, chunk)
          }
        }
      }
      state.segmentStart = state.textParts.length
      await old.completeAndDetach()
    }
    const sp = newStreamPreview(this.streamPreview, p, replyCtx, undefined, state.sender, sessionKey)
    const cp = newCompactProgressWriter(p, replyCtx, this.agent.name(),
      this.i18n.currentLang(), undefined, state.sender)
    state.preview = sp
    state.progressWriter = cp
    if (this.display.toolProgress && sp.canPreview()) {
      void sp.showPlaceholder(this.i18n.t(Msg.Processing))
    }
    // Reset for the new execution phase — the old surfaces tracked
    // pre-interaction state; stale textParts would leak into the final reply
    // and re-trigger the reply-HTML render a plan turn already covered.
    state.textParts = []
    state.segmentStart = 0
    state.toolCount = 0
    state.silentHold = false
  }

  /**
   * Settle a parked questions ask by applying the default answer to every
   * unanswered question (research-manual whole-card timeout): already
   * collected answers are kept, the rest default to their first option.
   * @param sessionKey - Interactive-state slot with the parked ask.
   * @returns True when a questions ask was settled.
   */
  settlePendingAskDefaults(sessionKey: string): boolean {
    const state = this.interactiveStates.get(sessionKey)
    const pending = state?.pendingAsk
    if (state === undefined || pending === undefined || pending.request.kind !== 'questions') return false
    pending.resolve({ answers: finalAskAnswers(pending.request.questions, pending.answers) })
    return true
  }

  /**
   * Current work dir for plan-file naming: the adapter's getWorkDir when
   * present (mirrors commandWorkDir's structural probe), process.cwd
   * otherwise.
   * @returns The directory slugified into the plan-file basename.
   */
  private planWorkDir(): string {
    const switcher = this.agent as { getWorkDir?: () => string }
    if (typeof switcher.getWorkDir === 'function') {
      const wd = switcher.getWorkDir().trim()
      if (wd !== '') return wd
    }
    return process.cwd()
  }

  /**
   * Persist a presented plan into the plans directory (Claude-Code-aligned
   * `.md` record). Never throws: a write failure logs a warning and returns
   * '' so the caller falls back to the inline plan card.
   * @param content - Full plan markdown as presented.
   * @returns The written file path, '' when persistence is off or failed.
   */
  private persistPlanFile(content: string): string {
    if (this.planDir === '') return ''
    try {
      return savePlanFile(this.planDir, this.planWorkDir(), content)
    } catch (error) {
      console.warn(`plan file write failed (${this.planDir}): ${String(error)}`)
      return ''
    }
  }

  /**
   * Read a plan file, truncate to `display.planMaxLen` if configured, and send
   * as a plan card with an export button (Go sendPlanContent). Returns the
   * (possibly truncated) content string for dedup. When `planMaxLen` is 0, no
   * truncation is applied. The card send is awaited (Go sends synchronously)
   * so the permission card follows it in the chat.
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param state - Interactive state recording the plan export content.
   * @param filePath - Plan markdown file to read.
   * @param revision - Plan revision counter, starting at 1; selects the card
   * header's (vN) variant from the second presentation on.
   * @param exportKey - Export-button key the content is stored under.
   * @returns The sent (possibly truncated) content, '' on read failure or empty content.
   */
  async sendPlanContent(
    p: Platform,
    replyCtx: unknown,
    state: InteractiveState | undefined,
    filePath: string,
    revision: number,
    exportKey: string,
  ): Promise<string> {
    let content = ''
    try {
      content = readFileSync(filePath, 'utf8').trim()
    } catch {
      return ''
    }
    if (content === '') return ''
    // Plan truncation uses "..." (three ASCII dots) to match the Go plan card
    // rendering, distinct from truncateIf's unicode ellipsis.
    const maxLen = this.display.planMaxLen
    if (maxLen > 0) {
      const runes = Array.from(content)
      if (runes.length > maxLen) {
        content = `${runes.slice(0, maxLen).join('')}...`
      }
    }
    await sendPlanCard(this, p, replyCtx, state, exportKey, content,
      { title: this.planCardTitle(revision), color: 'blue' },
      [{ text: this.i18n.t(Msg.PlanExportBtn), type: 'default', value: `export:${exportKey}` }])
    return content
  }

  /**
   * Plan-card header title: the localized bare header for the first
   * presentation, the (vN) variant from the second on. The plan's own title
   * stays in the card body — deriving the header from it duplicated the
   * body's first heading.
   * @param revision - Plan revision counter, starting at 1.
   * @returns The localized card title.
   */
  private planCardTitle(revision: number): string {
    return revision > 1
      ? this.i18n.tf(Msg.PlanContentHeaderRevision, revision)
      : this.i18n.t(Msg.PlanContentHeader)
  }

  /**
   * Send plan content passed inline in the ExitPlanMode tool input as a plan
   * card with an export button (Go sendInlinePlanContent). Returns the
   * trimmed content for dedup. The card send is awaited (Go sends
   * synchronously) so the permission card follows it in the chat.
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param state - Interactive state recording the plan export content.
   * @param content - Inline plan content from the tool input.
   * @param revision - Plan revision counter, starting at 1; selects the card
   * header's (vN) variant from the second presentation on.
   * @param exportKey - Export-button key the content is stored under.
   * @returns The sent (possibly truncated) content, '' when empty.
   */
  async sendInlinePlanContent(
    p: Platform,
    replyCtx: unknown,
    state: InteractiveState | undefined,
    content: string,
    revision: number,
    exportKey: string,
  ): Promise<string> {
    let body = content.trim()
    if (body === '') return ''
    const maxLen = this.display.planMaxLen
    if (maxLen > 0) {
      const runes = Array.from(body)
      if (runes.length > maxLen) body = `${runes.slice(0, maxLen).join('')}...`
    }
    await sendPlanCard(this, p, replyCtx, state, exportKey, body,
      { title: this.planCardTitle(revision), color: 'blue' },
      [{ text: this.i18n.t(Msg.PlanExportBtn), type: 'default', value: `export:${exportKey}` }])
    return body
  }

  /**
   * Send a permission prompt card with Allow/Deny/AllowAll buttons
   * (Go sendPermissionPrompt). Falls back to inline buttons, then plain text.
   * @param p - Platform the prompt is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param prompt - Prompt text for the plain-text fallback.
   * @param toolName - Tool requesting permission, shown in the card body.
   * @param toolInput - Tool input preview shown in the card body.
   */
  async sendPermissionPrompt(p: Platform, replyCtx: unknown, prompt: string, toolName: string, toolInput: string): Promise<void> {
    // Try inline buttons first (Telegram-style platforms)
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function') {
      const buttons = [
        [
          { text: this.i18n.t(Msg.PermBtnAllow), data: 'perm:allow' },
          { text: this.i18n.t(Msg.PermBtnDeny), data: 'perm:deny' },
        ],
        [
          { text: this.i18n.t(Msg.PermBtnAllowAll), data: 'perm:allow_all' },
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
      const body = this.i18n.tf(Msg.PermCardBody, toolName, toolInput)
      const allowBtn: CardButton = { text: this.i18n.t(Msg.PermBtnAllow), type: 'primary', value: 'perm:allow', name: 'perm_allow', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(Msg.PermBtnAllow)}`, perm_color: 'green', perm_body: body } }
      const denyBtn: CardButton = { text: this.i18n.t(Msg.PermBtnDeny), type: 'danger', value: 'perm:deny', name: 'perm_deny', actionType: 'form_submit', extra: { perm_label: `❌ ${this.i18n.t(Msg.PermBtnDeny)}`, perm_color: 'red', perm_body: body } }
      const allowAllBtn: CardButton = { text: this.i18n.t(Msg.PermBtnAllowAll), type: 'default', value: 'perm:allow_all', name: 'perm_allow_all', actionType: 'form_submit', extra: { perm_label: `✅ ${this.i18n.t(Msg.PermBtnAllowAll)}`, perm_color: 'green', perm_body: body } }

      const card = newCard()
        .title(`‼️ ${this.i18n.t(Msg.PermCardTitle)}`, 'red')
        .form('perm_form',
          { kind: 'markdown', content: body },
          // The note input is dual-purpose: on a plan-review card the text
          // rides alongside an approval as a supplement; elsewhere it is the
          // deny reason.
          { kind: 'input', name: 'perm_note', placeholder: this.i18n.t(toolName === 'ExitPlanMode' ? Msg.PermNotePlaceholder : Msg.PermDenyReasonPlaceholder), maxLength: 1000 },
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
   * Send the ONE card carrying every question of an ask (B2 multi-question
   * card; Go sent one card per question). Falls back to inline buttons for
   * the first unanswered question, then plain text listing all questions.
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param questions - All questions in the ask.
   * @param sessionKey - Interactive-state slot key, logged on card send.
   */
  async sendAskQuestionsCard(p: Platform, replyCtx: unknown, questions: UserQuestion[], sessionKey: string): Promise<void> {
    if (questions.length === 0) return
    const total = questions.length
    const titleSuffix = total > 1 ? ` (${total})` : ''

    // Try card (Feishu-style platforms): every question on one card.
    const cs = p as Platform & CardSender
    if (typeof cs.sendCard === 'function') {
      const cardTitle = questions.map(q => q.header).find(h => h !== '') ?? this.i18n.t(Msg.AskQuestionTitle)
      const card = buildAskQuestionsCard(`‼️ ${cardTitle}${titleSuffix}`, questions, new Map())
      try {
        await cs.sendCard(replyCtx, card)
        console.log(`engine: ask card sent (${sessionKey}, ${total} question${total > 1 ? 's' : ''})`)
        return
      } catch {
        // fall through to inline buttons
      }
    }

    // Inline buttons: buttons answer the first unanswered question; every
    // question is still listed so free-text replies can address the rest.
    const first = questions[0]
    const ibs = p as Platform & InlineButtonSender
    if (typeof ibs.sendWithButtons === 'function' && first !== undefined) {
      const buttons = first.options.map((opt, i) => [{
        text: opt.label,
        data: `askq:0:${i + 1}`,
      }])
      const text = `${askQuestionsPlainText(this, questions)}${titleSuffix}`
      try {
        await ibs.sendWithButtons(replyCtx, text, buttons)
        return
      } catch {
        // fall through to plain text
      }
    }

    // Plain text fallback: every question with its numbered options.
    await this.send(p, replyCtx, `${askQuestionsPlainText(this, questions)}${titleSuffix}`)
  }

  /**
   * Route a user response to the parked ask (Go handlePendingPermission):
   * card-button payloads (perm:/askq: values) first, free text second —
   * permission verdicts fall back to the keyword tables and question answers
   * to numeric-index parsing on card-less platforms. Returns true when the
   * message was consumed as an ask response. Synchronous like the Go
   * original — reply side-effects fire as floating promises, the decision
   * resolves the askUser promise.
   * @param p - Platform the response arrived on.
   * @param msg - The inbound response message.
   * @param content - Response text; card verdicts may append "\x00<note>".
   * @returns True when the message was consumed as an ask response.
   */
  routeAskResponse(p: Platform, msg: Message, content: string): boolean {
    const state = this.interactiveStates.get(msg.sessionKey)
    if (state === undefined) {
      if (msg.isPermissionAction && parsePermissionVerdict(content) !== undefined) {
        void this.reply(p, msg.replyCtx, this.i18n.t(Msg.PermissionExpired))
        return true
      }
      return false
    }

    // The user is back — the idle window ended, so abort the auxiliary HTML
    // render (Go cancelRenders in handlePendingPermission).
    cancelRenders(state)

    const pending = state.pendingAsk
    if (pending === undefined) {
      if (msg.isPermissionAction && parsePermissionVerdict(content) !== undefined) {
        void this.reply(p, msg.replyCtx, this.i18n.t(Msg.PermissionExpired))
        return true
      }
      return false
    }

    if (pending.request.kind === 'questions') {
      return this.routeQuestionResponse(p, msg, content, pending)
    }
    return this.routePermissionResponse(p, msg, content, pending)
  }

  /**
   * Route one response onto a parked questions ask: a card payload answers
   * its own question; free text answers the first unanswered question.
   * Echoes the answer for free-text replies; settles when every question is
   * answered.
   * @param p - Platform the response arrived on.
   * @param msg - The inbound response message.
   * @param content - Response text (askq payload, index(es), or free text).
   * @param pending - The parked questions ask.
   * @returns True when the message was consumed as an answer.
   */
  private routeQuestionResponse(
    p: Platform, msg: Message, content: string, pending: PendingAsk,
  ): boolean {
    if (pending.request.kind !== 'questions') return false
    const questions = pending.request.questions
    if (content === '' && (msg.files.length > 0 || msg.images.length > 0)) {
      return false
    }
    const payload = parseAskqSelection(content)
    // A card payload names its own question; free text answers the first
    // unanswered one.
    const qIdx = payload !== undefined
      ? payload.qIdx
      : questions.findIndex((_q, i) => !pending.answers.has(i))
    const q = questions[qIdx]
    if (q === undefined || qIdx < 0) return false
    const answer = resolveAskAnswer(q, content)
    pending.answers.set(qIdx, answer)
    if (!msg.isAskqCardAction) {
      void this.reply(p, msg.replyCtx, `✅ ${q.question}: **${askAnswerDisplay(answer)}**`)
    }
    // Every question answered — settle the whole ask.
    if (questions.every((_q, i) => pending.answers.has(i))) {
      pending.resolve({ answers: finalAskAnswers(questions, pending.answers) })
    }
    return true
  }

  /**
   * Route one response onto a parked permission/plan-review ask: structured
   * card payloads match first, free text falls back to the keyword tables;
   * anything else gets the permission hint and leaves the ask parked.
   * @param p - Platform the response arrived on.
   * @param msg - The inbound response message.
   * @param content - Response text; card verdicts may append "\x00<note>".
   * @param pending - The parked permission or plan-review ask.
   * @returns True when the message was consumed as a verdict.
   */
  private routePermissionResponse(p: Platform, msg: Message, content: string, pending: PendingAsk): boolean {
    const verdict = parsePermissionVerdict(content)
    if (verdict === undefined) {
      void this.reply(p, msg.replyCtx, this.i18n.t(Msg.PermissionHint))
      return true
    }
    if (verdict.verdict === 'allow') {
      pending.resolve(verdict.note !== '' ? { outcome: 'allowed-once', note: verdict.note } : { outcome: 'allowed-once' })
    } else if (verdict.verdict === 'allow-all') {
      pending.resolve(verdict.note !== '' ? { outcome: 'allowed-always', note: verdict.note } : { outcome: 'allowed-always' })
    } else {
      // Card button deny: the replaced card already shows ❌ 已拒绝; only a
      // text deny sends the standalone notice.
      if (!msg.isPermissionAction) {
        void this.reply(p, msg.replyCtx, this.i18n.t(Msg.PermissionDenied))
      }
      pending.resolve(verdict.note !== '' ? { outcome: 'rejected', note: verdict.note } : { outcome: 'rejected' })
    }
    return true
  }

  // ──────────────────────────────────────────────────────────────
  // M4: subtask orchestration (Go engine_subtask.go + engine_cmd_session.go)
  // ──────────────────────────────────────────────────────────────

  /**
   * Override the recursive delegation cap (Go SetSubtaskMaxDepth).
   * @param n - New delegation depth cap; <= 0 keeps the current value.
   */
  setSubtaskMaxDepth(n: number): void {
    if (n > 0) this.subtaskMaxDepth = n
  }

  /**
   * Override default worktree isolation for /spawn //fork (Go SetSpawnWorktreeMode).
   * @param s - Worktree mode word: 'on', 'off', or 'auto'.
   */
  setSpawnWorktreeMode(s: string): void {
    this.spawnWorktree = parseWorktreeMode(s)
  }

  /**
   * Set the integrate-branch override for /done's merged auto-removal. The
   * default containment target is the branch each worktree's HEAD was on at
   * creation (effectiveSpawnIntegrate); this setting replaces that default
   * for every worktree, e.g. a deployment whose checkouts roam feature
   * branches but always land in 'dev'.
   * @param s - Branch name, e.g. 'dev'; '' restores the per-worktree default.
   */
  setSpawnIntegrateBranch(s: string): void {
    this.spawnIntegrateBranch = s.trim()
  }

  /**
   * Configure the /spawn //fork RAM guard; 0 disables a tier (Go SetSpawnMemoryGuard).
   * @param warnPct - RAM percentage that triggers a warning; 0 disables.
   * @param blockPct - RAM percentage that rejects the spawn; 0 disables.
   */
  setSpawnMemoryGuard(warnPct: number, blockPct: number): void {
    this.spawnMemWarnPct = warnPct
    this.spawnMemBlockPct = blockPct
  }

  /**
   * Override the hard timeout for subtask sessions (Go SetSubtaskTimeout).
   * @param ms - Timeout in ms; 0 inherits eventIdleTimeout.
   */
  setSubtaskTimeout(ms: number): void {
    this.subtaskTimeout = ms
  }

  /**
   * Override the gather barrier fallback timeout (Go SetSubtaskGatherTimeout).
   * @param ms - Timeout in ms; <= 0 keeps the default.
   */
  setSubtaskGatherTimeout(ms: number): void {
    if (ms > 0) this.subtaskGatherTimeout = ms
  }

  /**
   * Suppress the settlement card for unattended native subtask reports; the
   * parent-agent wake is always delivered. Attended group children keep their
   * cards regardless.
   * @param v - True to deliver native settlements as wake-only.
   */
  setSubtaskQuiet(v: boolean): void {
    this.subtaskQuiet = v
  }

  /**
   * Effective recursive delegation cap (Go maxSubtaskDepth).
   * @returns The configured cap, or the default of 3.
   */
  maxSubtaskDepth(): number {
    return this.subtaskMaxDepth > 0 ? this.subtaskMaxDepth : defaultSubtaskMaxDepth
  }

  /**
   * The first registered group-capable platform, or undefined (Go spawnCapablePlatform).
   * @returns The first platform that can spawn groups, if any.
   */
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
   * @param session - Child session whose workspace is measured.
   * @param workspaceDir - Directory the diff runs in.
   * @returns A zero- or one-element markdown-element array.
   */
  async subtaskDiffElements(session: Session | undefined, workspaceDir: string): Promise<CardMarkdownLike[]> {
    if (session === undefined || session.getSubtaskDepth() <= 0) return []
    const s = await gitDiffShortstat(workspaceDir)
    if (s === '') return []
    return [{ content: `${this.i18n.t(Msg.SubtaskDiffSummary)}: ${s}` }]
  }

  // ── status footer + completion notification (Go engine_cmd_misc.go, M7) ──

  /**
   * Build and store the per-turn completion usage fields (Go buildCompletionUsage).
   * @param args - Turn token counters and self-reported context percent.
   */
  async buildCompletionUsage(args: BuildCompletionUsageArgs): Promise<void> {
    await buildCompletionUsageFields(this.usage, this.showContextIndicator, this.usageProviders, this.baseWorkDir, args)
  }

  /**
   * Record agent processing time for the completion header (Go setCompletionDurations).
   * @param agentDurationMs - Agent span of the turn in ms.
   * @param turnDurationMs - Full turn span in ms.
   */
  setCompletionDurations(agentDurationMs: number, turnDurationMs: number): void {
    setDurations(this.usage, agentDurationMs, turnDurationMs)
  }

  /**
   * Compute the per-turn output-token rate (Go setTokenRate).
   * @param outputTokens - Output tokens produced this turn.
   * @param thinkingTimeMs - Agent wall-clock minus tool/permission waits, in ms.
   */
  setTokenRate(outputTokens: number, thinkingTimeMs: number): void {
    setTokenRateMsg(this.usage, outputTokens, thinkingTimeMs)
  }

  /**
   * Plain-text status footer (Go buildStatusFooter).
   * @param prefix - Label starting the footer, e.g. the completion title.
   * @param agent - Agent whose model/provider lines are shown.
   * @param workspaceDir - Working directory shown on the footer.
   * @param agentSessionID - Agent session id; '' omits the session line.
   * @param sessionKey - Session key shown on the footer.
   * @returns The rendered footer text.
   */
  async buildStatusFooter(
    prefix: string,
    agent: Agent | undefined,
    workspaceDir: string,
    agentSessionID: string,
    sessionKey: string,
  ): Promise<string> {
    return buildStatusFooterText(prefix, {
      fields: this.usage,
      agent,
      workspaceDir,
      agentSessionID,
      sessionKey,
      editorUrl: this.display.editorUrl,
    })
  }

  /**
   * Structured footer elements for the purple notification card (Go buildStatusFooterElements).
   * @param agent - Agent whose model/provider lines are shown.
   * @param workspaceDir - Working directory shown on the footer.
   * @param agentSessionID - Agent session id; '' omits the session line.
   * @param sessionKey - Session key shown on the footer.
   * @returns The header suffix and the card's footer elements.
   */
  async buildStatusFooterElements(
    agent: Agent | undefined,
    workspaceDir: string,
    agentSessionID: string,
    sessionKey: string,
  ): Promise<{ headerSuffix: string; elements: CardElement[] }> {
    return buildFooterElements({
      fields: this.usage,
      agent,
      workspaceDir,
      agentSessionID,
      sessionKey,
      editorUrl: this.display.editorUrl,
      ...(this.hints.length > 0 || this.hintsWithParam.length > 0 || this.hintsCommon.length > 0
        ? { hints: { hints: this.hints, hintsWithParam: this.hintsWithParam, hintsCommon: this.hintsCommon, usage: this.hintUsage } }
        : {}),
    })
  }

  /**
   * Codex-style reply footer (Go buildReplyFooter).
   * @param agent - Agent whose usage feeds the footer.
   * @param agentSession - Live session providing usage; '' footer when undefined.
   * @param workspaceDir - Working directory shown on the footer.
   * @param contextLeft - Pre-rendered context-remaining line.
   * @returns The footer text, '' when the feature is off or the agent is unknown.
   */
  async buildReplyFooter(
    agent: Agent | undefined,
    agentSession: AgentSession | undefined,
    workspaceDir: string,
    contextLeft: string,
  ): Promise<string> {
    if (!this.replyFooterEnabled || agent === undefined) return ''
    return buildReplyFooterText(
      { i18n: this.i18n, cache: this.replyFooterUsageCache },
      agent,
      agentSession,
      workspaceDir,
      contextLeft,
    )
  }

  /**
   * Session's context-usage snapshot for the reply footer (Go replyFooterSessionContextUsage).
   * @param session - Agent session to probe.
   * @returns The context usage, or undefined when the session exposes none.
   */
  replyFooterSessionContextUsage(session: AgentSession | undefined): ContextUsage | undefined {
    return (session as { getContextUsage?: () => ContextUsage | undefined } | undefined)?.getContextUsage?.()
  }

  /**
   * Spawn parent/child jump links for the notification card (Go
   * spawnJumpMarkdown): a breadcrumb for children, one button per active
   * child group for parents. Returned as a markdown line so it folds inside
   * the collapsible panel.
   * @param p - Platform the jump URLs are built for.
   * @param sessions - Session manager resolving display names.
   * @param cur - Session the card is being built for.
   * @param sessionKey - Session key of cur.
   * @returns The markdown line, or undefined when no link applies.
   */
  async spawnJumpMarkdown(
    p: Platform,
    sessions: SessionManager,
    cur: Session,
    sessionKey: string,
  ): Promise<CardMarkdownLike | undefined> {
    if (cur.getParentSessionKey() !== '') {
      const chain = this.ancestorChain(p, sessions, cur)
      const currentName = sessionDisplayName(cur, sessions, sessionKey)
      return breadcrumbMarkdown(chain, currentName, p)
    }
    const md = jumpButtonsMarkdown(await this.spawnJumpButtons(p, sessions, cur, sessionKey))
    return md.ok ? md : undefined
  }

  /** Parent→child or child→parent jump buttons (Go spawnJumpButtons). */
  private async spawnJumpButtons(p: Platform, sessions: SessionManager, cur: Session, sessionKey: string): Promise<CardButton[]> {
    const jump: CardButton[] = []
    const parentKey = cur.getParentSessionKey()
    if (parentKey !== '') {
      const pcid = chatIDFromSessionKey(parentKey, p.name())
      if (pcid !== '') {
        let name = cur.getParentChatName()
        if (name === '') name = sessionDisplayName(undefined, sessions, parentKey)
        jump.push({ text: `↩ ${name}`, type: 'primary', value: '', url: this.chatJumpURL(p, pcid) })
      }
      return jump
    }

    const active = new Set((await asSpawnedChatLister(p)?.listActiveSpawnedChats() ?? []).map(c => c.chatID))
    const { idToKey } = sessions.sessionKeyMap()
    const seen = new Set<string>()
    for (const s of sessions.allSessions()) {
      if (s.getParentSessionKey() !== sessionKey) continue
      const ck = idToKey[s.id] ?? ''
      const ccid = chatIDFromSessionKey(ck, p.name())
      if (ccid === '' || seen.has(ccid)) continue
      if (active.size > 0 && !active.has(ccid)) continue
      seen.add(ccid)
      jump.push({ text: sessionDisplayName(s, sessions, ck), type: 'primary', value: '', url: this.chatJumpURL(p, ccid) })
    }
    return jump
  }

  /** Ancestor spawned chats of cur, root first (Go ancestorChain). */
  private ancestorChain(p: Platform, sessions: SessionManager, cur: Session): Array<{ chatID: string; name: string }> {
    const { idToKey } = sessions.sessionKeyMap()
    const keyToSession = new Map<string, Session>()
    for (const s of sessions.allSessions()) {
      const k = idToKey[s.id]
      if (k !== undefined) keyToSession.set(k, s)
    }
    const chain: Array<{ chatID: string; name: string }> = []
    const visited = new Set<string>()
    let parentKey = cur.getParentSessionKey()
    while (parentKey !== '' && !visited.has(parentKey)) {
      visited.add(parentKey)
      const ps = keyToSession.get(parentKey)
      const cid = chatIDFromSessionKey(parentKey, p.name())
      // Include every ancestor except the top-level bot DM; ancestors absent
      // from the local store stay with unknown parentage (Go mirrors).
      if (cid !== '' && !(ps !== undefined && ps.getParentSessionKey() === '')) {
        chain.push({ chatID: cid, name: sessionDisplayName(ps, sessions, parentKey) })
      }
      if (ps === undefined) break
      parentKey = ps.getParentSessionKey()
    }
    return chain.reverse()
  }

  /**
   * Emit the ✅ completion notification card (purple header, status footer:
   * model/ctx/workdir/git + spawn jump links + subtask diff) when no queued
   * messages remain (Go sendTurnCompletionCard). Card-update platforms get
   * the structured card and keep its handle; others fall back to the plain
   * completion notifier.
   * @param state - Turn state the notification closes out.
   * @param p - Platform the notification is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param session - Session whose agent-session ID feeds the footer.
   * @param sessionKey - Session key shown on the footer.
   * @param workspaceDir - Working directory shown on the footer.
   */
  async sendTurnCompletionCard(
    state: InteractiveState,
    p: Platform,
    replyCtx: unknown,
    session: Session,
    sessionKey: string,
    workspaceDir: string,
  ): Promise<void> {
    if (state.pendingMessages.length > 0) return
    const footerMsg = await this.buildStatusFooter(
      this.i18n.t(Msg.TurnCompleted), this.agent, workspaceDir, session.getAgentSessionID(), sessionKey)
    const cu = asCardSenderWithUpdate(p)
    if (cu !== undefined) {
      const { headerSuffix, elements } = await this.buildStatusFooterElements(
        this.agent, workspaceDir, session.getAgentSessionID(), sessionKey)
      let footerElements = elements
      const jumpMD = await this.spawnJumpMarkdown(p, this.sessions, session, sessionKey)
      if (jumpMD !== undefined && jumpMD.content !== '') {
        footerElements = appendIntoLastCollapsible(footerElements, { kind: 'markdown', content: jumpMD.content })
      }
      footerElements = [...footerElements, ...(await this.subtaskDiffElements(session, workspaceDir)).map(d => ({ kind: 'markdown' as const, content: d.content }))]
      // The ✅ push is the strongest done signal; carry the same unreported
      // count as the progress card so a phone-glance user knows background
      // subtasks outlive this turn.
      const pendingChildren = this.pendingNativeChildrenOf(sessionKey)
      if (pendingChildren > 0) {
        footerElements = [...footerElements,
          { kind: 'markdown' as const, content: this.i18n.tf(Msg.SubtasksRunningHint, pendingChildren) }]
      }
      if (footerElements.length > 0 || headerSuffix !== '') {
        const card = newCard().title(headerSuffix, 'purple')
        for (const el of footerElements) card.raw(el)
        try {
          const h = await cu.sendCardWithHandle(replyCtx, card.build())
          state.notificationHandle = h
          state.notificationFooterMsg = footerMsg
          state.notificationFooterElements = footerElements
          state.notificationHeaderSuffix = headerSuffix
        } catch (error) {
          console.warn(`notification card send failed (${p.name()}): ${String(error)}`)
        }
      }
      return
    }
    const notifier = asCompletionNotifier(p)
    if (notifier !== undefined && footerMsg !== '') {
      try {
        await notifier.sendCompletionNotification(replyCtx, footerMsg)
      } catch (error) {
        console.warn(`completion notification failed (${p.name()}): ${String(error)}`)
      }
    }
  }

  /**
   * Create an isolated child group + session that runs a delegated piece of
   * work in parallel, woken from the agent via the subtask tool (Go
   * SpawnSubtask). Records parent linkage + delegation depth for the
   * event-driven result reinjection (see reportSubtask) and auto-isolates
   * the child in a git worktree when it shares the parent's repository.
   * @param parentSessionKey - Session key of the delegating parent chat.
   * @param dir - Explicit child work dir (--dir); '' resolves from the parent.
   * @param wtPref - Worktree isolation preference for the child.
   * @param forkContext - Whether the child copies the parent's conversation (--fork).
   * @param message - First message delegating the work; '' spawns an idle child.
   * @param images - Images attached to the first message.
   * @param attended - Whether the child is an attended (user-visible) subtask.
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
    // NOT fire a first agent turn. Used by the chatroom plugin's --research
    // mode to pre-spawn an assistant that idles until the role sends it a
    // real task.
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

    // Resolve the child work dir and optional worktree isolation. Shared by
    // the group path and the native continuable path (de-baggage B4).
    const { workDir, wtPath, wtBranch, wtBase, wtBaseBranch, wtRoot } =
      await this.resolveSubtaskWorkDir(parentSessionKey, dir, wtPref, firstMsg)

    // Fork-source guard: fail fast BEFORE creating the group so the agent
    // learns to drop -f and retry, leaving no orphan group (Go
    // SpawnSubtask's PrepareForkSession check). In TS this checks existence
    // (live registry or persistence), not directory locality — the seed
    // source resolves globally by id, so cross-directory forks work.
    if (forkOrigID !== '') {
      const prep = asForkSessionPreparer(this.agent)
      if (prep !== undefined) {
        try {
          await prep.prepareForkSession(forkOrigID, '', '')
        } catch (error) {
          throw new Error(`subtask: --fork 父会话不可达：${String(error instanceof Error ? error.message : error)}（fork 源会话既不在内存也不在持久化日志中；请确认父会话存在，或去掉 -f 用全新上下文派发）`)
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
    if (wtPath !== '') ns.setWorktreeInfo(wtPath, wtBranch, wtBase, wtRoot, wtBaseBranch)
    this.sessions.save()

    // Fold a late-spawned child into an armed gather barrier so gather also
    // awaits it; without a barrier this is a no-op.
    const gg = parent.getPendingSubtaskGather()
    if (gg !== undefined) {
      if (gg.addExpected(syntheticMsg.sessionKey, childLabel(ns))) {
        console.info(`subtask: added late-spawned child to armed gather (parent=${parentSessionKey} child=${syntheticMsg.sessionKey})`)
      }
    }

    // Notification card in the new group. Reset the per-turn usage fields
    // first so the parent's last-turn ctx numbers don't bleed onto the
    // child's readiness card (Go buildCompletionUsage(0) before the card).
    const cs = asCardSender(p)
    if (cs !== undefined) {
      await this.buildCompletionUsage({
        totalInputTokens: 0, sdkPlausible: false, selfPct: 0,
        nonCachedDelta: 0, nonCachedCum: 0, cachedDelta: 0, cachedCum: 0,
        numTurns: 0, compactionCount: 0,
      })
      const jumpMD = jumpButtonsMarkdown(parentJumpButtons(parentSessionKey, this.subtaskParentLabel(parent), p))
      const card = await this.buildSpawnNotifyCard(
        workDir, this.i18n.t(Msg.SpawnGroupReady), '', jumpMD, syntheticMsg.sessionKey)
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
    this.bridge.emit('feishuBridge/subtask-dispatched', { engine: this, parentSessionKey })
    return { childName: groupName, childKey: syntheticMsg.sessionKey }
  }

  /**
   * Resolve the child work dir and optional worktree isolation shared by the
   * group and native spawn paths (de-baggage B4): the parent's per-chat
   * override (or agent base dir), then an explicit --dir; auto-mode
   * worktree isolation applies only when the child shares the parent's git
   * repository, and the worktree is created up front so failures leave no
   * child behind.
   * @param parentSessionKey - Session key of the delegating parent chat.
   * @param dir - Explicit child work dir (--dir); '' resolves from the parent.
   * @param wtPref - Worktree isolation preference for the child.
   * @param brief - The task brief, slugged into the worktree branch name.
   * @returns The child's resolved work dir and worktree coordinates ('' = none).
   */
  private async resolveSubtaskWorkDir(
    parentSessionKey: string,
    dir: string,
    wtPref: WorktreeMode,
    brief: string,
  ): Promise<{ workDir: string; wtPath: string; wtBranch: string; wtBase: string; wtBaseBranch: string; wtRoot: string }> {
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
    // the parent's git repository. Fail fast before creating anything.
    let wtPath = ''
    let wtBranch = ''
    let wtBase = ''
    let wtBaseBranch = ''
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
        created = await createWorktree(root, slugify(brief))
      } catch (error) {
        throw new Error(`subtask: worktree create failed: ${String(error instanceof Error ? error.message : error)}`)
      }
      wtPath = created.path
      wtBranch = created.branch
      wtBase = created.baseSHA
      wtBaseBranch = created.baseBranch
      wtRoot = root
      workDir = created.path
    }
    return { workDir, wtPath, wtBranch, wtBase, wtBaseBranch, wtRoot }
  }

  /**
   * Spawn an unattended child as a native continuable subagent session
   * (de-baggage B4): no Feishu group, no user-visible surface — lineage,
   * depth, and cold resume belong to the native runtime, the engine keeps
   * only the parentage record (persisted in the project state) and the
   * worktree it created. Settlement reaches the engine through the
   * `subagent/end` event; the runtime's own parent wake is mounted
   * 'external'.
   * @param parentSessionKey - Session key of the delegating parent chat.
   * @param dir - Explicit child work dir (--dir); '' resolves from the parent.
   * @param wtPref - Worktree isolation preference for the child.
   * @param forkContext - Whether the child copies the parent's conversation (--fork).
   * @param brief - The self-contained task brief; '' is invalid here.
   * @returns The child's durable native session id and label.
   */
  async spawnSubtaskNative(
    parentSessionKey: string,
    dir: string,
    wtPref: WorktreeMode,
    forkContext: boolean,
    brief: string,
  ): Promise<{ childName: string; childKey: string }> {
    const briefText = brief.trim()
    if (briefText === '') throw new Error('subtask: spawn requires a task brief (message)')
    const delegator = asContinuableDelegator(this.agent)
    if (delegator === undefined) {
      throw new Error('subtask: the agent backend does not support native subtasks')
    }

    const parent = this.sessions.getOrCreateActive(parentSessionKey)
    // Fork guard mirrors the group path: a fork needs a started parent
    // conversation to copy context from.
    if (forkContext) {
      const forkOrigID = parent.getAgentSessionID()
      if (forkOrigID === '' || forkOrigID === ContinueSession || forkOrigID.startsWith(ForkSessionPrefix)) {
        throw new Error('subtask: --fork needs a started parent conversation to copy context from')
      }
    }
    // The native runtime authorizes follow-ups and reports against the exact
    // live direct parent, so the parent's agent session must be up.
    const parentNativeID = this.liveNativeSessionID(parentSessionKey)
    if (parentNativeID === '') {
      throw new Error('subtask: the parent conversation has no live agent session; send it a message first')
    }

    const { workDir, wtPath, wtBranch, wtBase, wtBaseBranch, wtRoot } =
      await this.resolveSubtaskWorkDir(parentSessionKey, dir, wtPref, briefText)

    let childId: string
    let label: string
    try {
      const started = await delegator.startContinuableChild({
        provider: forkContext ? 'fork' : 'spawn',
        prompt: briefText,
        cwd: workDir,
        workspace: this.feishuWorkspace,
        maxDepth: this.maxSubtaskDepth(),
        parentAgentSessionID: parentNativeID,
      })
      childId = started.childId
      label = started.label
    } catch (error) {
      // A failed delegation must not leak the worktree it reserved.
      if (wtPath !== '') await this.removeNativeWorktreeQuiet(wtPath, wtBranch, wtRoot, wtBase, wtBaseBranch)
      throw error
    }

    if (this.projectState !== undefined) {
      this.projectState.setNativeChild(childId, {
        parent_key: parentSessionKey,
        parent_agent_session_id: parentNativeID,
        label,
        worktree_path: wtPath,
        worktree_branch: wtBranch,
        worktree_base: wtBase,
        worktree_base_branch: wtBaseBranch,
        worktree_root: wtRoot,
        reported: false,
      })
      this.projectState.save()
    }

    // Fold a late-spawned child into an armed gather barrier (no-op without one).
    const gg = parent.getPendingSubtaskGather()
    if (gg !== undefined) {
      if (gg.addExpected(childId, label)) {
        console.info(`subtask: added late-spawned native child to armed gather (parent=${parentSessionKey} child=${childId})`)
      }
    }

    // Surface the still-running count on the spawning turn's live card right
    // away (the stop-button row hint); the turn-end recount carries it onto
    // the settled card. Fire-and-forget — a hint PATCH must not fail the spawn.
    this.refreshSubtaskFooter(parentSessionKey)

    console.info(`subtask: spawned native (parent=${parentSessionKey} child=${childId} fork=${forkContext} worktree=${wtPath !== ''} dir=${workDir})`)
    return { childName: label, childKey: childId }
  }

  /**
   * Refresh the still-running-subtasks hint on a parent's live card. Called at
   * spawn and whenever a child's `reported` flag flips, so a long parent turn
   * (2026-08-27 oc_56801302: 40 minutes) no longer shows a stale count until
   * turn end. Zero pending clears the hint. Fire-and-forget — a hint PATCH
   * must not fail the operation that changed the count.
   * @param parentKey - Parent session key whose live card carries the hint.
   */
  private refreshSubtaskFooter(parentKey: string): void {
    const state = this.interactiveStates.get(parentKey)
    const sp = state?.preview
    if (this.display.toolProgress && sp !== undefined && sp.canPreview()) {
      const pending = this.pendingNativeChildrenOf(parentKey)
      // Mirror the turn-end recount: zero subtasks only clears the hint when no
      // background task is pending either (its count owns the hint in that case).
      if (pending > 0) void sp.setBackgroundHint(this.i18n.tf(Msg.SubtasksRunningHint, pending))
      else if (state !== undefined && state.backgroundTasksPending === 0) void sp.setBackgroundHint('')
    }
    // A running panel tracks the same flips (a reported child leaves the rows);
    // independent of the live-card hint, which the preview guard above owns.
    this.refreshSubtaskPanel(parentKey)
  }

  /**
   * Post or refresh the background-subtask panel for a parent whose turn
   * settled with unreported native children. Called at turn end and on every
   * reported-flag flip; no-ops without pending children (a live panel
   * finalizes to its done card) and when the feature is disabled or the
   * platform cannot hold a card handle.
   * @param parentKey - Parent session key the panel belongs to.
   */
  ensureSubtaskPanel(parentKey: string): void {
    if (!this.subtaskPanelEnabled || this.subtaskPanelIntervalMs <= 0) return
    const rows = this.subtaskPanelChildren(parentKey)
    if (rows.length === 0 || this.subtaskPanels.has(parentKey)) {
      this.refreshSubtaskPanel(parentKey)
      return
    }
    const p = this.reportCapablePlatform()
    if (p === undefined) return
    const cu = asCardSenderWithUpdate(p)
    const r = asReplyContextReconstructor(p)
    if (cu === undefined || r === undefined) return
    const startedAt = Date.now()
    void r.reconstructReplyCtx(parentKey).then(
      async (parentRctx) => {
        const card = renderSubtaskPanelCard(
          this.i18n, { pending: rows, reportedCount: this.reportedNativeChildrenOf(parentKey), startedAt, phase: 'running' },
          startedAt, this.subtaskPanelStallMs,
        )
        try {
          const handle = await cu.sendCardWithHandle(parentRctx, card)
          const timer = setInterval(() => { this.refreshSubtaskPanel(parentKey) }, this.subtaskPanelIntervalMs)
          this.subtaskPanels.set(parentKey, { handle, timer, startedAt })
          console.info(`subtask: background panel posted (${parentKey}: ${rows.length} child/children)`)
        } catch (error) {
          console.warn(`subtask: background panel post failed (${parentKey}): ${String(error)}`)
        }
      },
      (error: unknown) => {
        console.warn(`subtask: background panel reconstruct ctx failed (${parentKey}): ${String(error)}`)
      },
    )
  }

  /** One panel tick: PATCH the live card, or finalize it once nothing pends. */
  private refreshSubtaskPanel(parentKey: string): void {
    const panel = this.subtaskPanels.get(parentKey)
    if (panel === undefined) return
    const rows = this.subtaskPanelChildren(parentKey)
    const activity = asSubagentActivitySource(this.agent)
    const now = Date.now()
    const cu = asCardSenderWithUpdate(this.reportCapablePlatform() ?? this.platforms[0] ?? ({} as Platform))
    const card = renderSubtaskPanelCard(
      this.i18n,
      rows.length === 0
        ? { pending: [], reportedCount: this.reportedNativeChildrenOf(parentKey), startedAt: panel.startedAt, phase: 'done' }
        : { pending: rows, reportedCount: this.reportedNativeChildrenOf(parentKey), startedAt: panel.startedAt, phase: 'running' },
      now, this.subtaskPanelStallMs,
    )
    void cu?.updateCardWithHandle(panel.handle, card).then(() => {
      if (rows.length === 0) {
        clearInterval(panel.timer)
        this.subtaskPanels.delete(parentKey)
        activity?.forgetSubagentActivity(this.childIdsOf(parentKey))
        console.info(`subtask: background panel finalized (${parentKey})`)
      }
    }).catch((error: unknown) => {
      console.warn(`subtask: background panel update failed (${parentKey}): ${String(error)}`)
      // A dead card (recalled, chat deleted) must not tick forever.
      if (rows.length === 0) {
        clearInterval(panel.timer)
        this.subtaskPanels.delete(parentKey)
        activity?.forgetSubagentActivity(this.childIdsOf(parentKey))
      }
    })
  }

  /**
   * Close a parent's panel with its drained card (or silently when the chat
   * is going away) — the /done teardown path.
   * @param parentKey - Parent session key whose panel closes.
   * @param mode - 'drained' PATCHes the drained card; 'silent' stops the timer only.
   */
  clearSubtaskPanel(parentKey: string, mode: 'drained' | 'silent'): void {
    const panel = this.subtaskPanels.get(parentKey)
    if (panel === undefined) return
    clearInterval(panel.timer)
    this.subtaskPanels.delete(parentKey)
    asSubagentActivitySource(this.agent)?.forgetSubagentActivity(this.childIdsOf(parentKey))
    if (mode === 'silent') return
    const cu = asCardSenderWithUpdate(this.reportCapablePlatform() ?? this.platforms[0] ?? ({} as Platform))
    const card = renderSubtaskPanelCard(this.i18n, { pending: [], reportedCount: 0, startedAt: panel.startedAt, phase: 'drained' }, Date.now(), this.subtaskPanelStallMs)
    void cu?.updateCardWithHandle(panel.handle, card).catch((error: unknown) => {
      console.warn(`subtask: background panel drained update failed (${parentKey}): ${String(error)}`)
    })
  }

  /** Pending panel rows for a parent, in record order, joined with activity. */
  private subtaskPanelChildren(parentKey: string): Array<{ childId: string; label: string; toolCalls: number; lastEventAt: number }> {
    const activity = asSubagentActivitySource(this.agent)
    const rows: Array<{ childId: string; label: string; toolCalls: number; lastEventAt: number }> = []
    for (const [childId, rec] of Object.entries(this.nativeChildEntries())) {
      if (rec.parent_key !== parentKey || rec.reported) continue
      const act = activity?.subagentActivitySnapshot().get(childId)
      rows.push({ childId, label: rec.label, toolCalls: act?.toolCalls ?? 0, lastEventAt: act?.lastEventAt ?? 0 })
    }
    return rows
  }

  /** Reported native children count of one parent. */
  private reportedNativeChildrenOf(parentKey: string): number {
    let reported = 0
    for (const rec of Object.values(this.nativeChildEntries())) {
      if (rec.parent_key === parentKey && rec.reported) reported++
    }
    return reported
  }

  /** All native child ids recorded for one parent, reported or not. */
  private childIdsOf(parentKey: string): string[] {
    return Object.entries(this.nativeChildEntries())
      .filter(([, rec]) => rec.parent_key === parentKey)
      .map(([childId]) => childId)
  }

  /**
   * Configure the background-subtask live panel (features.subtaskLivePanel*).
   * A zero interval disables the panel entirely.
   * @param cfg - Enabled flag, refresh interval ms, and stall-flag window ms.
   */
  setSubtaskPanelConfig(cfg: { enabled: boolean; intervalMs: number; stallMs?: number }): void {
    this.subtaskPanelEnabled = cfg.enabled && cfg.intervalMs > 0
    this.subtaskPanelIntervalMs = cfg.intervalMs
    if (cfg.stallMs !== undefined && cfg.stallMs > 0) this.subtaskPanelStallMs = cfg.stallMs
  }

  /** Live native session id of an engine session's running agent ('' = none). */
  private liveNativeSessionID(sessionKey: string): string {
    const state = this.interactiveStates.get(sessionKey)
    if (state?.agentSession === undefined || !state.agentSession.alive()) return ''
    return state.agentSession.currentSessionID()
  }

  /** Remove a native child's worktree quietly (teardown paths; failures warn). */
  private async removeNativeWorktreeQuiet(path: string, branch: string, root: string, base: string, baseBranch: string): Promise<void> {
    if (path === '') return
    try {
      const dirty = await worktreeDirtyDetail(path, base)
      if (dirty.uncommitted || !(await this.worktreeMergedLossless(root, branch, dirty.ahead, this.effectiveSpawnIntegrate(baseBranch)))) {
        console.warn(`subtask: native child worktree is dirty; kept (${path})`)
        return
      }
      await removeWorktree(root, path, branch, false)
    } catch (error) {
      console.warn(`subtask: native child worktree removal failed; kept (${path}): ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  /**
   * The containment target for one worktree's merged auto-removal: the
   * configured integrateBranch overrides, else the branch HEAD was on when
   * the worktree was created; '' disables auto-removal for it.
   * @param baseBranch - The worktree's recorded base branch ('' when unknown).
   * @returns The branch to check containment against, or ''.
   */
  effectiveSpawnIntegrate(baseBranch: string): string {
    return this.spawnIntegrateBranch !== '' ? this.spawnIntegrateBranch : baseBranch
  }

  /**
   * Whether a dirty worktree's commits already landed in the containment
   * target, making removal lossless.
   * @param root - Repository root that owns the worktree's branch.
   * @param branch - The worktree's branch.
   * @param ahead - Whether the worktree has commits ahead of its base.
   * @param integrate - The containment target branch; '' never removes.
   * @returns True only when ahead and fully contained in the integrate branch.
   */
  async worktreeMergedLossless(root: string, branch: string, ahead: boolean, integrate: string): Promise<boolean> {
    if (!ahead || integrate === '') return false
    return worktreeMergedInto(root, branch, integrate)
  }

  /**
   * All persisted native continuable children of this engine, keyed by child id.
   * @returns The child records (empty map without a project state store).
   */
  nativeChildEntries(): Record<string, NativeChildRecord> {
    return this.projectState?.nativeChildren() ?? {}
  }

  /**
   * Whether this engine owns the given native child id (tool-call routing).
   * @param childId - The durable native child session id.
   * @returns True when the child was spawned by this engine.
   */
  ownsNativeChild(childId: string): boolean {
    return this.nativeChildEntries()[childId] !== undefined
  }

  /**
   * Count a session's persisted native children that have not reported —
   * the still-running-subtasks count shown on progress cards. Recomputed
   * from the durable records at each render point; no shadow counter.
   * @param sessionKey - Parent engine session key.
   * @returns Unreported native children spawned by this session.
   */
  private pendingNativeChildrenOf(sessionKey: string): number {
    let pending = 0
    for (const rec of Object.values(this.nativeChildEntries())) {
      if (rec.parent_key === sessionKey && !rec.reported) pending++
    }
    return pending
  }

  /**
   * Update one persisted native child record (no-op without a store).
   * @param childId - The durable native child session id.
   * @param patch - Fields to overwrite on the record.
   */
  private updateNativeChild(childId: string, patch: Partial<NativeChildRecord>): void {
    const entries = this.nativeChildEntries()
    const current = entries[childId]
    if (current === undefined || this.projectState === undefined) return
    this.projectState.setNativeChild(childId, { ...current, ...patch })
    this.projectState.save()
  }

  /**
   * Push a native child's result back to its parent (de-baggage B4): an
   * engine-session parent receives the same card + `[子任务完成]` wake the
   * group path delivers; a native parent (itself a continuable child)
   * receives the report through the runtime's native report path.
   * Idempotent per child until a follow-up re-arms it.
   * @param childId - The durable native child session id.
   * @param result - The child's result text; '' uses the child's last reply.
   * @param opts - settleEmpty: an empty result after the window re-read settles
   *   with a no-output notice instead of throwing (the settlement path has no
   *   live model to teach).
   */
  async reportNativeChild(childId: string, result: string, opts: { settleEmpty?: boolean } = {}): Promise<void> {
    const entry = this.nativeChildEntries()[childId]
    if (entry === undefined) {
      throw new Error('subtask: not a native child of this project')
    }
    if (entry.reported) {
      console.info(`subtask: native report already delivered, skipping duplicate (child=${childId})`)
      return
    }
    if (result.trim() === '') {
      const entries = await this.recentTurns(childId)
      const lastAssistant = [...entries].reverse().find(e => e.role === 'assistant')?.content ?? ''
      result = lastAssistant
    }
    if (result.trim() === '') {
      if (opts.settleEmpty === true) {
        result = this.i18n.t(Msg.SubtaskSettlementNoOutput)
      } else {
        throw new Error('subtask: no result to report')
      }
    }

    const nativeParent = this.nativeChildEntries()[entry.parent_key] !== undefined
    if (nativeParent) {
      const delegator = asContinuableDelegator(this.agent)
      if (delegator === undefined) {
        throw new Error('subtask: the agent backend does not support native subtasks')
      }
      await delegator.reportChildToNativeParent(childId, result.trim())
      this.updateNativeChild(childId, { reported: true })
      this.refreshSubtaskFooter(entry.parent_key)
      console.info(`subtask: native child reported to native parent (child=${childId})`)
      return
    }

    const p = this.reportCapablePlatform()
    if (p === undefined) {
      throw new Error('subtask: no platform available to deliver report')
    }
    if (!this.replyNativeToParent(p, childId, entry, result.trim())) {
      throw new Error('subtask: this chat has no parent session to report back to')
    }
    this.updateNativeChild(childId, { reported: true })
    this.refreshSubtaskFooter(entry.parent_key)
    console.info(`subtask: native child reported to parent (child=${childId})`)
  }

  /**
   * Settlement fallback (Go maybeAutoReportSubtask's native counterpart): the
   * `subagent/end` listener calls this with the epoch's final assistant
   * output and terminal outcome, so a child that never explicitly reported
   * still delivers — and a follow-up's answer re-arms the same delivery.
   * @param childId - The durable native child session id.
   * @param finalOutput - The epoch's final assistant text ('' re-reads the window).
   * @param stopReason - The terminal stop reason from `subagent/end`; a non-completed reason prefixes failure semantics.
   * @param diagnostic - Provider-authored failure detail ('' when none).
   */
  settleNativeChild(childId: string, finalOutput: string, stopReason: string = 'completed', diagnostic: string = ''): void {
    const entry = this.nativeChildEntries()[childId]
    if (entry === undefined || entry.reported) return
    const delivery = this.settlementDeliveryText(stopReason, finalOutput, diagnostic)
    void this.reportNativeChild(childId, delivery, { settleEmpty: true })
      .catch((error: unknown) => {
        console.warn(`subtask: native settlement delivery failed (child=${childId}): ${String(error)}`)
      })
  }

  /**
   * Compose a native child's settlement delivery text from its terminal
   * outcome: a non-completed stop reason carries an explicit failure prefix
   * (plus the provider diagnostic and a no-closing-output notice when
   * present), so the parent can tell finished work from failed work — the
   * bridge counterpart of the runtime's one-shot run-settlement vocabulary.
   * @param stopReason - The terminal stop reason from `subagent/end`.
   * @param output - The epoch's final assistant text ('' when none).
   * @param diagnostic - Provider-authored failure detail ('' when none).
   * @returns The delivery text; never empty for a non-completed reason.
   */
  settlementDeliveryText(stopReason: string, output: string, diagnostic: string): string {
    let prefix = ''
    switch (stopReason) {
      case 'completed': break
      case 'max-tokens': prefix = this.i18n.t(Msg.SubtaskSettlementMaxTokens); break
      case 'refusal': prefix = this.i18n.t(Msg.SubtaskSettlementRefusal); break
      case 'aborted': prefix = this.i18n.t(Msg.SubtaskSettlementAborted); break
      case 'error': prefix = this.i18n.t(Msg.SubtaskSettlementFailed); break
      // Merge-extensible stop reasons report as unfinished, never as success.
      default: prefix = this.i18n.tf(Msg.SubtaskSettlementAbnormal, stopReason); break
    }
    if (prefix === '') return output.trim()
    const parts = [prefix]
    if (diagnostic !== '') parts.push(this.i18n.tf(Msg.SubtaskSettlementDiagnostic, diagnostic))
    parts.push(output.trim() === '' ? this.i18n.t(Msg.SubtaskSettlementNoOutput) : output.trim())
    return parts.join('\n\n')
  }

  /**
   * Card + wake delivery for a native child's report to an engine-session
   * parent — the native counterpart of {@link replyToParent}.
   * @param p - Platform delivering the card and wake message.
   * @param childId - The durable native child session id.
   * @param entry - The child's persisted record.
   * @param content - Result content to push.
   * @returns True when the delivery was initiated.
   */
  private replyNativeToParent(p: Platform, childId: string, entry: NativeChildRecord, content: string): boolean {
    if (entry.parent_key === '' || content.trim() === '') return false
    const r = asReplyContextReconstructor(p)
    if (r === undefined) return false
    void r.reconstructReplyCtx(entry.parent_key).then(
      (parentRctx) => {
        void this.deliverParentReply(p, entry.parent_key, childId, entry.label, parentRctx, content, this.subtaskQuiet)
      },
      (error: unknown) => {
        console.warn(`replyNativeToParent: reconstruct reply ctx failed (parent=${entry.parent_key}): ${String(error)}`)
      },
    )
    return true
  }

  /**
   * Interrupt one native child's current turn (de-baggage B4's model-visible
   * interruption surface).
   * @param childId - The durable native child session id.
   */
  interruptNativeChild(childId: string): void {
    const entry = this.nativeChildEntries()[childId]
    if (entry === undefined) {
      throw new Error('subtask: not a native child of this project')
    }
    const delegator = asContinuableDelegator(this.agent)
    if (delegator === undefined) {
      throw new Error('subtask: the agent backend does not support native subtasks')
    }
    // Prefer the parent's CURRENT live native session: a resumed parent keeps
    // its id, and the runtime authorizes against the exact live ancestor.
    const liveParent = this.liveNativeSessionID(entry.parent_key)
    delegator.interruptChild(liveParent !== '' ? liveParent : entry.parent_agent_session_id, childId)
    // An interrupted child never reports; settle the record so the
    // still-running count on progress cards does not overstate forever.
    this.updateNativeChild(childId, { reported: true })
    this.refreshSubtaskFooter(entry.parent_key)
    console.info(`subtask: interrupt requested for native child (child=${childId})`)
  }

  /**
   * Tear down the native continuable descendants of the given root keys
   * (de-baggage B4): interrupt each child's current turn, recycle a clean
   * worktree, keep a dirty one, and drop the parentage records. Native
   * grandchildren chain through native records, so a group descendant that
   * spawned native children is covered by including it in the roots.
   * @param rootKeys - Session keys whose native descendants to drain.
   */
  async drainNativeDescendants(rootKeys: string[]): Promise<void> {
    const entries = this.nativeChildEntries()
    const roots = new Set(rootKeys)
    const toDrain: Array<[string, NativeChildRecord]> = []
    let grew = true
    while (grew) {
      grew = false
      for (const [childId, rec] of Object.entries(entries)) {
        if (toDrain.some(([id]) => id === childId)) continue
        if (!roots.has(rec.parent_key)) continue
        toDrain.push([childId, rec])
        roots.add(childId) // a drained native child roots its own descendants
        grew = true
      }
    }
    for (const [childId, rec] of toDrain) {
      try {
        this.interruptNativeChild(childId)
      } catch (error) {
        console.warn(`subtask: native descendant interrupt failed (child=${childId}): ${String(error)}`)
      }
      await this.removeNativeWorktreeQuiet(
        rec.worktree_path, rec.worktree_branch, rec.worktree_root, rec.worktree_base, rec.worktree_base_branch,
      )
      this.projectState?.clearNativeChild(childId)
    }
    if (toDrain.length > 0) this.projectState?.save()
    // Panels of drained roots close on their drained card; a root with no
    // drained native descendant (group children only) keeps no stale panel.
    for (const key of rootKeys) this.clearSubtaskPanel(key, 'drained')
  }

  /** Fire-and-forget inbound delivery (Go SafeGo ReceiveMessage). */
  private receiveMessageSafe(p: Platform, msg: Message): void {
    try {
      this.receiveMessage(p, msg)
    } catch (error) {
      console.error(`engine: receive-message failed (${msg.sessionKey}): ${String(error)}`)
    }
  }

  /**
   * Deliver one machine message (subtask report wake, gather-summary wake,
   * chatroom moderator wake, follow-up injection) to a session's agent. A
   * busy session receives it mid-turn through the agent-session steer
   * primitive — claimed at the next step boundary, so several machine
   * messages batch into one step — instead of entering the platform message
   * pipeline, whose queue semantics (queued-notice reply, in-memory storage,
   * length cap) belong to human conversations and must not apply to machine
   * coordination (2026-08-27 oc_56801302: six child reports queued behind a
   * 40-minute turn, the sixth silently dropped at the queue cap). An idle
   * session keeps the synthetic-message pipeline so the wake runs with the
   * bridge's full turn machinery. The startup window (no agent session yet,
   * issue #565) and a busy-but-dead agent session fall back to the pipeline's
   * existing queueing/failure semantics. A steer that lands just before the
   * running turn ends stays in the inbox for the next turn — durable session
   * events, never lost.
   * @param p - Platform the message would have been delivered on.
   * @param msg - The synthetic machine message; only content is steered.
   */
  deliverMachineMessage(p: Platform, msg: Message): void {
    const state = this.interactiveStates.get(msg.sessionKey)
    const busy = this.sessions.findActive(msg.sessionKey)?.isBusy() ?? false
    if (busy && state?.agentSession !== undefined && state.agentSession.alive()) {
      state.agentSession.steer(msg.content)
      return
    }
    this.receiveMessageSafe(p, msg)
  }

  /**
   * The agent's base work dir, or '' when it has none (Go GetWorkDir probe).
   * @returns The agent's configured working directory.
   */
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

  /**
   * Human label for the parent chat on jump buttons (Go subtaskParentLabel).
   * @param parent - Parent session whose name is used.
   * @returns The parent's display name, or the engine name as fallback.
   */
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
   * @param childSessionKey - Session key of the reporting child.
   * @param result - The child's result text; '' uses the child's last reply.
   */
  async reportSubtask(childSessionKey: string, result: string): Promise<void> {
    const p = this.reportCapablePlatform()
    if (p === undefined) {
      throw new Error('subtask: no platform available to deliver report')
    }

    // Non-creating lookup, symmetric with sendToSubtask: an unknown key
    // fails loudly instead of minting a parentless phantom.
    const sess = this.sessions.findActive(childSessionKey)
    if (sess === undefined) {
      throw new Error(`subtask: no subtask session ${childSessionKey} — the key may be mistyped`)
    }
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
    if (result.trim() === '') result = await this.lastResultOrReply(childSessionKey, sess)
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
   * @param callerSessionKey - Session key of the parent issuing the follow-up.
   * @param childSessionKey - Session key of the target child group.
   * @param message - Follow-up text for the child.
   */
  async sendToSubtask(callerSessionKey: string, childSessionKey: string, message: string): Promise<void> {
    const msg = message.trim()
    if (msg === '') throw new Error('subtask: message is required')
    if (childSessionKey.trim() === '') throw new Error('subtask: child session key is required')

    // Short child aliases: features may provision one for keys a model would
    // mistype in tool args (a 40+ char hex key drops characters in
    // transcription, 2026-08-25 oc_ac5db incident); the alias removes the
    // transcription entirely. '' from the waterfall = unknown alias, normal
    // key parsing continues.
    let childKey = childSessionKey.trim()
    const aliasResolved = this.bridge.waterfall('feishuBridge/resolve-child-alias', { engine: this, callerSessionKey, alias: childKey }, () => '')
    if (aliasResolved !== '') childKey = aliasResolved

    // Native continuable child: the runtime inbox queues the follow-up
    // behind the child's current turn — the deliberate deviation from Go's
    // busy-reject (a queued follow-up's answer re-arms the settlement
    // fallback, so it still folds back).
    const nativeEntry = this.nativeChildEntries()[childKey]
    if (nativeEntry !== undefined) {
      if (nativeEntry.parent_key !== callerSessionKey) {
        throw new Error(this.i18n.t(Msg.SubtaskSendNotChild))
      }
      const delegator = asContinuableDelegator(this.agent)
      if (delegator === undefined) {
        throw new Error('subtask: the agent backend does not support native subtasks')
      }
      const liveParent = this.liveNativeSessionID(callerSessionKey)
      if (liveParent === '' && !this.nativeChildEntries()[callerSessionKey]) {
        throw new Error('subtask: the parent conversation has no live agent session')
      }
      this.updateNativeChild(childKey, { reported: false })
      await delegator.followupChild(
        liveParent !== '' ? liveParent : nativeEntry.parent_agent_session_id,
        childKey,
        msg,
      )
      console.info(`subtask: parent sent follow-up to native child (parent=${callerSessionKey} child=${childKey})`)
      return
    }

    const p = this.reportCapablePlatform()
    if (p === undefined) throw new Error('subtask: no platform available to deliver follow-up')

    // Non-creating lookup: a bogus child key must fail loudly here, not mint
    // a phantom session whose empty parent link then misreports as "not your
    // child" (the oc_ac5db incident's confusing surface).
    const child = this.sessions.findActive(childKey)
    if (child === undefined) {
      throw new Error(`subtask: no subtask session ${childKey} — the key may be mistyped; copy it verbatim`)
    }
    if (child.getParentSessionKey() !== callerSessionKey) {
      throw new Error(this.i18n.t(Msg.SubtaskSendNotChild))
    }
    // Backpressure: a queued follow-up's answer would never report back (the
    // in-flight turn's auto-report consumes any re-arm); reject instead.
    if (child.isBusy()) {
      throw new Error(this.i18n.t(Msg.SubtaskChildBusy))
    }

    const r = asReplyContextReconstructor(p)
    if (r === undefined) {
      throw new Error(`subtask: platform "${p.name()}" cannot address the subtask group`)
    }
    let childRctx: unknown
    try {
      childRctx = await r.reconstructReplyCtx(childKey)
    } catch (error) {
      throw new Error(`subtask: reconstruct child reply ctx: ${String(error instanceof Error ? error.message : error)}`)
    }

    // Re-arm the one-shot auto-report so the child's answer to this
    // follow-up folds back to the parent.
    child.setSubtaskReported(false)
    this.sessions.save()

    // Post the follow-up as a visible card in the child group first, so
    // members see WHAT the parent asked (the injected message is silent).
    await this.sendAsCard(p, childRctx, msg, { title: this.i18n.t(Msg.SubtaskFollowupHeader), color: 'indigo' })

    const childMsg: Message = {
      ...emptyMessage(),
      sessionKey: childKey,
      platform: p.name(),
      userName: '[父任务追问]',
      content: `[父任务追问] ${msg}`,
      replyCtx: childRctx,
    }
    // The busy-reject above makes the idle path the norm; deliverMachineMessage
    // only steers when the child locked a turn in the check-to-inject race.
    this.deliverMachineMessage(p, childMsg)

    console.info(`subtask: parent sent follow-up to child (parent=${callerSessionKey} child=${childKey})`)
    this.bridge.emit('feishuBridge/subtask-dispatched', { engine: this, parentSessionKey: callerSessionKey })
  }

  /**
   * First-turn fallback: a subtask session that finishes its initial turn
   * without an explicit report still pushes that turn's reply to the parent.
   * One-shot per subtask (Go maybeAutoReportSubtask).
   * @param state - Turn state; its platform delivers the report.
   * @param session - Child session that finished its first turn.
   * @param baseResponse - The turn's clean reply text.
   * @param isSilent - Whether the turn was a silent reply.
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
   * @param sessionKey - Session key of the stopped child.
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
   * @param msg - The inbound human message.
   * @param session - Child session starting the new turn.
   * @param sessions - Session manager persisting the flag reset.
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
   * @param session - Child session whose queued message is draining.
   * @param sessions - Session manager persisting the flag reset.
   */
  rearmSubtaskReportOnDrain(session: Session, sessions: SessionManager): void {
    if (session.getSubtaskDepth() <= 0 || !session.getSubtaskReported()) return
    session.setSubtaskReported(false)
    sessions.save()
    console.info(`subtask: re-armed report on drained queued message (child=${session.id})`)
  }

  /**
   * Flip userInterjected when a real human sends a message into an otherwise
   * background session (subtask child or feature session, decided by the
   * `feishuBridge/background-session-policy` waterfall), re-enabling
   * auto-render from that point (Go markUserInterjectedOnHumanTurn).
   * @param msg - The inbound human message.
   * @param session - Background session being taken over.
   * @param sessions - Session manager persisting the flag.
   */
  markUserInterjectedOnHumanTurn(msg: Message, session: Session, sessions: SessionManager): void {
    if (msg.userID === '' || msg.isSpawnedGroup) return
    if (!this.bridge.waterfall('feishuBridge/background-session-policy', { session }, () => session.getSubtaskDepth() > 0)) return
    if (session.getUserInterjected()) return
    session.setUserInterjected(true)
    sessions.save()
    console.info(`auto-render: user took over background session; render re-enabled (${msg.sessionKey})`)
  }

  /**
   * A subtask session's interactive state was cleaned up without the subtask
   * reporting — send a synthetic failure notification so the parent does not
   * wait forever (Go reportSubtaskTimeout, wired on the stall-kill,
   * hard-cap, send-failure, and channel-closed paths). A user takeover
   * (stopped turn) suppresses it: the human drives that chat now and a later
   * human turn re-arms the report.
   * @param sessionKey - Session key of the timed-out child.
   */
  reportSubtaskTimeout(sessionKey: string): void {
    const sess = this.sessions.getOrCreateActive(sessionKey)
    if (sess.getSubtaskDepth() <= 0 || sess.getSubtaskReported() || sess.getSubtaskAutoReportSuppressed()
      || sess.getParentSessionKey() === '') return

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

    const failureMsg = this.i18n.t(Msg.SubtaskTimeout)
    if (this.replyToParent(p, sess, failureMsg)) {
      sess.setSubtaskReported(true)
      this.sessions.save()
      console.info(`subtask: reported timeout failure to parent (child=${sess.id})`)
    }
  }

  /**
   * Gather barrier fallback timeout (Go subtaskGatherTimeoutDuration).
   * @returns The configured timeout in ms, or the 20m default.
   */
  subtaskGatherTimeoutDuration(): number {
    return this.subtaskGatherTimeout > 0 ? this.subtaskGatherTimeout : defaultSubtaskGatherTimeout
  }

  /**
   * Install a fan-in barrier on the parent session so reports from its
   * in-flight children accumulate and the parent is woken EXACTLY ONCE with
   * the full set (or partial on timeout) (Go GatherSubtasks).
   *
   * The expected set holds only children that can settle the barrier: every
   * subtask report path requires subtask depth, and feature role groups
   * hang off their hub with parent set but no depth — their replies settle
   * through the feature's role relay, so counting them could only end at the
   * gather timeout (2026-08-26 oc_b46da incident).
   *
   * @param parentSessionKey - Session key of the gathering parent.
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
      if (s.getSubtaskDepth() <= 0) continue
      if (s.getSubtaskReported()) continue
      const ck = idToKey[s.id] ?? ''
      if (ck === '') continue
      g.expected.set(ck, true)
      g.labels.set(ck, childLabel(s))
    }
    // Native continuable children join the same barrier; their reports
    // bank through reportNativeChild → deliverParentReply's accumulate.
    for (const [childId, rec] of Object.entries(this.nativeChildEntries())) {
      if (rec.parent_key !== parentSessionKey || rec.reported) continue
      g.expected.set(childId, true)
      g.labels.set(childId, rec.label)
    }
    if (g.expected.size === 0) {
      throw new Error(this.i18n.t(Msg.SubtaskGatherNoPending))
    }
    parent.setPendingSubtaskGather(g)
    this.sessions.save()
    const timeout = this.subtaskGatherTimeoutDuration()
    g.timer = setTimeout(() => { this.fireSubtaskGatherTimeout(parentSessionKey) }, timeout)
    g.timer.unref()
    const timeoutS = Math.round(timeout / 1000)
    console.info(`subtask: gather armed on parent (parent=${parentSessionKey} expected=${g.expected.size} timeoutS=${timeoutS})`)
  }

  /**
   * Blocking variant of {@link gatherSubtasks} — the tool's synchronous
   * delivery contract: arm the barrier, then hold the calling tool call open
   * until every expected child has reported or the timeout fires, resolving
   * with the combined summary so it lands as the gather tool result inside
   * the still-open parent turn. While the call is in flight the turn stays
   * open — child activity streams on the live card (fromSubagent events) and
   * the in-flight tool call keeps the idle timer disarmed. Aborting the
   * signal (user stop, teardown) settles with an abort notice — an unsettled
   * tool promise parks the runtime turn forever — and drops the waiter so
   * later reports fall back to the async wake path: collected results are
   * not lost.
   * @param parentSessionKey - Session key of the gathering parent.
   * @param signal - Abort signal of the calling tool call; aborting settles with an abort notice and falls back to the async wake path.
   * @returns The combined summary (timeout appends the missing-children preamble).
   */
  async gatherSubtasksBlocking(parentSessionKey: string, signal?: AbortSignal): Promise<string> {
    this.gatherSubtasks(parentSessionKey)
    const parent = this.sessions.getOrCreateActive(parentSessionKey)
    return await new Promise<string>((resolve) => {
      parent.setGatherWaiter(resolve)
      signal?.addEventListener('abort', () => {
        // The tool call is gone; later reports must fall back to the async
        // wake instead of a waiter nobody awaits — but the promise still
        // settles, or the parked runtime turn can never end, quiescence is
        // unreachable, and the session leaks live in the runtime registry
        // (2026-08-26 oc_b46da incident).
        if (parent.getGatherWaiter() === resolve) parent.setGatherWaiter(undefined)
        resolve(this.i18n.t(Msg.SubtaskGatherAborted))
      }, { once: true })
    })
  }

  /**
   * Complete an armed gather: resolve the blocking waiter (the summary lands
   * as the gather tool result in the still-open turn) or, without one, inject
   * the synthetic [子任务汇总] wake message (Go wakeParentWithGather).
   * @param parentSess - The gathering parent session carrying the waiter.
   * @param parentKey - Session key of the parent, for the wake path.
   * @param summary - The combined summary text.
   */
  private resolveOrWakeGather(parentSess: Session, parentKey: string, summary: string): void {
    const waiter = parentSess.getGatherWaiter()
    if (waiter !== undefined) {
      parentSess.setGatherWaiter(undefined)
      waiter(summary)
      console.info(`subtask: blocking gather resolved in-turn (parent=${parentKey})`)
      return
    }
    this.wakeParentWithGather(parentKey, summary)
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
        this.deliverMachineMessage(p, {
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
    this.resolveOrWakeGather(parent, parentKey, summary)
    console.info(`subtask: gather timed out; woke parent with partial results (parent=${parentKey})`)
  }

  /**
   * Session keys of all descendants of rootKey, deepest-first so a caller
   * can tear children down before parents. rootKey itself is excluded; a
   * visited set guards against cycles (Go collectSubtree).
   * @param rootKey - Session key whose descendants are collected.
   * @returns Descendant session keys, deepest-first.
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
   * @param p - Platform delivering the card and wake message.
   * @param sess - Child session carrying the parent link.
   * @param content - Result content to push.
   * @returns True when the delivery was initiated.
   */
  replyToParent(p: Platform, sess: Session, content: string): boolean {
    const parentKey = sess.getParentSessionKey()
    if (parentKey === '' || content.trim() === '') return false
    const r = asReplyContextReconstructor(p)
    if (r === undefined) return false
    const childKey = this.sessions.sessionKeyMap().idToKey[sess.id] ?? ''
    void r.reconstructReplyCtx(parentKey).then(
      (parentRctx) => {
        void this.deliverParentReply(p, parentKey, childKey, childLabel(sess), parentRctx, content, false)
      },
      (error: unknown) => {
        console.warn(`replyToParent: reconstruct reply ctx failed (parent=${parentKey}): ${String(error)}`)
      },
    )
    return true
  }

  /**
   * Async half of {@link replyToParent} and {@link replyNativeToParent} once
   * the parent reply ctx resolved. The child arrives as its key and label
   * only, so group children and native continuable children share one
   * delivery machine. `silentCard` (unattended native settlements under
   * features.subtaskQuiet) skips the user-visible card; the parent-agent
   * wake below is always delivered — through {@link deliverMachineMessage},
   * so a busy parent turn receives it mid-turn instead of queueing it behind
   * itself.
   */
  private async deliverParentReply(
    p: Platform,
    parentKey: string,
    childKey: string,
    label: string,
    parentRctx: unknown,
    content: string,
    silentCard: boolean,
  ): Promise<void> {
    // A blocking gather holds the parent turn open with the child activity
    // already streaming on its live card; per-child settlement cards would
    // only duplicate that stream. Non-creating lookup stays: a dangling
    // parent key must not mint a phantom session.
    const parentSess = this.sessions.findActive(parentKey)
    const waiterArmed = parentSess?.getGatherWaiter() !== undefined
    if (!silentCard && !waiterArmed) {
      await this.sendAsCard(p, parentRctx, content, {
        title: this.i18n.tf(Msg.DoneReplyParentHeader, label),
        color: 'indigo',
      })
    }

    // Monitor-mode parent: the monitored chat has no interactive agent —
    // post the card only, never inject the wake message.
    if (parentSess === undefined) {
      console.warn(`subtask: parent session missing, card delivered without wake (parent=${parentKey} child=${childKey})`)
      return
    }
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
    const g = parentSess.getPendingSubtaskGather()
    if (g !== undefined) {
      const { done, summary, alreadyWoken } = g.accumulate(childKey, label, content)
      if (done) {
        parentSess.setPendingSubtaskGather(undefined)
        this.sessions.save()
        this.resolveOrWakeGather(parentSess, parentKey, summary)
        return
      }
      if (!alreadyWoken) return // banked; parent woken once when all report
      // Barrier already completed but not yet cleared — fall through to a
      // normal wake so this late report is not lost.
    }

    // The card body stays clean; the synthetic message the parent agent sees
    // carries a hint with the child's session key so it can follow up via
    // the subtask tool even after context compaction.
    let agentContent = `[子任务完成] ${label}:\n\n${content}`
    if (childKey !== '') {
      agentContent += `\n\n(如需追问该子任务: feishu_bridge_subtask 工具 action: send, child: ${childKey})`
    }
    this.deliverMachineMessage(p, {
      ...emptyMessage(),
      sessionKey: parentKey,
      platform: p.name(),
      userName: '[子任务]',
      content: agentContent,
      replyCtx: parentRctx,
    })
  }

  /**
   * Config-driven monitor chat check (Go isMonitorChat).
   * @param msg - Message whose session key is checked against the allowlist.
   * @returns True when the chat is a monitored chat.
   */
  isMonitorChat(msg: Message): boolean {
    if (!this.monitor.enabled) return false
    const chats = this.monitor.chatsVal()
    if (chats === '') return false
    const chatID = chatIDFromSessionKey(msg.sessionKey, msg.platform)
    if (chatID === '') return false
    return AllowList(chats, chatID)
  }

  /**
   * Set the monitor chat list (Go setMonitorChats; runtime application goes through MonitorCore).
   * @param chats - Allowlist of monitored chat IDs.
   */
  setMonitorChats(chats: string): void {
    this.monitor.setChats(chats)
  }

  // ──────────────────────────────────────────────────────────────
  // M4: group-name generation (Go engine_predict.go + engine_events.go)
  // ──────────────────────────────────────────────────────────────

  /**
   * Configure LLM group-name generation (Go SetGroupNameConfig).
   * @param enabled - Whether LLM naming runs for spawned groups.
   * @param provider - Provider route for naming queries.
   * @param timeoutMs - Query deadline in ms; 0 = 30s default.
   * @param prompt - Custom prompt template; '' = the default template.
   */
  setGroupNameConfig(enabled: boolean, provider: string, timeoutMs: number, prompt: string): void {
    this.groupNameEnabled = enabled
    this.groupNameProvider = provider
    this.groupNameTimeout = timeoutMs
    this.groupNamePrompt = prompt
  }

  /**
   * Toggle the group-icon avatar follow-up after rename (Go SetGroupNameAvatarEnabled).
   * @param enabled - Whether the LLM's icon is stamped as the avatar.
   */
  setGroupNameAvatarEnabled(enabled: boolean): void {
    this.groupNameSetAvatar = enabled
  }

  /**
   * Mark a manual rename inside the async LLM window (Go markPendingRename).
   * @param sessionKey - Session key of the manually renamed group.
   */
  markPendingRename(sessionKey: string): void {
    this.pendingRename.add(sessionKey)
  }

  /**
   * Consume the manual-rename mark (Go clearPendingRename).
   * @param sessionKey - Session key whose pending-rename mark is removed.
   */
  clearPendingRename(sessionKey: string): void {
    this.pendingRename.delete(sessionKey)
  }

  /**
   * Whether a manual rename is pending for the session (Go hasPendingRename).
   * @param sessionKey - Session key to check.
   * @returns True when a manual rename is pending.
   */
  hasPendingRename(sessionKey: string): boolean {
    return this.pendingRename.has(sessionKey)
  }

  /**
   * Snapshot of recently used group icons, oldest first (Go recentGroupIcons).
   * @returns The recent-icon ring buffer as an array.
   */
  recentGroupIcons(): string[] {
    return [...this.recentIcons]
  }

  /**
   * Record an icon into the recent ring buffer; empty and duplicates ignored (Go recordGroupIcon).
   * @param icon - Lucide icon name to record.
   */
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
   * @param seed - First message the name is derived from.
   * @returns The full prompt for the naming query.
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
   * @param seed - First message the name is derived from.
   * @param signal - Aborts the query; the caller owns the deadline.
   * @returns The generated [name, icon] pair.
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
   * @param p - Platform the group lives on.
   * @param sessionKey - Session key of the spawned group.
   * @param firstMessage - First message used as the naming seed.
   * @param interactiveKey - Interactive-state slot key of the group.
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
  private async handleSpawnedGroupFirstMessage(p: Platform, msg: Message, session: Session): Promise<void> {
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
    // First message = the chat's session has no conversation window yet. The
    // agent session for this message does not exist before the interactive
    // state is created, so an absent/empty live window is exactly "first".
    if (this.bridge.waterfall('feishuBridge/rename-exemption', { session }, () => false)) return
    if ((await this.recentTurnsOf(msg.sessionKey, session, 1)).length > 0) return
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
   * Rename the user's own hub group to the given topic (sync fallback),
   * then overwrite with a concise LLM name a few seconds later (Go
   * renameHubToTopic). With set_avatar on, the LLM's icon is stamped across
   * the whole family via setGroupFamilyAvatar.
   * @param p - Platform the hub group lives on.
   * @param sessionKey - Session key of the hub group.
   * @param chatType - Chat type; 'p2p' chats are skipped.
   * @param topic - Topic used as the naming seed.
   * @param childKeys - Session keys of the hub's child chats for family avatars.
   * @param namer - Derives the sync-fallback hub name from the topic
   *   (the feature owning the hub supplies its own naming rule).
   */
  renameHubToTopic(
    p: Platform,
    sessionKey: string,
    chatType: string,
    topic: string,
    childKeys: string[],
    namer: (topic: string) => string,
  ): void {
    if (chatType === 'p2p') return
    const renamer = asGroupRenamer(p)
    if (renamer === undefined) return
    const name = namer(topic)
    // Synchronous fallback: rename the hub to the topic text immediately.
    void renamer.renameGroupAny(sessionKey, name).catch((error: unknown) => {
      console.warn(`engine: failed to rename hub group to topic (${sessionKey}): ${String(error)}`)
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
        const setter = asGroupFamilyAvatarSetter(p)
        if (setter === undefined) return
        try {
          await setter.setGroupFamilyAvatar(sessionKey, capturedChildren, icon, hubName)
          this.recordGroupIcon(icon)
        } catch (error) {
          console.warn(`engine: set family avatar failed (hub=${sessionKey}): ${String(error)}`)
        }
      } catch (error) {
        console.warn(`engine: group-name LLM rename failed (${sessionKey}): ${String(error)}`)
      } finally {
        clearTimeout(timer)
      }
    })()
  }

  // ──────────────────────────────────────────────────────────────
  // M4: spawn-notify / worktree cards + platform helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Chat-jump URL for chatID when the platform can produce one (Go chatJumpURL).
   * @param p - Platform that builds the URL; undefined yields ''.
   * @param chatID - Chat the URL points at.
   * @returns The jump URL, or '' when the platform cannot produce one.
   */
  chatJumpURL(p: Platform | undefined, chatID: string): string {
    if (p === undefined) return ''
    return asChatJumpURLer(p)?.chatJumpURL(chatID) ?? ''
  }

  /**
   * Build the spawn/fork readiness card (Go buildSpawnNotifyCard, purple
   * header): the full status footer elements plus the note and jump links.
   * @param workDir - Working directory shown on the card footer.
   * @param fallbackTitle - Title used when the footer provides no header suffix.
   * @param extraNote - Extra markdown appended after the footer elements.
   * @param jumpMD - Jump links folded into the collapsible panel.
   * @param sessionKey - Session key shown on the card footer.
   * @returns The assembled card.
   */
  async buildSpawnNotifyCard(
    workDir: string,
    fallbackTitle: string,
    extraNote: string,
    jumpMD: CardMarkdownLike,
    sessionKey: string = '',
  ): Promise<Card> {
    const { headerSuffix, elements } = await this.buildStatusFooterElements(this.agent, workDir, '', sessionKey)
    const title = headerSuffix !== '' ? headerSuffix : fallbackTitle
    const builder = newCard().title(title, 'purple')
    let els = elements
    if (extraNote !== '') els = [...els, { kind: 'markdown', content: extraNote }]
    if (jumpMD.content !== '') {
      // Jump links fold into the collapsible panel — feishu does not fold
      // column_set/button rows, so they stay markdown (Go mirrors).
      els = appendIntoLastCollapsible(els, { kind: 'markdown', content: jumpMD.content })
    }
    if (els.length === 0 && workDir !== '') {
      // No footer state at all: keep the minimal workdir note.
      return builder.note(`📁 ${workDir}`).build()
    }
    return builder.raw(...els).build()
  }

  /**
   * Send content as a card with the given header, falling back to bold-title
   * plain text when the platform has no card support or the card send fails
   * (Go sendAsCard).
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param content - Markdown body of the card.
   * @param header - Card title and color.
   */
  async sendAsCard(p: Platform, replyCtx: unknown, content: string, header: CardHeader): Promise<void> {
    await this.sendAsCardWithButtons(p, replyCtx, content, header, [])
  }

  /**
   * sendAsCard plus an optional row of buttons appended after the markdown
   * body (Go sendAsCardWithButtons). Monitor spawn/coalesce notices use it
   * for their jump buttons; the plain-text fallback keeps the header title.
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param content - Markdown body of the card.
   * @param header - Card title and color.
   * @param buttons - Buttons appended after the body; empty renders none.
   */
  async sendAsCardWithButtons(p: Platform, replyCtx: unknown, content: string, header: CardHeader, buttons: CardButton[]): Promise<void> {
    const cs = asCardSender(p)
    if (cs !== undefined) {
      const builder = newCard().title(header.title, header.color).markdown(content)
      if (buttons.length > 0) builder.buttons(...buttons)
      const card = builder.build()
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

  /**
   * Render a card through the CardSender path with a plain-text fallback (Go replyWithCard).
   * @param p - Platform the card is sent to.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param card - Card to deliver.
   */
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

  /**
   * The /done Keep/Remove prompt card for a dirty worktree (Go renderWorktreeCard).
   * @param sessionKey - Session whose worktree the card describes.
   * @returns The assembled prompt card.
   */
  renderWorktreeCard(sessionKey: string): Card {
    const [path, branch] = this.sessions.getOrCreateActive(sessionKey).getWorktreeInfo()
    let md = this.i18n.tf(Msg.WorktreeDirtyPrompt, branch, path)
    const memDir = this.resolveOrphanMemoryDir(path)
    if (memDir !== '') {
      md += `\n${this.i18n.tf(Msg.WorktreeMemoryWarn, joinPath(memDir, 'memory'))}`
    }
    return newCard()
      .title(this.i18n.t(Msg.WorktreeCardTitle), 'orange')
      .markdown(md)
      .buttons(
        { text: this.i18n.t(Msg.WorktreeKeepBtn), type: 'default', value: 'act:/wt keep' },
        { text: this.i18n.t(Msg.WorktreeRemoveBtn), type: 'danger', value: 'act:/wt remove' },
      )
      .build()
  }

  /**
   * Terminal card after the user picks keep/remove (Go renderWorktreeDoneCard).
   * @param action - Chosen action; a 'remove' prefix renders the removed text.
   * @param memNote - Orphan-memory note appended when non-empty.
   * @returns The assembled terminal card.
   */
  renderWorktreeDoneCard(action: string, memNote: string): Card {
    let msg = this.i18n.t(Msg.WorktreeKept)
    if (action.startsWith('remove')) msg = this.i18n.t(Msg.WorktreeRemovedShort)
    if (memNote !== '') msg += `\n${memNote}`
    return newCard().title(this.i18n.t(Msg.WorktreeCardTitle), 'turquoise').markdown(msg).build()
  }

  /**
   * Handle the keep/remove choice from the worktree prompt card (Go
   * executeWorktreeAction). Card-action routing arrives with the Wave-2
   * integration; the engine-side action execution is this method.
   * @param sessionKey - Session owning the worktree.
   * @param args - Action argument: 'keep' or 'remove'.
   * @returns The orphan-memory note for the terminal card, '' when none applies.
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
        return memDir !== '' ? this.i18n.tf(Msg.WorktreeOrphanKept, memDir) : ''
      }
      sess.setWorktreeInfo('', '', '', '', '')
      this.sessions.save()
      const cleaned = removeOrphanMemory(memDir === '' ? '' : memDir)
      if (cleaned !== '') return this.i18n.tf(Msg.WorktreeOrphanCleaned, cleaned)
      return ''
    }
    // keep: folder stays on disk → memory stays.
    sess.setWorktreeInfo('', '', '', '', '')
    this.sessions.save()
    return memDir !== '' ? this.i18n.tf(Msg.WorktreeOrphanKept, memDir) : ''
  }

  /**
   * Handle one card-button action dispatched by a platform (Go handleCardNav,
   * M4 subset: the worktree Keep/Remove card and the /dir picker card).
   * `action` is the full act:/nav: value; `act:` runs the command's side
   * effect and the pressed card is replaced in place via the platform's card
   * refresher (falling back to a new card), while `nav:` only re-renders
   * (Go handleCardNav's prefix split). Other commands are consumed silently —
   * their render domains arrive with later milestones.
   * @param p - Platform the card action arrived on.
   * @param msg - The card-action message.
   * @param action - Full act:/nav: value carried by the pressed button.
   */
  async handleCardAction(p: Platform, msg: Message, action: string): Promise<void> {
    // Any card-button click means the user is back — abort in-flight HTML
    // renders (Go handleCardNav's cancelRenders).
    cancelRenders(this.interactiveStates.get(msg.sessionKey))
    const colonIdx = action.indexOf(':')
    if (colonIdx === -1) return
    const prefix = action.slice(0, colonIdx)
    if (prefix !== 'act' && prefix !== 'nav') return
    const body = action.slice(colonIdx + 1)
    const spaceIdx = body.indexOf(' ')
    const cmd = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
    const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim()
    if (cmd === '/cron') {
      // Cron card buttons only flip scheduler state; no card is re-rendered
      // (Go executeCardAction's "/cron" case returns an empty string).
      if (prefix === 'act') executeCardAction(this, cmd, args, msg.sessionKey)
      return
    }

    if (cmd === '/help') {
      const card = renderHelpGroupCard(this, args)
      await this.refreshOrReplyCard(p, msg, card)
      return
    }

    if (cmd === '/list') {
      const page = parsePositiveInt(args)
      await this.refreshOrReplyCard(p, msg, await renderListCardSafe(this, msg.sessionKey, page))
      return
    }

    if (cmd === '/status') {
      await this.refreshOrReplyCard(p, msg, await renderStatusCard(this, msg.sessionKey, msg.userID))
      return
    }

    if (cmd === '/switch') {
      // act:/switch runs the session swap (Go executeCardAction's "/switch"
      // case: cleanup interactive state and switch — the fresh session needs
      // no history reset), then re-renders the list card; nav:/switch just
      // shows the picker.
      if (prefix === 'act' && args !== '') {
        const { agent, sessions, interactiveKey } = commandContext(this, msg)
        const agentSessions = await collectAgentSessions(this, msg.sessionKey)
        const matched = agentSessions === undefined ? undefined : matchSession(agentSessions, sessions, args)
        if (matched !== undefined) {
          this.stopInteractiveSession(interactiveKey)
          sessions.switchToAgentSession(msg.sessionKey, matched.id, agent.name(), matched.summary)
        } else {
          console.info(`engine: switch card action matched no session (${msg.sessionKey}: ${args})`)
        }
      }
      await this.refreshOrReplyCard(p, msg, await renderListCardSafe(this, msg.sessionKey, 1))
      return
    }

    if (cmd === '/delete-mode') {
      // Every action runs the state machine first, then re-renders the
      // phase's card; cancel clears the picker, so the missing card falls
      // back to the session list (Go handleCardNav's "/delete-mode" routes).
      if (prefix === 'act') executeDeleteModeAction(this, msg.sessionKey, args, p, msg.replyCtx)
      const card = await renderDeleteModeCard(this, msg.sessionKey)
      if (card !== undefined) {
        await this.refreshOrReplyCard(p, msg, card)
        return
      }
      await this.refreshOrReplyCard(p, msg, await renderListCardSafe(this, msg.sessionKey, 1))
      return
    }

    if (cmd === '/dir') {
      // act:/dir switches first (select N / reset / prev, Go executeCardAction
      // mapping); nav:/dir only turns the page.
      let notice = ''
      let page = 1
      if (prefix === 'act') {
        const fields = args.split(/\s+/).filter(f => f !== '')
        const sub = fields[0] ?? ''
        let applyArgs: string[] | undefined
        if (sub === 'select' && fields.length >= 2) applyArgs = [fields[1] ?? '']
        else if (sub === 'reset') applyArgs = ['reset']
        else if (sub === 'prev') applyArgs = ['-']
        if (applyArgs !== undefined) {
          const { agent, sessions, interactiveKey } = commandContext(this, msg)
          const [errMsg] = await dirApply(this, agent, sessions, interactiveKey, msg.sessionKey, applyArgs)
          if (errMsg !== '') {
            console.info(`engine: dir card action failed (${msg.sessionKey}): ${errMsg}`)
          } else {
            notice = this.i18n.t(Msg.DirSessionReset)
          }
        }
      } else {
        const n = Number.parseInt(args, 10)
        if (Number.isInteger(n) && n > 0) page = n
      }
      const card = renderDirCardSafe(this, msg.sessionKey, page, notice)
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
      return
    }

    // Registered card actions: run the feature's state machine and re-render
    // the pressed card in place (Go handleCardNav's feature routes; feature
    // card pickers register through registerCardAction).
    const cardAction = this.cardActionHandlers.get(cmd)
    if (cardAction !== undefined) {
      const card = cardAction(msg.sessionKey, cmd, args)
      if (card !== undefined) {
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
      return
    }
    // Background-subtask panel's Stop-all button: interrupt every unreported
    // native child of this chat. The interrupts flip the reported flags, so
    // the next panel tick finalizes the card to its done state.
    if (cmd === '/subtask-panel') {
      if (prefix === 'act' && args === 'stop') {
        for (const [childId, rec] of Object.entries(this.nativeChildEntries())) {
          if (rec.parent_key !== msg.sessionKey || rec.reported) continue
          try {
            this.interruptNativeChild(childId)
          } catch (error) {
            console.warn(`subtask: panel stop interrupt failed (child=${childId}): ${String(error)}`)
          }
        }
      }
      return
    }

    // Predict-next 屏蔽 button (#33): stop predicting for this session until
    // /new, then re-render the pressed card as the confirmation.
    if (cmd === '/nopred') {
      this.setPredictNextDisabled(msg.sessionKey)
      const card = newCard().title('🚫 已屏蔽猜你想问', 'red').markdown('本会话不再显示预测卡片。`/new` 后恢复。').build()
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

  /**
   * PATCH the card a card-action callback arrived on in place, falling back
   * to sending a new card when the platform cannot refresh (the pattern
   * every handleCardAction branch shares).
   * @param p - Platform the card action arrived on.
   * @param msg - The card-action message addressing the chat.
   * @param card - The replacement card.
   */
  private async refreshOrReplyCard(p: Platform, msg: Message, card: Card): Promise<void> {
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

  /**
   * Resolve the agent's orphan project-data dir for a worktree path (Go resolveOrphanMemoryDir).
   * @param worktreePath - Worktree whose orphan memory dir is resolved.
   * @returns The dir with content, or '' when none applies.
   */
  resolveOrphanMemoryDir(worktreePath: string): string {
    const r = asWorktreeOrphanResolver(this.agent)
    if (r === undefined) return ''
    const dir = r.orphanProjectDir(worktreePath)
    if (dir === undefined || dir === '') return ''
    if (!memoryHasContent(dir)) return ''
    return dir
  }

  /**
   * Resolve and delete the orphan memory for a worktree path (Go cleanupWorktreeOrphanMemory).
   * @param worktreePath - Worktree whose orphan memory dir is deleted.
   * @returns The removed dir, or '' when nothing was cleaned.
   */
  cleanupWorktreeOrphanMemory(worktreePath: string): string {
    const dir = this.resolveOrphanMemoryDir(worktreePath)
    if (dir === '') return ''
    return removeOrphanMemory(dir)
  }

  /**
   * Remove the worktree owned by sessionKey, clear the session's worktree
   * metadata, and report the outcome (Go finishWorktreeRemoval).
   * @param p - Platform the outcome is reported on.
   * @param replyCtx - Platform reply context addressing the chat.
   * @param sessionKey - Session owning the worktree.
   * @param force - Whether the removal ignores uncommitted changes.
   * @param mergedInto - Integration branch the commits already landed in; ''
   * reports the plain removal message instead of the merged variant.
   */
  async finishWorktreeRemoval(p: Platform, replyCtx: unknown, sessionKey: string, force: boolean, mergedInto: string = ''): Promise<void> {
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
    sess.setWorktreeInfo('', '', '', '', '')
    this.sessions.save()
    if (err !== undefined) {
      console.warn(`worktree removal failed; cleared session fields anyway (${sessionKey} ${path}): ${errorMessage(err)}`)
      let msg = this.i18n.tf(Msg.WorktreeCreateError, errorMessage(err))
      if (memDir !== '') msg += `\n${this.i18n.tf(Msg.WorktreeOrphanKept, memDir)}`
      await this.reply(p, replyCtx, msg)
      return
    }
    let msg = mergedInto !== ''
      ? this.i18n.tf(Msg.WorktreeRemovedMerged, mergedInto, branch)
      : this.i18n.tf(Msg.WorktreeRemoved, branch)
    const cleaned = removeOrphanMemory(memDir === '' ? '' : memDir)
    if (cleaned !== '') msg += `\n${this.i18n.tf(Msg.WorktreeOrphanCleaned, cleaned)}`
    await this.reply(p, replyCtx, msg)
  }

  /**
   * Restore a /done'd spawned group's baseline-phase avatar on the next
   * message when the platform reports it inactive (Go
   * reactivateSpawnedChatAvatar). The active-check guard keeps idempotent
   * resumes from spamming avatar-update system messages.
   * @param p - Platform owning the spawned chat's avatar.
   * @param sessionKey - Session key of the spawned chat.
   */
  async reactivateSpawnedChatAvatar(p: Platform, sessionKey: string): Promise<void> {
    const checker = asSpawnedChatActiveChecker(p)
    const painter = asChatPhasePainter(p)
    if (checker === undefined || painter === undefined) return
    if (checker.isSpawnedChatActive(sessionKey)) return
    try {
      await painter.setChatPhase(sessionKey, painter.chatBasePhase(sessionKey))
    } catch (error) {
      console.warn(`reactivate avatar failed (${sessionKey}): ${String(error)}`)
    }
  }

  /**
   * Apply a lifecycle phase to the chat's avatar (ChatPhasePainter).
   * Best-effort: platforms without the capability, non-spawned chats, and
   * same-key transitions all no-op; failures degrade to a warn. A chat with
   * an outstanding /done mark ignores every engine-driven repaint (ask
   * settlement, turn-end baselines, stall) — the gray terminal phase is the
   * user's explicit verdict and survives until /undone or message-driven
   * reactivation, which paint through the platform directly.
   * @param p - Platform owning the chat's avatar.
   * @param sessionKey - Session key of the chat.
   * @param phase - Lifecycle phase to paint.
   */
  async applyChatPhase(p: Platform, sessionKey: string, phase: ChatPhase): Promise<void> {
    const painter = asChatPhasePainter(p)
    if (painter === undefined) return
    const checker = asSpawnedChatActiveChecker(p)
    if (phase !== 'done' && checker !== undefined && checker.isSpawnedChatDone(sessionKey)) return
    try {
      await painter.setChatPhase(sessionKey, phase)
    } catch (error) {
      console.warn(`set chat phase failed (${sessionKey}, ${phase}): ${String(error)}`)
    }
  }

  /**
   * The chat's baseline phase — the target overlays return to. Defaults to
   * `discussing` when the platform cannot report it (legacy/unregistered).
   * @param p - Platform owning the chat's avatar.
   * @param sessionKey - Session key of the chat.
   * @returns The baseline phase.
   */
  chatBasePhase(p: Platform, sessionKey: string): ChatBasePhase {
    return asChatPhasePainter(p)?.chatBasePhase(sessionKey) ?? 'discussing'
  }

  /**
   * Mark a spawned chat done on the platform side (avatar axis owner).
   * Awaits the platform so the terminal mark is observable before callers
   * release stop-triggered late settlements.
   * @param p - Platform owning the spawned chat's state.
   * @param sessionKey - Session key of the spawned chat.
   */
  async markSpawnedChatDone(p: Platform, sessionKey: string): Promise<void> {
    await asSpawnedChatStateUpdater(p)?.markSpawnedChatDone(sessionKey)
  }

  /**
   * Add an emoji reaction to the replied message when the platform can (Go AddReaction probe).
   * @param p - Platform the reaction is added on.
   * @param replyCtx - Platform reply context identifying the message.
   * @param emoji - Emoji name to react with.
   */
  addReaction(p: Platform, replyCtx: unknown, emoji: string): void {
    asReactionAdder(p)?.addReaction(replyCtx, emoji)
  }
}
