import { describe, expect, it } from 'vitest'
import { extractPostPlainText, hasHumanMention, isBotMentioned, stripMentions } from '../../src/feishu/extract.js'
import { AllowList } from '../../src/feishu/allowlist.js'
import { FeishuPlatform, type FeishuApiClient, type FeishuReceiveEvent } from '../../src/feishu/platform.js'
import type { Message } from '../../src/core/types.js'

// Ported from cc-connect platform/feishu/feishu_test.go (text-path subset)
// plus dispatch-level checks against a fake API client.

describe('extractPostPlainText', () => {
  it('flat format', () => {
    const content = '{"title":"公告","content":[[{"tag":"text","text":"第一段"}],[{"tag":"text","text":"第二段"}]]}'
    expect(extractPostPlainText(content)).toBe('公告\n第一段\n第二段')
  })

  it('locale wrapped', () => {
    const content = '{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"内容"}]]}}'
    expect(extractPostPlainText(content)).toBe('标题\n内容')
  })

  it('no title', () => {
    expect(extractPostPlainText('{"content":[[{"tag":"text","text":"仅内容"}]]}')).toBe('仅内容')
  })

  it('empty', () => {
    expect(extractPostPlainText('{}')).toBe('')
  })

  it('link text', () => {
    const content = '{"content":[[{"tag":"text","text":"hello "},{"tag":"a","text":"link","href":"http://x.com"}]]}'
    expect(extractPostPlainText(content)).toBe('hello link')
  })

  it.each([
    ['named', '{"content":[[{"tag":"text","text":"hi "},{"tag":"at","user_id":"ou_x","user_name":"Alice"}]]}', 'hi @Alice'],
    ['all', '{"content":[[{"tag":"at","user_id":"all"}]]}', '@all'],
    ['fallback', '{"content":[[{"tag":"at","user_id":"ou_x"}]]}', '@user'],
  ])('at mention %s', (_name, content, want) => {
    expect(extractPostPlainText(content)).toBe(want)
  })

  it('markdown passthrough', () => {
    const content = '{"content":[[{"tag":"markdown","text":"**bold** and *italic*"}]]}'
    expect(extractPostPlainText(content)).toBe('**bold** and *italic*')
  })

  it('code block inline', () => {
    const content = '{"content":[[{"tag":"text","text":"see:"},{"tag":"code_block","language":"go","text":"fmt.Println()"}]]}'
    expect(extractPostPlainText(content)).toBe('see:```go\nfmt.Println()\n```')
  })

  it('invalid JSON yields empty', () => {
    expect(extractPostPlainText('not json')).toBe('')
  })
})

describe('stripMentions', () => {
  it.each([
    { name: 'no mentions', text: 'hello', mentions: undefined, botOpenID: '', expected: 'hello' },
    {
      name: 'bot mention removed',
      text: '@_user_1 /help',
      mentions: [{ key: '@_user_1', id: { open_id: 'bot123' }, name: 'Bot' }],
      botOpenID: 'bot123',
      expected: '/help',
    },
    {
      name: 'non-bot mention replaced with name',
      text: 'assign to @_user_2',
      mentions: [{ key: '@_user_2', id: { open_id: 'user456' }, name: '张三' }],
      botOpenID: 'bot123',
      expected: 'assign to @张三',
    },
    {
      name: 'bot removed and other preserved',
      text: '@_user_1 assign to @_user_2',
      mentions: [
        { key: '@_user_1', id: { open_id: 'bot123' }, name: 'Bot' },
        { key: '@_user_2', id: { open_id: 'user456' }, name: '张三' },
      ],
      botOpenID: 'bot123',
      expected: 'assign to @张三',
    },
    {
      name: 'mention with nil key skipped',
      text: '@_user_1 hello',
      mentions: [{ id: { open_id: 'bot123' } }],
      botOpenID: 'bot123',
      expected: '@_user_1 hello',
    },
    {
      name: 'mention with no name fallback removed',
      text: 'text @_user_3',
      mentions: [{ key: '@_user_3', id: { open_id: 'user789' } }],
      botOpenID: 'bot123',
      expected: 'text',
    },
    {
      name: 'empty botOpenID all non-named removed',
      text: '@_user_1 hello',
      mentions: [{ key: '@_user_1', id: { open_id: 'someone' } }],
      botOpenID: '',
      expected: 'hello',
    },
  ])('$name', ({ text, mentions, botOpenID, expected }) => {
    expect(stripMentions(text, mentions, botOpenID)).toBe(expected)
  })
})

