/**
 * Feishu platform ported from cc-connect platform/feishu (M1 text path +
 * M2 card system): a WSClient long connection per app (plan D5),
 * im.message.receive_v1 dispatch with @bot gating and allowlists, event
 * dedup, thread-isolated session keys; interactive-card sends/replies with
 * in-place PATCH updates, streaming preview handles with per-card caches,
 * PATCH rate limiting, transient/token retry, reactions, TopNotice, pins,
 * completion notifications, and spinner GIF upload.
 *
 * The API client and WS bootstrap are injectable so unit tests feed
 * synthetic events into dispatch and record outbound calls without the
 * network. M4 adds the platform domain: group spawning with the spawned-chat
 * registry, im/v2 tag management with verify-after-bind self-healing, Lucide
 * icon avatars with /done graying, chat-name TTL caching, member
 * listing/adding, and image/file media both ways. Not ported yet: mention
 * resolution, comment-session driving, audio messages (attachment types the
 * TS Message does not carry yet).
 *
 * @module dsh-feishu-bridge/feishu-platform
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MessageDedup, isOldMessage } from '../dedup.js'
import { AllowList } from './allowlist.js'
import { MaxPlatformMessageLen, splitMessage } from '../engine/message-split.js'
import { extractCardImageKeys, extractInteractiveCardText, extractPollText, extractPostImageKeys, extractPostPlainText, hasHumanMention, interactiveCardPlaceholder, isBotMentioned, replaceMentions, stripMentions, unwrapCardContent } from './extract.js'
import { isMonitorCommand } from '../core/types.js'
import type { UserQuestion } from '../core/types.js'
import { buildAskQuestionsCard, parseAskqSelection } from '../engine/ask.js'
import { hintCategoryOfCode, parseHintButtonName } from '../engine/hints-panel.js'
import type { FeishuMention } from './extract.js'
import type { Card } from '../card.js'
import { newCard } from '../card.js'
import { renderCard, renderCardMap, type FeishuCardMap } from './card.js'
import {
  buildPreviewCardJSON,
  buildProgressCardJSONFromPayload,
  buildReplyContent,
  injectReplyButtons,
  injectStopButton,
  markCardStopped,
} from './progress.js'
import { previewOverflow as previewOverflowFn } from './markdown.js'
import { noSpinner, resolveSpinnerAsset, type SpinnerCfg } from './spinner.js'
import { parseProgressStyle } from '../progress.js'
import { TokenBucketRateLimiter, isTenantAccessTokenInvalid, withTransientRetry } from './retry.js'
import { errorMessage } from './retry.js'
import { ErrNotSupported, type ImageAttachment, type FileAttachment, type Message, type MessageHandler, type Platform, type ProgressContent } from '../core/types.js'
import { SpawnedChatStore, extractFeishuChatID, projectBaseForTag, type GroupSpawnOptions, type SpawnedChatInfo, type SpawnedChatMeta } from './spawn.js'
import { TagManager, buildDirWordFreq, pickDirTagName, type CreateTagResult, type FeishuCodeReply, type TagApi, type TagRelationTag } from './tag.js'
import { groupAvatarColor, grayscaleAvatar, iconGrayBG, renderIconPNG } from './avatar.js'
import { ChatNameCache } from './chatname.js'
import { chatMembersAddBatch, dedupMemberIDs } from './members.js'
import { detectFeishuFileType, detectMimeType, maxFeishuDownloadBytes, type FeishuFileType } from './media.js'
import { fallbackGroupIcon, lucideIconSVG } from '../lucide/icon.js'

export { extractFeishuChatID, type GroupSpawnOptions, type SpawnedChatInfo, type SpawnedChatMeta }

/** Platform-side reply context (Go replyContext). */
export interface FeishuReplyContext {
  messageID: string
  chatID: string
  sessionKey: string
}

/** One item of an im.message.list response, as consumed by the monitor poll path. */
export interface FeishuListItem {
  messageId: string
  msgType: string
  content: string
  /** Unix milliseconds as a decimal string, like the API returns. */
  createTime: string
  sender?: {
    id?: string
    idType?: string
    senderType?: string
  }
}

/** Parse a Feishu create_time (unix ms as a decimal string) into seconds; 0 on garbage (Go msgTimeSec). */
function msgTimeSec(ms: string): number {
  const n = Number.parseInt(ms, 10)
  if (!Number.isFinite(n)) return 0
  return Math.trunc(n / 1000)
}

/**
 * Reply payload of the getMessage verb: the raw fields the quoted-message
 * chain needs (Go fetchSingleMessage's decode of GET im/v1/messages/{id}).
 */
export interface FeishuQuotedMessage {
  msgType: string
  parentId: string
  updateTimeMs: number
  senderId: string
  senderType: string
  bodyContent: string
  mentions?: FeishuMention[]
}

/** One entry of a fetched reply chain (Go chainMessage). */
export interface ChainMessage {
  senderName: string
  senderType: string
  text: string
  parentId: string
  updateTimeMs: number
}

/**
 * Format a reply chain into a readable prefix (Go formatReplyChain): a
 * single message keeps the legacy bracket format; multi-message chains use
 * a numbered list with user/assistant role labels.
 * @param chain - Quoted messages in chronological order.
 * @returns Prefix prepended to the reply content; empty for an empty chain.
 */
export function formatReplyChain(chain: ChainMessage[]): string {
  if (chain.length === 0) return ''
  if (chain.length === 1) {
    const only = chain[0] as ChainMessage
    return `[Quoted message from ${only.senderName}]:\n${only.text}\n\n`
  }
  let out = `--- Reply chain (${chain.length} messages) ---\n`
  for (const [i, msg] of chain.entries()) {
    const role = msg.senderType === 'app' ? 'assistant' : 'user'
    out += `[${i + 1}] ${msg.senderName} (${role}):\n${msg.text}\n\n`
  }
  return `${out}---\n\n`
}

/** Max parent messages traversed per inbound reply (Go maxReplyChainDepth). */
const maxReplyChainDepth = 5

