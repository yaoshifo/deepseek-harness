/**
 * Core interface model ported from cc-connect core/interfaces.go and
 * core/message.go: Platform, Agent, AgentSession, Message, Event. M1 carries
 * the base set only; optional capability interfaces arrive with the
 * milestones that port their tests (cards → M2, approval → M3, …).
 *
 * Go's optional-capability interface checks (`if cs, ok := p.(CardSender)`)
 * become structural checks on optional methods (`isCardSender(p)` guards in
 * the engine). The `compaction`/`todo_update` event kinds carry the native
 * dsh signals (compaction lifecycle, todo snapshots) the Go bridge had to
 * mine from stream-json text.
 *
 * @module dsh-feishu-bridge/core-types
 */

import type { ProgressCardPayload, TodoItem } from '../progress.ts'
import type { ContextSnapshotValues } from '../context/types.ts'
import type { I18n } from '../i18n/index.ts'

/** Sentinel AgentSessionID telling the agent to resume the most recent session. */
export const ContinueSession = '__continue__'

/** Marks an AgentSessionID that should resume with a forked transcript. */
export const ForkSessionPrefix = '__fork__'

/** Marks a session resuming from a truncated (rollback) transcript. */
export const ForkAtSessionPrefix = '__forkat__'

/** Platform operation not supported by this implementation. */
export class ErrNotSupported extends Error {
  constructor(operation = 'operation not supported by this platform') {
    super(operation)
    this.name = 'ErrNotSupported'
  }
}

/** Image attachment bytes sent by the user. */
export interface ImageAttachment {
  mimeType: string
  data: Uint8Array
  fileName?: string
}

/** File attachment bytes sent by the user. */
export interface FileAttachment {
  mimeType: string
  data: Uint8Array
  fileName: string
}

/**
 * The default Feishu Wiki/Drive location this project's bot operates in
 * (Go FeishuWorkspaceInfo, #18). Non-empty fields surface as the CC_FEISHU_*
 * lines of the session's workspace routing section, scoping doc
 * search/creation to this location.
 */
export interface FeishuWorkspaceInfo {
  wikiSpaceId: string
  folderToken: string
  wikiNodeToken: string
  description: string
}

/** One turn in a conversation history (timestamp is an ISO string, like Go time.Time's JSON form). */
export interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

/** A session as reported by the agent backend (for /list, /switch). */
export interface AgentSessionInfo {
  id: string
  summary: string
  messageCount: number
  modifiedAt: number
}

/** One choice in a UserQuestion (Go UserQuestionOption). */
export interface UserQuestionOption {
  label: string
  description: string
  /** Presentation flag: multi-select cards render this option pre-checked. */
  recommended?: boolean
}

/** A structured question from AskUserQuestion (Go UserQuestion). */
export interface UserQuestion {
  /** Caller-stable question id echoed in the answer; defaults to the question text. */
  id?: string
  question: string
  header: string
  options: UserQuestionOption[]
  multiSelect: boolean
}

/**
 * One interactive ask delegated to the engine's `askUser` (B2): render ONE
 * card and await the user's decision. Permission asks carry the native
 * `ApprovalRequest` preview (`toolInput`, falling back to `reason`);
 * plan-review asks carry the plan text from the userQuestions intent.
 */
export type AskRequest =
  | { kind: 'permission'; toolName: string; preview: string }
  | { kind: 'plan-review'; heading: string; plan: string }
  | { kind: 'questions'; questions: UserQuestion[] }

/** One answered question in an {@link AskDecision}. */
export interface AskDecisionAnswer {
  /** The answered question's id. */
  id: string
  /** Labels of the chosen options. */
  selected: string[]
  /** Free-text answer, absent when the answer was a selection. */
  custom?: string
}

/** The user's decision on one ask, in the native answer structures. */
export interface AskDecision {
  /** Permission verdict; `'cancelled'` when the ask withdrew. Absent on questions asks. */
  outcome?: 'allowed-once' | 'allowed-always' | 'rejected' | 'cancelled'
  /** Card-input note riding the verdict (deny reason or allow supplement). */
  note?: string
  /** Answers in question order (questions asks). */
  answers?: AskDecisionAnswer[]
}

/**
 * The engine-side ask surface: the adapter's native approval answerer and
 * userQuestions provider delegate card rendering and decision waiting here.
 * Implemented by the engine; injected at assembly time to keep the
 * engine→agent dependency one-directional.
 */
export interface AskDelegate {
  /**
   * Render one ask card and resolve with the user's decision.
   * @param sessionKey - Interactive-state slot the ask is rendered on.
   * @param request - What to ask (permission, plan review, or questions).
   * @param signal - Abort; settles the decision as cancelled.
   */
  askUser(sessionKey: string, request: AskRequest, signal?: AbortSignal): Promise<AskDecision>
}

/** One collected answer inside a parked questions ask. */
export interface PendingAskAnswer {
  selected: string[]
  custom?: string
}

/**
 * One parked ask awaiting the user's card-button or text response (B2).
 * Replaces the Go-era PendingPermission state machine: the promise lives in
 * the delegate call, and this object carries only what response routing
 * needs.
 */
export interface PendingAsk {
  /** What was asked. */
  request: AskRequest
  /** Collected answers keyed by question index (questions asks). */
  answers: Map<number, PendingAskAnswer>
  /** Settles the askUser promise; the router calls it exactly once. */
  resolve(decision: AskDecision): void
  /** Feature whole-ask timeout armed on the parked ask (cleared on settle). */
  autoTimer?: ReturnType<typeof setTimeout>
}

/** Unified incoming message from any platform (Go core.Message). */
export interface Message {
  sessionKey: string
  platform: string
  messageID: string
  userID: string
  userName: string
  chatName: string
  chatType: string
  content: string
  originalContent: string
  images: ImageAttachment[]
  files: FileAttachment[]
  extraContent: string
  replyCtx: unknown
  fromVoice: boolean
  isSpawnedGroup: boolean
  isPermissionAction: boolean
  isAskqCardAction: boolean
  /**
   * A followups suggestion-card submission (`fw:` payload from the
   * `fw_multi:` form): the content is a machine-parsed selection that starts
   * a fresh turn, never an answer to a parked ask — the ask router must not
   * claim it. Optional like `machine`: a later-added routing discriminator
   * absent on ordinary messages.
   */
  isFollowupAction?: boolean
  /** A card.action.trigger button press with an act:/nav: value (M4). */
  isCardAction: boolean
  /**
   * Synthetic machine message (deliverMachineMessage: chatroom moderator
   * wake, subtask report wake). Never a human reply — the route-human-reply
   * waterfall must not claim it.
   */
  machine?: boolean
  parentMessageID: string
  quotedText: string
  /** Sender type of the quoted message ('user' | 'app'); set with quotedText. */
  quotedSenderType?: string
  /** Update time of the quoted message in unix ms (card PATCH time); /fork-rollback locator. */
  quotedUpdateTimeMs?: number
  /** Permission mode override for this message ('' = project default; Go ModeOverride). */
  modeOverride?: string
  /**
   * Opaque per-message metadata extensions, carried through the queue to
   * the drained turn and consumed at `feishuBridge/turn-start`: the feature
   * that injects a synthetic message sets its own keys (the gather-round
   * stamp and the research dispatch-defer arm are the current users).
   * Never surfaced to the agent.
   */
  metadata?: Record<string, unknown>
  /** Message creation time in seconds (Go CreateTime); 0/undefined when unknown. */
  createTime?: number
}