describe('hasHumanMention / isBotMentioned', () => {
  it.each([
    { name: 'nil mentions', mentions: undefined, expected: false },
    { name: 'empty mentions', mentions: [], expected: false },
    { name: 'bot mention only', mentions: [{ mentionedType: 'bot' }], expected: false },
    { name: 'single human mention', mentions: [{ mentionedType: 'user' }], expected: true },
    { name: 'bot and human mixed', mentions: [{ mentionedType: 'bot' }, { mentionedType: 'user' }], expected: true },
    { name: 'nil MentionedType skipped', mentions: [{}], expected: false },
  ])('hasHumanMention: $name', ({ mentions, expected }) => {
    expect(hasHumanMention(mentions)).toBe(expected)
  })

  it('isBotMentioned matches the bot open_id', () => {
    expect(isBotMentioned([{ id: { open_id: 'bot1' } }], 'bot1')).toBe(true)
    expect(isBotMentioned([{ id: { open_id: 'user1' } }], 'bot1')).toBe(false)
    expect(isBotMentioned(undefined, 'bot1')).toBe(false)
  })
})

describe('AllowList', () => {
  it('permits all on empty or *', () => {
    expect(AllowList('', 'anyone')).toBe(true)
    expect(AllowList('*', 'anyone')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(AllowList('ou_A, ou_B', 'ou_b')).toBe(true)
    expect(AllowList('ou_A', 'ou_C')).toBe(false)
  })
})

/** Recording fake API client for outbound assertions. */
function recordingClient(): FeishuApiClient & { replies: unknown[]; creates: unknown[] } {
  return {
    replies: [],
    creates: [],
    async reply(params) {
      ;(this as { replies: unknown[] }).replies.push(params)
    },
    async create(params) {
      ;(this as { creates: unknown[] }).creates.push(params)
    },
  }
}

let eventCounter = 0

function receiveEvent(overrides: Partial<FeishuReceiveEvent['message']> & { chatID?: string; userID?: string }): FeishuReceiveEvent {
  const { chatID = 'oc_1', userID = 'ou_9', ...msg } = overrides
  eventCounter += 1
  return {
    message: {
      message_id: `om_${eventCounter}`,
      chat_id: chatID,
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'p2p',
      create_time: String(Date.now()),
      ...msg,
    },
    sender: { sender_id: { open_id: userID } },
  }
}

function collectHandler(): { messages: Message[]; handler: (p: unknown, msg: Message) => void } {
  const messages: Message[] = []
  return { messages, handler: (_p, msg) => { messages.push(msg) } }
}

async function dispatched(p: FeishuPlatform, event: FeishuReceiveEvent): Promise<Message[]> {
  const { messages, handler } = collectHandler()
  await p.start(handler)
  p.onMessage(event)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  return messages
}

function newPlatform(options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    ...options,
  })
}