/** An all-empty Message literal for the poll path's spread base. */
function emptyMessageShape(): Message {
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

/** Params for a reply API call. */
export interface FeishuReplyParams { messageId: string; msgType: string; content: string; replyInThread?: boolean }

/**
 * Outbound message API surface the platform needs (node-sdk subset). M1's
 * reply/create are required; the M2 verbs are optional so minimal test
 * fakes keep working — card paths fail loud when a verb is missing.
 */
export interface FeishuApiClient {
  reply(params: FeishuReplyParams): Promise<{ messageId?: string } | undefined>
  create(params: { chatId: string; msgType: string; content: string }): Promise<{ messageId?: string } | undefined>
  patch?(params: { messageId: string; content: string }): Promise<void>
  delete?(params: { messageId: string }): Promise<void>
  fetchTenantAccessToken?(): Promise<string>
  /** A client bound to an explicit token, bypassing the cached one. */
  withToken?(token: string): FeishuApiClient
  putTopNotice?(params: { chatId: string; messageId: string }): Promise<void>
  deleteTopNotice?(params: { chatId: string }): Promise<void>
  createPin?(params: { messageId: string }): Promise<void>
  createReaction?(params: { messageId: string; emojiType: string }): Promise<{ reactionId?: string } | undefined>
  deleteReaction?(params: { messageId: string; reactionId: string }): Promise<void>
  uploadImage?(img: { data: Uint8Array; mimeType: string; fileName: string }): Promise<string>
  // ----- M4 platform-domain verbs (group spawn/tag/avatar/media/members) -----

  /** Create a group chat containing the bot and the given users (Im.Chat.Create). */
  createChat?(params: {
    name: string
    userIdList: string[]
    groupMessageType?: 'chat' | 'thread'
    avatar?: string
  }): Promise<FeishuCodeReply & { chatId?: string | undefined }>
  /** Update a chat's name and/or avatar (Im.Chat.Update). */
  updateChat?(params: { chatId: string; name?: string; avatar?: string }): Promise<FeishuCodeReply>
  /** Fetch a chat's name (Im.Chat.Get). */
  getChat?(params: { chatId: string }): Promise<FeishuCodeReply & { name?: string | undefined }>
  /** Fetch one page of chat members as open_ids (Im.ChatMembers.Get). */
  listChatMembersPage?(
    params: { chatId: string; pageToken?: string },
  ): Promise<FeishuCodeReply & { memberIDs: string[]; pageToken?: string | undefined }>
  /** Add members to a chat, max 50 per call (Im.ChatMembers.Create). */
  createChatMembers?(params: { chatId: string; idList: string[] }): Promise<FeishuCodeReply>
  /** Create a tenant tag (im/v2 Tag.Create); duplicateId carries the taken name's id. */
  createTag?(params: { name: string }): Promise<CreateTagResult>
  /** Read the tags bound to a chat (im/v2 BizEntityTagRelation.Get). */
  getTagRelation?(params: { chatId: string }): Promise<FeishuCodeReply & { tags: TagRelationTag[] }>
  /** Bind tags to a chat (im/v2 BizEntityTagRelation.Create). */
  createTagRelation?(params: { chatId: string; tagIds: string[] }): Promise<FeishuCodeReply>
  /** Unbind tags from a chat (im/v2 BizEntityTagRelation.Update). */
  updateTagRelation?(params: { chatId: string; tagIds: string[] }): Promise<FeishuCodeReply>
  /** Upload avatar-type image bytes and return the image_key (Im.Image.Create). */
  uploadAvatar?(params: { data: Uint8Array }): Promise<string>
  /** Upload a file and return its file_key (Im.File.Create). */
  uploadFile?(params: { data: Uint8Array; fileName: string; fileType: FeishuFileType }): Promise<string>
  /** Download a message resource's bytes (Im.MessageResource.Get). */
  downloadMessageResource?(params: { messageId: string; fileKey: string; type: string }): Promise<Uint8Array>
  /**
   * List a chat's messages (Im.Message.List) with raw_card_content delivery
   * so interactive cards stay readable; backs the monitor poll fallback.
   */
  listMessages?(params: {
    chatId: string
    sortType: 'ByCreateTimeDesc' | 'ByCreateTimeAsc'
    pageSize: number
    startTimeSec?: number
  }): Promise<FeishuListItem[]>
  /**
   * Fetch one message by id with raw_card_content delivery (GET
   * im/v1/messages/{id}); undefined when the message is unreadable. Backs
   * the quoted-message reply-chain fetch.
   */
  getMessage?(params: { messageId: string }): Promise<FeishuQuotedMessage | undefined>
  /** Fetch the bot's own identity (GET /open-apis/bot/v3/info, bare HTTP). */
  getBotInfo?(): Promise<{ openID: string; avatarURL: string; appName: string }>
}

/** Inbound im.message.receive_v1 payload (structural slice). */
export interface FeishuReceiveEvent {
  message: {
    message_id?: string
    chat_id?: string
    message_type?: string
    content?: string
    chat_type?: string
    create_time?: string
    mentions?: FeishuMention[]
    root_id?: string
    thread_id?: string
    parent_id?: string
  }
  sender: {
    sender_id?: { open_id?: string }
  }
}

/**
 * card.action.trigger callback response replacing the pressed card in place
 * (Go callback.CardActionTriggerResponse with a raw card payload). The WS
 * dispatcher's handler return value travels back to Feishu as the callback
 * response, which swaps the card the user pressed.
 */
export interface CardActionCallbackResponse {
  card: { type: 'raw'; data: FeishuCardMap }
}

/**
 * Every question of one ask card, captured at send time (B2 replaces the
 * Go single-question askqMeta): form_submit callbacks carry no action.value
 * and button-click callbacks only the clicked option, so the platform caches
 * the full question set (mirroring permBodyCache) and reads it back to
 * rebuild the card with answered questions frozen.
 */
interface AskCardMeta {
  /** Card title as sent. */
  title: string
  /** All questions in ask order. */
  questions: UserQuestion[]
}

/**
 * Extract one ask card's questions from the core card model: single-select
 * rows carry `askq:{q}:{n}` button values, multi-select forms carry
 * `askq_multi:{q}` actions — both keyed by their question index.
 * @param card - The ask card being sent.
 * @returns The extracted question set, or undefined when the card carries no ask questions.
 */
function askCardMeta(card: Card): AskCardMeta | undefined {
  const title = card.header?.title ?? ''
  const questions = new Map<number, UserQuestion>()
  for (const elem of card.elements) {
    if (elem.kind === 'listItem' && elem.btnValue.startsWith('askq:')) {
      const sel = parseAskqSelection(elem.btnValue)
      if (sel === undefined) continue
      const q = questions.get(sel.qIdx) ?? { question: '', header: '', options: [], multiSelect: false }
      if (q.question === '') q.question = elem.extra?.askq_question ?? ''
      const optIdx = (sel.indices[0] ?? 1) - 1
      q.options[optIdx] = { label: elem.text, description: elem.description ?? '' }
      questions.set(sel.qIdx, q)
    } else if (elem.kind === 'checkOptions' && (elem.action ?? '').startsWith('askq_multi:')) {
      const qIdx = Number.parseInt((elem.action ?? '').slice('askq_multi:'.length), 10)
      if (!Number.isInteger(qIdx) || qIdx < 0) continue
      questions.set(qIdx, {
        question: elem.extra?.askq_question ?? elem.question ?? '',
        header: '',
        options: elem.options.map(o => ({ label: o.label, description: o.description ?? '' })),
        multiSelect: true,
      })
    }
  }
  if (questions.size === 0) return undefined
  const ordered: UserQuestion[] = []
  for (const [i, q] of [...questions.entries()].sort((a, b) => a[0] - b[0])) {
    ordered[i] = q
  }
  return { title, questions: ordered }
}

/**
 * Build the callback card replacement for one answered question of a
 * multi-question ask card: answered questions render frozen with their
 * selection marked, unanswered ones stay interactive, so the remaining
 * questions remain clickable while the choice stays reviewable (B2 replaces
 * the Go single-question frozen card).
 * @param sessionKey - Session key stamped into the rendered card.
 * @param meta - The cached question set of the ask card.
 * @param answered - Selected option indices per answered question index.
 * @returns The callback response replacing the pressed card.
 */
function buildAskCardResponse(
  sessionKey: string,
  meta: AskCardMeta,
  answered: Map<number, number[]>,
): CardActionCallbackResponse {
  const card = buildAskQuestionsCard(meta.title, meta.questions, answered)
  return { card: { type: 'raw', data: renderCardMap(card, sessionKey) } }
}

/**
 * Inbound card.action.trigger payload (structural slice). Fields sit at the
 * ROOT of the parsed WS payload — the same flattened convention as
 * {@link FeishuReceiveEvent} (SDK RequestHandle.parse unwraps the v2
 * envelope's `event` object and passes keys through unmodified; the root
 * nesting was confirmed against live payloads, the `form_value` key name
 * against the Go SDK's card event struct json tag).
 */
export interface CardActionTriggerEvent {
  action?: {
    value?: Record<string, string>
    option?: string
    name?: string
    form_value?: Record<string, unknown>
  }
  /** Wire keys are snake_case (live payload: open_id). */
  operator?: { open_id?: string }
  /** Wire keys are snake_case (live payload: open_chat_id, open_message_id). */
  context?: { open_chat_id?: string; open_message_id?: string }
}

/** Inbound im.chat.updated_v1 payload (structural slice, root-level like FeishuReceiveEvent). */
export interface FeishuChatUpdatedEvent {
  chat_id?: string
  after_change?: { name?: string; avatar?: string }
}

/** Inbound im.message.recalled_v1 payload (structural slice, root-level snake_case). */
export interface FeishuRecallEvent {
  message_id?: string
  chat_id?: string
}

/** Handle for an in-place editable preview card (Go feishuPreviewHandle). */
export class FeishuPreviewHandle {
  /** Message id of the sent preview card. */
  readonly messageID: string
  /** Chat the preview card was sent to. */
  readonly chatID: string
  /** Session the preview card belongs to. */
  readonly sessionKey: string

  constructor(messageID: string, chatID: string, sessionKey: string) {
    this.messageID = messageID
    this.chatID = chatID
    this.sessionKey = sessionKey
  }

  /**
   * Stable per-turn key for associating exported content (Go ExportKey).
   * @returns The handle's message id.
   */
  exportKey(): string {
    return this.messageID
  }
}

/** Platform construction options. */
export interface FeishuPlatformOptions {
  appID: string
  appSecret: string
  /** Session-key prefix and platform name (multi-bot deployments differ). */
  tag?: string
  allowFrom?: string
  allowChat?: string
  groupReplyAll?: boolean
  groupOnly?: boolean
  shareSessionInChannel?: boolean
  threadIsolation?: boolean
  noReplyToTrigger?: boolean
  respondToAtEveryoneAndHere?: boolean
  /** The bot's own open_id; empty disables the group @-gate (startup probe fills it). */
  botOpenID?: string
  /** Spawned-chat predicate (M4 wires the real store; default: none). */
  isSpawnedChat?: (chatID: string) => boolean
  /** Outbound API client; defaults to the node-sdk-backed client. */
  apiClient?: FeishuApiClient
  /**
   * WS bootstrap receiving the raw-event callback; defaults to WSClient.
   * Resolves to a close handle for the transport when it owns one (test
   * fakes may resolve undefined); `stop()` closes the connection through it.
   */
  wsStart?: (onRawEvent: (eventType: string, data: unknown) => unknown) => Promise<void | WsClose>
  /** Interactive cards and preview PATCHes (Go enable_feishu_card; default true). */
  useInteractiveCard?: boolean
  /** "legacy" (default), "compact", or "card" (Go progress_style). */
  progressStyle?: string
  /** ✅ push notification after in-place completion (Go notify_on_complete). */
  notifyOnComplete?: boolean
  /** Emoji reactions (empty or "none" disables the respective reaction). */
  reactionEmoji?: string
  doneEmoji?: string
  cancelEmoji?: string
  /** Top-notice banner on the first turn's message (Go topnotice_first_message). */
  topNoticeFirstMessage?: boolean
  /** Accumulate messages into the chat's pin panel (Go pin_user_messages). */
  pinUserMessages?: boolean
  /** Running-state header GIF on progress cards (Go progress_spinner; default true). */
  progressSpinner?: boolean
  /** Global PATCH rate-limit refill interval in ms (default 120 ≈ 8 PATCH/s, burst 3). */
  patchRateIntervalMs?: number
  /** Data directory for persisted state (Go cc_data_dir); empty disables persistence. */
  dataDir?: string
  /**
   * Shared directory for this bot's tag-id cache (Go kept every bot's
   * `<project>_feishu_tag_cache.json` in one shared sessions dir, which is what
   * makes the sibling-cache id fallback work across bots of one tenant). Falls
   * back to `<dataDir>/sessions` when absent.
   */
  tagCacheDir?: string
  /** Project name seeding cache file names and the active-tag fallback (Go cc_project). */
  projectName?: string
  /** Working directory seeding the spawned-chat dir tag (Go cc_work_dir). */
  workDir?: string
  /** Explicit active-tag name override skipping heart-candidate fallthrough (Go active_tag_name). */
  activeTagOverride?: string
  /** Pre-resolved bot avatar image key (startup upload fills this at runtime). */
  botAvatarKey?: string
  /** Pre-resolved grayscaled bot avatar key (startup upload fills this at runtime). */
  botAvatarKeyGray?: string
  /** Pre-seeded bot display name (app_name); the startup bot-info probe fills it at runtime. */
  botDisplayName?: string
}

/** Feishu reply API code for a recalled/withdrawn target message. */
const feishuCodeMessageWithdrawn = 230011

function isThreadSessionKey(sessionKey: string): boolean {
  // Go strings.SplitN(key, ":", 3): the third field is the REMAINDER, which
  // JS split(limit) truncates — slice-join instead so "thread:x" survives.
  const parts = sessionKey.split(':')
  if (parts.length < 3) return false
  const tail = parts.slice(2).join(':')
  if (!tail.startsWith('root:') && !tail.startsWith('thread:')) return false
  return tail.slice(tail.indexOf(':') + 1) !== ''
}

/**
 * Checked option indices from a multi-select askq form submission (Go
 * collectAskqMultiSelectedFromFormValue): form_value keys follow askq_opt_{N}
 * with a truthy value when checked. Sorted numerically (Go sorted the index
 * strings, which misorders 10 before 2 — harmless there, fixed here).
 */
function collectAskqMultiSelected(formValue: Record<string, unknown> | undefined): string[] {
  if (formValue === undefined) return []
  const indices: number[] = []
  for (const [key, raw] of Object.entries(formValue)) {
    if (!key.startsWith('askq_opt_')) continue
    const idx = Number.parseInt(key.slice('askq_opt_'.length), 10)
    if (!Number.isFinite(idx)) continue
    // Live form_value checkbox entries may arrive as strings or booleans
    // (Go received any); coerce before the truthiness check.
    const v = String(raw).trim()
    if (v !== '' && v !== '0' && v.toLowerCase() !== 'false') indices.push(idx)
  }
  indices.sort((a, b) => a - b)
  return indices.map(String)
}

/**
 * Feishu (Lark) platform over one app's long connection (Go Platform).
 */
export class FeishuPlatform implements Platform {
  private readonly opts: Required<Pick<FeishuPlatformOptions, 'appID' | 'appSecret'>>
  private readonly o: FeishuPlatformOptions
  private readonly dedup = new MessageDedup()
  private handler: MessageHandler | undefined
  private api: FeishuApiClient | undefined
  private wsStarted = false
  private wsClose: WsClose | undefined

  /** Interactive cards enabled (enable_feishu_card). */
  readonly useInteractiveCard: boolean
  /** Validated progress style ("legacy" | "compact" | "card"). */
  readonly progressStyle: string
  /** ✅ notifications enabled (notify_on_complete). */
  readonly notifyOnComplete: boolean
  /** Configured reaction emoji (reaction_emoji). */
  readonly reactionEmoji: string
  /** Configured completion emoji (done_emoji). */
  readonly doneEmoji: string
  /** Configured stop emoji (cancel_emoji). */
  readonly cancelEmoji: string
  /** Top-notice banner enabled (topnotice_first_message). */
  readonly topNoticeEnabled: boolean
  /** Pin panel enabled (pin_user_messages). */
  readonly pinEnabled: boolean
  /** Running-state header GIF enabled (progress_spinner); observable for assembly tests. */
  readonly spinnerEnabled: boolean
  /** Global limiter for every card PATCH entry point. */
  private readonly patchRL: TokenBucketRateLimiter

  /** messageID → pre-button card JSON (stop-card rebuild + render-status rebuild). */
  private readonly lastProgressCard = new Map<string, string>()
  /** messageID → latest render status text (#48 survival). */
  private readonly renderStatusText = new Map<string, string>()
  /** sessionKey → permission card body (M3 card-action replacement). */
  readonly permBodyCache = new Map<string, string>()
  /** sessionKey → the ask card's full question set, cached at send time to rebuild the card on callbacks. */
  readonly askqMetaCache = new Map<string, AskCardMeta>()
  /** messageID → answered question indices with selections; dedups repeated callbacks per question. */
  readonly askqAnswered = new Map<string, Map<number, number[]>>()
  /** sessionKey → messageID tracked from card-action callbacks (M3 writes it). */
  readonly cardActionMsgIDs = new Map<string, string>()
  /** Engine callback for group renames (im.chat.updated_v1, Go chatRenamedHandler). */
  private chatRenamedHandler: ((sessionKey: string, newName: string) => void) | undefined
  /** Engine callback for group name/avatar changes (Go chatChangedHandler). */
  private chatChangedHandler: ((sessionKey: string) => void) | undefined
  /** Engine export-content lookup for the 📄/💬 buttons (Go exportHandler). */
  private exportHandler: ((sessionKey: string, exportKey: string) => { text: string; ok: boolean }) | undefined
  /** Engine callback for message recalls (im.message.recalled_v1, Go recallHandler, #30). */
  private recallHandler: ((messageID: string) => void) | undefined

  private hintClickHandler: ((hintText: string, category: 'hints' | 'hints_with_param' | 'hints_common') => void) | undefined

  private spinnerOnce: Promise<void> | undefined
  private thinkingImgKey = ''
  private executingImgKey = ''

  /** Spawned-chat registry (loaded from dataDir when set). */
  readonly spawnStore: SpawnedChatStore
  /** Tag manager bound to this platform's API client. */
  private readonly tagManager: TagManager
  /** Chat-name TTL cache (Go chatNameCache). */
  /** Chat-name TTL cache (Go chatNameCache; rename events refresh it). */
  readonly chatNames = new ChatNameCache()
  /** Bot avatar image keys, filled by the startup probe when it runs. */
  private botAvatarKey: string
  private botAvatarKeyGray: string
  /** The bot's app_name (Go botDisplayName); labels the bot's p2p chat on jump buttons. */
  private displayName: string
  /** Document frequency of words across workspace project names (Go dirWordFreq). */
  private dirWordFreq: Record<string, number> = {}
  /** #53: comma-separated monitored chat IDs, or "*"; "" = monitor off (Go monitorChats). */
  private monitorChats = ''
  /** #53: open_id owning subgroups spawned for sender-less webhook cards (Go monitorFallbackUser). */
  private monitorFallbackUser = ''
  /** One-shot cache/store load + dir-tag derivation. */
  private initOnce: Promise<void> | undefined

  constructor(options: FeishuPlatformOptions) {
    this.opts = { appID: options.appID, appSecret: options.appSecret }
    this.o = options
    this.useInteractiveCard = options.useInteractiveCard !== false
    this.progressStyle = parseProgressStyle(options.tag ?? 'feishu', options.progressStyle ?? '')
    this.notifyOnComplete = options.notifyOnComplete === true
    this.reactionEmoji = options.reactionEmoji === 'none' ? '' : options.reactionEmoji ?? ''
    this.doneEmoji = options.doneEmoji ?? ''
    this.cancelEmoji = options.cancelEmoji ?? ''
    this.topNoticeEnabled = options.topNoticeFirstMessage === true
    this.pinEnabled = options.pinUserMessages === true
    this.spinnerEnabled = options.progressSpinner !== false
    this.patchRL = new TokenBucketRateLimiter(options.patchRateIntervalMs ?? 120, 3)
    this.botAvatarKey = options.botAvatarKey ?? ''
    this.botAvatarKeyGray = options.botAvatarKeyGray ?? ''
    this.displayName = options.botDisplayName ?? ''
    const projectName = options.projectName !== undefined && options.projectName !== '' ? options.projectName : this.name()
    // State files are keyed by project name only. Folding the platform tag
    // into these filenames made every feishu.tag rename start the tag-id
    // cache and spawn registry from an empty file, silently losing every
    // bindable tag id this app had resolved. Legacy bases cover the two
    // historical shapes (current platform tag, pre-tag 'feishu'); renames
    // beyond those are not migrated.
    const base = projectName
    const legacyBases = [...new Set([`${projectName}_${this.name()}`, `${projectName}_feishu`])]
      .filter(b => b !== base)
    const dataDir = options.dataDir ?? ''
    const sessionsDir = dataDir === '' ? '' : join(dataDir, 'sessions')
    this.spawnStore = new SpawnedChatStore(
      sessionsDir === '' ? '' : join(sessionsDir, `${base}_spawned.json`),
      sessionsDir === '' ? [] : legacyBases.map(b => join(sessionsDir, `${b}_spawned.json`)),
    )
    // The tag cache is tenant-shared state (sibling lookup reuses ids created
    // by other bots), unlike the spawned registry which is this bot's private
    // state — hence the separate directory.
    const tagCacheDir = options.tagCacheDir ?? sessionsDir
    this.tagManager = new TagManager({
      api: this.tagApi(),
      tagCacheFile: tagCacheDir === '' ? '' : join(tagCacheDir, `${base}_tag_cache.json`),
      legacyTagCacheFiles: tagCacheDir === '' ? [] : legacyBases.map(b => join(tagCacheDir, `${b}_tag_cache.json`)),
      projectName,
      ...(options.activeTagOverride !== undefined ? { activeTagOverride: options.activeTagOverride } : {}),
      spawnedChatIDs: () => this.spawnStore.chatIDs(),
    })
  }

  /** Platform name (session-key prefix). */
  name(): string {
    return this.o.tag ?? 'feishu'
  }

  /**
   * The bot's display name (app_name), or '' before the probe resolves (Go BotDisplayName).
   * @returns The resolved app_name, or an empty string before the startup probe runs.
   */
  botDisplayName(): string {
    return this.displayName
  }

  private tag(): string {
    return this.name()
  }

  /**
   * Open the long connection and register the inbound dispatcher. The
   * im.message.receive_v1 surface is wired; card.action.trigger arrives
   * with the card-action milestone.
   */
  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler
    if (this.wsStarted) return
    this.wsStarted = true
    await this.ensureInit()
    // Bot identity probe (Go fetchBotOpenID): fills botOpenID when not
    // configured and kicks off the avatar upload. Production startup runs it
    // against the real API; an injected apiClient or wsStart marks a
    // unit-test platform whose fakes must stay offline.
    if (this.o.apiClient === undefined && this.o.wsStart === undefined) {
      await this.probeBotInfo()
    }
    const wsStart = this.o.wsStart ?? (onRawEvent => defaultWsStart(this.opts.appID, this.opts.appSecret, onRawEvent))
    this.wsClose = (await wsStart((eventType, data) => {
      if (eventType === 'im.message.receive_v1') {
        this.onMessage(data as FeishuReceiveEvent)
        return undefined
      }
      if (eventType === 'card.action.trigger') {
        return this.onCardAction(data as CardActionTriggerEvent)
      }
      if (eventType === 'im.chat.updated_v1') {
        this.onChatUpdated(data as FeishuChatUpdatedEvent)
        return undefined
      }
      if (eventType === 'im.message.recalled_v1') {
        this.onMessageRecalled(data as FeishuRecallEvent)
      }
      return undefined
    })) ?? undefined
  }

  /** Fetch the bot's identity and upload its avatar pair (best-effort). */
  private async probeBotInfo(): Promise<void> {
    const client = await this.ensureApi()
    if (client.getBotInfo === undefined) return
    try {
      const info = await this.request('bot info', (c) => {
        if (c.getBotInfo === undefined) throw new ErrNotSupported('feishu client without bot info support')
        return c.getBotInfo()
      })
      if ((this.o.botOpenID ?? '') === '' && info.openID !== '') {
        this.o.botOpenID = info.openID
      }
      if (info.appName !== '') this.displayName = info.appName
      if (info.avatarURL !== '') {
        void this.uploadBotAvatars(info.avatarURL)
      }
    } catch (err) {
      console.warn(`${this.tag()}: failed to get bot open_id, group chat filtering disabled: ${String(err)}`)
    }
  }

  /**
   * Load persisted caches and derive the dir tag from the work dir. Runs once,
   * awaited by start() and by every spawn/tag entry point so direct method
   * calls (tests, tools) see loaded state.
   */
  private ensureInit(): Promise<void> {
    this.initOnce ??= this.init()
    return this.initOnce
  }

  private async init(): Promise<void> {
    await this.spawnStore.load()
    await this.tagManager.load()
    const wd = this.o.workDir ?? ''
    if (wd !== '') {
      this.dirWordFreq = await buildDirWordFreq(dirname(wd))
      this.tagManager.dirTagName = pickDirTagName(basename(wd), this.dirWordFreq)
    }
  }

  /**
   * Close the WS transport. Cordis HMR config reloads dispose the owning
   * engine and rebuild it — without this close, the old WSClient stays
   * connected and Feishu load-balances app events onto the zombie connection,
   * where they reach the disposed engine and vanish. Idempotent; a platform
   * that never started (or a test fake without a transport) is a no-op.
   */
  stop(): Promise<void> {
    const close = this.wsClose
    this.wsClose = undefined
    if (close !== undefined) close()
    return Promise.resolve()
  }

  /**
   * Handle one im.message.receive_v1 event (Go onMessage).
   * @param event - Raw im.message.receive_v1 payload.
   */
  onMessage(event: FeishuReceiveEvent): void {
    const msg = event.message
    const msgType = msg.message_type ?? ''
    const chatID = msg.chat_id ?? ''
    const userID = event.sender.sender_id?.open_id ?? ''
    const messageID = msg.message_id ?? ''

    if (this.dedup.isDuplicate(messageID)) return

    if (msg.create_time !== undefined) {
      const ms = Number.parseInt(msg.create_time, 10)
      if (Number.isFinite(ms) && isOldMessage(ms)) return
    }

    const chatType = msg.chat_type ?? ''
    const isSpawned = this.isSpawned(chatID)
    const isMonitor = this.isMonitorChat(chatID)
    // /monitor 命令豁免 @-drop，与下方 allow_chat 闸一致：让命令能从未监控新群发起（#53）
    const isMonitorCmd = isMonitorCommand(msg.content ?? '')
    // Group messages require an @bot mention unless group_reply_all is set.
    if (chatType === 'group' && this.o.groupReplyAll !== true && !isSpawned && !isMonitor && !isMonitorCmd
      && (this.o.botOpenID ?? '') !== '') {
      if (!isBotMentioned(msg.mentions, this.o.botOpenID ?? '')) {
        // Feishu @all sends {"text":"@_all"} with zero mentions.
        const content = msg.content ?? ''
        if (this.o.respondToAtEveryoneAndHere === true && content.includes('@_all')) {
          // respond to @all
        } else {
          return
        }
      }
    }

    // A spawned-group message that @mentions a human is not for the bot.
    if (isSpawned && hasHumanMention(msg.mentions)) return

    if (!AllowList(this.o.allowFrom ?? '', userID)) return
    if (chatType === 'group' && !AllowList(this.o.allowChat ?? '', chatID) && !isSpawned && !isMonitor && !isMonitorCmd) return
    if (chatType !== 'group' && this.o.groupOnly === true) return

    if (msg.content === undefined) return

    const content = msg.content
    const mentions = msg.mentions
    const parentID = msg.parent_id ?? ''
    const sessionKey = this.makeSessionKey(msg, chatID, userID)
    const replyCtx: FeishuReplyContext = { messageID, chatID, sessionKey }

    if (msgType === 'text') {
      let text = ''
      try {
        text = (JSON.parse(content) as { text?: string }).text ?? ''
      } catch {
        console.error('feishu: failed to parse text content')
        return
      }
      text = stripMentions(text, mentions, this.o.botOpenID ?? '')
      if (text === '') return
      void this.dispatchWithQuote(sessionKey, messageID, userID, chatID, chatType, text, replyCtx, isSpawned, parentID)
      return
    }
    if (msgType === 'post') {
      void this.dispatchPostMessage(sessionKey, messageID, userID, chatID, chatType, content, mentions, replyCtx, isSpawned, parentID)
      return
    }
    if (msgType === 'file') {
      // Downloads run off the SDK event loop; a failure replies directly
      // rather than waking the agent (Go dispatchMessage file branch).
      void this.dispatchFileMessage(sessionKey, messageID, userID, chatID, chatType, content, replyCtx, isSpawned)
      return
    }
    if (msgType === 'image') {
      void this.dispatchImageMessage(sessionKey, messageID, userID, chatID, chatType, content, replyCtx, isSpawned)
      return
    }
  }

  /** File-message branch of Go dispatchMessage: download then attach. */
  private async dispatchFileMessage(
    sessionKey: string,
    messageID: string,
    userID: string,
    chatID: string,
    chatType: string,
    content: string,
    replyCtx: FeishuReplyContext,
    isSpawned: boolean,
  ): Promise<void> {
    let fileBody: { file_key?: string; file_name?: string }
    try {
      fileBody = JSON.parse(content) as { file_key?: string; file_name?: string }
    } catch {
      console.error('feishu: failed to parse file content')
      return
    }
    try {
      const fileData = await this.downloadMessageResource(messageID, fileBody.file_key ?? '', 'file')
      const file: FileAttachment = {
        mimeType: detectMimeType(fileData),
        data: fileData,
        fileName: fileBody.file_name ?? '',
      }
      this.dispatch(sessionKey, messageID, userID, chatID, chatType, '', '', replyCtx, isSpawned, '', false, false, [], [file])
    } catch (err) {
      console.error(`${this.tag()}: download file failed: ${String(err)}`)
      await this.replyDownloadError(replyCtx, '文件', fileBody.file_name ?? '')
    }
  }

  /** Image-message branch of Go dispatchMessage: download then attach. */
  private async dispatchImageMessage(
    sessionKey: string,
    messageID: string,
    userID: string,
    chatID: string,
    chatType: string,
    content: string,
    replyCtx: FeishuReplyContext,
    isSpawned: boolean,
  ): Promise<void> {
    let imgBody: { image_key?: string }
    try {
      imgBody = JSON.parse(content) as { image_key?: string }
    } catch {
      console.error('feishu: failed to parse image content')
      return
    }
    try {
      const [data, mimeType] = await this.downloadImage(messageID, imgBody.image_key ?? '')
      const image: ImageAttachment = { mimeType, data }
      this.dispatch(sessionKey, messageID, userID, chatID, chatType, '', '', replyCtx, isSpawned, '', false, false, [image], [])
    } catch (err) {
      console.error(`${this.tag()}: download image failed: ${String(err)}`)
      await this.replyDownloadError(replyCtx, '图片', '')
    }
  }

  /**
   * Post-message branch of Go dispatchMessage: image+text combined arrives as
   * a rich-text post. The text is extracted with `[image]` placeholders and
   * every embedded image is downloaded and attached, exactly like a pure
   * image message.
   */
  private async dispatchPostMessage(
    sessionKey: string,
    messageID: string,
    userID: string,
    chatID: string,
    chatType: string,
    content: string,
    mentions: FeishuMention[] | undefined,
    replyCtx: FeishuReplyContext,
    isSpawned: boolean,
    parentID: string,
  ): Promise<void> {
    const text = stripMentions(extractPostPlainText(content), mentions, this.o.botOpenID ?? '')
    if (text === '') return
    const images = await this.downloadPostImages(messageID, content)
    await this.dispatchWithQuote(sessionKey, messageID, userID, chatID, chatType, text, replyCtx, isSpawned, parentID, images)
  }

  /**
   * Fetch images embedded in a post message by key, mirroring
   * {@link FeishuPlatform.downloadCardImages}: capped so a post with many
   * images can't flood downloads; a failed download is logged and skipped —
   * the text still flows through.
   */
  private async downloadPostImages(messageID: string, content: string): Promise<ImageAttachment[]> {
    if (messageID === '') return []
    const keys = extractPostImageKeys(content)
    if (keys.length === 0) return []
    const maxPostImages = 9
    const capped = keys.slice(0, maxPostImages)
    if (keys.length > maxPostImages) {
      console.warn(`${this.tag()}: post has many images, truncating (want=${keys.length} kept=${maxPostImages})`)
    }
    const out: ImageAttachment[] = []
    for (const key of capped) {
      try {
        const [data, mimeType] = await this.downloadImage(messageID, key)
        out.push({ mimeType, data })
      } catch (error) {
        console.warn(`${this.tag()}: download post image failed (key=${key}): ${String(error)}`)
      }
    }
    return out
  }

  /**
   * Handle one card.action.trigger callback (Go onCardAction). Parses
   * perm:/askq:/act: action values and dispatches synthetic messages with the
   * matching flag so the engine routes them: permission responses to
   * handlePendingPermission, act: button presses (the worktree Keep/Remove
   * card) to the card-action handler. The perm: branch additionally returns a
   * card response so Feishu replaces the pressed card with the resolved
   * state (Go returns it in the callback response).
   * @param event - Raw card.action.trigger payload.
   * @returns The callback response replacing the pressed card, undefined when
   *   the action produces no card update.
   */
  onCardAction(event: CardActionTriggerEvent): CardActionCallbackResponse | undefined {
    const action = event.action
    if (action === undefined) return
    let chatID = event.context?.open_chat_id ?? ''
    const messageID = event.context?.open_message_id ?? ''
    const userID = event.operator?.open_id ?? ''
    if (chatID === '') chatID = userID

    // Allow-chat filter
    if (chatID !== '' && !AllowList(this.o.allowChat ?? '', chatID)) return

    // Resolve action value from value map, option, or button name
    let actionVal = action.value?.action ?? ''
    if (actionVal === '' && action.option !== '') actionVal = action.option ?? ''
    let hintButton = false
    let hintClick: { category: 'hints' | 'hints_with_param' | 'hints_common'; hintText: string } | undefined
    if (actionVal === '') {
      const name = action.name ?? ''
      if (name === 'perm_allow') actionVal = 'perm:allow'
      else if (name === 'perm_deny') actionVal = 'perm:deny'
      else if (name === 'perm_allow_all') actionVal = 'perm:allow_all'
      else if (name.startsWith('askq_multi_submit_')) actionVal = `askq_multi:${name.slice('askq_multi_submit_'.length)}`
      else if (name.startsWith('askq_') && name !== 'askq_multi_submit_') {
        // Single-select askq button: value carries "askq:qIdx:optIdx"
        actionVal = action.value?.action ?? name
      } else if (name.startsWith('hint__')) {
        // Hint form submit (Go feishu_dispatch.go): the callback omits
        // action.value, so the command is recovered from the button name.
        const parsed = parseHintButtonName(name)
        if (parsed !== undefined) {
          hintButton = true
          hintClick = { category: hintCategoryOfCode(parsed.category), hintText: parsed.hintText }
          actionVal = `cmd:${parsed.hintText}`
        }
      }
    }
    if (actionVal === '') return

    const sessionKey = this.sessionKeyFromCardAction(chatID, userID, action.value ?? {})
    const replyCtx: FeishuReplyContext = { messageID, chatID, sessionKey }
    const isSpawned = this.isSpawned(chatID)

    // act: → synchronous card action; nav: → page-turn-only card action (Go
    // runs both in the callback response and returns the updated card; the
    // async TS dispatch instead PATCHes the recorded message id from the
    // engine's card-action handler, which distinguishes the prefixes).
    if (actionVal.startsWith('act:') || actionVal.startsWith('nav:')) {
      if (messageID !== '') this.cardActionMsgIDs.set(sessionKey, messageID)
      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        actionVal, '', replyCtx, isSpawned, '', false, false, [], [], true)
      return
    }

    // perm: → permission response with in-place card update (Go
    // feishu_dispatch.go perm branch): the resolved card rides back as the
    // callback response so the pressed card swaps to the outcome state. The
    // structured perm: payload rides the dispatch verbatim (B2: the card
    // path never consults the keyword tables), with the card-input note
    // packed after the NUL separator.
    if (actionVal.startsWith('perm:')) {
      const rawNote = action.form_value?.perm_note
      const note = typeof rawNote === 'string' ? rawNote.trim() : ''
      if (actionVal !== 'perm:allow' && actionVal !== 'perm:deny' && actionVal !== 'perm:allow_all') {
        return undefined
      }
      const content = note !== '' ? `${actionVal}\x00${note}` : actionVal

      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        content, '', replyCtx, isSpawned, '', true, false)

      let permLabel = action.value?.perm_label ?? ''
      let permColor = action.value?.perm_color ?? ''
      let permBody = action.value?.perm_body ?? ''
      if (permLabel === '') {
        // form_submit callbacks omit action.value; build the response from
        // the determined action.
        if (actionVal === 'perm:allow') {
          permLabel = '✅ 已允许'
          permColor = 'green'
        } else if (actionVal === 'perm:deny') {
          permLabel = '❌ 已拒绝'
          permColor = 'red'
          if (note !== '') permBody = `> ${note}`
        } else {
          permLabel = '✅ 已全部允许'
          permColor = 'green'
        }
      }
      if (permBody === '') permBody = this.permBodyCache.get(sessionKey) ?? ''
      // Deviates from Go (which deletes only when it read the cache): the
      // entry is consumed either way, so a stale body never leaks into the
      // next permission card.
      this.permBodyCache.delete(sessionKey)
      // An allow/allow_all note rides as a quoted supplement under the
      // resolved body (deny replaced the body outright above).
      if (actionVal !== 'perm:deny' && note !== '') {
        permBody = permBody === '' ? `> ${note}` : `${permBody}\n\n> ${note}`
      }
      if (permColor === '') permColor = 'green'
      const cb = newCard().title(permLabel, permColor)
      if (permBody !== '') cb.markdown(permBody)
      return { card: { type: 'raw', data: renderCardMap(cb.build(), sessionKey) } }
    }

    // askq: → one question's answer on the ask card (B2 multi-question card):
    // a multi-select form submit collects its checked indices from form_value
    // (Go collectAskqMultiSelectedFromFormValue) into the same converged
    // askq:{q}:{i1},{i2} payload a single-select button carries. The callback
    // response rebuilds the card with the answered question frozen and the
    // rest still interactive; the cache entry drops once every question is
    // answered (the card stops being interactive).
    if (actionVal.startsWith('askq:') || actionVal.startsWith('askq_multi:')) {
      if (actionVal.startsWith('askq_multi:') && !actionVal.slice('askq_multi:'.length).includes(':')) {
        const indices = collectAskqMultiSelected(action.form_value)
        actionVal += `:${indices.join(',')}`
      }
      const sel = parseAskqSelection(actionVal)
      if (sel === undefined) return undefined
      // Dedup per card message and question: a double-click or a Feishu
      // callback retry would otherwise forward the same question's answer
      // twice; a NEW click on an answered question updates it.
      let answered: Map<number, number[]>
      if (messageID !== '') {
        const prior = this.askqAnswered.get(messageID)
        if (prior !== undefined && prior.has(sel.qIdx)) return undefined
        answered = new Map(prior ?? [])
        answered.set(sel.qIdx, sel.indices)
        this.askqAnswered.set(messageID, answered)
      } else {
        answered = new Map([[sel.qIdx, sel.indices]])
      }
      const content = `askq:${String(sel.qIdx)}:${sel.indices.join(',')}`
      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        content, '', replyCtx, isSpawned, '', false, true)

      const meta = this.askqMetaCache.get(sessionKey)
      if (meta === undefined) return undefined
      if (meta.questions.every((_q, i) => answered.has(i))) this.askqMetaCache.delete(sessionKey)
      return buildAskCardResponse(sessionKey, meta, answered)
    }

    // cmd: → command shortcut from a card button; forward as a message
    // (Go bridge.go: the /learn list's delete buttons use this; hint buttons
    // append their input field's value and echo the command back).
    if (actionVal.startsWith('cmd:')) {
      let cmdText = actionVal.slice('cmd:'.length)
      const fv = action.form_value
      if (fv !== undefined) {
        const argName = action.value?._arg
        if (argName !== undefined && argName !== '') {
          const arg = fv[argName]
          if (typeof arg === 'string' && arg !== '') cmdText += ` ${arg}`
        } else {
          for (const v of Object.values(fv)) {
            if (typeof v === 'string' && v !== '') {
              cmdText += ` ${v}`
              break
            }
          }
        }
      }
      if (hintButton) {
        if (hintClick !== undefined && this.hintClickHandler !== undefined) {
          this.hintClickHandler(hintClick.hintText, hintClick.category)
        }
        const echoText = cmdText
        const echoCtx = { chatID, sessionKey } as FeishuReplyContext
        void this.reply(echoCtx, echoText).catch((error: unknown) => {
          console.warn(`${this.tag()}: hint echo failed: ${String(error)}`)
        })
      }
      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        cmdText, '', replyCtx, isSpawned, '')
      return
    }

    // export: → send the cached reply/plan text as a .md file attachment
    // (Go feishu_dispatch.go export branch, Go SafeGo → floating promise).
    if (actionVal.startsWith('export:')) {
      const exportKey = actionVal.slice('export:'.length)
      void (async () => {
        if (this.exportHandler === undefined) {
          console.warn('export: no handler registered')
          return
        }
        const { text, ok } = this.exportHandler(sessionKey, exportKey)
        if (!ok || text === '') {
          await this.reply(replyCtx, '导出失败：未找到对应内容，可能会话已过期')
          return
        }
        const namePrefix = exportKey.startsWith('plan:') ? 'plan' : 'reply'
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6})/, '$1_$2')
        await this.sendFile(replyCtx, {
          mimeType: 'text/markdown',
          data: new TextEncoder().encode(text),
          fileName: `${namePrefix}_${stamp}.md`,
        }).catch((error: unknown) => {
          console.warn(`export file send failed: ${String(error)}`)
        })
      })()
      return
    }

    // sendreply: → send the cached full reply as new chat messages (sibling
    // of export:, Go feishu_dispatch.go sendreply branch).
    if (actionVal.startsWith('sendreply:')) {
      const exportKey = actionVal.slice('sendreply:'.length)
      void (async () => {
        if (this.exportHandler === undefined) {
          console.warn('sendreply: no handler registered')
          return
        }
        const { text, ok } = this.exportHandler(sessionKey, exportKey)
        if (!ok || text === '') {
          await this.reply(replyCtx, '未找到对应内容，可能会话已过期')
          return
        }
        for (const chunk of splitMessage(text, MaxPlatformMessageLen)) {
          try {
            await this.reply(replyCtx, chunk)
          } catch (error) {
            console.warn(`sendreply: reply send failed: ${String(error)}`)
            break
          }
        }
      })()
      return
    }
  }

  /**
   * Session key for a card-action callback (Go sessionKeyFromCardAction): the
   * value's explicit session_key wins; otherwise spawned chats and
   * share_session_in_channel key on the chat alone, everything else on
   * chat+user — the same key an ordinary text message in that chat would use.
   * @param chatID - Chat the card action fired in.
   * @param userID - Open id of the user who triggered the action.
   * @param value - Action value map; an explicit session_key entry wins.
   * @returns The derived session key.
   */
  sessionKeyFromCardAction(chatID: string, userID: string, value: Record<string, string>): string {
    if (value.session_key !== undefined && value.session_key !== '') return value.session_key
    if (chatID !== '' && this.isSpawned(chatID)) return `${this.tag()}:${chatID}`
    if (this.o.shareSessionInChannel === true) return `${this.tag()}:${chatID}`
    return `${this.tag()}:${chatID}:${userID}`
  }

  /**
   * Handle one im.chat.updated_v1 event (Go onChatUpdated): a group rename
   * refreshes the chat-name cache and notifies the engine so jump-button
   * labels stay current; a name OR avatar change additionally notifies the
   * chat-changed handler so the engine can bump the active preview card back
   * to the chat tail (Feishu inserts a system notice that pushes it off).
   * Other changes (permissions, etc.) insert no notices and are skipped.
   * @param event - Raw im.chat.updated_v1 payload.
   */
  onChatUpdated(event: FeishuChatUpdatedEvent): void {
    const chatID = event.chat_id ?? ''
    const ac = event.after_change
    if (chatID === '' || ac === undefined) return
    const sessionKey = `${this.tag()}:${chatID}`

    if (ac.name !== undefined) {
      const newName = ac.name.trim()
      if (newName !== '') {
        this.chatNames.setName(chatID, newName)
        if (this.chatRenamedHandler !== undefined) {
          console.info(`${this.tag()}: chat renamed (chat ${chatID} → ${newName})`)
          this.chatRenamedHandler(sessionKey, newName)
        }
      }
    }

    if ((ac.name !== undefined || ac.avatar !== undefined) && this.chatChangedHandler !== undefined) {
      this.chatChangedHandler(sessionKey)
    }
  }

  /**
   * Register the engine callback invoked on group rename (Go SetChatRenamedHandler).
   * @param handler - Callback receiving the session key and the new chat name.
   */
  setChatRenamedHandler(handler: (sessionKey: string, newName: string) => void): void {
    this.chatRenamedHandler = handler
  }

  /**
   * Register the engine callback invoked on group name/avatar change (Go SetChatChangedHandler).
   * @param handler - Callback receiving the session key.
   */
  setChatChangedHandler(handler: (sessionKey: string) => void): void {
    this.chatChangedHandler = handler
  }

  /**
   * Register the engine's export-content lookup (Go SetExportHandler, Go ReplyExporter).
   * @param handler - Lookup returning the cached text for a session's export key.
   */
  setExportHandler(handler: (sessionKey: string, exportKey: string) => { text: string; ok: boolean }): void {
    this.exportHandler = handler
  }

  /**
   * Register the engine callback invoked on message recall (Go SetRecallHandler, #30).
   * @param handler - Callback receiving the recalled message id.
   */
  setRecallHandler(handler: (messageID: string) => void): void {
    this.recallHandler = handler
  }

  /**
   * Register the engine callback invoked on hint-button clicks (Go SetHintClickHandler).
   * @param handler - Callback receiving the hint text and its config category.
   */
  setHintClickHandler(handler: (hintText: string, category: 'hints' | 'hints_with_param' | 'hints_common') => void): void {
    this.hintClickHandler = handler
  }

  /**
   * Handle one im.message.recalled_v1 event (Go onMessageRecalled): forward
   * the recalled message id to the engine so it cancels the queued copy.
   * Fields sit at the ROOT of the parsed payload in snake_case (the live
   * flattened convention, same as card.action.trigger).
   * @param event - Raw im.message.recalled_v1 payload.
   */
  onMessageRecalled(event: FeishuRecallEvent): void {
    const messageID = event.message_id ?? ''
    if (messageID === '') return
    if (this.recallHandler === undefined) {
      console.warn(`${this.tag()}: recall handler not set — engine wiring regression`)
      return
    }
    this.recallHandler(messageID)
  }

  /** Whether the chat is /spawn-created (external predicate or the store). */
  private isSpawned(chatID: string): boolean {
    if (this.o.isSpawnedChat !== undefined) return this.o.isSpawnedChat(chatID)
    return this.spawnStore.isSpawned(chatID)
  }

  /**
   * Configure which chats are in monitor mode (#53, Go SetMonitorChats).
   * Pushed by the engine from [projects.monitor] chats. Empty = monitor off.
   * @param chats - Comma-separated chat IDs, or "*"; empty disables monitor mode.
   */
  setMonitorChats(chats: string): void {
    this.monitorChats = chats
  }

  /**
   * Set the open_id used as the subgroup owner when a polled monitored
   * message has no human sender (Go SetMonitorFallbackUser).
   * @param openID - open_id owning subgroup spawns for sender-less messages.
   */
  setMonitorFallbackUser(openID: string): void {
    this.monitorFallbackUser = openID
  }

  /**
   * Whether chatID is a monitored chat. Empty monitorChats means monitoring
   * is disabled (NOT "monitor all" — AllowList("") would wrongly pass
   * everything), so guard explicitly (Go isMonitorChat).
   */
  private isMonitorChat(chatID: string): boolean {
    if (this.monitorChats === '') return false
    return AllowList(this.monitorChats, chatID)
  }

  private dispatch(
    sessionKey: string,
    messageID: string,
    userID: string,
    _chatID: string,
    chatType: string,
    content: string,
    extraContent: string,
    replyCtx: FeishuReplyContext,
    isSpawnedGroup: boolean,
    parentMessageID: string,
    isPermissionAction = false,
    isAskqCardAction = false,
    images: ImageAttachment[] = [],
    files: FileAttachment[] = [],
    isCardAction = false,
    quoted?: { text: string; senderType: string; updateTimeMs: number },
  ): void {
    if (this.handler === undefined) return
    const message: Message = {
      sessionKey,
      platform: this.name(),
      messageID,
      userID,
      userName: '',
      chatName: '',
      chatType,
      content,
      originalContent: '',
      images,
      files,
      extraContent,
      replyCtx,
      fromVoice: false,
      isSpawnedGroup,
      isPermissionAction,
      isAskqCardAction,
      isCardAction,
      parentMessageID,
      quotedText: quoted?.text ?? '',
      ...(quoted !== undefined ? { quotedSenderType: quoted.senderType, quotedUpdateTimeMs: quoted.updateTimeMs } : {}),
    }
    // Async dispatch keeps the SDK event loop free of engine IO (Go SafeGo).
    void Promise.resolve().then(() => this.handler?.(this, message)).catch((error: unknown) => {
      console.error(`feishu: dispatch failed (${sessionKey}): ${String(error)}`)
    })
  }

  /**
   * Fetch the reply chain a text message quotes (when it is a reply) and
   * dispatch with the formatted prefix as extraContent (Go dispatchMessage's
   * quoted-prefix block). Skipped inside isolated threads — the thread
   * already carries the context and a long prefix would drown the user's
   * text — except in monitored chats: they never run an agent session, so
   * the quote is /learn's data, not context the session already holds. Any
   * fetch failure degrades to dispatching without the quote. Downloaded
   * attachments (post-embedded images) ride along unchanged.
   * @param images - Downloaded images to attach, e.g. a post's embedded images.
   */
  private async dispatchWithQuote(
    sessionKey: string,
    messageID: string,
    userID: string,
    chatID: string,
    chatType: string,
    text: string,
    replyCtx: FeishuReplyContext,
    isSpawned: boolean,
    parentID: string,
    images: ImageAttachment[] = [],
  ): Promise<void> {
    let prefix = ''
    let quoted: ChainMessage | undefined
    if (parentID !== '' && !(this.o.threadIsolation === true && isThreadSessionKey(sessionKey) && !this.isMonitorChat(chatID))) {
      ({ prefix, quoted } = await this.fetchQuotedMessage(parentID))
    }
    this.dispatch(
      sessionKey, messageID, userID, chatID, chatType, text, prefix, replyCtx, isSpawned, parentID,
      false, false, images, [], false,
      quoted !== undefined ? { text: quoted.text, senderType: quoted.senderType, updateTimeMs: quoted.updateTimeMs } : undefined,
    )
  }

  /**
   * Fetch one message by id and extract its readable text (Go
   * fetchSingleMessage); undefined on any failure or when nothing readable
   * remains. Sender names are not resolved through the contact API (the TS
   * platform never resolves contact names), so senders render as Bot/User.
   */
  private async fetchSingleMessage(messageID: string): Promise<ChainMessage | undefined> {
    let raw: FeishuQuotedMessage | undefined
    try {
      raw = await this.request('message.get', async (client) => {
        if (client.getMessage === undefined) throw new ErrNotSupported('feishu client without message fetch support')
        return client.getMessage({ messageId: messageID })
      })
    } catch (error) {
      console.warn(`${this.tag()}: fetch single message failed (${messageID}): ${String(error)}`)
      return undefined
    }
    if (raw === undefined || raw.bodyContent === '') return undefined

    let text = ''
    switch (raw.msgType) {
      case 'text':
        try {
          text = replaceMentions((JSON.parse(raw.bodyContent) as { text?: string }).text ?? '', raw.mentions)
        } catch {
          text = ''
        }
        break
      case 'post':
        text = extractPostPlainText(raw.bodyContent)
        break
      case 'interactive':
        text = extractInteractiveCardText(raw.bodyContent)
        break
      default:
        text = `[${raw.msgType}]`
    }
    if (text === '') return undefined
    const senderName = raw.senderType === 'app' ? 'Bot' : 'User'
    return {
      senderName,
      senderType: raw.senderType,
      text,
      parentId: raw.parentId,
      updateTimeMs: raw.updateTimeMs,
    }
  }

  /**
   * Walk parent_id links up to {@link maxReplyChainDepth} entries and return
   * the chain in chronological order (Go fetchReplyChain); stops on any
   * failure, a circular reference, or the depth cap.
   */
  private async fetchReplyChain(parentID: string, maxDepth: number): Promise<ChainMessage[]> {
    const chain: ChainMessage[] = []
    const visited = new Set<string>()
    let currentID = parentID
    while (currentID !== '' && chain.length < maxDepth) {
      if (visited.has(currentID)) break
      visited.add(currentID)
      const msg = await this.fetchSingleMessage(currentID)
      if (msg === undefined) break
      chain.push(msg)
      currentID = msg.parentId
    }
    return chain.reverse()
  }

  /** Fetch the quoted chain plus its formatted prefix (Go fetchQuotedMessageWithMeta). */
  private async fetchQuotedMessage(parentID: string): Promise<{ prefix: string; quoted?: ChainMessage }> {
    const chain = await this.fetchReplyChain(parentID, maxReplyChainDepth)
    const prefix = formatReplyChain(chain)
    if (chain.length === 0) return { prefix }
    const quotedMsg = chain[chain.length - 1]
    return quotedMsg === undefined ? { prefix } : { prefix, quoted: quotedMsg }
  }

  /**
   * Session-key derivation (Go makeSessionKey): spawned chats key on the
   * chat alone; thread isolation splits group conversations by thread or
   * reply root; otherwise per-user (or per-chat with
   * share_session_in_channel).
   * @param msg - Inbound message fields; thread/root ids drive thread isolation.
   * @param chatID - Chat the message arrived in.
   * @param userID - Sender open_id.
   * @returns The derived session key.
   */
  makeSessionKey(msg: FeishuReceiveEvent['message'], chatID: string, userID: string): string {
    const tag = this.name()
    if (this.isSpawned(chatID)) return `${tag}:${chatID}`
    if (this.o.threadIsolation === true && msg.chat_type === 'group') {
      const threadID = msg.thread_id ?? ''
      if (threadID !== '') return `${tag}:${chatID}:thread:${threadID}`
      const rootID = msg.root_id !== undefined && msg.root_id !== '' ? msg.root_id : msg.message_id ?? ''
      if (rootID !== '') return `${tag}:${chatID}:root:${rootID}`
    }
    if (this.o.shareSessionInChannel === true) return `${tag}:${chatID}`
    return `${tag}:${chatID}:${userID}`
  }

  // ---------------------------------------------------------------------
  // Outbound: text / card routing
  // ---------------------------------------------------------------------

  /** Reply quoting the trigger message (Go Reply; markdown routes to cards). */
  async reply(replyCtx: unknown, content: string): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const { msgType, body } = buildReplyContent(content)
    if (!this.shouldUseThreadOrReplyAPI(rc)) {
      await this.sendNewMessageToChat(rc, msgType, body)
      return
    }
    await this.replyMessage(rc, msgType, body)
  }

  /** Send: reply-shaped when a trigger message exists, else new message. */
  async send(replyCtx: unknown, content: string): Promise<void> {
    if (this.shouldUseThreadOrReplyAPI(this.requireReplyCtx(replyCtx))) {
      await this.reply(replyCtx, content)
      return
    }
    const rc = this.requireReplyCtx(replyCtx)
    const { msgType, body } = buildReplyContent(content)
    await this.sendNewMessageToChat(rc, msgType, body)
  }

  private shouldUseThreadOrReplyAPI(rc: FeishuReplyContext): boolean {
    if (rc.messageID === '') return false
    return this.o.noReplyToTrigger !== true
  }

  private shouldReplyInThread(rc: FeishuReplyContext): boolean {
    if (rc.messageID === '') return false
    // Monitored chats reply inline: the poll path already does (per-user
    // session keys), and a thread reply would open a new topic in the group
    // on every ack.
    if (this.isMonitorChat(rc.chatID)) return false
    return this.o.threadIsolation === true && isThreadSessionKey(rc.sessionKey)
  }

  private requireReplyCtx(replyCtx: unknown): FeishuReplyContext {
    const rc = replyCtx as Partial<FeishuReplyContext> | undefined
    if (typeof rc?.chatID !== 'string' || typeof rc.sessionKey !== 'string') {
      throw new Error(`feishu: invalid reply context ${String(replyCtx)}`)
    }
    return { messageID: rc.messageID ?? '', chatID: rc.chatID, sessionKey: rc.sessionKey }
  }

  private async ensureApi(): Promise<FeishuApiClient> {
    this.api ??= this.o.apiClient ?? (await defaultApiClient(this.opts.appID, this.opts.appSecret))
    return this.api
  }

  /** One request over the default client, retrying once with a fresh token. */
  private async request<T>(operation: string, fn: (client: FeishuApiClient) => Promise<T>): Promise<T> {
    const client = await this.ensureApi()
    let err: unknown
    try {
      return await fn(client)
    } catch (error) {
      err = error
    }
    if (!isTenantAccessTokenInvalid(err)) throw err
    const fresh = await this.fetchFreshTenantAccessToken(client, operation, err)
    console.warn(`feishu: retrying ${operation} with fresh tenant access token`)
    return fn(client.withToken?.(fresh) ?? client)
  }

  private async fetchFreshTenantAccessToken(client: FeishuApiClient, operation: string, original: unknown): Promise<string> {
    if (client.fetchTenantAccessToken === undefined) {
      throw new Error(`feishu: ${operation} failed: token went stale and the client cannot refresh it (original error: ${String(original)})`)
    }
    const token = (await client.fetchTenantAccessToken()).trim()
    if (token === '') {
      throw new Error(`feishu: fetch tenant access token returned empty token (original error: ${String(original)})`)
    }
    return token
  }

  private async sendNewMessageToChat(rc: FeishuReplyContext, msgType: string, content: string): Promise<void> {
    if (rc.chatID === '') throw new Error('feishu: chatID is empty, cannot send new message')
    await this.withRetry('send', () => this.request('send', client =>
      client.create({ chatId: rc.chatID, msgType, content })))
  }

  private async replyMessage(rc: FeishuReplyContext, msgType: string, content: string): Promise<void> {
    const replyInThread = this.shouldReplyInThread(rc)
    // Object holder: TS control-flow analysis cannot see the closure write,
    // so a bare `let withdrawn` would narrow to `false` after the await.
    const state = { withdrawn: false }
    await this.withRetry('reply', () => this.request('reply', async (client) => {
      try {
        await client.reply({ messageId: rc.messageID, msgType, content, ...(replyInThread ? { replyInThread } : {}) })
      } catch (error) {
        if (errorMessage(error).includes(`code=${feishuCodeMessageWithdrawn}`)) {
          state.withdrawn = true
          return
        }
        throw error
      }
    }))
    if (state.withdrawn) {
      console.info(`feishu: reply target withdrawn — sending as standalone chat message (chat ${rc.chatID})`)
      await this.sendNewMessageToChat(rc, msgType, content)
    }
  }

  /** All API calls go through transient retry with backoff. */
  private withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withTransientRetry(`${this.tag()}: ${operation}`, fn)
  }

  // ---------------------------------------------------------------------
  // Cards (CardSender / CardSenderWithUpdate)
  // ---------------------------------------------------------------------

  /**
   * Send a structured card quoting the trigger message (Go ReplyCard).
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param card - Structured card to render and send.
   */
  async replyCard(replyCtx: unknown, card: Card): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const permBody = card.permBody ?? ''
    if (permBody !== '') this.permBodyCache.set(rc.sessionKey, permBody)
    this.cacheAskqMeta(rc.sessionKey, card)
    const cardJSON = renderCard(card, rc.sessionKey)
    if (!this.shouldUseThreadOrReplyAPI(rc)) {
      if (rc.chatID === '') throw new Error('feishu: chatID is empty, cannot send card')
      await this.withRetry('send card', () => this.request('send card', client =>
        client.create({ chatId: rc.chatID, msgType: 'interactive', content: cardJSON })))
      return
    }
    const replyInThread = this.shouldReplyInThread(rc)
    await this.withRetry('reply card', () => this.request('reply card', client =>
      client.reply({ messageId: rc.messageID, msgType: 'interactive', content: cardJSON, replyInThread })))
  }

  /**
   * Send a structured card as a new message to the chat (Go SendCard).
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param card - Structured card to render and send.
   */
  async sendCard(replyCtx: unknown, card: Card): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    if (rc.chatID === '') throw new Error('feishu: chatID is empty, cannot send card')
    const permBody = card.permBody ?? ''
    if (permBody !== '') this.permBodyCache.set(rc.sessionKey, permBody)
    this.cacheAskqMeta(rc.sessionKey, card)
    if (this.o.noReplyToTrigger !== true && this.shouldReplyInThread(rc)) {
      await this.replyCard(replyCtx, card)
      return
    }
    const cardJSON = renderCard(card, rc.sessionKey)
    await this.withRetry('send card', () => this.request('send card', client =>
      client.create({ chatId: rc.chatID, msgType: 'interactive', content: cardJSON })))
  }

  /**
   * Cache the full question set of an ask card at send time: a callback
   * cannot carry the whole card, so it is read back to rebuild the card with
   * answered questions frozen. Only ask cards are cached.
   * @param sessionKey - Session the card was sent to.
   * @param card - The card being sent.
   */
  private cacheAskqMeta(sessionKey: string, card: Card): void {
    const meta = askCardMeta(card)
    if (meta !== undefined) this.askqMetaCache.set(sessionKey, meta)
  }

  /**
   * Send a card and return a handle for subsequent PATCH updates.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param card - Structured card to render and send.
   * @returns Handle identifying the sent card message.
   */
  async sendCardWithHandle(replyCtx: unknown, card: Card): Promise<FeishuPreviewHandle> {
    const rc = this.requireReplyCtx(replyCtx)
    if (rc.chatID === '') throw new Error('feishu: chatID is empty, cannot send card')
    const cardJSON = renderCard(card, rc.sessionKey)
    const msgID = await this.withRetry('send card with handle', () => this.request('send card with handle', async (client) => {
      const resp = await client.create({ chatId: rc.chatID, msgType: 'interactive', content: cardJSON })
      return resp?.messageId ?? ''
    }))
    return new FeishuPreviewHandle(msgID, rc.chatID, rc.sessionKey)
  }

  /**
   * PATCH an existing card identified by handle.
   * @param handle - Preview handle from sendCardWithHandle.
   * @param card - Structured card to render and PATCH.
   */
  async updateCardWithHandle(handle: unknown, card: Card): Promise<void> {
    const h = requirePreviewHandle(handle)
    const cardJSON = renderCard(card, h.sessionKey)
    await this.patchRateWait()
    await this.withRetry('update card by handle', () => this.patchMessage(h.messageID, cardJSON))
  }

  /**
   * PATCH a card tracked from the most recent card-action callback.
   * @param sessionKey - Session whose tracked card message to PATCH.
   * @param card - Structured card to render and PATCH.
   */
  async refreshCard(sessionKey: string, card: Card): Promise<void> {
    const msgID = this.cardActionMsgIDs.get(sessionKey) ?? ''
    if (msgID === '') throw new Error(`feishu: no tracked card messageID for session ${sessionKey}`)
    const cardJSON = renderCard(card, sessionKey)
    await this.patchRateWait()
    await this.withRetry('refresh card', () => this.patchMessage(msgID, cardJSON))
  }

  // ---------------------------------------------------------------------
  // Streaming preview
  // ---------------------------------------------------------------------

  /**
   * Keep the preview card as the final delivered message (Go KeepPreviewOnFinish).
   * @returns Whether the preview card stays as the final message.
   */
  keepPreviewOnFinish(): boolean {
    return this.useInteractiveCard
  }

  /**
   * Whether the platform renders structured progress payloads.
   * @returns Always true on this platform.
   */
  supportsProgressCardPayload(): boolean {
    return true
  }

  /**
   * Whether content exceeds the preview card's table limit (11310 guard).
   * @param content - Rendered content to test.
   * @returns Whether the content exceeds the limit.
   */
  previewOverflow(content: string): boolean {
    return previewOverflowFn(content)
  }

  /**
   * Whether a PATCH failure is a transient rate-limit (230020).
   * @param err - Error from a PATCH attempt.
   * @returns Whether the error is a transient rate-limit.
   */
  isTransientPatchError(err: unknown): boolean {
    return err instanceof Error && err.message.includes('code=230020')
  }

  /** Upload the spinner GIFs once and cache their image keys. */
  private ensureSpinnerKeys(): Promise<void> {
    this.spinnerOnce ??= (async () => {
      const upload = async (name: string): Promise<string> => {
        const client = await this.ensureApi()
        if (client.uploadImage === undefined) return ''
        try {
          // Resolve against this module's location so the path survives the
          // tsdown bundle (lib/index.js) as well as the source tree.
          const asset = resolveSpinnerAsset(name)
          if (asset === undefined) throw new Error(`spinner asset not found (${name})`)
          const data = new Uint8Array(await readFile(asset))
          return await client.uploadImage({ data, mimeType: 'image/gif', fileName: name })
        } catch (error) {
          console.warn(`feishu: upload spinner gif failed (${name}): ${String(error)}`)
          return ''
        }
      }
      this.thinkingImgKey = await upload('thinking.gif')
      this.executingImgKey = await upload('executing.gif')
    })()
    return this.spinnerOnce
  }

  /**
   * Current spinner config, uploading on first use.
   * @returns Spinner config, or the no-spinner config when disabled or upload failed.
   */
  async spinnerCfg(): Promise<SpinnerCfg> {
    if (!this.spinnerEnabled || !this.useInteractiveCard) return noSpinner
    await this.ensureSpinnerKeys()
    if (this.thinkingImgKey === '' && this.executingImgKey === '') return noSpinner
    return { enabled: true, thinkingKey: this.thinkingImgKey, executingKey: this.executingImgKey }
  }

  /**
   * Send a new preview card message and return a handle for subsequent
   * edits. The pre-button card JSON is cached per messageID so stop-card
   * rebuilds never append a second button row.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param content - Initial preview content: structured payload or text.
   * @returns Handle for subsequent in-place edits.
   */
  async sendPreviewStart(replyCtx: unknown, content: ProgressContent): Promise<FeishuPreviewHandle> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: preview start without interactive cards')
    const rc = this.requireReplyCtx(replyCtx)
    if (rc.chatID === '') throw new Error('feishu: chatID is empty')

    const spin = await this.spinnerCfg()
    const preButtonJSON = this.renderPreviewCard(content, spin)
    const cardJSON = injectStopButton(preButtonJSON, rc.sessionKey, this.bgHintOf(content))

    const msgID = await this.withRetry('send preview', () => this.request('send preview', async (client) => {
      // Go SendPreviewStart: reply only under thread isolation so the card
      // lands in the triggering thread; otherwise a new message — never a
      // reply, which would quote the user's trigger message.
      if (this.shouldReplyInThread(rc)) {
        const resp = await client.reply({
          messageId: rc.messageID,
          msgType: 'interactive',
          content: cardJSON,
          replyInThread: true,
        })
        return resp?.messageId ?? ''
      }
      const resp = await client.create({ chatId: rc.chatID, msgType: 'interactive', content: cardJSON })
      return resp?.messageId ?? ''
    }))
    if (msgID === '') throw new Error('feishu: send preview: no message ID returned')

    this.lastProgressCard.set(msgID, preButtonJSON)
    return new FeishuPreviewHandle(msgID, rc.chatID, rc.sessionKey)
  }

  /**
   * Edit the preview card in place. The rendered card JSON is cached
   * pre-button; the stop button and (on green) the export/reply buttons are
   * injected per PATCH, deferring to the latest render-status text.
   * @param previewHandle - Preview handle from sendPreviewStart.
   * @param content - Updated content: structured payload or text.
   */
  async updateMessage(previewHandle: unknown, content: ProgressContent): Promise<void> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: update message without interactive cards')
    const h = requirePreviewHandle(previewHandle)

    const spin = await this.spinnerCfg()
    const cardJSON = this.renderPreviewCard(content, spin)
    this.lastProgressCard.set(h.messageID, cardJSON)
    let json = injectStopButton(cardJSON, h.sessionKey, this.bgHintOf(content))
    const statusText = this.renderStatusText.get(h.messageID) ?? ''
    json = injectReplyButtons(json, h.sessionKey, h.messageID, statusText)
    await this.patchRateWait()
    await this.withRetry('patch message', () => this.patchMessage(h.messageID, json))
  }

  /** Render preview content into a card JSON string (payload or text path). */
  private renderPreviewCard(content: ProgressContent, spin: SpinnerCfg): string {
    if (content.kind === 'card') return buildProgressCardJSONFromPayload(content.payload, spin)
    return buildPreviewCardJSON(content.text, spin, content.status)
  }

  /**
   * Background-task hint carried by text-path preview content; the card
   * payload path and an absent field carry none.
   * @param content - Preview content being rendered.
   * @returns Hint text for the stop-button row, or the empty string.
   */
  private bgHintOf(content: ProgressContent): string {
    return content.kind === 'text' ? (content.bgTaskHint ?? '') : ''
  }

  /**
   * Refresh the render-status line on a previously sent green card (#47/#48):
   * rebuild from the pre-button cache, re-inject stop + reply buttons plus
   * the status, PATCH in place.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param exportKey - Turn key identifying the card to refresh.
   * @param statusText - Render-status line to display.
   */
  async updateRenderStatus(replyCtx: unknown, exportKey: string, statusText: string): Promise<void> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: update render status without interactive cards')
    const rc = this.requireReplyCtx(replyCtx)
    if (exportKey === '') throw new Error('feishu: UpdateRenderStatus: empty exportKey')
    // Record unconditionally so the green-化 re-PATCH in updateMessage can
    // re-apply it; keyed per card so concurrent sessions don't cross-leak.
    this.renderStatusText.set(exportKey, statusText)
    const baseJSON = this.requireCachedCard(exportKey, 'update render status')
    let cardJSON = injectStopButton(baseJSON, rc.sessionKey)
    cardJSON = injectReplyButtons(cardJSON, rc.sessionKey, exportKey, statusText)
    await this.patchRateWait()
    await this.withRetry('update render status', () => this.patchMessage(exportKey, cardJSON))
  }

  /**
   * PATCH the active preview card to a stopped terminal state (⏹ 已停止 +
   * ▶ 继续执行) so a user stop is not overwritten by the default failed-card
   * PATCH. A cache miss errors so the caller falls back.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param previewMsgID - Preview handle of the active card.
   */
  async renderStoppedCard(replyCtx: unknown, previewMsgID: unknown): Promise<void> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: stopped card without interactive cards')
    const rc = this.requireReplyCtx(replyCtx)
    const h = requirePreviewHandle(previewMsgID)
    if (h.messageID === '') throw new Error('feishu: RenderStoppedCard: empty messageID')
    const baseJSON = this.requireCachedCard(h.messageID, 'render stopped card')
    const cardJSON = markCardStopped(baseJSON, rc.sessionKey)
    await this.patchRateWait()
    await this.withRetry('render stopped card', () => this.patchMessage(h.messageID, cardJSON))
  }

  private requireCachedCard(msgID: string, op: string): string {
    const base = this.lastProgressCard.get(msgID) ?? ''
    if (base === '') throw new Error(`feishu: ${op}: no cached progress card for ${msgID}`)
    return base
  }

  /**
   * Remove a preview message and its caches (Go DeletePreviewMessage).
   * @param previewHandle - Preview handle of the message to remove.
   */
  async deletePreviewMessage(previewHandle: unknown): Promise<void> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: delete preview without interactive cards')
    const h = requirePreviewHandle(previewHandle)
    this.lastProgressCard.delete(h.messageID)
    this.renderStatusText.delete(h.messageID)
    const client = await this.ensureApi()
    const boundDelete = client.delete?.bind(client)
    if (boundDelete === undefined) throw new ErrNotSupported('feishu client without delete support')
    await this.withRetry('delete preview message', () => boundDelete({ messageId: h.messageID }))
  }

  /**
   * Block until the global PATCH limiter allows one call.
   * @param signal - Aborts the wait for a limiter slot.
   */
  async patchRateWait(signal?: AbortSignal): Promise<void> {
    await this.patchRL.wait(signal)
  }

  /** PATCH a card message body, failing loud without client support. */
  private async patchMessage(messageId: string, content: string): Promise<void> {
    await this.request('patch message', async (client) => {
      if (client.patch === undefined) throw new ErrNotSupported('feishu client without patch support')
      await client.patch({ messageId, content })
    })
  }

  // ---------------------------------------------------------------------
  // Completion notifications, TopNotice, pins, reactions
  // ---------------------------------------------------------------------

  /**
   * Brief new message after the in-place completion PATCH so Feishu
   * generates a notification badge; usage text stays out of the card body.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param usageMsg - Usage summary text; empty skips the notification.
   */
  async sendCompletionNotification(replyCtx: unknown, usageMsg: string): Promise<void> {
    if (!this.notifyOnComplete || usageMsg === '') return
    await this.reply(replyCtx, usageMsg)
  }

  /**
   * Set the chat's top-notice banner to a message (Go SetTopNotice).
   * @param chatID - Chat whose banner to set.
   * @param messageID - Message the banner points at.
   */
  async setTopNotice(chatID: string, messageID: string): Promise<void> {
    if (!this.topNoticeEnabled) throw new ErrNotSupported('feishu: top notice disabled')
    await this.withRetry('top_notice.put', () => this.request('top_notice.put', async (client) => {
      if (client.putTopNotice === undefined) throw new ErrNotSupported('feishu client without top notice support')
      await client.putTopNotice({ chatId: chatID, messageId: messageID })
    }))
  }

  /**
   * Remove the chat's top-notice banner (Go ClearTopNotice).
   * @param chatID - Chat whose banner to remove.
   * @param _messageID - Unused; the banner is chat-scoped.
   */
  async clearTopNotice(chatID: string, _messageID: string): Promise<void> {
    if (!this.topNoticeEnabled) throw new ErrNotSupported('feishu: top notice disabled')
    await this.withRetry('top_notice.delete', () => this.request('top_notice.delete', async (client) => {
      if (client.deleteTopNotice === undefined) throw new ErrNotSupported('feishu client without top notice support')
      await client.deleteTopNotice({ chatId: chatID })
    }))
  }

  /**
   * Pin a message into the chat's pin panel (Go AddMessagePin).
   * @param _chatID - Unused; pins are message-scoped.
   * @param messageID - Message to pin.
   */
  async addMessagePin(_chatID: string, messageID: string): Promise<void> {
    if (!this.pinEnabled) throw new ErrNotSupported('feishu: pin disabled')
    await this.withRetry('pin.create', () => this.request('pin.create', async (client) => {
      if (client.createPin === undefined) throw new ErrNotSupported('feishu client without pin support')
      await client.createPin({ messageId: messageID })
    }))
  }

  private async addReactionWithEmoji(messageID: string, emojiType: string): Promise<string> {
    if (emojiType === '') return ''
    try {
      return await this.withRetry('add reaction', () => this.request('add reaction', async (client) => {
        if (client.createReaction === undefined) throw new ErrNotSupported('feishu client without reaction support')
        const resp = await client.createReaction({ messageId: messageID, emojiType })
        return resp?.reactionId ?? ''
      }))
    } catch (error) {
      console.warn(`feishu: add reaction failed: ${String(error)}`)
      return ''
    }
  }

  private async removeReactionByID(messageID: string, reactionID: string): Promise<void> {
    if (reactionID === '' || messageID === '') return
    try {
      await this.withRetry('remove reaction', () => this.request('remove reaction', async (client) => {
        if (client.deleteReaction === undefined) throw new ErrNotSupported('feishu client without reaction support')
        await client.deleteReaction({ messageId: messageID, reactionId: reactionID })
      }))
    } catch (error) {
      console.warn(`feishu: remove reaction failed: ${String(error)}`)
    }
  }

  /**
   * Remove a previously added reaction by its ID (Go ReactionManager.RemoveReaction).
   * @param replyCtx - Reply context carrying the reacted message id.
   * @param reactionID - Reaction id returned by addReactionWithID.
   */
  async removeReaction(replyCtx: unknown, reactionID: string): Promise<void> {
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    await this.removeReactionByID(messageID, reactionID)
  }

  private readonly pendingTypingRemovals = new Map<string, string>()

  /**
   * Add the typing emoji and return a stop function removing it.
   * @param replyCtx - Reply context carrying the trigger message id.
   * @returns Stop function that removes the typing reaction.
   */
  startTyping(replyCtx: unknown): () => void {
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    if (messageID === '') return () => {}
    void (async () => {
      const reactionID = await this.addReactionWithEmoji(messageID, this.reactionEmoji)
      this.pendingTypingRemovals.set(messageID, reactionID)
    })()
    return () => {
      const reactionID = this.pendingTypingRemovals.get(messageID) ?? ''
      this.pendingTypingRemovals.delete(messageID)
      void this.removeReactionByID(messageID, reactionID)
    }
  }

  /**
   * Done-reaction push after a quiet multi-round turn (Go AddDoneReaction).
   * @param replyCtx - Reply context carrying the trigger message id.
   */
  addDoneReaction(replyCtx: unknown): void {
    this.fireAndForgetReaction(replyCtx, this.doneEmoji)
  }

  /**
   * Cancelled-reaction after a user stop (Go AddCancelledReaction).
   * @param replyCtx - Reply context carrying the trigger message id.
   */
  addCancelledReaction(replyCtx: unknown): void {
    this.fireAndForgetReaction(replyCtx, this.cancelEmoji)
  }

  /**
   * Arbitrary emoji acknowledgment (Go AddReaction).
   * @param replyCtx - Reply context carrying the trigger message id.
   * @param emoji - Emoji type to add.
   */
  addReaction(replyCtx: unknown, emoji: string): void {
    this.fireAndForgetReaction(replyCtx, emoji)
  }

  private fireAndForgetReaction(replyCtx: unknown, emoji: string): void {
    if (emoji === '') return
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    if (messageID === '') return
    void this.addReactionWithEmoji(messageID, emoji)
  }

  /**
   * Synchronous reaction returning an ID (Go AddReactionWithID).
   * @param replyCtx - Reply context carrying the trigger message id.
   * @param emoji - Emoji type to add.
   * @returns The reaction id, or '' when the add failed.
   */
  async addReactionWithID(replyCtx: unknown, emoji: string): Promise<string> {
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    if (messageID === '') return ''
    return this.addReactionWithEmoji(messageID, emoji)
  }

  /**
   * Rebuild a reply context from a session key for proactive sends (cron,
   * tools). The chat ID is the key's second segment.
   * @param sessionKey - Session key whose second segment is the chat id.
   * @returns Reply context with an empty message id for new-message sends.
   */
  reconstructReplyCtx(sessionKey: string): Promise<FeishuReplyContext> {
    const parts = sessionKey.split(':')
    const chatID = parts[1] ?? ''
    if (chatID === '') {
      return Promise.reject(new Error(`feishu: cannot reconstruct reply context from ${sessionKey}`))
    }
    return Promise.resolve({ messageID: '', chatID, sessionKey })
  }

  // ---------------------------------------------------------------------
  // M4 platform domain: spawn / tags / avatars / members / media
  // ---------------------------------------------------------------------

  /** Throw on a non-zero Feishu business code (Go resp.Success() checks). */
  private ensureOk(resp: { code?: number | undefined; msg?: string | undefined }, op: string): void {
    if (resp.code !== undefined && resp.code !== 0) {
      throw new Error(`feishu: ${op}: code=${resp.code} msg=${resp.msg ?? ''}`)
    }
  }

  /**
   * The four im/v2 tag wire calls, bound to this platform's client with the
   * same transient + fresh-token retry machinery as every other verb.
   */
  private tagApi(): TagApi {
    const call = <T>(op: string, fn: (client: FeishuApiClient) => Promise<T>): Promise<T> =>
      this.withRetry(op, () => this.request(op, fn))
    return {
      createTag: async name => call(`ensure tag ${name}`, async (client) => {
        if (client.createTag === undefined) throw new ErrNotSupported('feishu client without tag support')
        return client.createTag({ name })
      }),
      getTagRelation: async chatId => call('get tag relation', async (client) => {
        if (client.getTagRelation === undefined) throw new ErrNotSupported('feishu client without tag support')
        return client.getTagRelation({ chatId })
      }),
      createTagRelation: async (chatId, tagIds) => call('tag spawned chat', async (client) => {
        if (client.createTagRelation === undefined) throw new ErrNotSupported('feishu client without tag support')
        return client.createTagRelation({ chatId, tagIds })
      }),
      updateTagRelation: async (chatId, tagIds) => call('remove tag from chat', async (client) => {
        if (client.updateTagRelation === undefined) throw new ErrNotSupported('feishu client without tag support')
        return client.updateTagRelation({ chatId, tagIds })
      }),
    }
  }

  /**
   * Rename a chat via Im.Chat.Update. Only the name field is sent, leaving the
   * avatar and other fields untouched. `signal` mirrors Go's ctx propagation:
   * an aborted signal fails the rename (before the call when already aborted,
   * promptly when it aborts mid-flight) instead of letting a stale 30s rename
   * deadline judge an already-delivered request as failed.
   */
  private async renameChat(chatID: string, newName: string, signal?: AbortSignal): Promise<void> {
    await this.withAbort(() => this.withRetry('rename chat', () => this.request('rename chat', async (client) => {
      if (client.updateChat === undefined) throw new ErrNotSupported('feishu client without chat update support')
      const resp = await client.updateChat({ chatId: chatID, name: newName })
      this.ensureOk(resp, 'rename chat')
    })), signal)
  }

  /**
   * Run `make()` but reject promptly when `signal` aborts. The thunk defers
   * the request so an already-aborted signal fails before any API call; once
   * in flight the request keeps running (the API client surface carries no
   * cancellation), mirroring Go's real-world case where the PUT already
   * reached Feishu.
   */
  private async withAbort<T>(make: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return await make()
    signal.throwIfAborted()
    const op = make()
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error(`${this.tag()}: aborted`)) }
      signal.addEventListener('abort', onAbort, { once: true })
      op.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error instanceof Error ? error : new Error(`${this.tag()}: rename failed: ${String(error)}`))
        },
      )
    })
  }

  /**
   * Set only the chat avatar via Im.Chat.Update (name and other fields are
   * not serialized when absent).
   */
  private async updateChatAvatar(chatID: string, imageKey: string): Promise<void> {
    await this.withRetry('update chat avatar', () => this.request('update chat avatar', async (client) => {
      if (client.updateChat === undefined) throw new ErrNotSupported('feishu client without chat update support')
      const resp = await client.updateChat({ chatId: chatID, avatar: imageKey })
      this.ensureOk(resp, 'update chat avatar')
    }))
  }

  /**
   * Rename a spawned chat only (Go RenameGroup, conservative default).
   * @param sessionKey - Session key identifying the spawned chat.
   * @param newName - New group name.
   * @param signal - Aborts the rename; an aborted signal fails it.
   */
  async renameGroup(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '' || !this.isSpawned(chatID)) return
    await this.renameChat(chatID, newName, signal)
  }

  /**
   * Rename any group, including user-owned ones (Go RenameGroupAny) — used by
   * /chatroom to rename the user's own hub group to the discussion topic.
   * @param sessionKey - Session key identifying the group.
   * @param newName - New group name.
   * @param signal - Aborts the rename; an aborted signal fails it.
   */
  async renameGroupAny(sessionKey: string, newName: string, signal?: AbortSignal): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') return
    await this.renameChat(chatID, newName, signal)
  }

  /**
   * Switch a spawned group's avatar state: active=true restores the color
   * avatar, false grays it. Per-group custom keys (#52) win over the global
   * bot avatar; a missing gray key skips dimming rather than failing /done.
   * @param sessionKey - Session key identifying the spawned group.
   * @param active - true restores the color avatar, false grays it.
   */
  async setChatAvatarActive(sessionKey: string, active: boolean): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: set chat avatar: no chat ID in session key`)
    }
    const meta = this.spawnStore.get(chatID)
    if (meta?.colorAvatarKey !== undefined && meta.colorAvatarKey !== '') {
      let key = meta.colorAvatarKey
      if (!active) {
        if (meta.grayAvatarKey === undefined || meta.grayAvatarKey === '') {
          console.warn(`${this.tag()}: custom avatar gray key unavailable, skipping avatar dimming`)
          return
        }
        key = meta.grayAvatarKey
      }
      await this.updateChatAvatar(chatID, key)
      return
    }
    // No custom avatar → the global bot avatar pair.
    let key = this.botAvatarKey
    if (!active) {
      if (this.botAvatarKeyGray === '') {
        console.warn(`${this.tag()}: gray avatar key unavailable, skipping avatar dimming`)
        return
      }
      key = this.botAvatarKeyGray
    }
    if (key === '') return // no avatar key at all (startup upload failed)
    await this.updateChatAvatar(chatID, key)
  }

  /**
   * Upload one avatar-type image and return its image_key (Go uploadAvatarImage;
   * used for the bot avatar pair and rendered icon avatars).
   */
  private async uploadAvatarImage(data: Uint8Array): Promise<string> {
    const key = await this.withRetry('upload avatar image', () => this.request('upload avatar image', async (client) => {
      if (client.uploadAvatar === undefined) throw new ErrNotSupported('feishu client without avatar upload support')
      return client.uploadAvatar({ data })
    }))
    if (key === '') throw new Error(`${this.tag()}: upload avatar: no image_key returned`)
    return key
  }

  /**
   * Render and upload the color icon avatar: resolve the Lucide icon name
   * (with fuzzy fallback, then a group-name-hashed pool fallback), rasterize
   * onto the group's hashed background, and upload. An empty svg means the
   * icon is not in the sprite and no fallback hit — the caller skips the
   * avatar.
   */
  private async uploadIconAvatarColor(iconName: string, groupName: string): Promise<{ svg: string; key: string }> {
    let svg = lucideIconSVG(iconName, '#ffffff')
    if (svg === undefined) {
      console.warn(`${this.tag()}: group icon not in sprite, falling back (icon ${iconName}, group ${groupName})`)
      svg = lucideIconSVG(fallbackGroupIcon(groupName), '#ffffff')
    }
    if (svg === undefined) return { svg: '', key: '' }
    const colorPNG = await renderIconPNG(svg, 256, groupAvatarColor(groupName))
    const key = await this.uploadAvatarImage(colorPNG)
    return { svg, key }
  }

  /**
   * Set a group's avatar from a Lucide icon name (Go SetGroupIconAvatar, #52):
   * upload color + gray versions, set the color one as the chat avatar, and
   * persist both keys on the spawned-chat meta so /done dimming restores the
   * custom avatar instead of the global bot avatar.
   * @param sessionKey - Session key identifying the group.
   * @param iconName - Lucide icon name; fuzzy and hashed-pool fallbacks apply.
   * @param groupName - Group name, seeding the background color and fallbacks.
   */
  async setGroupIconAvatar(sessionKey: string, iconName: string, groupName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: set group icon avatar: no chat ID in session key`)
    }
    let rendered: { svg: string; key: string }
    try {
      rendered = await this.uploadIconAvatarColor(iconName, groupName)
    } catch (err) {
      throw new Error(`${this.tag()}: render color icon: ${String(err)}`)
    }
    if (rendered.svg === '') return
    // Gray upload failure is non-fatal: /done then skips the dimming.
    let grayKey = ''
    try {
      grayKey = await this.uploadAvatarImage(await renderIconPNG(rendered.svg, 256, iconGrayBG))
    } catch (err) {
      console.warn(`${this.tag()}: upload gray icon avatar failed: ${String(err)}`)
    }
    try {
      await this.updateChatAvatar(chatID, rendered.key)
    } catch (err) {
      throw new Error(`${this.tag()}: set chat avatar to icon: ${String(err)}`)
    }
    const meta = this.spawnStore.get(chatID) ?? {}
    this.spawnStore.set(chatID, { ...meta, colorAvatarKey: rendered.key, grayAvatarKey: grayKey })
    await this.spawnStore.save()
    console.info(
      `${this.tag()}: group icon avatar set (session_key ${sessionKey}, icon ${iconName}, color_key ${rendered.key}, gray_key ${grayKey})`,
    )
  }

  /**
   * Brand a non-spawned chat with a fixed name and Lucide icon avatar (Go
   * BrandChat) — the monitor dispatch hub. No SpawnedChatMeta side effects;
   * the avatar is best-effort and the rename error is the return value.
   * @param sessionKey - Session key identifying the chat.
   * @param groupName - Fixed name to apply.
   * @param iconName - Lucide icon name for the avatar.
   */
  async brandChat(sessionKey: string, groupName: string, iconName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: brand chat: no chat ID in session key`)
    }
    try {
      const rendered = await this.uploadIconAvatarColor(iconName, groupName)
      if (rendered.svg !== '' && rendered.key !== '') {
        try {
          await this.updateChatAvatar(chatID, rendered.key)
        } catch (err) {
          console.warn(`${this.tag()}: brand chat: set avatar failed: ${String(err)}`)
        }
      }
    } catch (err) {
      console.warn(`${this.tag()}: brand chat: upload icon avatar failed: ${String(err)}`)
    }
    await this.renameChat(chatID, groupName)
  }

  // ── monitor polling fallback (#53, Go feishu_monitor_poll.go) ────────────

  /**
   * Create time (seconds) of the newest message in the chat, seeding the
   * poll high-water mark so history isn't replayed (Go LatestMessageTime).
   * @param chatID - Chat to inspect.
   * @returns Create time in seconds of the newest message, or 0 when none.
   */
  async latestMessageTime(chatID: string): Promise<number> {
    const items = await this.listMessages(chatID, 0, 'ByCreateTimeDesc', 1)
    if (items.length === 0) return 0
    return msgTimeSec(items[0]?.createTime ?? '')
  }

  /**
   * Messages created after afterSec (exclusive), oldest-first, as fully-built
   * Messages with extracted text (Go ListMonitorMessages). Skips the bot's
   * own messages. Catches webhook-bot / other-app card messages that never
   * arrive as events.
   * @param chatID - Chat to poll.
   * @param afterSec - High-water mark; messages created after it (exclusive).
   * @param limit - Max messages to return; non-positive means 20.
   * @returns Fully-built Messages, oldest first, bot's own excluded.
   */
  async listMonitorMessages(chatID: string, afterSec: number, limit: number): Promise<Message[]> {
    const pageSize = limit <= 0 ? 20 : limit
    const items = await this.listMessages(chatID, afterSec, 'ByCreateTimeAsc', pageSize)
    const out: Message[] = []
    for (const m of items) {
      const msg = await this.pollItemToMessage(m, chatID)
      if (msg !== undefined) out.push(msg)
    }
    return out
  }

  /**
   * List a chat's messages via im.message.list. Requests the full schema 2.0
   * card JSON (raw_card_content) instead of the degraded img+"请升级"
   * placeholder the default returns — without it, interactive-card text is
   * unreadable (Go listMessages).
   */
  private async listMessages(chatID: string, afterSec: number, sortType: 'ByCreateTimeDesc' | 'ByCreateTimeAsc', pageSize: number): Promise<FeishuListItem[]> {
    return this.withRetry('message.list', () => this.request('message.list', async (client) => {
      if (client.listMessages === undefined) throw new ErrNotSupported('feishu client without message listing support')
      return client.listMessages({
        chatId: chatID,
        sortType,
        pageSize,
        ...(afterSec > 0 ? { startTimeSec: afterSec } : {}),
      })
    }))
  }

  /**
   * Convert a listed message into a Message for triage (Go
   * pollItemToMessage). Undefined for messages that should be skipped (the
   * bot's own, no extractable text, or no owner for a sender-less card).
   */
  private async pollItemToMessage(m: FeishuListItem, chatID: string): Promise<Message | undefined> {
    // Skip the bot's own messages (spawn notices, /learn acks). App messages
    // carry sender.id = app_id (not the bot open_id), so match both.
    if (m.sender?.id !== undefined) {
      if (m.sender.id === (this.o.botOpenID ?? '')) return undefined
      if (m.sender.senderType === 'app' && m.sender.id === this.opts.appID) return undefined
    }

    // Subgroup owner: the sender if a human user, else the configured
    // fallback (webhook-bot/other-app cards have no human sender). Skip early
    // when neither is available — SpawnSubtask needs an owner, and there's no
    // point extracting/downloading content we can't act on.
    let userID = ''
    if (m.sender?.id !== undefined && m.sender.idType === 'open_id' && m.sender.senderType === 'user') {
      userID = m.sender.id
    }
    if (userID === '') userID = this.monitorFallbackUser
    if (userID === '') {
      console.warn(`${this.tag()}: monitor: poll message has no human sender and no fallback_user; skipping`)
      return undefined
    }

    const text = stripMentions(extractPollText(m.msgType, m.content), undefined, this.o.botOpenID ?? '')

    // Triage is text-based (rule patterns + an LLM prompt over the message
    // text), so a card with no usable text — empty, or just the
    // "[interactive card]" placeholder — can't be routed even if it carries a
    // screenshot. Drop it here rather than downloading images we'd have
    // nowhere to send. (Image-only alerts need at least a title/body to
    // triage; the screenshot then attaches to that text.)
    if (text.trim() === '' || text.trim() === interactiveCardPlaceholder) return undefined

    // Attach embedded card images (e.g. an alert screenshot) so they reach
    // the subgroup alongside the triaged text. Capped; download failures are
    // skipped so one bad image doesn't drop the whole alert.
    const images = await this.downloadCardImages(m.messageId, m.content)

    const sessionKey = `${this.tag()}:${chatID}:${userID}`
    const replyCtx: FeishuReplyContext = { messageID: m.messageId, chatID, sessionKey }
    return {
      ...emptyMessageShape(),
      sessionKey,
      platform: this.name(),
      messageID: m.messageId,
      userID,
      // The TS platform never resolves contact names (userName stays '' on
      // the event path too); the poll path matches that ceiling.
      userName: '',
      chatType: 'group',
      content: text,
      images,
      replyCtx,
      createTime: msgTimeSec(m.createTime),
    }
  }

  /**
   * Fetch embedded card images by key (Go downloadCardImages). Capped so a
   * card with many images can't flood downloads; a failed download is logged
   * and skipped — the remaining images still flow through.
   */
  private async downloadCardImages(messageID: string, content: string): Promise<ImageAttachment[]> {
    if (messageID === '') return []
    const keys = extractCardImageKeys(unwrapCardContent(content))
    if (keys.length === 0) return []
    const maxCardImages = 9
    const capped = keys.slice(0, maxCardImages)
    if (keys.length > maxCardImages) {
      console.warn(`${this.tag()}: monitor: card has many images, truncating (want=${keys.length} kept=${maxCardImages})`)
    }
    const out: ImageAttachment[] = []
    for (const key of capped) {
      try {
        const [data, mimeType] = await this.downloadImage(messageID, key)
        out.push({ mimeType, data })
      } catch (error) {
        console.warn(`${this.tag()}: monitor: download card image failed (key=${key}): ${String(error)}`)
      }
    }
    return out
  }

  /**
   * Stamp one shared Lucide icon avatar across a chatroom family (Go
   * SetChatroomFamilyAvatar): hub plus role/assistant child groups. One
   * render + upload per variant, the same color image on every group. The hub
   * is never tracked as spawned; children get per-group color/gray keys so
   * chatroom-end /done dims via the gray icon. Without children the gray
   * upload is skipped.
   * @param hubKey - Session key of the hub group.
   * @param childKeys - Session keys of the role/assistant child groups.
   * @param iconName - Lucide icon rendered onto every group.
   * @param familyName - Family name seeding the color and fallbacks.
   */
  async setChatroomFamilyAvatar(hubKey: string, childKeys: string[], iconName: string, familyName: string): Promise<void> {
    let rendered: { svg: string; key: string }
    try {
      rendered = await this.uploadIconAvatarColor(iconName, familyName)
    } catch (err) {
      throw new Error(`${this.tag()}: chatroom family avatar: render color: ${String(err)}`)
    }
    if (rendered.svg === '') return
    let grayKey = ''
    if (childKeys.length > 0) {
      try {
        grayKey = await this.uploadAvatarImage(await renderIconPNG(rendered.svg, 256, iconGrayBG))
      } catch (err) {
        console.warn(`${this.tag()}: chatroom family avatar: upload gray failed: ${String(err)}`)
      }
    }
    const hubChatID = extractFeishuChatID(hubKey)
    if (hubChatID !== '') {
      try {
        await this.updateChatAvatar(hubChatID, rendered.key)
      } catch (err) {
        console.warn(`${this.tag()}: chatroom family avatar: set hub avatar failed: ${String(err)}`)
      }
    }
    for (const k of childKeys) {
      const chatID = extractFeishuChatID(k)
      if (chatID === '') continue
      try {
        await this.updateChatAvatar(chatID, rendered.key)
      } catch (err) {
        console.warn(`${this.tag()}: chatroom family avatar: set child avatar failed: ${String(err)}`)
        continue
      }
      const meta = this.spawnStore.get(chatID) ?? { active: true }
      this.spawnStore.set(chatID, { ...meta, colorAvatarKey: rendered.key, grayAvatarKey: grayKey })
      await this.spawnStore.save()
    }
    console.info(
      `${this.tag()}: chatroom family avatar set (hub ${hubKey}, icon ${iconName}, children ${childKeys.length}, color_key ${rendered.key}, gray_key ${grayKey})`,
    )
  }

  /**
   * Create a new group chat containing the bot and the caller, register it as
   * an active spawned chat, apply the dir tag asynchronously, and return a
   * synthetic message the engine feeds back to trigger the first turn (Go
   * SpawnGroup).
   * @param msg - Caller message providing the user id and name.
   * @param groupName - Name for the new group.
   * @param firstMsg - Initial message forwarded into the group; empty skips.
   * @returns Synthetic message the engine feeds back as the first turn.
   */
  async spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message> {
    return this.spawnGroupWithOptions(msg, groupName, firstMsg, { topicGroup: false, workDir: '' })
  }

  /**
   * Spawn with options (Go SpawnGroupWithOptions): topic groups use
   * group_message_type=thread; a non-default workDir re-derives the dir tag
   * from that directory.
   * @param msg - Caller message providing the user id and name.
   * @param groupName - Name for the new group.
   * @param firstMsg - Initial message forwarded into the group; empty skips.
   * @param opts - Spawn options: topic-group mode and workDir for the dir tag.
   * @returns Synthetic message the engine feeds back as the first turn.
   */
  async spawnGroupWithOptions(msg: Message, groupName: string, firstMsg: string, opts: GroupSpawnOptions): Promise<Message> {
    await this.ensureInit()
    const userID = msg.userID
    if (userID === '') {
      throw new Error('feishu: spawn: could not determine caller user ID')
    }
    const chatType = opts.topicGroup ? 'thread' : 'chat'
    const resp = await this.withRetry('spawn create chat', () => this.request('spawn create chat', async (client) => {
      if (client.createChat === undefined) throw new ErrNotSupported('feishu client without chat create support')
      const r = await client.createChat({
        name: groupName,
        userIdList: [userID],
        groupMessageType: chatType,
        ...(this.botAvatarKey !== '' ? { avatar: this.botAvatarKey } : {}),
      })
      this.ensureOk(r, 'spawn: create chat')
      return r
    }))
    const chatID = resp.chatId ?? ''
    if (chatID === '') throw new Error('feishu: spawn: create chat: no chat_id in response')

    this.spawnStore.set(chatID, { active: true })
    await this.spawnStore.save()

    const sessionKey = `${this.tag()}:${chatID}`
    console.info(`${this.tag()}: spawned group chat (chat_id ${chatID}, user_id ${userID}, group_name ${groupName}, mode ${opts.topicGroup ? 'topic_group' : 'group'})`)

    // Apply the dir tag off the critical path; no active (❤️) tag on spawn —
    // the group is "active" by its color avatar alone.
    void (async () => {
      let tagName = this.tagManager.dirTagName
      if (opts.workDir !== '') {
        const base = projectBaseForTag(opts.workDir)
        if (base !== '' && base !== '.') tagName = pickDirTagName(base, this.dirWordFreq)
      }
      try {
        await this.tagManager.applySpawnDirTag(chatID, tagName)
      } catch (err) {
        console.warn(`${this.tag()}: tag spawned chat failed: ${String(err)}`)
      }
    })()

    const synthetic: Message = {
      sessionKey,
      platform: this.name(),
      messageID: '',
      userID,
      userName: msg.userName,
      chatName: groupName,
      chatType: 'group',
      content: '',
      originalContent: '',
      images: [],
      files: [],
      extraContent: '',
      replyCtx: { messageID: '', chatID, sessionKey },
      fromVoice: false,
      isSpawnedGroup: true,
      isPermissionAction: false,
      isAskqCardAction: false,
      isCardAction: false,
      parentMessageID: '',
      quotedText: '',
    }
    if (firstMsg === '') return synthetic

    const { msgType, body } = buildReplyContent(firstMsg)
    try {
      await this.sendNewMessageToChat({ messageID: '', chatID, sessionKey }, msgType, body)
    } catch (err) {
      console.warn(`${this.tag()}: spawn: failed to forward initial message: ${String(err)}`)
    }
    synthetic.content = firstMsg
    return synthetic
  }

  /**
   * The applink that opens chatID when clicked (Go ChatJumpURL).
   * @param chatID - Chat the link opens.
   * @returns Applink URL that opens the chat when clicked.
   */
  chatJumpURL(chatID: string): string {
    return `https://applink.feishu.cn/client/chat/open?openChatId=${chatID}`
  }

  /**
   * Download the bot avatar once and upload the color + grayscale avatar pair
   * used by /spawn and /done (Go uploadBotAvatars). Failures degrade to the
   * default avatar / no dimming.
   */
  private async uploadBotAvatars(avatarURL: string): Promise<void> {
    let data: Uint8Array
    try {
      const resp = await fetch(avatarURL)
      if (!resp.ok) throw new Error(`HTTP ${String(resp.status)}`)
      data = new Uint8Array(await resp.arrayBuffer())
    } catch (err) {
      console.warn(`${this.name()}: bot avatar download failed, spawned groups will have default avatar: ${String(err)}`)
      return
    }
    try {
      this.botAvatarKey = await this.uploadAvatarImage(data)
    } catch (err) {
      console.warn(`${this.name()}: bot avatar upload failed, spawned groups will have default avatar: ${String(err)}`)
      return
    }
    console.info(`${this.name()}: bot avatar uploaded (image_key ${this.botAvatarKey})`)
    try {
      this.botAvatarKeyGray = await this.uploadAvatarImage(await grayscaleAvatar(data))
    } catch (err) {
      console.warn(`${this.name()}: bot avatar grayscale upload failed, /done avatar dimming disabled: ${String(err)}`)
      return
    }
    console.info(`${this.name()}: bot avatar grayscale uploaded (image_key ${this.botAvatarKeyGray})`)
  }

  /**
   * List every member open_id of the chat identified by sessionKey, excluding
   * the bot itself (Go ListChatMembers). A page error mid-iteration still
   * returns the partial page collected on the last attempt so a dispatch
   * member-copy does not silently zero out.
   * @param sessionKey - Session key identifying the chat.
   * @returns Member open_ids excluding the bot itself.
   */
  async listChatMembers(sessionKey: string): Promise<string[]> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: list members: empty chat id from session key "${sessionKey}"`)
    }
    const botID = this.o.botOpenID ?? ''
    let ids: string[] = []
    let failure: unknown
    try {
      await this.withRetry('list chat members', async () => {
        const attempt: string[] = []
        let pageToken = ''
        for (;;) {
          let page: { memberIDs: string[]; pageToken?: string | undefined }
          try {
            page = await this.request('list chat members', async (client) => {
              if (client.listChatMembersPage === undefined) throw new ErrNotSupported('feishu client without member listing support')
              const r = await client.listChatMembersPage({
                chatId: chatID,
                ...(pageToken !== '' ? { pageToken } : {}),
              })
              this.ensureOk(r, 'list chat members')
              return r
            })
          } catch (err) {
            ids = attempt // stash the partial page for best-effort callers
            throw err
          }
          for (const id of page.memberIDs) {
            if (id !== '' && id !== botID) attempt.push(id)
          }
          if (page.pageToken === undefined || page.pageToken === '') {
            ids = attempt
            return
          }
          pageToken = page.pageToken
        }
      })
    } catch (err) {
      failure = err
    }
    if (failure !== undefined) {
      // Carry the partial roster on the thrown error so best-effort callers
      // (monitor dispatch member-copy) can still copy what was fetched — Go
      // returns (partial, err) from the same situation.
      throw Object.assign(new Error(`${this.tag()}: list chat members: ${errorMessage(failure)}`), { partial: ids })
    }
    return ids
  }

  /**
   * Add open_ids to the chat identified by sessionKey (Go AddChatMembers):
   * the bot and duplicates are skipped, requests batch at 50, and a batch
   * failure is logged without aborting the remaining batches.
   * @param sessionKey - Session key identifying the chat.
   * @param userIDs - open_ids to add; the bot and duplicates are skipped.
   */
  async addChatMembers(sessionKey: string, userIDs: string[]): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: add members: empty chat id from session key "${sessionKey}"`)
    }
    const ids = dedupMemberIDs(userIDs, this.o.botOpenID ?? '')
    if (ids.length === 0) return
    for (let i = 0; i < ids.length; i += chatMembersAddBatch) {
      const batch = ids.slice(i, i + chatMembersAddBatch)
      try {
        await this.withRetry('add chat members', () => this.request('add chat members', async (client) => {
          if (client.createChatMembers === undefined) throw new ErrNotSupported('feishu client without member add support')
          const resp = await client.createChatMembers({ chatId: chatID, idList: batch })
          this.ensureOk(resp, 'add chat members')
        }))
      } catch (err) {
        console.warn(`${this.tag()}: add chat members batch failed (chat_id ${chatID}, batch_size ${String(batch.length)}): ${String(err)}`)
      }
    }
  }

  /**
   * This bot's resolved active-tag name (Go ActiveTagName).
   * @returns The resolved active-tag name.
   */
  activeTagName(): string {
    return this.tagManager.activeTagName()
  }

  /**
   * Remove a tag from a chat (Go RemoveTagFromChat, /done).
   * @param sessionKey - Session key identifying the chat.
   * @param tagName - Tag to remove.
   */
  async removeTagFromChat(sessionKey: string, tagName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: remove tag: no chat ID in session key`)
    }
    await this.ensureInit()
    await this.tagManager.removeTagFromChat(chatID, tagName)
  }

  /**
   * Attach the active (heart) tag to a chat (Go ApplyActiveTag).
   * @param sessionKey - Session key identifying the chat.
   */
  async applyActiveTag(sessionKey: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: apply active tag: no chat ID in session key`)
    }
    await this.ensureInit()
    await this.tagManager.resolveAndAttachActiveTag(chatID)
  }

  /**
   * Mark a spawned chat done (inactive) — Go MarkSpawnedChatDone.
   * @param sessionKey - Session key identifying the spawned chat.
   */
  async markSpawnedChatDone(sessionKey: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') return
    await this.ensureInit()
    await this.spawnStore.markDone(chatID)
  }

  /**
   * Mark a spawned chat active again — Go MarkSpawnedChatActive.
   * @param sessionKey - Session key identifying the spawned chat.
   */
  async markSpawnedChatActive(sessionKey: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') return
    await this.ensureInit()
    await this.spawnStore.markActive(chatID)
  }

  /**
   * Whether a spawned chat is in the active (color-avatar) state; lets the
   * engine skip redundant avatar reactivation that would emit a spurious
   * "更新了群头像" system message.
   * @param sessionKey - Session key identifying the spawned chat.
   * @returns Whether the chat is in the active (color-avatar) state.
   */
  isSpawnedChatActive(sessionKey: string): boolean {
    return this.spawnStore.isActive(extractFeishuChatID(sessionKey))
  }

  /**
   * Resolve a chat's display name through the TTL cache (Go resolveChatName).
   * Lookup failures cache and return the chat id.
   */
  private async resolveChatName(chatID: string): Promise<string> {
    return this.chatNames.resolve(chatID, async (id) => {
      const resp = await this.request('resolve chat name', async (client) => {
        if (client.getChat === undefined) throw new ErrNotSupported('feishu client without chat get support')
        const r = await client.getChat({ chatId: id })
        this.ensureOk(r, 'get chat')
        return r
      })
      return { name: resp.name }
    })
  }

  /**
   * List all spawned chats that are still active (Go ListActiveSpawnedChats):
   * legacy entries without a resolved activity are backfilled via the tag
   * API, names resolve through the TTL cache (at most 8 in flight).
   * @returns Active spawned chats with resolved display names.
   */
  async listActiveSpawnedChats(): Promise<SpawnedChatInfo[]> {
    await this.ensureInit()
    const known: Array<[string, SpawnedChatMeta]> = []
    const unknown: Array<[string, SpawnedChatMeta]> = []
    for (const entry of this.spawnStore.entries()) {
      if (entry[1].active === true) known.push(entry)
      else if (entry[1].backfilled !== true) unknown.push(entry)
    }
    let needSave = false
    for (const [chatID] of unknown) {
      const active = await this.tagManager.chatHasActiveTag(chatID)
      const meta = this.spawnStore.get(chatID)
      if (meta !== undefined) {
        meta.active = active
        meta.backfilled = true
        if (active) known.push([chatID, meta])
      }
      needSave = true
    }
    if (needSave) await this.spawnStore.save()
    if (known.length === 0) return []

    const result: SpawnedChatInfo[] = new Array<SpawnedChatInfo>(known.length)
    const maxParallel = 8
    for (let i = 0; i < known.length; i += maxParallel) {
      const slice = known.slice(i, i + maxParallel)
      const resolved = await Promise.all(slice.map(async ([chatID]) => ({
        chatID,
        chatName: await this.resolveChatName(chatID),
        botName: this.name(),
      })))
      resolved.forEach((info, j) => { result[i + j] = info })
    }
    return result
  }

  // ----- media (Go feishu_media.go) -----

  /**
   * Upload image bytes and return the image_key without sending a message
   * (Go UploadImage); the engine embeds images inside cards with it.
   * @param img - Image bytes and metadata to upload.
   * @returns The uploaded image's image_key.
   */
  async uploadImage(img: ImageAttachment): Promise<string> {
    const key = await this.withRetry('upload image', () => this.request('upload image', async (client) => {
      if (client.uploadImage === undefined) throw new ErrNotSupported('feishu client without image upload support')
      return client.uploadImage({ data: img.data, mimeType: img.mimeType, fileName: img.fileName ?? 'image' })
    }))
    if (key === '') throw new Error(`${this.tag()}: upload image: no image_key returned`)
    return key
  }

  /**
   * Send an image message quoting the trigger when one exists (Go SendImage).
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param img - Image attachment to upload and send.
   */
  async sendImage(replyCtx: unknown, img: ImageAttachment): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const imageKey = await this.uploadImage(img)
    await this.sendMediaMessage(rc, 'image', JSON.stringify({ image_key: imageKey }))
  }

  /**
   * Send a file message: upload with the detected Feishu file type, then send
   * (Go SendFile).
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param file - File attachment to upload and send.
   */
  async sendFile(replyCtx: unknown, file: FileAttachment): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const fileName = file.fileName === '' ? 'attachment' : file.fileName
    const fileType: FeishuFileType = detectFeishuFileType(file.mimeType, fileName)
    const fileKey = await this.withRetry('upload file', () => this.request('upload file', async (client) => {
      if (client.uploadFile === undefined) throw new ErrNotSupported('feishu client without file upload support')
      const key = await client.uploadFile({ data: file.data, fileName, fileType })
      if (key === '') throw new Error(`${this.tag()}: upload file: no file_key returned`)
      return key
    }))
    await this.sendMediaMessage(rc, 'file', JSON.stringify({ file_key: fileKey }))
  }

  /** Reply-shaped when a trigger message exists, else a new chat message. */
  private async sendMediaMessage(rc: FeishuReplyContext, msgType: string, content: string): Promise<void> {
    if (this.shouldUseThreadOrReplyAPI(rc)) {
      await this.replyMessage(rc, msgType, content)
      return
    }
    await this.sendNewMessageToChat(rc, msgType, content)
  }

  /**
   * Download a message resource's raw bytes (Go downloadResource). Downloads
   * deliberately skip the retry wrappers: a large slow download must fail
   * fast, and the size is capped at the download ceiling.
   */
  private async downloadMessageResource(messageID: string, fileKey: string, resType: string): Promise<Uint8Array> {
    const client = await this.ensureApi()
    if (client.downloadMessageResource === undefined) {
      throw new ErrNotSupported('feishu client without download support')
    }
    const data = await client.downloadMessageResource({ messageId: messageID, fileKey, type: resType })
    return data.subarray(0, maxFeishuDownloadBytes + 1)
  }

  /** Download an image resource and sniff its MIME type (Go downloadImage). */
  private async downloadImage(messageID: string, imageKey: string): Promise<[Uint8Array, string]> {
    const data = await this.downloadMessageResource(messageID, imageKey, 'image')
    return [data, detectMimeType(data)]
  }

  /**
   * Notify the user that an attachment download failed (Go replyDownloadError)
   * — directly through reply, never via the agent handler, so a download
   * failure must not wake the agent. Hard-coded Chinese (the primary user
   * language); upgrade path: an i18n handle on the platform.
   * @param replyCtx - Reply context of the trigger message (FeishuReplyContext).
   * @param kind - Attachment kind label shown to the user.
   * @param name - Attachment file name; empty omits it from the message.
   */
  async replyDownloadError(replyCtx: unknown, kind: string, name: string): Promise<void> {
    const label = name === '' ? kind : `${kind}「${name}」`
    const msg = `⚠️ ${label}下载失败：可能超时或文件过大。请重试，或拆分后上传，或直接发送服务器上的文件路径。`
    try {
      await this.reply(replyCtx, msg)
    } catch (err) {
      console.warn(`${this.tag()}: reply download error failed: ${String(err)}`)
    }
  }
}