/** Agent output event kinds (Go EventType). M1 handles text/thinking/tool/result/error. */
export type EventKind =
  | 'text'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'thinking'
  | 'subagent_status'
  | 'compaction'
  | 'todo_update'
  | 'skill_invocation'

/** A single piece of agent output streamed to the engine (Go Event). */
export interface Event {
  type: EventKind
  /** Event payload text; on `skill_invocation` events it is the loaded skill's name. */
  content: string
  toolName?: string
  toolInput?: string
  toolInputRaw?: Record<string, unknown>
  toolResult?: string
  /** Tool result success; absent means success (emitters without failure identity). */
  toolSuccess?: boolean
  toolID?: string
  done: boolean
  error?: Error
  errorText?: string
  /**
   * Token usage for this event: on `text`/`thinking` events it is the
   * per-request usage of the assistant message that carried it; on `result`
   * events it is the turn sum. Undefined means unreported.
   */
  inputTokens?: number
  /** Input tokens including cache reads/writes; same split as {@link inputTokens}. */
  totalInputTokens?: number
  /** Output tokens; same split as {@link inputTokens}. */
  outputTokens?: number
  /** API calls made this turn (result events). */
  numTurns?: number
  /** Whole-list todo snapshot carried by a `todo_update` event. */
  todos?: TodoItem[]
  /** True when the event projects a delegated subagent child session's activity. */
  fromSubagent?: boolean
  /**
   * True for a `tool_use` whose arguments set `run_in_background` (e.g. a
   * long Bash deploy): the call returns immediately and the task's real
   * completion arrives as a later engine-woken turn.
   */
  toolBackground?: boolean
}

/**
 * Whether content is a /monitor command — exact word, not /monitoring (Go core.IsMonitorCommand).
 *
 * @param content - the message text to test.
 * @returns whether the trimmed text is the /monitor word, optionally followed by arguments.
 */
export function isMonitorCommand(content: string): boolean {
  const c = content.trim()
  return c.startsWith('/monitor') && (c.length === 8 || c[8] === ' ')
}

/**
 * Push channel replacing Go's `<-chan Event`: buffered push, explicit close,
 * and async receive. The event loop awaits `receive()`; `drain()` discards
 * buffered events the way Go's drainEvents did.
 */
export class EventChannel {
  private queue: Event[] = []
  private closed = false
  private waiters: Array<(r: { done: false; event: Event } | { done: true }) => void> = []

  /**
   * Push one buffered event; resolves a waiting receiver immediately.
   *
   * @param event - the event to deliver to the next receiver.
   */
  push(event: Event): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ done: false, event })
    else this.queue.push(event)
  }

  /** Close the channel; pending receivers observe done once the buffer drains. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.queue.length === 0) {
      for (const waiter of this.waiters) waiter({ done: true })
      this.waiters = []
    }
  }

  /**
   * Receive the next event, or done once closed and drained. Resolving is
   * FIFO across competing receivers, mirroring Go channel semantics.
   *
   * @returns the next buffered event, or done once closed and drained.
   */
  receive(): Promise<{ done: false; event: Event } | { done: true }> {
    return this.receiveArmed().promise
  }

  /**
   * Receive with a cancel arm: unlike a bare promise, the parked waiter can
   * still be removed, so an event loop that exits without consuming never
   * steals the next event from a later receiver.
   *
   * @returns the receive promise plus its cancel arm; cancel is a no-op once
   *   the promise resolved.
   */
  receiveArmed(): { promise: Promise<{ done: false; event: Event } | { done: true }>; cancel(): void } {
    if (this.queue.length > 0) {
      return { promise: Promise.resolve({ done: false, event: this.queue.shift() as Event }), cancel: () => {} }
    }
    if (this.closed) {
      return { promise: Promise.resolve({ done: true } as const), cancel: () => {} }
    }
    let waiter!: (r: { done: false; event: Event } | { done: true }) => void
    const promise = new Promise<{ done: false; event: Event } | { done: true }>((resolve) => {
      waiter = resolve
      this.waiters.push(resolve)
    })
    let canceled = false
    const cancel = (): void => {
      if (canceled) return
      canceled = true
      const i = this.waiters.indexOf(waiter)
      if (i >= 0) this.waiters.splice(i, 1)
    }
    return { promise, cancel }
  }

  /** Discard all buffered events without waiting (Go drainEvents). */
  drain(): void {
    this.queue = []
    if (this.closed) {
      for (const waiter of this.waiters) waiter({ done: true })
      this.waiters = []
    }
  }
}

/** Called by platforms when a new message arrives (Go MessageHandler). */
export type MessageHandler = (p: Platform, msg: Message) => void

/** A messaging platform (Go Platform base interface). */
export interface Platform {
  name(): string
  start(handler: MessageHandler): Promise<void>
  reply(replyCtx: unknown, content: string): Promise<void>
  send(replyCtx: unknown, content: string): Promise<void>
  stop(): Promise<void>
}

/** A running agent session with a persistent process (Go AgentSession). */
export interface AgentSession {
  send(prompt: string, images: ImageAttachment[], files: FileAttachment[]): Promise<void>
  /**
   * Append mid-turn text to the agent's next-step inbox: the driver claims it
   * between steps, so the text reaches the model inside the running turn —
   * including while the turn waits on a permission (agent-loop steer).
   * @param prompt - The text to append; attachments never ride this path.
   */
  steer(prompt: string): void
  events(): EventChannel
  currentSessionID(): string
  alive(): boolean
  close(): Promise<void>
  /**
   * Optional: wall-clock timestamp of the newest event the agent session
   * projected from its durable event stream. Unlike the engine-side
   * `state.lastEventAt` — updated only by the pump currently receiving the
   * channel — this reflects real agent output regardless of which consumer
   * owns the channel, so a stall watchdog can distinguish a silent agent
   * from a blind pump (2026-08-25 oc_29bb incident: a degraded handoff left
   * the pump event-less while the agent streamed for the whole window).
   * @returns milliseconds since epoch of the last projected event.
   */
  lastStreamActivity?(): number
}

/**
 * Typed per-session start metadata the engine hands to
 * {@link Agent.startSession} (the replacement for the Go-era CC_* env-note
 * array): subtask child flags, a feature persona, the engine session key,
 * Feishu workspace routing, and the shared research venv. Absent groups
 * mean the plain-session path.
 */
export interface SessionStartOptions {
  /**
   * Engine session key the live agent session is bound by. Distinct from the
   * interactive-state slot key on cron new-per-run sessions, whose slot key
   * carries a `#cron:` suffix the session key must not. '' falls back to the
   * startSession sessionID.
   */
  sessionKey: string
  /**
   * Interactive-state slot key the ask surfaces (permission cards, ask cards)
   * render and route under. Set only when it differs from `sessionKey`
   * (cron new-per-run `#cron:` slots); absent = same key as `sessionKey`.
   */
  interactiveSlotKey?: string
  /** Agent-delegated subtask child persona; absent = not a subtask. */
  subtask?: {
    /** A human has spoken in the child group (keeps the normal approval path). */
    attended: boolean
    /** The child never reports back (no-report preamble). */
    noReport: boolean
    /**
     * The child is a research assistant: the research contract rides on top
     * of the report preamble. Decorated by the owning feature's
     * session-start-options listener; absent = not a research assistant.
     */
    researchAssistant?: boolean
  }
  /**
   * Whole-prompt persona for the session; absent = plain session. The
   * owning feature's session-start-options listener precomputes the prompt
   * and policy flags; the adapter only consumes them.
   */
  persona?: {
    /** Complete replacement system prompt (Go --bare persona semantics). */
    prompt: string
    /** Tool permissions auto-approve for this persona (nobody can answer the prompts). */
    bypassPermissions: boolean
    /** Mode forced over an inherited plan default; undefined keeps the adapter-computed mode. */
    forceMode: string | undefined
  }
  /**
   * Working directory for this session's native create (meta.cwd); absent
   * uses the adapter's configured global. Replaces the Go-era global
   * workDir switch around StartSession, which leaked into concurrent
   * sessions.
   */
  workDir?: string
  /**
   * Mode pinned for this chat's sessions by a /spawn --plan/--default flag;
   * absent or '' keeps the project default (config agent.mode). One-shot
   * mode overrides and the unattended-subtask bypass outrank it.
   */
  spawnMode?: string
  /** Default Feishu workspace routing (#18); absent = no routing section. */
  feishuWorkspace?: FeishuWorkspaceInfo
  /** Shared research venv root; absent = none. Inlined into the assistant preamble (no Go-era env injection exists here). */
  venv?: {
    /** venv root directory. */
    virtualEnv: string
  }
}

