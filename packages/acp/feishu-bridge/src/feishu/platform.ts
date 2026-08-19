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
import { fileURLToPath } from 'node:url'
import { MessageDedup, isOldMessage } from '../dedup.js'
import { AllowList } from './allowlist.js'
import { extractPostPlainText, hasHumanMention, isBotMentioned, stripMentions } from './extract.js'
import type { FeishuMention } from './extract.js'
import type { Card } from '../card.js'
import { renderCard } from './card.js'
import {
  buildPreviewCardJSON,
  buildProgressCardJSONFromPayload,
  buildReplyContent,
  injectReplyButtons,
  injectStopButton,
  markCardStopped,
} from './progress.js'
import { previewOverflow as previewOverflowFn } from './markdown.js'
import { noSpinner, type SpinnerCfg } from './spinner.js'
import { parseProgressCardPayload, parseProgressStyle } from '../progress.js'
import { TokenBucketRateLimiter, isTenantAccessTokenInvalid, withTransientRetry } from './retry.js'
import { errorMessage } from './retry.js'
import { ErrNotSupported, type ImageAttachment, type FileAttachment, type Message, type MessageHandler, type Platform } from '../core/types.js'
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

/**
 * Outbound message API surface the platform needs (node-sdk subset). M1's
 * reply/create are required; the M2 verbs are optional so minimal test
 * fakes keep working — card paths fail loud when a verb is missing.
 */
/** Params for a reply API call. */
export interface FeishuReplyParams { messageId: string; msgType: string; content: string; replyInThread?: boolean }

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

/** Inbound card.action.trigger payload (structural slice, M3). */
export interface CardActionTriggerEvent {
  event?: {
    action?: {
      value?: Record<string, string>
      option?: string
      name?: string
      formValue?: Record<string, string>
    }
    operator?: { openId?: string }
    context?: { openChatID?: string; openMessageID?: string }
  }
}

/** Handle for an in-place editable preview card (Go feishuPreviewHandle). */
export class FeishuPreviewHandle {
  readonly messageID: string
  readonly chatID: string
  readonly sessionKey: string

  constructor(messageID: string, chatID: string, sessionKey: string) {
    this.messageID = messageID
    this.chatID = chatID
    this.sessionKey = sessionKey
  }

  /** Stable per-turn key for associating exported content (Go ExportKey). */
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
  /** WS bootstrap receiving the raw-event callback; defaults to WSClient. */
  wsStart?: (onRawEvent: (eventType: string, data: unknown) => void) => Promise<void>
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
}

/** Feishu reply API code for a recalled/withdrawn target message. */
const feishuCodeMessageWithdrawn = 230011

function isThreadSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':', 3)
  if (parts.length !== 3) return false
  const tail = parts[2] ?? ''
  if (!tail.startsWith('root:') && !tail.startsWith('thread:')) return false
  return tail.slice(tail.indexOf(':') + 1) !== ''
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

  /** Interactive cards enabled (enable_feishu_card). */
  readonly useInteractiveCard: boolean
  /** Validated progress style ("legacy" | "compact" | "card"). */
  readonly progressStyle: string
  private readonly notifyOnComplete: boolean
  private readonly reactionEmoji: string
  private readonly doneEmoji: string
  private readonly cancelEmoji: string
  private readonly topNoticeEnabled: boolean
  private readonly pinEnabled: boolean
  private readonly spinnerEnabled: boolean
  /** Global limiter for every card PATCH entry point. */
  private readonly patchRL: TokenBucketRateLimiter

  /** messageID → pre-button card JSON (stop-card rebuild + render-status rebuild). */
  private readonly lastProgressCard = new Map<string, string>()
  /** messageID → latest render status text (#48 survival). */
  private readonly renderStatusText = new Map<string, string>()
  /** sessionKey → permission card body (M3 card-action replacement). */
  readonly permBodyCache = new Map<string, string>()
  /** sessionKey → messageID tracked from card-action callbacks (M3 writes it). */
  readonly cardActionMsgIDs = new Map<string, string>()

  private spinnerOnce: Promise<void> | undefined
  private thinkingImgKey = ''
  private executingImgKey = ''

  /** Spawned-chat registry (loaded from dataDir when set). */
  readonly spawnStore: SpawnedChatStore
  /** Tag manager bound to this platform's API client. */
  private readonly tagManager: TagManager
  /** Chat-name TTL cache (Go chatNameCache). */
  private readonly chatNames = new ChatNameCache()
  /** Bot avatar image keys, filled by the startup probe when it runs. */
  private botAvatarKey: string
  private botAvatarKeyGray: string
  /** Document frequency of words across workspace project names (Go dirWordFreq). */
  private dirWordFreq: Record<string, number> = {}
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
    const projectName = options.projectName !== undefined && options.projectName !== '' ? options.projectName : this.name()
    const base = `${projectName}_${this.name()}`
    const dataDir = options.dataDir ?? ''
    const sessionsDir = dataDir === '' ? '' : join(dataDir, 'sessions')
    this.spawnStore = new SpawnedChatStore(sessionsDir === '' ? '' : join(sessionsDir, `${base}_spawned.json`))
    this.tagManager = new TagManager({
      api: this.tagApi(),
      tagCacheFile: sessionsDir === '' ? '' : join(sessionsDir, `${base}_tag_cache.json`),
      projectName,
      ...(options.activeTagOverride !== undefined ? { activeTagOverride: options.activeTagOverride } : {}),
      spawnedChatIDs: () => this.spawnStore.chatIDs(),
    })
  }

  /** Platform name (session-key prefix). */
  name(): string {
    return this.o.tag ?? 'feishu'
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
    await wsStart((eventType, data) => {
      if (eventType === 'im.message.receive_v1') {
        this.onMessage(data as FeishuReceiveEvent)
      } else if (eventType === 'card.action.trigger') {
        this.onCardAction(data as CardActionTriggerEvent)
      }
    })
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

  async stop(): Promise<void> {
    // The node-sdk WSClient owns its reconnect loop; teardown relies on
    // process exit (watchdog arrives with the liveness milestone).
  }

  /** Handle one im.message.receive_v1 event (Go onMessage). */
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

    // Group messages require an @bot mention unless group_reply_all is set.
    if (chatType === 'group' && this.o.groupReplyAll !== true && !isSpawned
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
    if (chatType === 'group' && !AllowList(this.o.allowChat ?? '', chatID) && !isSpawned) return
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
      this.dispatch(sessionKey, messageID, userID, chatID, chatType, text, '', replyCtx, isSpawned, parentID)
      return
    }
    if (msgType === 'post') {
      const text = stripMentions(extractPostPlainText(content), mentions, this.o.botOpenID ?? '')
      if (text === '') return
      this.dispatch(sessionKey, messageID, userID, chatID, chatType, text, '', replyCtx, isSpawned, parentID)
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
   * Handle one card.action.trigger callback (Go onCardAction, M3 subset).
   * Parses perm:/askq: action values and dispatches as synthetic messages
   * with isPermissionAction/isAskqCardAction flags so the engine routes
   * them to handlePendingPermission.
   */
  onCardAction(event: CardActionTriggerEvent): void {
    const action = event.event?.action
    if (action === undefined) return
    const chatID = event.event?.context?.openChatID ?? ''
    const messageID = event.event?.context?.openMessageID ?? ''
    const userID = event.event?.operator?.openId ?? ''

    // Allow-chat filter
    if (chatID !== '' && !AllowList(this.o.allowChat ?? '', chatID)) return

    // Resolve action value from value map, option, or button name
    let actionVal = action.value?.action ?? ''
    if (actionVal === '' && action.option !== '') actionVal = action.option ?? ''
    if (actionVal === '') {
      const name = action.name ?? ''
      if (name === 'perm_allow') actionVal = 'perm:allow'
      else if (name === 'perm_deny') actionVal = 'perm:deny'
      else if (name === 'perm_allow_all') actionVal = 'perm:allow_all'
      else if (name.startsWith('askq_multi_submit_')) actionVal = `askq_multi:${name.slice('askq_multi_submit_'.length)}`
      else if (name.startsWith('askq_') && name !== 'askq_multi_submit_') {
        // Single-select askq button: value carries "askq:qIdx:optIdx"
        actionVal = action.value?.action ?? name
      }
    }
    if (actionVal === '') return

    const sessionKey = `feishu:${chatID}:${userID}`
    const replyCtx: FeishuReplyContext = { messageID, chatID, sessionKey }
    const isSpawned = this.isSpawned(chatID)

    // perm: → permission response
    if (actionVal.startsWith('perm:')) {
      let content = ''
      if (actionVal === 'perm:allow') content = 'allow'
      else if (actionVal === 'perm:deny') {
        content = 'deny'
        const reason = action.formValue?.deny_reason ?? ''
        if (reason.trim() !== '') content = `deny\x00${reason.trim()}`
      } else if (actionVal === 'perm:allow_all') content = 'allow all'
      else return

      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        content, '', replyCtx, isSpawned, '', true, false)
      return
    }

    // askq: → AskUserQuestion answer
    if (actionVal.startsWith('askq:') || actionVal.startsWith('askq_multi:')) {
      // Convert askq_multi: to askq: format for the engine
      let content = actionVal
      if (actionVal.startsWith('askq_multi:')) {
        content = 'askq:' + actionVal.slice('askq_multi:'.length)
      }
      // Prefer the label from value for display
      const label = action.value?.askq_label ?? content
      this.dispatch(sessionKey, messageID, userID, chatID, 'group',
        label, '', replyCtx, isSpawned, '', false, true)
      return
    }
  }

  /** Whether the chat is /spawn-created (external predicate or the store). */
  private isSpawned(chatID: string): boolean {
    if (this.o.isSpawnedChat !== undefined) return this.o.isSpawnedChat(chatID)
    return this.spawnStore.isSpawned(chatID)
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
      parentMessageID,
      quotedText: '',
    }
    // Async dispatch keeps the SDK event loop free of engine IO (Go SafeGo).
    void Promise.resolve().then(() => this.handler?.(this, message)).catch((error: unknown) => {
      console.error(`feishu: dispatch failed (${sessionKey}): ${String(error)}`)
    })
  }

  /**
   * Session-key derivation (Go makeSessionKey): spawned chats key on the
   * chat alone; thread isolation splits group conversations by thread or
   * reply root; otherwise per-user (or per-chat with
   * share_session_in_channel).
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

  /** Send a structured card quoting the trigger message (Go ReplyCard). */
  async replyCard(replyCtx: unknown, card: Card): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const permBody = card.permBody ?? ''
    if (permBody !== '') this.permBodyCache.set(rc.sessionKey, permBody)
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

  /** Send a structured card as a new message to the chat (Go SendCard). */
  async sendCard(replyCtx: unknown, card: Card): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    if (rc.chatID === '') throw new Error('feishu: chatID is empty, cannot send card')
    const permBody = card.permBody ?? ''
    if (permBody !== '') this.permBodyCache.set(rc.sessionKey, permBody)
    if (this.o.noReplyToTrigger !== true && this.shouldReplyInThread(rc)) {
      await this.replyCard(replyCtx, card)
      return
    }
    const cardJSON = renderCard(card, rc.sessionKey)
    await this.withRetry('send card', () => this.request('send card', client =>
      client.create({ chatId: rc.chatID, msgType: 'interactive', content: cardJSON })))
  }

  /** Send a card and return a handle for subsequent PATCH updates. */
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

  /** PATCH an existing card identified by handle. */
  async updateCardWithHandle(handle: unknown, card: Card): Promise<void> {
    const h = requirePreviewHandle(handle)
    const cardJSON = renderCard(card, h.sessionKey)
    await this.patchRateWait()
    await this.withRetry('update card by handle', () => this.patchMessage(h.messageID, cardJSON))
  }

  /** PATCH a card tracked from the most recent card-action callback. */
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

  /** Keep the preview card as the final delivered message (Go KeepPreviewOnFinish). */
  keepPreviewOnFinish(): boolean {
    return this.useInteractiveCard
  }

  /** Whether the platform renders structured progress payloads. */
  supportsProgressCardPayload(): boolean {
    return true
  }

  /** Whether content exceeds the preview card's table limit (11310 guard). */
  previewOverflow(content: string): boolean {
    return previewOverflowFn(content)
  }

  /** Whether a PATCH failure is a transient rate-limit (230020). */
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
          const dir = dirname(fileURLToPath(import.meta.url))
          const data = new Uint8Array(await readFile(`${dir}/../../assets/${name}`))
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

  /** Current spinner config, uploading on first use. */
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
   */
  async sendPreviewStart(replyCtx: unknown, content: string): Promise<FeishuPreviewHandle> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: preview start without interactive cards')
    const rc = this.requireReplyCtx(replyCtx)
    if (rc.chatID === '') throw new Error('feishu: chatID is empty')

    const spin = await this.spinnerCfg()
    const preButtonJSON = buildPreviewCardJSON(content, spin)
    const cardJSON = injectStopButton(preButtonJSON, rc.sessionKey)

    const msgID = await this.withRetry('send preview', () => this.request('send preview', async (client) => {
      if (this.shouldUseThreadOrReplyAPI(rc)) {
        const resp = await client.reply({
          messageId: rc.messageID,
          msgType: 'interactive',
          content: cardJSON,
          replyInThread: this.shouldReplyInThread(rc),
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
   */
  async updateMessage(previewHandle: unknown, content: string): Promise<void> {
    if (!this.useInteractiveCard) throw new ErrNotSupported('feishu: update message without interactive cards')
    const h = requirePreviewHandle(previewHandle)

    const spin = await this.spinnerCfg()
    const payload = parseProgressCardPayload(content)
    const cardJSON = payload !== undefined
      ? buildProgressCardJSONFromPayload(payload, spin)
      : buildPreviewCardJSON(content, spin)
    this.lastProgressCard.set(h.messageID, cardJSON)
    let json = injectStopButton(cardJSON, h.sessionKey)
    const statusText = this.renderStatusText.get(h.messageID) ?? ''
    json = injectReplyButtons(json, h.sessionKey, h.messageID, statusText)
    await this.patchRateWait()
    await this.withRetry('patch message', () => this.patchMessage(h.messageID, json))
  }

  /**
   * Refresh the render-status line on a previously sent green card (#47/#48):
   * rebuild from the pre-button cache, re-inject stop + reply buttons plus
   * the status, PATCH in place.
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

  /** Remove a preview message and its caches (Go DeletePreviewMessage). */
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

  /** Block until the global PATCH limiter allows one call. */
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
   */
  async sendCompletionNotification(replyCtx: unknown, usageMsg: string): Promise<void> {
    if (!this.notifyOnComplete || usageMsg === '') return
    await this.reply(replyCtx, usageMsg)
  }

  /** Set the chat's top-notice banner to a message (Go SetTopNotice). */
  async setTopNotice(chatID: string, messageID: string): Promise<void> {
    if (!this.topNoticeEnabled) throw new ErrNotSupported('feishu: top notice disabled')
    await this.withRetry('top_notice.put', () => this.request('top_notice.put', async (client) => {
      if (client.putTopNotice === undefined) throw new ErrNotSupported('feishu client without top notice support')
      await client.putTopNotice({ chatId: chatID, messageId: messageID })
    }))
  }

  /** Remove the chat's top-notice banner (Go ClearTopNotice). */
  async clearTopNotice(chatID: string, _messageID: string): Promise<void> {
    if (!this.topNoticeEnabled) throw new ErrNotSupported('feishu: top notice disabled')
    await this.withRetry('top_notice.delete', () => this.request('top_notice.delete', async (client) => {
      if (client.deleteTopNotice === undefined) throw new ErrNotSupported('feishu client without top notice support')
      await client.deleteTopNotice({ chatId: chatID })
    }))
  }

  /** Pin a message into the chat's pin panel (Go AddMessagePin). */
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

  private async removeReaction(messageID: string, reactionID: string): Promise<void> {
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

  private readonly pendingTypingRemovals = new Map<string, string>()

  /** Add the typing emoji and return a stop function removing it. */
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
      void this.removeReaction(messageID, reactionID)
    }
  }

  /** Done-reaction push after a quiet multi-round turn (Go AddDoneReaction). */
  addDoneReaction(replyCtx: unknown): void {
    this.fireAndForgetReaction(replyCtx, this.doneEmoji)
  }

  /** Cancelled-reaction after a user stop (Go AddCancelledReaction). */
  addCancelledReaction(replyCtx: unknown): void {
    this.fireAndForgetReaction(replyCtx, this.cancelEmoji)
  }

  /** Arbitrary emoji acknowledgment (Go AddReaction). */
  addReaction(replyCtx: unknown, emoji: string): void {
    this.fireAndForgetReaction(replyCtx, emoji)
  }

  private fireAndForgetReaction(replyCtx: unknown, emoji: string): void {
    if (emoji === '') return
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    if (messageID === '') return
    void this.addReactionWithEmoji(messageID, emoji)
  }

  /** Synchronous reaction returning an ID (Go AddReactionWithID). */
  async addReactionWithID(replyCtx: unknown, emoji: string): Promise<string> {
    const messageID = (replyCtx as Partial<FeishuReplyContext> | undefined)?.messageID ?? ''
    if (messageID === '') return ''
    return this.addReactionWithEmoji(messageID, emoji)
  }

  /**
   * Rebuild a reply context from a session key for proactive sends (cron,
   * tools). The chat ID is the key's second segment.
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
   * avatar and other fields untouched.
   */
  private async renameChat(chatID: string, newName: string): Promise<void> {
    await this.withRetry('rename chat', () => this.request('rename chat', async (client) => {
      if (client.updateChat === undefined) throw new ErrNotSupported('feishu client without chat update support')
      const resp = await client.updateChat({ chatId: chatID, name: newName })
      this.ensureOk(resp, 'rename chat')
    }))
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

  /** Rename a spawned chat only (Go RenameGroup, conservative default). */
  async renameGroup(sessionKey: string, newName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '' || !this.spawnStore.isSpawned(chatID)) return
    await this.renameChat(chatID, newName)
  }

  /**
   * Rename any group, including user-owned ones (Go RenameGroupAny) — used by
   * /chatroom to rename the user's own hub group to the discussion topic.
   */
  async renameGroupAny(sessionKey: string, newName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') return
    await this.renameChat(chatID, newName)
  }

  /**
   * Switch a spawned group's avatar state: active=true restores the color
   * avatar, false grays it. Per-group custom keys (#52) win over the global
   * bot avatar; a missing gray key skips dimming rather than failing /done.
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

  /**
   * Stamp one shared Lucide icon avatar across a chatroom family (Go
   * SetChatroomFamilyAvatar): hub plus role/assistant child groups. One
   * render + upload per variant, the same color image on every group. The hub
   * is never tracked as spawned; children get per-group color/gray keys so
   * chatroom-end /done dims via the gray icon. Without children the gray
   * upload is skipped.
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
   */
  async spawnGroup(msg: Message, groupName: string, firstMsg: string): Promise<Message> {
    return this.spawnGroupWithOptions(msg, groupName, firstMsg, {})
  }

  /**
   * Spawn with options (Go SpawnGroupWithOptions): topic groups use
   * group_message_type=thread; a non-default workDir re-derives the dir tag
   * from that directory.
   */
  async spawnGroupWithOptions(msg: Message, groupName: string, firstMsg: string, opts: GroupSpawnOptions): Promise<Message> {
    await this.ensureInit()
    const userID = msg.userID
    if (userID === '') {
      throw new Error('feishu: spawn: could not determine caller user ID')
    }
    const chatType = opts.topicGroup === true ? 'thread' : 'chat'
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
    console.info(`${this.tag()}: spawned group chat (chat_id ${chatID}, user_id ${userID}, group_name ${groupName}, mode ${opts.topicGroup === true ? 'topic_group' : 'group'})`)

    // Apply the dir tag off the critical path; no active (❤️) tag on spawn —
    // the group is "active" by its color avatar alone.
    void (async () => {
      let tagName = this.tagManager.dirTagName
      if (opts.workDir !== undefined && opts.workDir !== '') {
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

  /** The applink that opens chatID when clicked (Go ChatJumpURL). */
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
      throw new Error(`${this.tag()}: list chat members: ${errorMessage(failure)}`)
    }
    return ids
  }

  /**
   * Add open_ids to the chat identified by sessionKey (Go AddChatMembers):
   * the bot and duplicates are skipped, requests batch at 50, and a batch
   * failure is logged without aborting the remaining batches.
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

  /** This bot's resolved active-tag name (Go ActiveTagName). */
  activeTagName(): string {
    return this.tagManager.activeTagName()
  }

  /** Remove a tag from a chat (Go RemoveTagFromChat, /done). */
  async removeTagFromChat(sessionKey: string, tagName: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: remove tag: no chat ID in session key`)
    }
    await this.ensureInit()
    await this.tagManager.removeTagFromChat(chatID, tagName)
  }

  /** Attach the active (heart) tag to a chat (Go ApplyActiveTag). */
  async applyActiveTag(sessionKey: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') {
      throw new Error(`${this.tag()}: apply active tag: no chat ID in session key`)
    }
    await this.ensureInit()
    await this.tagManager.resolveAndAttachActiveTag(chatID)
  }

  /** Mark a spawned chat done (inactive) — Go MarkSpawnedChatDone. */
  async markSpawnedChatDone(sessionKey: string): Promise<void> {
    const chatID = extractFeishuChatID(sessionKey)
    if (chatID === '') return
    await this.ensureInit()
    await this.spawnStore.markDone(chatID)
  }

  /** Mark a spawned chat active again — Go MarkSpawnedChatActive. */
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
   */
  async uploadImage(img: ImageAttachment): Promise<string> {
    const key = await this.withRetry('upload image', () => this.request('upload image', async (client) => {
      if (client.uploadImage === undefined) throw new ErrNotSupported('feishu client without image upload support')
      return client.uploadImage({ data: img.data, mimeType: img.mimeType, fileName: img.fileName ?? 'image' })
    }))
    if (key === '') throw new Error(`${this.tag()}: upload image: no image_key returned`)
    return key
  }

  /** Send an image message quoting the trigger when one exists (Go SendImage). */
  async sendImage(replyCtx: unknown, img: ImageAttachment): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const imageKey = await this.uploadImage(img)
    await this.sendMediaMessage(rc, 'image', JSON.stringify({ image_key: imageKey }))
  }

  /**
   * Send a file message: upload with the detected Feishu file type, then send
   * (Go SendFile).
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
  })
  const base = verbSet()
  return { ...base, withToken: (token: string): FeishuApiClient => verbSet(sdk.withTenantToken(token)) }
}

/**
 * Default WS bootstrap over the SDK's long-connection client (plan D5):
 * one WSClient per app, dispatcher wired for im.message.receive_v1.
 */
async function defaultWsStart(
  appID: string,
  appSecret: string,
  onRawEvent: (eventType: string, data: unknown) => void,
): Promise<void> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const dispatcher = new sdk.EventDispatcher({}).register({
    'im.message.receive_v1': (data: unknown) => {
      onRawEvent('im.message.receive_v1', data)
    },
    'card.action.trigger': (data: unknown) => {
      onRawEvent('card.action.trigger', data)
    },
  })
  const wsClient = new sdk.WSClient({ appId: appID, appSecret, domain: sdk.Domain.Feishu })
  await wsClient.start({ eventDispatcher: dispatcher })
}
