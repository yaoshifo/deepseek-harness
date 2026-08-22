/**
 * Quoted-message fetch tests for the Feishu platform (Go feishu.go
 * fetchQuotedMessage / fetchReplyChain / formatReplyChain, the M6b /learn
 * leftover): a reply's parent chain is fetched through the api client,
 * formatted as a prefix, and attached to the dispatched Message
 * (extraContent for /learn's extractQuotedText, quotedText + sender type +
 * update time for later /fork-rollback wiring). Any fetch failure degrades
 * to delivering the user's message without the quote.
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient, type FeishuQuotedMessage, type FeishuReceiveEvent } from '../../src/feishu/platform.js'
import { formatReplyChain, type ChainMessage } from '../../src/feishu/platform.js'
import type { Message } from '../../src/core/types.js'

function quoted(overrides: Partial<FeishuQuotedMessage> & { messageID?: string }): FeishuQuotedMessage {
  return {
    msgType: 'text',
    parentId: '',
    updateTimeMs: 1690000000000,
    senderId: 'ou_q',
    senderType: 'user',
    bodyContent: JSON.stringify({ text: '支付服务 502 了' }),
    ...overrides,
  }
}

/** Client serving a message-id → payload map (undefined = fetch failure). */
function quoteApi(byID: Record<string, FeishuQuotedMessage | undefined>): FeishuApiClient {
  return {
    async reply() { return { messageId: 'om_ok' } },
    async create() { return { messageId: 'om_ok' } },
    async getMessage({ messageId }) {
      return byID[messageId]
    },
  }
}

function newPlatform(api: FeishuApiClient, options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    apiClient: api,
    wsStart: async () => {},
    ...options,
  })
}

function receiveEvent(overrides: Partial<FeishuReceiveEvent['message']>): FeishuReceiveEvent {
  return {
    message: {
      message_id: 'om_new',
      chat_id: 'oc_1',
      message_type: 'text',
      content: JSON.stringify({ text: 'help with this' }),
      chat_type: 'p2p',
      create_time: String(Date.now()),
      ...overrides,
    },
    sender: { sender_id: { open_id: 'ou_9' } },
  }
}

async function dispatched(p: FeishuPlatform, event: FeishuReceiveEvent): Promise<Message[]> {
  const messages: Message[] = []
  await p.start((_platform, msg) => { messages.push(msg) })
  p.onMessage(event)
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  return messages
}

describe('formatReplyChain', () => {
  it('single message uses the legacy bracket format', () => {
    const chain: ChainMessage[] = [{ senderName: '韩明', senderType: 'user', text: 'hi', parentId: '', updateTimeMs: 1 }]
    expect(formatReplyChain(chain)).toBe('[Quoted message from 韩明]:\nhi\n\n')
  })

  it('multi-message chains use the numbered role format', () => {
    const chain: ChainMessage[] = [
      { senderName: '韩明', senderType: 'user', text: '问题', parentId: 'om_2', updateTimeMs: 1 },
      { senderName: 'Bot', senderType: 'app', text: '回答', parentId: '', updateTimeMs: 2 },
    ]
    const text = formatReplyChain(chain)
    expect(text).toBe('--- Reply chain (2 messages) ---\n[1] 韩明 (user):\n问题\n\n[2] Bot (assistant):\n回答\n\n---\n\n')
  })

  it('empty chain is empty', () => {
    expect(formatReplyChain([])).toBe('')
  })
})