/** An AI coding assistant backend (Go Agent). */
export interface Agent {
  name(): string
  startSession(sessionID: string, options?: SessionStartOptions): Promise<AgentSession>
  listSessions(): Promise<AgentSessionInfo[]>
  stop(): Promise<void>
}

/**
 * Agent session whose context can be compacted on demand (Go
 * ContextCompressor, whose "/compact" message round-trip becomes a direct
 * ctx.compaction.compactNow call in the dsh adapter).
 */
export interface SessionCompressor {
  compress(signal?: AbortSignal): Promise<void>
}

/**
 * Optional: agent can delete one of its persisted sessions (Go
 * SessionDeleter). The dsh adapter does not implement it — the native
 * sessionPersistence service is append-only — so deletion falls back to the
 * bridge's own ledger until a native delete surface exists.
 */
export interface SessionDeleter {
  deleteSession(sessionID: string): Promise<void>
}

/** Optional: agent accepts a one-shot mode override consumed by the next startSession. */
export interface SessionModeInjector {
  setSessionMode(mode: string): void
}

/**
 * Structural check for the {@link SessionModeInjector} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSessionModeInjector(a: Agent): SessionModeInjector | undefined {
  const candidate = a as Partial<SessionModeInjector>
  return typeof candidate.setSessionMode === 'function' ? (candidate as SessionModeInjector) : undefined
}

/**
 * Optional: agent session supports fast user-stop cancellation of the
 * in-flight turn (Go AgentInterrupter.Interrupt). Unlike close(), it keeps
 * the session handle alive; the caller still closes afterwards.
 */
export interface AgentInterrupter {
  cancelTurn(): void
}

/**
 * Structural check for the {@link AgentInterrupter} capability.
 *
 * @param s - the agent session to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asAgentInterrupter(s: AgentSession): AgentInterrupter | undefined {
  const candidate = s as Partial<AgentInterrupter>
  return typeof candidate.cancelTurn === 'function' ? (candidate as AgentInterrupter) : undefined
}

/**
 * Optional: agent projects a session's recent conversation window (user and
 * assistant turns) from the native session log — live sessions from the
 * adapter's incrementally maintained window, cold ones from the persisted
 * log.
 */
export interface RecentTurnsReader {
  /**
   * Read a session's trailing conversation turns.
   * @param agentSessionID - the native session id to read; '' returns [].
   * @param limit - the number of trailing entries to return; <= 0 returns all.
   * @returns the trailing window entries, oldest first.
   */
  recentTurns(agentSessionID: string, limit: number): Promise<HistoryEntry[]>
}

/**
 * Structural check for the {@link RecentTurnsReader} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asRecentTurnsReader(a: Agent): RecentTurnsReader | undefined {
  const candidate = a as Partial<RecentTurnsReader>
  return typeof candidate.recentTurns === 'function' ? (candidate as RecentTurnsReader) : undefined
}

/**
 * Optional: agent drops one staged rollback-fork seed (the parent event
 * array the adapter keeps resident until the fork session plants its
 * sentinel); other agents have nothing staged and skip.
 */
export interface StagedForkSeedForgetter {
  forgetForkAtSeed(forkID: string): void
}

/**
 * Structural check for the {@link StagedForkSeedForgetter} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asStagedForkSeedForgetter(a: Agent): StagedForkSeedForgetter | undefined {
  const candidate = a as Partial<StagedForkSeedForgetter>
  return typeof candidate.forgetForkAtSeed === 'function' ? (candidate as StagedForkSeedForgetter) : undefined
}

/**
 * Optional: agent reads one native session's context-projection snapshot for
 * the /context insight card — dsh-context's timeline/headers plus
 * token-meter's pressure/breakdown/usage, as one consistent cut over the
 * live session's log.
 */
export interface ContextSnapshotReader {
  /**
   * Read the context-relevant projection values of one live native session.
   * @param agentSessionID - the native agent session id to read; '' yields undefined.
   * @returns the projection values present on that session, or undefined
   *   when the session has no live agent or the projection registry is
   *   unmounted.
   */
  contextSnapshot(agentSessionID: string): ContextSnapshotValues | undefined
}

/**
 * Structural check for the {@link ContextSnapshotReader} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asContextSnapshotReader(a: Agent): ContextSnapshotReader | undefined {
  return withMethod<ContextSnapshotReader>(a, 'contextSnapshot')
}

/**
 * Structured preview-card status carried beside display text, replacing the
 * `__cc_state__:`/`__cc_ts__:`/`__cc_tc__:` text header lines the engine-side
 * preview used to prepend.
 */
export interface ProgressStatus {
  /**
   * Card lifecycle state; "running" matches the former headerless prefix;
   * "waiting" marks a card parked on a user answer; the four settled states
   * replace that waiting header once the parked ask resolves (the user
   * answered, or the ask was cancelled).
   */
  state: 'running' | 'completed' | 'failed' | 'thinking' | 'waiting'
    | 'approved' | 'rejected' | 'answered' | 'cancelled'
  /** Timestamp (HH:MM:SS) appended to the card title; empty string omits it. */
  ts: string
  /** Tool-call count appended to the title when positive. */
  toolCallSeq: number
  /** Unreported native subtasks; positive appends a running-subtasks suffix to terminal titles. */
  pendingSubtasks?: number
}

/** Header states a card parked on an ask settles its waiting header to when the ask resolves. */
export type ParkOutcome = 'approved' | 'rejected' | 'answered' | 'cancelled'

/** Text-path preview content: a display body with an optional structured status. */
export interface TextPreviewContent {
  kind: 'text'
  text: string
  status?: ProgressStatus
  /** Background-task hint; non-terminal cards render it beside the stop button, terminal cards inside the body. */
  bgTaskHint?: string
}

/** Card-path preview content: a structured progress-card payload. */
export interface CardPreviewContent {
  kind: 'card'
  payload: ProgressCardPayload
}

/**
 * Content a preview-capable platform renders in place: a structured
 * progress-card payload, or text with an optional structured status.
 */
export type ProgressContent = TextPreviewContent | CardPreviewContent

/** Optional: platform can update a previously sent message in place (PATCH). */
export interface MessageUpdater {
  updateMessage(replyCtx: unknown, content: ProgressContent): Promise<void>
}

/**
 * Optional: platform can start a streaming preview message and return a
 * handle for subsequent in-place edits.
 */
export interface PreviewStarter {
  sendPreviewStart(replyCtx: unknown, content: ProgressContent): Promise<unknown>
}

/** Optional: platform can delete a preview message when the final reply is sent separately. */
export interface PreviewCleaner {
  deletePreviewMessage(previewHandle: unknown): Promise<void>
}

