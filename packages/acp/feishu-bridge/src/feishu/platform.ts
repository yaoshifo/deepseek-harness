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
 * network. Not ported yet: mention resolution, comment-session driving,
 * media downloads (media milestone).
 *
 * @module dsh-feishu-bridge/feishu-platform
 */

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
import { ErrNotSupported, type Message, type MessageHandler, type Platform } from '../core/types.js'

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
    const wsStart = this.o.wsStart ?? (onRawEvent => defaultWsStart(this.opts.appID, this.opts.appSecret, onRawEvent))
    await wsStart((eventType, data) => {
      if (eventType === 'im.message.receive_v1') {
        this.onMessage(data as FeishuReceiveEvent)
      }
    })
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
    const isSpawned = this.o.isSpawnedChat?.(chatID) ?? false

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
    }
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
      images: [],
      files: [],
      extraContent,
      replyCtx,
      fromVoice: false,
      isSpawnedGroup,
      isPermissionAction: false,
      isAskqCardAction: false,
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
    if (this.o.isSpawnedChat?.(chatID) ?? false) return `${tag}:${chatID}`
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
}

function requirePreviewHandle(handle: unknown): FeishuPreviewHandle {
  if (handle instanceof FeishuPreviewHandle) return handle
  throw new Error(`feishu: invalid preview handle type ${String(handle)}`)
}

/**
 * Default API client over @larksuiteoapi/node-sdk (lazily imported so unit
 * tests never load the SDK). Token refresh uses the SDK's
 * withTenantToken per-request option on a token-cache-disabled client.
 */
async function defaultApiClient(appID: string, appSecret: string): Promise<FeishuApiClient> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const client = new sdk.Client({
    appId: appID,
    appSecret,
    appType: sdk.AppType.SelfBuild,
    domain: sdk.Domain.Feishu,
  })
  const base: FeishuApiClient = {
    async reply({ messageId, msgType, content, replyInThread }) {
      const resp = await client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType, ...(replyInThread === true ? { reply_in_thread: true } : {}) },
      })
      return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
    },
    async create({ chatId, msgType, content }) {
      const resp = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: msgType },
      })
      return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
    },
    async patch({ messageId, content }) {
      await client.im.message.patch({ path: { message_id: messageId }, data: { content } })
    },
    async delete({ messageId }) {
      await client.im.message.delete({ path: { message_id: messageId } })
    },
    fetchTenantAccessToken: async () => {
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appID, app_secret: appSecret }),
      })
      const data = await resp.json() as { tenant_access_token?: string }
      return data.tenant_access_token ?? ''
    },
    withToken: (token: string): FeishuApiClient => {
      const opts = sdk.withTenantToken(token)
      return {
        ...base,
        reply: async (params) => {
          const resp = await client.im.message.reply({
            path: { message_id: params.messageId },
            data: {
              content: params.content,
              msg_type: params.msgType,
              ...(params.replyInThread === true ? { reply_in_thread: true } : {}),
            },
          }, opts)
          return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
        },
        create: async (params) => {
          const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: params.chatId, content: params.content, msg_type: params.msgType },
          }, opts)
          return resp.data?.message_id !== undefined ? { messageId: resp.data.message_id } : undefined
        },
        patch: async (params) => {
          await client.im.message.patch({ path: { message_id: params.messageId }, data: { content: params.content } }, opts)
        },
      }
    },
    async putTopNotice({ chatId, messageId }) {
      await client.im.chatTopNotice.putTopNotice({
        path: { chat_id: chatId },
        data: { chat_top_notice: [{ action_type: '1', message_id: messageId }] },
      })
    },
    async deleteTopNotice({ chatId }) {
      await client.im.chatTopNotice.deleteTopNotice({ path: { chat_id: chatId } })
    },
    async createPin({ messageId }) {
      await client.im.pin.create({ data: { message_id: messageId } })
    },
    async createReaction({ messageId, emojiType }) {
      const resp = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      return resp.data?.reaction_id !== undefined ? { reactionId: resp.data.reaction_id } : undefined
    },
    async deleteReaction({ messageId, reactionId }) {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    },
    async uploadImage({ data }) {
      // node-sdk takes the raw multipart fields (Buffer); the file name and
      // MIME type ride along in the multipart metadata it builds.
      const resp = await client.im.image.create({
        data: { image_type: 'message', image: Buffer.from(data) },
      })
      return resp?.image_key ?? ''
    },
  }
  return base
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
  })
  const wsClient = new sdk.WSClient({ appId: appID, appSecret, domain: sdk.Domain.Feishu })
  await wsClient.start({ eventDispatcher: dispatcher })
}