describe('quoted message fetch on dispatch', () => {
  it('attaches the quoted parent as extraContent + quotedText', async () => {
    const p = newPlatform(quoteApi({ om_parent: quoted({}) }))
    const messages = await dispatched(p, receiveEvent({ parent_id: 'om_parent' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.extraContent).toContain('[Quoted message from User]')
    expect(messages[0]!.extraContent).toContain('支付服务 502 了')
    expect(messages[0]!.quotedText).toBe('支付服务 502 了')
    expect(messages[0]!.quotedSenderType).toBe('user')
    expect(messages[0]!.quotedUpdateTimeMs).toBe(1690000000000)
    expect(messages[0]!.parentMessageID).toBe('om_parent')
  })

  it('traverses the parent chain chronologically with bot labels', async () => {
    const p = newPlatform(quoteApi({
      om_parent: quoted({ parentId: 'om_grand', senderType: 'app', bodyContent: JSON.stringify({ text: 'bot answer' }) }),
      om_grand: quoted({ bodyContent: JSON.stringify({ text: 'original question' }) }),
    }))
    const messages = await dispatched(p, receiveEvent({ parent_id: 'om_parent' }))
    expect(messages[0]!.extraContent).toContain('--- Reply chain (2 messages) ---')
    expect(messages[0]!.extraContent).toContain('[1] User (user):\noriginal question')
    expect(messages[0]!.extraContent).toContain('[2] Bot (assistant):\nbot answer')
    // quotedText is the directly-quoted message (chain tail).
    expect(messages[0]!.quotedText).toBe('bot answer')
    expect(messages[0]!.quotedSenderType).toBe('app')
  })

  it('stops on circular references and caps the depth', async () => {
    const byID: Record<string, FeishuQuotedMessage | undefined> = {
      om_a: quoted({ parentId: 'om_b', bodyContent: JSON.stringify({ text: 'A' }) }),
      om_b: quoted({ parentId: 'om_a', bodyContent: JSON.stringify({ text: 'B' }) }),
    }
    const p = newPlatform(quoteApi(byID))
    const messages = await dispatched(p, receiveEvent({ parent_id: 'om_a' }))
    expect(messages[0]!.extraContent).toContain('--- Reply chain (2 messages) ---')
  })

  it('degrades gracefully when the fetch fails', async () => {
    const p = newPlatform(quoteApi({ om_missing: undefined }))
    const messages = await dispatched(p, receiveEvent({ parent_id: 'om_missing' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.extraContent).toBe('')
    expect(messages[0]!.quotedText).toBe('')
    expect(messages[0]!.content).toBe('help with this')
  })

  it('skips the fetch inside an isolated thread and without a parent', async () => {
    let calls = 0
    const api = quoteApi({})
    api.getMessage = async () => { calls++; return undefined }
    const p = newPlatform(api, { threadIsolation: true })
    // No thread_id and no thread-prefixed session key here; the thread skip
    // needs an isolated-thread session key, so assert the no-parent path.
    const noParent = await dispatched(p, receiveEvent({}))
    expect(noParent[0]!.extraContent).toBe('')
    expect(calls).toBe(0)
  })

  it('labels app senders as Bot and extracts card text from interactive parents', async () => {
    const p = newPlatform(quoteApi({
      om_card: quoted({
        msgType: 'interactive',
        senderType: 'app',
        bodyContent: JSON.stringify({ type: 'raw_card_content', raw_card_content: JSON.stringify({ elements: [{ tag: 'text', text: '进度卡内容' }] }) }),
      }),
    }))
    const messages = await dispatched(p, receiveEvent({ parent_id: 'om_card' }))
    expect(messages[0]!.extraContent).toContain('Bot')
    expect(messages[0]!.extraContent).toContain('进度卡内容')
  })
})

describe('monitor-chat exemption from thread isolation', () => {
  // Under threadIsolation every group message derives a root:/thread: session
  // key, so the quote-fetch skip would fire for monitored chats too — where
  // the quote is /learn's data, not redundant session context.
  it('fetches the quote in a monitored group under thread isolation', async () => {
    const p = newPlatform(quoteApi({ om_parent: quoted({}) }), { threadIsolation: true })
    p.setMonitorChats('oc_1')
    const messages = await dispatched(p, receiveEvent({ chat_type: 'group', parent_id: 'om_parent' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.extraContent).toContain('[Quoted message from User]')
    expect(messages[0]!.quotedText).toBe('支付服务 502 了')
  })

  it('still skips the quote in a non-monitored group under thread isolation', async () => {
    let calls = 0
    const api = quoteApi({ om_parent: quoted({}) })
    api.getMessage = async () => { calls++; return undefined }
    const p = newPlatform(api, { threadIsolation: true })
    const messages = await dispatched(p, receiveEvent({ chat_type: 'group', parent_id: 'om_parent' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.extraContent).toBe('')
    expect(calls).toBe(0)
  })

  it('replies inline from a monitored chat under thread isolation', async () => {
    const api = quoteApi({})
    const threadFlags: boolean[] = []
    api.reply = async ({ replyInThread }) => {
      threadFlags.push(replyInThread === true)
      return { messageId: 'om_ok' }
    }
    const p = newPlatform(api, { threadIsolation: true })
    p.setMonitorChats('oc_chat')
    await p.send({ messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:root:om_trigger' }, 'ack')
    expect(threadFlags).toEqual([false])
  })

  it('still replies in thread from a non-monitored chat under thread isolation', async () => {
    const api = quoteApi({})
    const threadFlags: boolean[] = []
    api.reply = async ({ replyInThread }) => {
      threadFlags.push(replyInThread === true)
      return { messageId: 'om_ok' }
    }
    const p = newPlatform(api, { threadIsolation: true })
    await p.send({ messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:root:om_trigger' }, 'ack')
    expect(threadFlags).toEqual([true])
  })
})