/**
 * Optional: platform keeps a per-chat activity ledger so a preview card can
 * tell — synchronously, without message-list API calls — whether a newer
 * message landed in its chat. The streaming preview consults this on its
 * content flushes and the chat-changed bump consults it before reissuing, so
 * the newest-message chat summary keeps tracking the card while a card that
 * already owns the tail is never pointlessly recalled and resent.
 */
export interface PreviewDisplacementProber {
  /**
   * @param previewHandle - Handle returned by {@link PreviewStarter.sendPreviewStart}.
   * @param sinceMs - Epoch ms the card was last sent or reissued at.
   * @returns True when a tracked message (inbound messages, non-preview
   * outbound sends, chat name/avatar-change notices) landed in the card's
   * chat after `sinceMs`; false for thread-isolated cards, whose chat is a
   * topic the root tail does not apply to.
   */
  previewDisplaced(previewHandle: unknown, sinceMs: number): boolean
}

/** Optional: platform wants the preview kept as the final delivered message. */
export interface PreviewFinishPreference {
  keepPreviewOnFinish(): boolean
}

/**
 * Optional: platform streaming-preview cards have content limits beyond the
 * core character cap (e.g. Feishu's 5-table card limit, API error 11310).
 */
export interface PreviewOverflowReporter {
  previewOverflow(content: string): boolean
}

/** Optional: platform classifies PATCH failures as transient (rate limit). */
export interface TransientPatchErrorChecker {
  isTransientPatchError(err: unknown): boolean
}

/** Optional: platform renders a terminal "stopped" card in place on user stop. */
export interface StoppedCardRenderer {
  renderStoppedCard(replyCtx: unknown, previewMsgID: unknown): Promise<void>
}

/** Optional: platform can deliver file attachments. */
export interface FileSender {
  sendFile(replyCtx: unknown, file: FileAttachment): Promise<void>
}

/** Optional: platform can send interactive cards (Go CardSender). */
export interface CardSender {
  sendCard(replyCtx: unknown, card: unknown): Promise<void>
  replyCard(replyCtx: unknown, card: unknown): Promise<void>
}

/**
 * Optional: platform can send a card and return an updatable handle, then
 * PATCH that card later (Go CardSenderWithUpdate — research progress cards).
 */
export interface CardSenderWithUpdate {
  sendCardWithHandle(replyCtx: unknown, card: unknown): Promise<unknown>
  updateCardWithHandle(handle: unknown, card: unknown): Promise<void>
}

/**
 * Optional: platform supplies the header-icon image key for live running-state
 * cards (the executing spinner). Returns '' when the platform has none.
 */
export interface LiveCardIconSource {
  liveCardIconKey(): Promise<string>
}

/**
 * Optional: platform can PATCH the card a card-action callback arrived on, so
 * an act: button press replaces its own prompt card in place (Go returns the
 * new card in the callback response; the async TS dispatch PATCHes the
 * recorded message id instead).
 */
export interface CardRefresher {
  refreshCard(sessionKey: string, card: unknown): Promise<void>
}

/** Optional: platform can send inline buttons (Go InlineButtonSender). */
export interface InlineButtonSender {
  sendWithButtons(replyCtx: unknown, content: string, buttonRows: ButtonOption[][]): Promise<void>
}

/** Clickable inline button (Go ButtonOption, re-exported from card.ts shape). */
export interface ButtonOption {
  text: string
  data: string
}

/** Optional: platform sends a brief notification after the final in-place delivery. */
export interface CompletionNotifier {
  sendCompletionNotification(replyCtx: unknown, usageMsg: string): Promise<void>
}

/** Structural checks for the M2 card capability interfaces. */
function withMethod<T>(obj: object, method: keyof T & string): T | undefined {
  return typeof (obj as Partial<T>)[method] === 'function' ? (obj as T) : undefined
}

/**
 * Structural check for the {@link MessageUpdater} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asMessageUpdater(p: Platform): MessageUpdater | undefined {
  return withMethod<MessageUpdater>(p, 'updateMessage')
}

/**
 * Structural check for the {@link PreviewStarter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asPreviewStarter(p: Platform): PreviewStarter | undefined {
  return withMethod<PreviewStarter>(p, 'sendPreviewStart')
}

/**
 * Structural check for the {@link PreviewCleaner} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asPreviewCleaner(p: Platform): PreviewCleaner | undefined {
  return withMethod<PreviewCleaner>(p, 'deletePreviewMessage')
}

/**
 * Structural check for the {@link PreviewDisplacementProber} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asPreviewDisplacementProber(p: Platform): PreviewDisplacementProber | undefined {
  return withMethod<PreviewDisplacementProber>(p, 'previewDisplaced')
}

/**
 * Structural check for the {@link PreviewFinishPreference} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asPreviewFinishPreference(p: Platform): PreviewFinishPreference | undefined {
  return withMethod<PreviewFinishPreference>(p, 'keepPreviewOnFinish')
}

/**
 * Structural check for the {@link PreviewOverflowReporter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asPreviewOverflowReporter(p: Platform): PreviewOverflowReporter | undefined {
  return withMethod<PreviewOverflowReporter>(p, 'previewOverflow')
}

/**
 * Structural check for the {@link TransientPatchErrorChecker} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asTransientPatchErrorChecker(p: Platform): TransientPatchErrorChecker | undefined {
  return withMethod<TransientPatchErrorChecker>(p, 'isTransientPatchError')
}

/**
 * Structural check for the {@link StoppedCardRenderer} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asStoppedCardRenderer(p: Platform): StoppedCardRenderer | undefined {
  return withMethod<StoppedCardRenderer>(p, 'renderStoppedCard')
}

/**
 * Structural check for the {@link FileSender} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asFileSender(p: Platform): FileSender | undefined {
  return withMethod<FileSender>(p, 'sendFile')
}

/**
 * Structural check for the {@link CardSender} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCardSender(p: Platform): CardSender | undefined {
  return withMethod<CardSender>(p, 'sendCard')
}

/**
 * Whether the platform can render interactive cards (Go supportsCards).
 *
 * @param p - the platform to inspect.
 * @returns true when the platform implements the CardSender capability.
 */
export function supportsCards(p: Platform): boolean {
  return asCardSender(p) !== undefined
}

/**
 * Structural check for the {@link CardSenderWithUpdate} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCardSenderWithUpdate(p: Platform): CardSenderWithUpdate | undefined {
  return withMethod<CardSenderWithUpdate>(p, 'sendCardWithHandle')
}

/**
 * Structural check for the {@link LiveCardIconSource} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asLiveCardIconSource(p: Platform): LiveCardIconSource | undefined {
  return withMethod<LiveCardIconSource>(p, 'liveCardIconKey')
}

/**
 * Structural check for the {@link CardRefresher} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCardRefresher(p: Platform): CardRefresher | undefined {
  return withMethod<CardRefresher>(p, 'refreshCard')
}

/**
 * Structural check for the {@link CompletionNotifier} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCompletionNotifier(p: Platform): CompletionNotifier | undefined {
  return withMethod<CompletionNotifier>(p, 'sendCompletionNotification')
}

// ── M4 subtask / group-management capability interfaces (Go interfaces.go) ──

/** Reconstruct a reply context from a session key (Go ReplyContextReconstructor). */
export interface ReplyContextReconstructor {
  reconstructReplyCtx(sessionKey: string): Promise<unknown>
}

/**
 * Optional platform capability redirecting where a cron run's replies go
 * (Go CronReplyTargetResolver) — e.g. a fresh thread instead of the stored
 * chat. Only test stubs implement it today.
 */
