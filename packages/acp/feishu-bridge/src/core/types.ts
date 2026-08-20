/**
 * Core interface model ported from cc-connect core/interfaces.go and
 * core/message.go: Platform, Agent, AgentSession, Message, Event. M1 carries
 * the base set only; optional capability interfaces arrive with the
 * milestones that port their tests (cards → M2, approval → M3, …).
 *
 * Go's optional-capability interface checks (`if cs, ok := p.(CardSender)`)
 * become structural checks on optional methods (`isCardSender(p)` guards in
 * engine code).
 *
 * @module dsh-feishu-bridge/core-types
 */

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
 * (Go FeishuWorkspaceInfo, #18). Non-empty fields surface as CC_FEISHU_* env
 * entries on session start, scoping doc search/creation to this location.
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
  gitBranch?: string
}

/** Permission decision sent back to the agent. */
export interface PermissionResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  /** Deny reason message forwarded to the agent (Go PermissionResult.Message). */
  message?: string
}

/** One choice in a UserQuestion (Go UserQuestionOption). */
export interface UserQuestionOption {
  label: string
  description: string
  /** Optional preview text shown below the option (Go Preview). */
  preview?: string
}

/** A structured question from AskUserQuestion (Go UserQuestion). */
export interface UserQuestion {
  question: string
  header: string
  options: UserQuestionOption[]
  multiSelect: boolean
}

/**
 * A pending permission prompt parked on an InteractiveState (Go
 * pendingPermission). `resolved` replaces Go's `chan struct{}` — call
 * `resolve()` to settle; `isResolved()` checks.
 */
export interface PendingPermission {
  requestID: string
  toolName: string
  toolInput: Record<string, unknown>
  inputPreview: string
  /** Non-empty when ToolName === "AskUserQuestion". */
  questions: UserQuestion[]
  /** Collected answers keyed by question index. */
  answers: Map<number, string>
  /** Index of the question currently being asked. */
  currentQuestion: number
  /** Set true when user denies. */
  denied: boolean
  /** Resolved promise; settled when user responds. */
  resolved: Promise<void>
  /** Internal resolve function paired with `resolved`. */
  resolve(): void
  /** Research-manual AskUserQuestion auto-default timer (M5; stopped on resolve). */
  autoTimer?: ReturnType<typeof setTimeout>
  /** One-shot guard for the research-manual auto-default (Go autoFired). */
  autoFired?: boolean
}

/** Card button callback action types for permission and askq flows. */
export type PermissionAction = 'perm:allow' | 'perm:deny' | 'perm:allow_all'

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
  /** A card.action.trigger button press with an act:/nav: value (M4). */
  isCardAction: boolean
  parentMessageID: string
  quotedText: string
  /** Sender type of the quoted message ('user' | 'app'); set with quotedText. */
  quotedSenderType?: string
  /** Update time of the quoted message in unix ms (card PATCH time); /fork-rollback locator. */
  quotedUpdateTimeMs?: number
  /** Permission mode override for this message ('' = project default; Go ModeOverride). */
  modeOverride?: string
  /**
   * Internal chatroom metadata on synthetic ask messages injected into role
   * sessions: the gather round stamp and the research dispatch-defer arm.
   * Consumed at turn start (stampChatroomAskOnTurnStart) and never surfaced
   * to the agent. 0/false for ordinary messages (Go ChatroomAskSeq etc.).
   */
  chatroomAskSeq?: number
  chatroomAwaitAssistant?: boolean
  /** Message creation time in seconds (Go CreateTime); 0/undefined when unknown. */
  createTime?: number
}

/** Agent output event kinds (Go EventType). M1 handles text/thinking/tool/result/error/permission. */
export type EventKind =
  | 'text'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'thinking'

/** A single piece of agent output streamed to the engine (Go Event). */
export interface Event {
  type: EventKind
  content: string
  toolName?: string
  toolInput?: string
  toolInputRaw?: Record<string, unknown>
  toolResult?: string
  toolID?: string
  sessionID?: string
  requestID?: string
  done: boolean
  error?: Error
  errorText?: string
  inputTokens?: number
  totalInputTokens?: number
  outputTokens?: number
  numTurns?: number
  arrivedAt?: number
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
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, event: this.queue.shift() as Event })
    }
    if (this.closed) return Promise.resolve({ done: true } as const)
    return new Promise((resolve) => { this.waiters.push(resolve) })
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
  respondPermission(requestID: string, result: PermissionResult): Promise<void>
  events(): EventChannel
  currentSessionID(): string
  alive(): boolean
  close(): Promise<void>
}

