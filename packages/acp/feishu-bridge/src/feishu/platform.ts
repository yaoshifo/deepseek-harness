/**
 * Minimal Feishu platform ported from cc-connect platform/feishu (M1 text
 * path): a WSClient long connection per app (plan D5), im.message.receive_v1
 * dispatch with @bot gating, allow_from/allow_chat whitelists, event dedup,
 * thread-isolated session keys, and plain-text reply/send. Cards, media,
 * and rich markdown replies arrive with M2.
 *
 * The API client and WS bootstrap are injectable so unit tests feed synthetic
 * events into dispatch and record outbound calls without the network.
 *
 * @module dsh-feishu-bridge/feishu-platform
 */

import { MessageDedup, isOldMessage } from '../dedup.js'
import { AllowList } from './allowlist.js'
import { extractPostPlainText, hasHumanMention, isBotMentioned, stripMentions } from './extract.js'
import type { FeishuMention } from './extract.js'
import type { Message, MessageHandler, Platform } from '../core/types.js'

/** Platform-side reply context (Go replyContext). */
export interface FeishuReplyContext {
  messageID: string
  chatID: string
  sessionKey: string
}

/** Outbound message API surface the platform needs (node-sdk subset). */
export interface FeishuApiClient {
  reply(params: { messageId: string; msgType: string; content: string }): Promise<void>
  create(params: { chatId: string; msgType: string; content: string }): Promise<void>
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
}

/** msg_type for outbound text (Go larkim.MsgTypeText). */
const msgTypeText = 'text'

/**
 * Feishu (Lark) platform over one app's long connection (Go Platform, M1
 * subset).
 */
export class FeishuPlatform implements Platform {
  private readonly opts: Required<Pick<FeishuPlatformOptions, 'appID' | 'appSecret'>>
  private readonly o: FeishuPlatformOptions
  private readonly dedup = new MessageDedup()
  private handler: MessageHandler | undefined
  private api: FeishuApiClient | undefined
  private wsStarted = false

  constructor(options: FeishuPlatformOptions) {
    this.opts = { appID: options.appID, appSecret: options.appSecret }
    this.o = options
  }

  /** Platform name (session-key prefix). */
  name(): string {
    return this.o.tag ?? 'feishu'
  }

  /**
   * Open the long connection and register the inbound dispatcher. Only the
   * im.message.receive_v1 surface is wired for M1; card.action.trigger
   * arrives with M2's card system.
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
    // The node-sdk WSClient owns its reconnect loop; M1 relies on process
    // teardown (D9 watchdog arrives with the liveness milestone).
  }

  /** Handle one im.message.receive_v1 event (Go onMessage, M1 subset). */
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

    // TODO(M2): image/audio/file/merge_forward dispatch (media download).
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

  /** Reply quoting the trigger message when one exists (Go Reply). */
  async reply(replyCtx: unknown, content: string): Promise<void> {
    const rc = this.requireReplyCtx(replyCtx)
    const body = JSON.stringify({ text: content })
    if (this.shouldUseThreadOrReplyAPI(rc)) {
      await this.apiReply(rc.messageID, body)
      return
    }
    await this.apiCreate(rc.chatID, body)
  }

  /** Send: reply-shaped when a trigger message exists, else new message. */
  async send(replyCtx: unknown, content: string): Promise<void> {
    await this.reply(replyCtx, content)
  }

  private shouldUseThreadOrReplyAPI(rc: FeishuReplyContext): boolean {
    if (rc.messageID === '') return false
    return this.o.noReplyToTrigger !== true
  }

  private requireReplyCtx(replyCtx: unknown): FeishuReplyContext {
    const rc = replyCtx as Partial<FeishuReplyContext> | undefined
    if (typeof rc?.chatID !== 'string' || typeof rc.sessionKey !== 'string') {
      throw new Error(`feishu: invalid reply context ${String(replyCtx)}`)
    }
    return { messageID: rc.messageID ?? '', chatID: rc.chatID, sessionKey: rc.sessionKey }
  }

  private async apiReply(messageID: string, body: string): Promise<void> {
    const client = await this.ensureApi()
    await client.reply({ messageId: messageID, msgType: msgTypeText, content: body })
  }

  private async apiCreate(chatID: string, body: string): Promise<void> {
    if (chatID === '') throw new Error('feishu: chatID is empty, cannot send new message')
    const client = await this.ensureApi()
    await client.create({ chatId: chatID, msgType: msgTypeText, content: body })
  }

  private async ensureApi(): Promise<FeishuApiClient> {
    this.api ??= this.o.apiClient ?? (await defaultApiClient(this.opts.appID, this.opts.appSecret))
    return this.api
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

/**
 * Default API client over @larksuiteoapi/node-sdk (lazily imported so unit
 * tests never load the SDK).
 */
async function defaultApiClient(appID: string, appSecret: string): Promise<FeishuApiClient> {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const client = new sdk.Client({
    appId: appID,
    appSecret,
    appType: sdk.AppType.SelfBuild,
    domain: sdk.Domain.Feishu,
  })
  return {
    async reply({ messageId, msgType, content }): Promise<void> {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: { content, msg_type: msgType },
      })
    },
    async create({ chatId, msgType, content }): Promise<void> {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: msgType },
      })
    },
  }
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