export interface CronReplyTargetResolver {
  /**
   * @param sessionKey - The job's stored session key.
   * @param title - Human-readable run title for any UI the platform shows.
   * @returns [resolvedSessionKey, replyCtx]; an empty key keeps the original.
   */
  resolveCronReplyTarget(sessionKey: string, title: string): Promise<[string, unknown]>
}

/** A configured LLM route an agent can switch between (Go ProviderConfig subset). */
export interface ProviderConfig {
  name: string
  /** Model the route pins (Go ProviderConfig.Model). */
  model?: string
  /** Model context window in tokens; 0 = project/default (Go ContextWindow). */
  contextWindow?: number
}

/**
 * Agent that can fork side queries against a named provider (Go
 * ForkQuerierWithProvider). `lightweightQuery` drives group-name generation.
 */
export interface ForkQuerierWithProvider {
  forkQuery(sessionID: string, question: string, workDir: string): Promise<string>
  forkSessionWithProvider(sessionID: string, question: string, providerName: string, workDir: string): Promise<string>
  lightweightQuery(prompt: string, providerName: string, signal?: AbortSignal): Promise<string>
}

/** Agent whose active provider can be queried for fallbacks (Go ProviderSwitcher). */
export interface ProviderSwitcher {
  setProviders(providers: ProviderConfig[]): void
  setActiveProvider(name: string): boolean
  getActiveProvider(): ProviderConfig | undefined
  listProviders(): ProviderConfig[]
}

/**
 * Agent whose fork mechanism requires the source transcript to be reachable
 * from the child's workDir (Go ForkSessionPreparer).
 */
export interface ForkSessionPreparer {
  prepareForkSession(origID: string, parentWorkDir: string, childWorkDir: string): Promise<void>
}

/**
 * What a native continuable-child spawn asks the adapter for (de-baggage
 * B4): the provider choice mirrors the tool's fork flag, the persona is
 * composed inside the adapter from the unattended-subtask preamble plus the
 * workspace routing section, and the parent is identified by its live
 * native session id.
 */
export interface ContinuableChildStart {
  /** In-process provider: 'fork' seeds the parent's completed-turn prefix, 'spawn' starts fresh. */
  provider: 'spawn' | 'fork'
  /** The self-contained task brief delivered as the child's first user message. */
  prompt: string
  /** Absolute working directory the child session records as its cwd. */
  cwd: string
  /** Feishu workspace routing the child's persona section names; undefined = none. */
  workspace: FeishuWorkspaceInfo | undefined
  /** Delegation-depth cap the child enforces on its own descendants. */
  maxDepth: number
  /** Native session id of the live delegating parent. */
  parentAgentSessionID: string
}

/**
 * Agent that delegates continuable child sessions to the native subagent
 * runtime (`ctx.subagents`, mounted with external settlement delivery).
 * Child turns run on the native inbox FIFO; settlement reaches the engine
 * through the `subagent/end` event, not a runtime parent wake.
 */
export interface ContinuableDelegator {
  /**
   * @param request - the child spawn request.
   * @returns the durable native child session id and its creation label.
   */
  startContinuableChild(request: ContinuableChildStart): Promise<{ childId: string; label: string }>
  /**
   * Deliver a follow-up to a native child as its next FIFO turn; a running
   * child queues it (the deliberate deviation from Go's busy-reject).
   * @param parentAgentSessionID - native id of the live direct parent.
   * @param childId - the durable native child session id.
   * @param message - the follow-up text.
   */
  followupChild(parentAgentSessionID: string, childId: string, message: string): Promise<void>
  /**
   * Interrupt one native child's current turn (fire-and-return).
   * @param parentAgentSessionID - native id of the live direct parent (the authority).
   * @param childId - the durable native child session id.
   */
  interruptChild(parentAgentSessionID: string, childId: string): void
  /**
   * Push one native child's content to its durable direct parent through the
   * runtime's report path — used when the parent is itself a native child.
   * @param childId - the durable native child session id (the authority credential).
   * @param content - the report text.
   */
  reportChildToNativeParent(childId: string, content: string): Promise<void>
  /**
   * Whether one native child has a live agent in the runtime registry —
   * false when the child is settled to storage (interrupted, finished, or
   * never started). Restart recovery uses it to distinguish a child still
   * running (for example after an HMR rebuild left the runtime alive) from
   * one whose epoch died with the old process. Optional: a delegator
   * without the probe reports nothing live.
   * @param childId - the durable native child session id.
   */
  childLive?(childId: string): boolean
  /**
   * The recorded working directory of one native child ('' when the child
   * has no live agent or no cwd). A native child spawning its own child
   * uses it as the inheritance base the runtime would otherwise resolve
   * internally, so worktree auto-mode can compare repository roots.
   * Optional: a delegator without the probe reports no cwd, and a
   * dir='' grandchild then inherits at runtime without isolation.
   * @param childId - the durable native child session id.
   */
  childCwd?(childId: string): string
}

/**
 * Agent that can prepare a rollback fork (Go PrepareForkAtSession on
 * ForkSessionPreparer): truncate the source transcript to the turn the
 * quoted message belongs to and stage the prefix under a fresh id the
 * engine later starts via the `__forkat__` sentinel (one seeded create in
 * the dsh adapter; Go had to persist a truncated log file for its external
 * `--resume` process). Kept a separate interface from
 * {@link ForkSessionPreparer} so the subtask cross-workdir guard's
 * structural check stays a single-method probe.
 */
export interface ForkAtPreparer {
  /**
   * @param origID - the native id of the fork source session.
   * @param childWorkDir - the directory the child session records as cwd.
   * @param quotedText - the quoted-message text as the platform delivered it.
   * @param quotedSenderType - 'app' or 'user' sender of the quoted message.
   * @param quotedTimeMs - update time of the quoted message in unix ms; 0 = unknown.
   * @returns the fresh native id the `__forkat__` sentinel references.
   */
  prepareForkAtSession(
    origID: string,
    childWorkDir: string,
    quotedText: string,
    quotedSenderType: string,
    quotedTimeMs: number,
  ): Promise<string>
}

/** Agent exposing a per-workspace project-data dir for orphan cleanup (Go WorktreeOrphanResolver). */
export interface WorktreeOrphanResolver {
  orphanProjectDir(workDir: string): string | undefined
}

/** Agent with a runtime-switchable working directory (Go WorkDirSwitcher). */
export interface WorkDirSwitcher {
  setWorkDir(dir: string): void
  getWorkDir(): string
}

/** Options controlling how a spawned group is created (Go GroupSpawnOptions). */
export interface GroupSpawnOptions {
  /** Create a topic-style group where each thread gets its own session. */
  topicGroup: boolean
  /** Effective working directory at spawn time. */
  workDir: string
}

/** Platform that can create a new group chat and inject a first message (Go GroupSpawner). */
export interface GroupSpawner {
  /** Returns a synthetic Message to feed Engine.receiveMessage for the first turn. */
  spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message>
}

/** GroupSpawner extension supporting spawn options (Go GroupSpawnerEx). */
export interface GroupSpawnerEx extends GroupSpawner {
  spawnGroupWithOptions(msg: Message, groupName: string, firstMsg: string, opts: GroupSpawnOptions): Promise<Message>
}

/**
 * Platform that can rename group chats (Go GroupRenamer). `renameGroup` only
 * renames spawned groups; `renameGroupAny` renames any group including
 * user-owned ones.
 */