describe('FeishuPlatform dispatch', () => {
  it('delivers a p2p text message to the handler', async () => {
    const p = newPlatform()
    const messages = await dispatched(p, receiveEvent({}))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('hello')
    expect(messages[0]!.sessionKey).toBe('feishu:oc_1:ou_9')
    expect(messages[0]!.platform).toBe('feishu')
  })

  it('drops duplicate message ids', async () => {
    const p = newPlatform()
    const { messages, handler } = collectHandler()
    await p.start(handler)
    p.onMessage(receiveEvent({ message_id: 'om_same' }))
    p.onMessage(receiveEvent({ message_id: 'om_same' }))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(1)
  })

  it('drops group messages without a bot mention', async () => {
    const p = newPlatform({ botOpenID: 'ou_bot', allowChat: '*' })
    const messages = await dispatched(p, receiveEvent({ chat_type: 'group' }))
    expect(messages).toHaveLength(0)
  })

  it('delivers group messages that mention the bot, mention stripped', async () => {
    const p = newPlatform({ botOpenID: 'ou_bot', allowChat: '*' })
    const messages = await dispatched(p, receiveEvent({
      chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 /help' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' }],
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/help')
  })

  it('enforces allow_chat (#27)', async () => {
    const p = newPlatform({ botOpenID: 'ou_bot', allowChat: 'oc_allowed' })
    const dropped = await dispatched(p, receiveEvent({
      chat_type: 'group',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    }))
    expect(dropped).toHaveLength(0)

    const allowed = await dispatched(p, receiveEvent({
      chat_id: 'oc_allowed',
      chat_type: 'group',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    }))
    expect(allowed).toHaveLength(1)
  })

  it('enforces allow_from', async () => {
    const p = newPlatform({ allowFrom: 'ou_friend' })
    const dropped = await dispatched(p, receiveEvent({ userID: 'ou_stranger' }))
    expect(dropped).toHaveLength(0)
    const allowed = await dispatched(p, receiveEvent({ userID: 'ou_friend' }))
    expect(allowed).toHaveLength(1)
  })

  it('group_only skips p2p messages', async () => {
    const p = newPlatform({ groupOnly: true })
    const messages = await dispatched(p, receiveEvent({}))
    expect(messages).toHaveLength(0)
  })

  it('dispatches post rich text as plain text', async () => {
    const p = newPlatform()
    const messages = await dispatched(p, receiveEvent({
      message_type: 'post',
      content: '{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"内容"}]]}}',
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('标题\n内容')
  })

  it('thread isolation keys group sessions by thread then root', () => {
    const p = newPlatform({ threadIsolation: true })
    expect(p.makeSessionKey({ chat_type: 'group', thread_id: 'om_t1' }, 'oc_1', 'ou_9'))
      .toBe('feishu:oc_1:thread:om_t1')
    expect(p.makeSessionKey({ chat_type: 'group', root_id: 'om_r1' }, 'oc_1', 'ou_9'))
      .toBe('feishu:oc_1:root:om_r1')
    expect(p.makeSessionKey({ chat_type: 'group', message_id: 'om_1' }, 'oc_1', 'ou_9'))
      .toBe('feishu:oc_1:root:om_1')
    expect(p.makeSessionKey({ chat_type: 'p2p' }, 'oc_1', 'ou_9'))
      .toBe('feishu:oc_1:ou_9')
  })

  it('share_session_in_channel keys on the chat alone', () => {
    const p = newPlatform({ shareSessionInChannel: true })
    expect(p.makeSessionKey({ chat_type: 'p2p' }, 'oc_1', 'ou_9'))
      .toBe('feishu:oc_1')
  })

  it('spawned chats key on the chat alone and bypass the @-gate', async () => {
    const p = newPlatform({ isSpawnedChat: chatID => chatID === 'oc_spawn' })
    expect(p.makeSessionKey({ chat_type: 'group' }, 'oc_spawn', 'ou_9'))
      .toBe('feishu:oc_spawn')
    const messages = await dispatched(p, receiveEvent({ chatID: 'oc_spawn', chat_type: 'group' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.isSpawnedGroup).toBe(true)
  })

  it('spawned-group messages mentioning a human stay silent', async () => {
    const p = newPlatform({ isSpawnedChat: chatID => chatID === 'oc_spawn' })
    const messages = await dispatched(p, receiveEvent({
      chatID: 'oc_spawn',
      chat_type: 'group',
      mentions: [{ key: '@_user_2', id: { open_id: 'ou_human' }, name: '张三', mentionedType: 'user' }],
    }))
    expect(messages).toHaveLength(0)
  })
})

describe('FeishuPlatform outbound', () => {
  it('reply quotes the trigger message via the reply API', async () => {
    const api = recordingClient()
    const p = newPlatform({ apiClient: api })
    await p.reply({ messageID: 'om_9', chatID: 'oc_1', sessionKey: 'feishu:oc_1:ou_9' }, 'hi there')
    expect(api.replies).toEqual([{ messageId: 'om_9', msgType: 'text', content: JSON.stringify({ text: 'hi there' }) }])
    expect(api.creates).toHaveLength(0)
  })

  it('send without a trigger message creates a new chat message', async () => {
    const api = recordingClient()
    const p = newPlatform({ apiClient: api })
    await p.send({ messageID: '', chatID: 'oc_1', sessionKey: 'feishu:oc_1' }, 'broadcast')
    expect(api.creates).toEqual([{ chatId: 'oc_1', msgType: 'text', content: JSON.stringify({ text: 'broadcast' }) }])
    expect(api.replies).toHaveLength(0)
  })

  it('reconstructReplyCtx keys on the chat for proactive sends', async () => {
    const api = recordingClient()
    const p = newPlatform({ apiClient: api })
    const rc = await p.reconstructReplyCtx('feishu:oc_42:ou_x')
    expect(rc.chatID).toBe('oc_42')
    await p.send(rc, 'proactive')
    expect(api.creates[0]).toMatchObject({ chatId: 'oc_42' })
  })

  it('no_reply_to_trigger sends new messages even with a message id', async () => {
    const api = recordingClient()
    const p = newPlatform({ apiClient: api, noReplyToTrigger: true })
    await p.reply({ messageID: 'om_9', chatID: 'oc_1', sessionKey: 'feishu:oc_1' }, 'plain')
    expect(api.replies).toHaveLength(0)
    expect(api.creates).toHaveLength(1)
  })
})

describe('FeishuPlatform WS teardown', () => {
  it('stop() closes the WS handle returned by wsStart exactly once', async () => {
    let closed = 0
    const p = newPlatform({ wsStart: async () => () => { closed++ } })
    await p.start(() => {})
    expect(closed).toBe(0)
    await p.stop()
    expect(closed).toBe(1)
    await p.stop()
    expect(closed).toBe(1)
  })

  it('stop() tolerates a wsStart that returns no close handle', async () => {
    const p = newPlatform()
    await p.start(() => {})
    await p.stop()
  })

  it('stop() before start() is a no-op', async () => {
    const p = newPlatform({ wsStart: async () => () => { throw new Error('close must not run') } })
    await p.stop()
  })
})