/** An AI coding assistant backend (Go Agent). */
export interface Agent {
  name(): string
  startSession(sessionID: string): Promise<AgentSession>
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

/** Optional: agent accepts per-session env vars (CC_PROJECT, …). */
export interface SessionEnvInjector {
  setSessionEnv(env: string[]): void
}

/** Optional: agent accepts a one-shot mode override consumed by the next startSession. */
export interface SessionModeInjector {
  setSessionMode(mode: string): void
}

/**
 * Structural checks replacing Go's interface type assertions.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asSessionEnvInjector(a: Agent): SessionEnvInjector | undefined {
  const candidate = a as Partial<SessionEnvInjector>
  return typeof candidate.setSessionEnv === 'function' ? (candidate as SessionEnvInjector) : undefined
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

/** Optional: platform can update a previously sent message in place (PATCH). */
export interface MessageUpdater {
  updateMessage(replyCtx: unknown, content: string): Promise<void>
}

/**
 * Optional: platform can start a streaming preview message and return a
 * handle for subsequent in-place edits.
 */
export interface PreviewStarter {
  sendPreviewStart(replyCtx: unknown, content: string): Promise<unknown>
}

/** Optional: platform can delete a preview message when the final reply is sent separately. */
export interface PreviewCleaner {
  deletePreviewMessage(previewHandle: unknown): Promise<void>
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
 * Structural check for the {@link CardRefresher} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asCardRefresher(p: Platform): CardRefresher | undefined {
  return withMethod<CardRefresher>(p, 'refreshCard')
}

/**
 * Structural check for the {@link InlineButtonSender} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asInlineButtonSender(p: Platform): InlineButtonSender | undefined {
  return withMethod<InlineButtonSender>(p, 'sendWithButtons')
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
 * from the child's workDir (Go ForkSessionPreparer). The fork-at (rollback)
 * members arrive with the quoted-message rollback milestone.
 */
export interface ForkSessionPreparer {
  prepareForkSession(origID: string, parentWorkDir: string, childWorkDir: string): Promise<void>
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
 * chat tail after the change's system notice pushes it off.
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

/** Platform that stamps one shared icon avatar across a chatroom family (Go ChatroomFamilyAvatarSetter). */
export interface ChatroomFamilyAvatarSetter {
  setChatroomFamilyAvatar(hubKey: string, childKeys: string[], iconName: string, familyName: string): Promise<void>
}

/**
 * Platform that signals a spawned group's active state via the group avatar
 * (#done dimming, Go ChatAvatarStateSwitcher).
 */
export interface ChatAvatarStateSwitcher {
  setChatAvatarActive(sessionKey: string, active: boolean): Promise<void>
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

/** Platform with a single top-notice banner (Go TopNoticeSetter). */
export interface TopNoticeSetter {
  setTopNotice(chatID: string, messageID: string): Promise<void>
  clearTopNotice(chatID: string, messageID: string): Promise<void>
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
  markSpawnedChatDone(sessionKey: string): void
}

/** Platform that marks a spawned chat as active again, the /undone path (Go SpawnedChatActivator). */
export interface SpawnedChatActivator {
  markSpawnedChatActive(sessionKey: string): void
}

/** Platform reporting whether a spawned chat is in the active (color-avatar) state (Go SpawnedChatActiveChecker). */
export interface SpawnedChatActiveChecker {
  isSpawnedChatActive(sessionKey: string): boolean
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
  /** Messages created after afterSec (exclusive of newer-than), oldest-first. */
  listMonitorMessages(chatID: string, afterSec: number, limit: number): Promise<Message[]>
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
 * Structural check for the {@link GroupIconAvatarSetter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asGroupIconAvatarSetter(p: Platform): GroupIconAvatarSetter | undefined {
  return withMethod<GroupIconAvatarSetter>(p, 'setGroupIconAvatar')
}

/**
 * Structural check for the {@link ChatroomFamilyAvatarSetter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatroomFamilyAvatarSetter(p: Platform): ChatroomFamilyAvatarSetter | undefined {
  return withMethod<ChatroomFamilyAvatarSetter>(p, 'setChatroomFamilyAvatar')
}

/**
 * Structural check for the {@link ChatAvatarStateSwitcher} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asChatAvatarStateSwitcher(p: Platform): ChatAvatarStateSwitcher | undefined {
  return withMethod<ChatAvatarStateSwitcher>(p, 'setChatAvatarActive')
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
 * Structural check for the {@link TopNoticeSetter} capability.
 *
 * @param p - the platform to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asTopNoticeSetter(p: Platform): TopNoticeSetter | undefined {
  return withMethod<TopNoticeSetter>(p, 'setTopNotice')
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
 * RenderQuerier): a standalone one-shot agent with tool access, a
 * complete-replacement system prompt, and an explicit sessionEnv so
 * concurrent render sessions don't crosstalk via a shared env slot.
 */
export interface RenderQuerier {
  /**
   * Run a standalone query with an injected system prompt. `providerName`
   * selects the provider route; `sessionEnv` is passed through verbatim and
   * must not be sourced from a shared slot. Returns the session's trimmed
   * stdout (expected one-line confirmation).
   */
  renderQuery(prompt: string, providerName: string, systemPrompt: string, sessionEnv: string[], signal?: AbortSignal): Promise<string>
}

/** Agent whose render-session effort can be overridden per project (Go RenderEffortSetter). */
export interface RenderEffortSetter {
  setRenderEffort(effort: string): void
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
 * Structural check for the {@link RenderEffortSetter} capability.
 *
 * @param a - the agent to inspect.
 * @returns the capability view, or undefined when not implemented.
 */
export function asRenderEffortSetter(a: Agent): RenderEffortSetter | undefined {
  return withMethod<RenderEffortSetter>(a, 'setRenderEffort')
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