export interface GroupRenamer {
  renameGroup(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
  renameGroupAny(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void>
}

/**
 * Platform that notifies the engine when a chat was renamed (Go
 * ChatRenamedNotifier): the engine syncs session Name/ParentChatName labels
 * so jump buttons stay current.
 */
export interface ChatRenamedNotifier {
  setChatRenamedHandler(handler: (sessionKey: string, newName: string) => void): void
}

/**
 * Platform that notifies the engine on chat name/avatar change (Go
 * ChatChangedNotifier): the engine bumps the active preview card back to the
 * chat tail after the change's system notice pushes it off — gated on the
 * platform's displacement ledger, so a card that already owns the tail (or
 * lives in an isolated thread) is left alone.
 */
export interface ChatChangedNotifier {
  setChatChangedHandler(handler: (sessionKey: string) => void): void
}

/**
 * Platform that detects message recalls (Go RecallNotifier, #30): the engine
 * cancels the recalled message's queued entry before it reaches the agent.
 */
export interface RecallNotifier {
  setRecallHandler(handler: (messageID: string) => void): void
}

/** Platform that can set a group avatar from a Lucide icon name (#52, Go GroupIconAvatarSetter). */
export interface GroupIconAvatarSetter {
  setGroupIconAvatar(sessionKey: string, iconName: string, groupName: string): Promise<void>
}

/** Platform that stamps one shared icon avatar across a group family (hub plus child groups; Go ChatroomFamilyAvatarSetter). */
export interface GroupFamilyAvatarSetter {
  setGroupFamilyAvatar(hubKey: string, childKeys: string[], iconName: string, familyName: string): Promise<void>
}

/**
 * Lifecycle phase shown as the spawned group's avatar background color
 * (diverges from Go's random-hue + gray pair):
 * - `discussing` (yellow): no approved plan yet — also covers sessions that
 *   never plan (unattended runs, direct work).
 * - `plan-review` (blue): an ExitPlanMode card is parked awaiting approval.
 * - `approved` (green): a plan was approved; the baseline healthy state.
 * - `attention` (red): the user must step in — a pending question/permission
 *   card, an errored turn, or a stall timeout.
 * - `done` (gray): /done, same as the previous dimming design.
 */
export type ChatPhase = 'discussing' | 'plan-review' | 'approved' | 'attention' | 'done'

/** The subset of phases a chat returns to when an overlay clears. */
export type ChatBasePhase = 'discussing' | 'approved'

/**
 * Platform that paints a spawned group's avatar to its lifecycle phase
 * (replaces Go's boolean ChatAvatarStateSwitcher; the implementation dedups
 * same-phase calls so avatar updates never spam chat system messages).
 */
export interface ChatPhasePainter {
  setChatPhase(sessionKey: string, phase: ChatPhase): Promise<void>
  /**
   * The chat's baseline phase — what an overlay (`attention`/`plan-review`/
   * `done`) returns to when it clears.
   * @param sessionKey - Session key identifying the spawned group.
   * @returns The persisted baseline, defaulting to `discussing`.
   */
  chatBasePhase(sessionKey: string): ChatBasePhase
}

/** Platform that can list chat members and add members (Go ChatMemberManager). */
export interface ChatMemberManager {
  listChatMembers(sessionKey: string): Promise<string[]>
  addChatMembers(sessionKey: string, userIDs: string[]): Promise<void>
}

/** Platform that can produce a URL opening a given chat (Go ChatJumpURLer). */
export interface ChatJumpURLer {
  chatJumpURL(chatID: string): string
}

/** Platform with a multi-message pin panel (Go MessagePinAppender). */
export interface MessagePinAppender {
  addMessagePin(chatID: string, messageID: string): Promise<void>
}

/** Platform that can add an emoji reaction to the replied message (Go ReactionAdder). */
export interface ReactionAdder {
  addReaction(replyCtx: unknown, emoji: string): void
}

/** Platform that can add an emoji reaction to a specific message (Go MessageReactionAdder). */
export interface MessageReactionAdder {
  addReactionToMessage(chatID: string, messageID: string, emoji: string): Promise<void>
}

/** The default active tag applied to spawned groups (Go ActiveTagName). */
export const ActiveTagName = '❤️'

/** Platform whose active-tag name differs from the global default (Go ActiveTagNamer). */
export interface ActiveTagNamer {
  activeTagName(): string
}

/** Platform that can remove tags from chats, e.g. /done (Go ChatTagRemover). */
export interface ChatTagRemover {
  removeTagFromChat(sessionKey: string, tagName: string): Promise<void>
}

/** Platform that applies the active (heart) tag to a chat (Go ChatActiveTagger). */
export interface ChatActiveTagger {
  applyActiveTag(sessionKey: string): Promise<void>
}

/** An active spawned group chat as reported by the platform (Go SpawnedChatInfo). */
export interface SpawnedChatInfo {
  chatID: string
  chatName: string
  botName: string
}

/** Platform that returns active spawned chats for dashboard display (Go SpawnedChatLister). */
export interface SpawnedChatLister {
  listActiveSpawnedChats(): Promise<SpawnedChatInfo[]>
}

/** Platform that marks a spawned chat as active or inactive (Go SpawnedChatStateUpdater). */
export interface SpawnedChatStateUpdater {
  markSpawnedChatDone(sessionKey: string): Promise<void>
}

/** Platform that marks a spawned chat as active again, the /undone path (Go SpawnedChatActivator). */
export interface SpawnedChatActivator {
  markSpawnedChatActive(sessionKey: string): Promise<void>
}

/** Platform reporting whether a spawned chat is in the active (color-avatar) state (Go SpawnedChatActiveChecker). */
export interface SpawnedChatActiveChecker {
  isSpawnedChatActive(sessionKey: string): boolean
  /**
   * Whether a /done terminal mark is outstanding (marked done, not yet
   * undone) — the signal that freezes the avatar axis against late engine
   * repaints.
   */
  isSpawnedChatDone(sessionKey: string): boolean
}

/** Platform that can report the bot's own display name (Go BotIdentityProvider). */
export interface BotIdentityProvider {
  botDisplayName(): string
}

/**
 * Platform that can add an emoji reaction and return its ID for later
 * removal (Go ReactionManager). monitorReact uses it so a dropped triage can
 * unreact without orphaning the "picked up" mark.
 */
export interface ReactionManager {
  addReactionWithID(replyCtx: unknown, emoji: string): Promise<string>
  removeReaction(replyCtx: unknown, reactionID: string): Promise<void>
}

/**
 * Platform that can brand a chat as the monitor dispatch hub: rename it and
 * set a named icon avatar (Go ChatBrander).
 */
export interface ChatBrander {
  brandChat(sessionKey: string, groupName: string, iconName: string): Promise<void>
}

/**
 * Platform that can list a monitored chat's recent messages, backing the
 * monitor polling fallback (#53): catches webhook-bot / other-app card
 * messages that never arrive as events.
 */
export interface MonitorPoller {
  /** Create time (seconds) of the chat's newest message; 0 for an empty chat. */
  latestMessageTime(chatID: string): Promise<number>
  /**
   * Messages created after afterSec, oldest-first, plus the newest create
   * time among ALL fetched raw items (seconds). Unprocessable items (the
   * bot's own, sender-less without a fallback owner, no extractable text)
   * are excluded from `messages` but still count in `latestTimeSec` — the
   * watermark must advance past them or an unprocessable page refetches
   * forever and buries every later alert.
   */
  listMonitorMessages(chatID: string, afterSec: number, limit: number): Promise<MonitorPollPage>
}

/** One poll page from {@link MonitorPoller.listMonitorMessages}. */
export interface MonitorPollPage {
  /** Triageable messages, oldest-first. */
  messages: Message[]
  /** Newest create time among all fetched raw items, in seconds (0 when none). */
  latestTimeSec: number
}

/**
 * Platform receiving runtime monitor config pushes (Go
 * MonitorChatConfigurable): the monitored chat set and the fallback user that
 * owns subgroups spawned for sender-less webhook cards.
 */
export interface MonitorChatConfigurable {
  setMonitorChats(chats: string): void
  setMonitorFallbackUser(openID: string): void
}

/**
 * The platform's own active-tag name, falling back to the global default (Go activeTagNameFor).
 *
 * @param p - the platform to inspect.
 * @returns the platform's active-tag name, or {@link ActiveTagName} when it has none.
 */
export function activeTagNameFor(p: Platform): string {
  const namer = withMethod<ActiveTagNamer>(p, 'activeTagName')
  const name = namer?.activeTagName() ?? ''
  return name !== '' ? name : ActiveTagName
}

/**
 * Structural check for the {@link ReplyContextReconstructor} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asReplyContextReconstructor(p: Platform): ReplyContextReconstructor | undefined {
  return withMethod<ReplyContextReconstructor>(p, 'reconstructReplyCtx')
}

/**
 * Structural check for the {@link CronReplyTargetResolver} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCronReplyTargetResolver(p: Platform): CronReplyTargetResolver | undefined {
  return withMethod<CronReplyTargetResolver>(p, 'resolveCronReplyTarget')
}

/**
 * Structural check for the {@link ForkQuerierWithProvider} capability (all three members required).
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asForkQuerierWithProvider(a: Agent): ForkQuerierWithProvider | undefined {
  const candidate = a as Partial<ForkQuerierWithProvider>
  return typeof candidate.lightweightQuery === 'function'
    && typeof candidate.forkQuery === 'function'
    && typeof candidate.forkSessionWithProvider === 'function'
    ? candidate as ForkQuerierWithProvider
    : undefined
}

/**
 * Structural check for the {@link ProviderSwitcher} capability (all four members required).
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asProviderSwitcher(a: Agent): ProviderSwitcher | undefined {
  const candidate = a as Partial<ProviderSwitcher>
  return typeof candidate.getActiveProvider === 'function'
    && typeof candidate.setActiveProvider === 'function'
    && typeof candidate.setProviders === 'function'
    && typeof candidate.listProviders === 'function'
    ? candidate as ProviderSwitcher
    : undefined
}

/**
 * Structural check for the {@link ForkSessionPreparer} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asForkSessionPreparer(a: Agent): ForkSessionPreparer | undefined {
  return withMethod<ForkSessionPreparer>(a, 'prepareForkSession')
}

/**
 * Structural check for the {@link ContinuableDelegator} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asContinuableDelegator(a: Agent): ContinuableDelegator | undefined {
  return withMethod<ContinuableDelegator>(a, 'startContinuableChild')
}

/**
 * Agent that reports delegated child sessions' liveness (last durable-event
 * time and tool-call count), recorded independently of the ancestor
 * projection — the background-subtask panel reads it while the parent turn
 * is detached, where projection drops child events.
 */
export interface SubagentActivitySource {
  /**
   * @returns the live activity map keyed by child session id; entries exist
   * only for children that emitted at least one event.
   */
  subagentActivitySnapshot(): ReadonlyMap<string, { lastEventAt: number; toolCalls: number }>
  /** Drop the activity records of settled children. */
  forgetSubagentActivity(childIds: readonly string[]): void
}

/**
 * Structural check for the {@link SubagentActivitySource} capability.
 *
 * @param a - the agent to probe.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSubagentActivitySource(a: Agent): SubagentActivitySource | undefined {
  return withMethod<SubagentActivitySource>(a, 'subagentActivitySnapshot')
}

/**
 * Structural check for the {@link ForkAtPreparer} capability.
 *
 * @param a - the agent to probe.
 * @returns the capability when the agent implements rollback-fork preparation.
 */
export function asForkAtPreparer(a: Agent): ForkAtPreparer | undefined {
  return withMethod<ForkAtPreparer>(a, 'prepareForkAtSession')
}

/**
 * Structural check for the {@link WorktreeOrphanResolver} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asWorktreeOrphanResolver(a: Agent): WorktreeOrphanResolver | undefined {
  return withMethod<WorktreeOrphanResolver>(a, 'orphanProjectDir')
}

/**
 * Structural check for the {@link WorkDirSwitcher} capability (both members required).
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asWorkDirSwitcher(a: Agent): WorkDirSwitcher | undefined {
  const candidate = a as Partial<WorkDirSwitcher>
  return typeof candidate.getWorkDir === 'function' && typeof candidate.setWorkDir === 'function'
    ? candidate as WorkDirSwitcher
    : undefined
}

/**
 * Structural check for the {@link GroupSpawner} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupSpawner(p: Platform): GroupSpawner | undefined {
  return withMethod<GroupSpawner>(p, 'spawnGroup')
}

/**
 * Structural check for the {@link GroupSpawnerEx} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupSpawnerEx(p: Platform): GroupSpawnerEx | undefined {
  return withMethod<GroupSpawnerEx>(p, 'spawnGroupWithOptions')
}

/**
 * Structural check for the {@link GroupRenamer} capability (both members required).
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupRenamer(p: Platform): GroupRenamer | undefined {
  const candidate = p as Partial<GroupRenamer>
  return typeof candidate.renameGroup === 'function' && typeof candidate.renameGroupAny === 'function'
    ? candidate as GroupRenamer
    : undefined
}

/**
 * Structural check for the {@link ChatRenamedNotifier} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatRenamedNotifier(p: Platform): ChatRenamedNotifier | undefined {
  return withMethod<ChatRenamedNotifier>(p, 'setChatRenamedHandler')
}

/**
 * Structural check for the {@link ChatChangedNotifier} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatChangedNotifier(p: Platform): ChatChangedNotifier | undefined {
  return withMethod<ChatChangedNotifier>(p, 'setChatChangedHandler')
}

/**
 * Structural check for the {@link RecallNotifier} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asRecallNotifier(p: Platform): RecallNotifier | undefined {
  return withMethod<RecallNotifier>(p, 'setRecallHandler')
}

/**
 * Structural check for the {@link SessionCompressor} capability.
 *
 * @param s - the session to inspect; undefined passes through as undefined.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSessionCompressor(s: AgentSession | undefined): SessionCompressor | undefined {
  return s !== undefined && typeof (s as Partial<SessionCompressor>).compress === 'function'
    ? s as AgentSession & SessionCompressor
    : undefined
}

/**
 * Structural check for the {@link SessionDeleter} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSessionDeleter(a: Agent): SessionDeleter | undefined {
  return withMethod<SessionDeleter>(a, 'deleteSession')
}

/**
 * Structural check for the {@link GroupIconAvatarSetter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupIconAvatarSetter(p: Platform): GroupIconAvatarSetter | undefined {
  return withMethod<GroupIconAvatarSetter>(p, 'setGroupIconAvatar')
}

/**
 * Structural check for the {@link GroupFamilyAvatarSetter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupFamilyAvatarSetter(p: Platform): GroupFamilyAvatarSetter | undefined {
  return withMethod<GroupFamilyAvatarSetter>(p, 'setGroupFamilyAvatar')
}

/**
 * Structural check for the {@link ChatPhasePainter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatPhasePainter(p: Platform): ChatPhasePainter | undefined {
  return withMethod<ChatPhasePainter>(p, 'setChatPhase')
}

/**
 * Structural check for the {@link ChatMemberManager} capability (both members required).
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatMemberManager(p: Platform): ChatMemberManager | undefined {
  const candidate = p as Partial<ChatMemberManager>
  return typeof candidate.listChatMembers === 'function' && typeof candidate.addChatMembers === 'function'
    ? candidate as ChatMemberManager
    : undefined
}

/**
 * Structural check for the {@link ChatJumpURLer} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatJumpURLer(p: Platform): ChatJumpURLer | undefined {
  return withMethod<ChatJumpURLer>(p, 'chatJumpURL')
}

/**
 * Structural check for the {@link MessagePinAppender} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asMessagePinAppender(p: Platform): MessagePinAppender | undefined {
  return withMethod<MessagePinAppender>(p, 'addMessagePin')
}

/**
 * Structural check for the {@link ReactionAdder} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asReactionAdder(p: Platform): ReactionAdder | undefined {
  return withMethod<ReactionAdder>(p, 'addReaction')
}

/**
 * Structural check for the {@link MessageReactionAdder} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asMessageReactionAdder(p: Platform): MessageReactionAdder | undefined {
  return withMethod<MessageReactionAdder>(p, 'addReactionToMessage')
}

/**
 * Structural check for the {@link ChatTagRemover} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatTagRemover(p: Platform): ChatTagRemover | undefined {
  return withMethod<ChatTagRemover>(p, 'removeTagFromChat')
}

/**
 * Structural check for the {@link ChatActiveTagger} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatActiveTagger(p: Platform): ChatActiveTagger | undefined {
  return withMethod<ChatActiveTagger>(p, 'applyActiveTag')
}

/**
 * Structural check for the {@link SpawnedChatLister} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSpawnedChatLister(p: Platform): SpawnedChatLister | undefined {
  return withMethod<SpawnedChatLister>(p, 'listActiveSpawnedChats')
}

/**
 * Structural check for the {@link SpawnedChatStateUpdater} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSpawnedChatStateUpdater(p: Platform): SpawnedChatStateUpdater | undefined {
  return withMethod<SpawnedChatStateUpdater>(p, 'markSpawnedChatDone')
}

/**
 * Structural check for the {@link SpawnedChatActivator} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSpawnedChatActivator(p: Platform): SpawnedChatActivator | undefined {
  return withMethod<SpawnedChatActivator>(p, 'markSpawnedChatActive')
}

/**
 * Structural check for the {@link SpawnedChatActiveChecker} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSpawnedChatActiveChecker(p: Platform): SpawnedChatActiveChecker | undefined {
  return withMethod<SpawnedChatActiveChecker>(p, 'isSpawnedChatActive')
}

/**
 * Structural check for the {@link BotIdentityProvider} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asBotIdentityProvider(p: Platform): BotIdentityProvider | undefined {
  return withMethod<BotIdentityProvider>(p, 'botDisplayName')
}

/**
 * Structural check for the {@link ReactionManager} capability (both members required).
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asReactionManager(p: Platform): ReactionManager | undefined {
  const candidate = p as Partial<ReactionManager>
  return typeof candidate.addReactionWithID === 'function' && typeof candidate.removeReaction === 'function'
    ? candidate as ReactionManager
    : undefined
}

/**
 * Structural check for the {@link ChatBrander} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatBrander(p: Platform): ChatBrander | undefined {
  return withMethod<ChatBrander>(p, 'brandChat')
}

/**
 * Structural check for the {@link MonitorPoller} capability (both members required).
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asMonitorPoller(p: Platform): MonitorPoller | undefined {
  const candidate = p as Partial<MonitorPoller>
  return typeof candidate.latestMessageTime === 'function' && typeof candidate.listMonitorMessages === 'function'
    ? candidate as MonitorPoller
    : undefined
}

/**
 * Structural check for the {@link MonitorChatConfigurable} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asMonitorChatConfigurable(p: Platform): MonitorChatConfigurable | undefined {
  const candidate = p as Partial<MonitorChatConfigurable>
  return typeof candidate.setMonitorChats === 'function'
    ? candidate as MonitorChatConfigurable
    : undefined
}

// ── M7 plan/reply HTML render capability interfaces (Go interfaces.go) ─────

/**
 * Agent that can spawn an isolated, non-plan-mode "render session" (Go
 * RenderQuerier): a standalone one-shot agent with tool access and a
 * complete-replacement system prompt. The one-shot spawns in-process with a
 * fresh session, so concurrent renders cannot crosstalk.
 */
export interface RenderQuerier {
  /**
   * Run a standalone query with an injected system prompt. `providerName`
   * selects the provider route. Returns the session's trimmed stdout
   * (expected one-line confirmation).
   */
  renderQuery(prompt: string, providerName: string, systemPrompt: string, signal?: AbortSignal): Promise<string>
}

/** Optional: platform can send standalone image messages (Go ImageSender). */
export interface ImageSender {
  sendImage(replyCtx: unknown, img: ImageAttachment): Promise<void>
}

/** Optional: platform can upload images and return a platform image key (Go ImageUploader). */
export interface ImageUploader {
  uploadImage(img: ImageAttachment): Promise<string>
}

/** Optional: platform can PATCH the render-status line on a sent green card (Go RenderStatusUpdater). */
export interface RenderStatusUpdater {
  updateRenderStatus(replyCtx: unknown, exportKey: string, statusText: string): Promise<void>
}

/**
 * Structural check for the {@link RenderQuerier} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asRenderQuerier(a: Agent): RenderQuerier | undefined {
  return withMethod<RenderQuerier>(a, 'renderQuery')
}

/**
 * Structural check for the {@link ImageSender} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asImageSender(p: Platform): ImageSender | undefined {
  return withMethod<ImageSender>(p, 'sendImage')
}

/**
 * Structural check for the {@link ImageUploader} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asImageUploader(p: Platform): ImageUploader | undefined {
  return withMethod<ImageUploader>(p, 'uploadImage')
}

/**
 * Structural check for the {@link RenderStatusUpdater} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asRenderStatusUpdater(p: Platform): RenderStatusUpdater | undefined {
  return withMethod<RenderStatusUpdater>(p, 'updateRenderStatus')
}

/** Optional: platform registers the engine's export-content lookup for export:/sendreply: card buttons (Go ReplyExporter). */
export interface ReplyExporter {
  setExportHandler(handler: (sessionKey: string, exportKey: string) => { text: string; ok: boolean }): void
}

/**
 * Structural check for the {@link ReplyExporter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asReplyExporter(p: Platform): ReplyExporter | undefined {
  return withMethod<ReplyExporter>(p, 'setExportHandler')
}

/** Optional: platform receives hint-button clicks so the engine counts them (Go HintClickReporter). */
export interface HintClickReporter {
  setHintClickHandler(handler: (hintText: string, category: 'hints' | 'hints_with_param' | 'hints_common') => void): void
}

/**
 * Structural check for the {@link HintClickReporter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asHintClickReporter(p: Platform): HintClickReporter | undefined {
  return withMethod<HintClickReporter>(p, 'setHintClickHandler')
}

/**
 * Optional: platform localizes its own user-visible copy (perm card rebuilds,
 * export/sendreply failure notices) through the engine's message handle —
 * config.language reaches the engine's i18n, never the platform, so the
 * engine hands its {@link I18n} instance over at mount.
 */
export interface I18nHandleReceiver {
  setI18nHandle(handle: I18n): void
}

/**
 * Structural check for the {@link I18nHandleReceiver} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asI18nHandleReceiver(p: Platform): I18nHandleReceiver | undefined {
  return withMethod<I18nHandleReceiver>(p, 'setI18nHandle')
}