function requirePreviewHandle(handle: unknown): FeishuPreviewHandle {
  if (handle instanceof FeishuPreviewHandle) return handle
  throw new Error(`feishu: invalid preview handle type ${String(handle)}`)
}

/**
 * Default API client over @larksuiteoapi/node-sdk (lazily imported so unit
 * tests never load the SDK). Token refresh uses the SDK's
 * withTenantToken per-request option on a token-cache-disabled client: the
 * verb set is built by one factory so withToken wraps every verb, not just
 * the first few.
 */
async function defaultApiClient(appID: string, appSecret: string): Promise<FeishuApiClient> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const client = new sdk.Client({
    appId: appID,
    appSecret,
    appType: sdk.AppType.SelfBuild,
    domain: sdk.Domain.Feishu,
  })
  const fetchTenantToken = async (): Promise<string> => {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appID, app_secret: appSecret }),
    })
    const data = await resp.json() as { tenant_access_token?: string }
    return data.tenant_access_token ?? ''
  }
  const verbSet = (opts?: Parameters<typeof client.im.message.reply>[1]): FeishuApiClient => ({
    async reply({ messageId, msgType, content, replyInThread }) {
      const resp = await client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType, ...(replyInThread === true ? { reply_in_thread: true } : {}) },
      }, opts)
      return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
    },
    async create({ chatId, msgType, content }) {
      const resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: msgType },
      }, opts)
      return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
    },
    async patch({ messageId, content }) {
      await client.im.message.patch({ path: { message_id: messageId }, data: { content } }, opts)
    },
    async delete({ messageId }) {
      await client.im.message.delete({ path: { message_id: messageId } }, opts)
    },
    fetchTenantAccessToken: fetchTenantToken,
    async putTopNotice({ chatId, messageId }) {
      await client.im.chatTopNotice.putTopNotice({
        path: { chat_id: chatId },
        data: { chat_top_notice: [{ action_type: '1', message_id: messageId }] },
      }, opts)
    },
    async deleteTopNotice({ chatId }) {
      await client.im.chatTopNotice.deleteTopNotice({ path: { chat_id: chatId } }, opts)
    },
    async createPin({ messageId }) {
      await client.im.pin.create({ data: { message_id: messageId } }, opts)
    },
    async createReaction({ messageId, emojiType }) {
      const resp = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }, opts)
      return resp.data?.reaction_id !== undefined ? { reactionId: resp.data.reaction_id } : undefined
    },
    async deleteReaction({ messageId, reactionId }) {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }, opts)
    },
    async uploadImage({ data }) {
      // node-sdk takes the raw multipart fields (Buffer); the file name and
      // MIME type ride along in the multipart metadata it builds.
      const resp = await client.im.image.create({
        data: { image_type: 'message', image: Buffer.from(data) },
      }, opts)
      return resp?.image_key ?? ''
    },
    async createChat({ name, userIdList, groupMessageType, avatar }) {
      const resp = await client.im.chat.create({
        params: { user_id_type: 'open_id' },
        data: {
          name,
          user_id_list: userIdList,
          ...(groupMessageType !== undefined ? { group_message_type: groupMessageType } : {}),
          ...(avatar !== undefined ? { avatar } : {}),
        },
      }, opts)
      return { chatId: resp.data?.chat_id, code: resp.code, msg: resp.msg }
    },
    async updateChat({ chatId, name, avatar }) {
      const resp = await client.im.chat.update({
        path: { chat_id: chatId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(avatar !== undefined ? { avatar } : {}),
        },
      }, opts)
      return { code: resp.code, msg: resp.msg }
    },
    async getChat({ chatId }) {
      const resp = await client.im.chat.get({ path: { chat_id: chatId } }, opts)
      return { name: resp.data?.name, code: resp.code, msg: resp.msg }
    },
    async listChatMembersPage({ chatId, pageToken }) {
      const resp = await client.im.chatMembers.get({
        path: { chat_id: chatId },
        params: {
          member_id_type: 'open_id',
          page_size: 100,
          ...(pageToken !== undefined ? { page_token: pageToken } : {}),
        },
      }, opts)
      return {
        memberIDs: (resp.data?.items ?? []).map(item => item.member_id ?? ''),
        pageToken: resp.data?.has_more === true ? resp.data.page_token : undefined,
        code: resp.code,
        msg: resp.msg,
      }
    },
    async createChatMembers({ chatId, idList }) {
      const resp = await client.im.chatMembers.create({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id' },
        data: { id_list: idList },
      }, opts)
      return { code: resp.code, msg: resp.msg }
    },
    async createTag({ name }) {
      const resp = await client.im.v2.tag.create({
        data: { create_tag: { tag_type: 'tenant', name } },
      }, opts)
      return {
        code: resp.code,
        msg: resp.msg,
        id: resp.data?.id,
        duplicateId: resp.data?.create_tag_fail_reason?.duplicate_id,
      }
    },
    async getTagRelation({ chatId }) {
      const resp = await client.im.v2.bizEntityTagRelation.get({
        params: { tag_biz_type: 'chat', biz_entity_id: chatId },
      }, opts)
      return {
        code: resp.code,
        msg: resp.msg,
        tags: (resp.data?.tag_info_with_bind_versions ?? []).map(t => ({
          id: t.tag_info?.id,
          name: t.tag_info?.name,
        })),
      }
    },
    async createTagRelation({ chatId, tagIds }) {
      const resp = await client.im.v2.bizEntityTagRelation.create({
        data: { tag_biz_type: 'chat', biz_entity_id: chatId, tag_ids: tagIds },
      }, opts)
      return { code: resp.code, msg: resp.msg }
    },
    async updateTagRelation({ chatId, tagIds }) {
      const resp = await client.im.v2.bizEntityTagRelation.update({
        data: { tag_biz_type: 'chat', biz_entity_id: chatId, tag_ids: tagIds },
      }, opts)
      return { code: resp.code, msg: resp.msg }
    },
    async uploadAvatar({ data }) {
      const resp = await client.im.image.create({
        data: { image_type: 'avatar', image: Buffer.from(data) },
      }, opts)
      return resp?.image_key ?? ''
    },
    async uploadFile({ data, fileName, fileType }) {
      const resp = await client.im.file.create({
        data: { file_type: fileType, file_name: fileName, file: Buffer.from(data) },
      }, opts)
      return resp?.file_key ?? ''
    },
    async downloadMessageResource({ messageId, fileKey, type }) {
      const resp = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      }, opts)
      const chunks: Buffer[] = []
      for await (const chunk of resp.getReadableStream()) {
        chunks.push(chunk as Buffer)
      }
      return new Uint8Array(Buffer.concat(chunks))
    },
    async listMessages({ chatId, sortType, pageSize, startTimeSec }) {
      const resp = await client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          sort_type: sortType,
          page_size: pageSize,
          // Request the full schema 2.0 card JSON instead of the degraded
          // img+"请升级" placeholder the default returns — the value
          // lark-cli uses; without it, interactive-card text is unreadable.
          card_msg_content_type: 'raw_card_content',
          ...(startTimeSec !== undefined ? { start_time: String(startTimeSec) } : {}),
        },
      }, opts)
      return (resp.data?.items ?? []).map(item => ({
        messageId: item.message_id ?? '',
        msgType: item.msg_type ?? '',
        content: item.body?.content ?? '',
        createTime: item.create_time ?? '',
        ...(item.sender !== undefined ? {
          sender: {
            id: item.sender.id,
            idType: item.sender.id_type,
            senderType: item.sender.sender_type,
          },
        } : {}),
      }))
    },
    async getBotInfo() {
      const token = (await fetchTenantToken()).trim()
      const resp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await resp.json() as { code?: number; bot?: { open_id?: string; avatar_url?: string; app_name?: string } }
      if (data.code !== undefined && data.code !== 0) {
        throw new Error(`feishu: bot info: code=${String(data.code)}`)
      }
      return {
        openID: data.bot?.open_id ?? '',
        avatarURL: data.bot?.avatar_url ?? '',
        appName: data.bot?.app_name ?? '',
      }
    },
    async getMessage({ messageId }) {
      // Bare HTTP like getBotInfo: the quoted-chain fetch needs the
      // card_msg_content_type query the node-sdk's get typing lacks.
      const token = (await fetchTenantToken()).trim()
      const resp = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}?card_msg_content_type=raw_card_content`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await resp.json() as {
        code?: number
        data?: {
          items?: Array<{
            msg_type?: string
            parent_id?: string
            update_time?: string
            sender?: { id?: string; sender_type?: string }
            body?: { content?: string }
            mentions?: FeishuMention[]
          }>
        }
      }
      if (payload.code !== undefined && payload.code !== 0) {
        throw new Error(`feishu: message get: code=${String(payload.code)}`)
      }
      const item = payload.data?.items?.[0]
      if (item === undefined) return undefined
      const ms = Number.parseInt(item.update_time ?? '', 10)
      return {
        msgType: item.msg_type ?? '',
        parentId: item.parent_id ?? '',
        updateTimeMs: Number.isFinite(ms) ? ms : 0,
        senderId: item.sender?.id ?? '',
        senderType: item.sender?.sender_type ?? '',
        bodyContent: item.body?.content ?? '',
        ...(item.mentions !== undefined ? { mentions: item.mentions } : {}),
      }
    },
  })
  const base = verbSet()
  return { ...base, withToken: (token: string): FeishuApiClient => verbSet(sdk.withTenantToken(token)) }
}

/**
 * Event registrations for the default WS dispatcher (Go
 * feishu_lifecycle.go): the four routed event types pass through to the
 * raw-event callback — whose return value travels back as the callback
 * response (card.action.trigger card updates); the reaction echo events our
 * own add/removeReaction triggers carry explicit no-op handlers — without
 * one the node-sdk warns "no im.message.reaction.* handle" on every reaction.
 * @param onRawEvent - Raw-event sink receiving the event type and payload.
 * @returns Event-type → handler map for EventDispatcher.register.
 */
export function wsEventRegistrations(
  onRawEvent: (eventType: string, data: unknown) => unknown,
): Record<string, (data: unknown) => unknown> {
  const route = (eventType: string) => (data: unknown): unknown => onRawEvent(eventType, data)
  return {
    'im.message.receive_v1': route('im.message.receive_v1'),
    'card.action.trigger': route('card.action.trigger'),
    'im.chat.updated_v1': route('im.chat.updated_v1'),
    'im.message.recalled_v1': route('im.message.recalled_v1'),
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
  }
}

/**
 * Close handle for one started WS transport: severs the long connection so a
 * disposed platform (Cordis HMR reload) stops receiving Feishu events.
 */
export type WsClose = () => void

/**
 * Default WS bootstrap over the SDK's long-connection client (plan D5):
 * one WSClient per app, dispatcher wired for im.message.receive_v1.
 *
 * @returns A close handle for the client — without it an HMR-disposed
 * platform's WSClient stays connected and Feishu keeps delivering app events
 * to the zombie connection (load-balanced across the app's connections),
 * silently dropping messages routed to the disposed engine.
 */
async function defaultWsStart(
  appID: string,
  appSecret: string,
  onRawEvent: (eventType: string, data: unknown) => void,
): Promise<WsClose> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const dispatcher = new sdk.EventDispatcher({}).register(wsEventRegistrations(onRawEvent))
  const wsClient = new sdk.WSClient({ appId: appID, appSecret, domain: sdk.Domain.Feishu })
  await wsClient.start({ eventDispatcher: dispatcher })
  return () => { wsClient.close({ force: true }) }
}
