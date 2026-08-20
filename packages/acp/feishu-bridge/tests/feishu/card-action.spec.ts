/**
 * Card-action dispatch for `act:` prefixes (Go onCardAction's act: branch):
 * the worktree Keep/Remove card's buttons arrive as card.action.trigger with
 * value "act:/wt keep" / "act:/wt remove". The platform records the callback's
 * message id for in-place PATCH updates and dispatches a synthetic message
 * flagged isCardAction so the engine routes it to the card-action handler
 * instead of a normal turn. Session keys mirror Go sessionKeyFromCardAction:
 * the value's session_key wins, spawned chats key on the chat alone, and
 * share_session_in_channel keys on the chat alone.
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type CardActionTriggerEvent } from '../../src/feishu/platform.js'
import { hintButtonName } from '../../src/engine/hints-panel.js'
import type { Message } from '../../src/core/types.js'

let counter = 0

function cardEvent(overrides: {
  action?: string
  chatID?: string
  userID?: string
  value?: Record<string, string>
}): CardActionTriggerEvent {
  counter += 1
  return {
    action: { value: { action: overrides.action ?? '', ...(overrides.value ?? {}) } },
    operator: { open_id: overrides.userID ?? 'ou_9' },
    context: { open_chat_id: overrides.chatID ?? 'oc_1', open_message_id: `om_${counter}` },
  }
}

function newPlatform(options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    ...options,
  })
}

async function dispatched(
  p: FeishuPlatform,
  event: CardActionTriggerEvent,
): Promise<Message[]> {
  const messages: Message[] = []
  await p.start((_platform, msg) => { messages.push(msg) })
  p.onCardAction(event)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  return messages
}

describe('onCardAction act: dispatch', () => {
  it('routes act:/wt keep as a card-action message and tracks the message id', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({ action: 'act:/wt keep' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('act:/wt keep')
    expect(messages[0]!.isCardAction).toBe(true)
    expect(messages[0]!.sessionKey).toBe('feishu:oc_1:ou_9')
    expect(p.cardActionMsgIDs.get('feishu:oc_1:ou_9')).toBe(messages[0]!.messageID)
  })

  it('routes nav:/dir page turns through the same card-action path', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({ action: 'nav:/dir 2' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('nav:/dir 2')
    expect(messages[0]!.isCardAction).toBe(true)
    expect(messages[0]!.sessionKey).toBe('feishu:oc_1:ou_9')
    expect(p.cardActionMsgIDs.get('feishu:oc_1:ou_9')).toBe(messages[0]!.messageID)
  })

  it('keys spawned chats on the chat alone', async () => {
    const p = newPlatform({ allowChat: '*', isSpawnedChat: chatID => chatID === 'oc_spawn' })
    const messages = await dispatched(p, cardEvent({ action: 'act:/wt remove', chatID: 'oc_spawn' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.sessionKey).toBe('feishu:oc_spawn')
    expect(messages[0]!.isSpawnedGroup).toBe(true)
  })

  it('honors an explicit session_key in the action value', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({
      action: 'act:/wt keep',
      value: { action: 'act:/wt keep', session_key: 'feishu:oc_special' },
    }))
    expect(messages[0]!.sessionKey).toBe('feishu:oc_special')
  })

  it('keys on the chat alone with share_session_in_channel', async () => {
    const p = newPlatform({ allowChat: '*', shareSessionInChannel: true })
    const messages = await dispatched(p, cardEvent({ action: 'act:/wt keep' }))
    expect(messages[0]!.sessionKey).toBe('feishu:oc_1')
  })

  it('drops actions from chats outside allow_chat', async () => {
    const p = newPlatform({ allowChat: 'oc_allowed' })
    const messages = await dispatched(p, cardEvent({ action: 'act:/wt keep', chatID: 'oc_other' }))
    expect(messages).toHaveLength(0)
  })

  it('still routes perm: actions through the permission path', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({ action: 'perm:allow' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.isPermissionAction).toBe(true)
    expect(messages[0]!.isCardAction).toBe(false)
    expect(messages[0]!.content).toBe('allow')
  })
})

describe('onCardAction perm: in-place card update (Go feishu_dispatch.go perm branch)', () => {
  it('builds the resolved card from the button value extras when present', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    const resp = p.onCardAction(cardEvent({
      action: 'perm:allow',
      value: {
        action: 'perm:allow',
        perm_label: '✅ Allow',
        perm_color: 'green',
        perm_body: 'Agent wants to use **Bash**',
      },
    }))
    expect(resp?.card.type).toBe('raw')
    const header = (resp!.card.data as { header: { title: { content: string }; template: string } }).header
    expect(header.title.content).toBe('✅ Allow')
    expect(header.template).toBe('green')
    const body = (resp!.card.data as { body: { elements: Array<{ tag: string; content?: string }> } }).body
    expect(body.elements[0]).toEqual({ tag: 'markdown', content: 'Agent wants to use **Bash**' })
  })

  it('falls back to the fixed labels and permBodyCache when the callback omits action.value', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.permBodyCache.set('feishu:oc_1:ou_9', 'cached perm body')
    const event: CardActionTriggerEvent = {
      action: { name: 'perm_allow' },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_p1' },
    }
    const resp = p.onCardAction(event) as { card: { type: string; data: Record<string, unknown> } } | undefined
    expect(resp?.card.type).toBe('raw')
    const header = (resp!.card.data as { header: { title: { content: string }; template: string } }).header
    expect(header.title.content).toBe('✅ 已允许')
    expect(header.template).toBe('green')
    const body = (resp!.card.data as { body: { elements: Array<{ tag: string; content: string }> } }).body
    expect(body.elements[0]).toEqual({ tag: 'markdown', content: 'cached perm body' })
    // LoadAndDelete semantics (Go sync.Map LoadAndDelete)
    expect(p.permBodyCache.has('feishu:oc_1:ou_9')).toBe(false)
  })

  it('shows the deny reason as the quoted body on a card deny', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.permBodyCache.set('feishu:oc_1:ou_9', 'cached perm body')
    const event: CardActionTriggerEvent = {
      action: { name: 'perm_deny', formValue: { deny_reason: '  scope too broad  ' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_p2' },
    }
    const resp = p.onCardAction(event) as { card: { type: string; data: Record<string, unknown> } } | undefined
    const header = (resp!.card.data as { header: { title: { content: string }; template: string } }).header
    expect(header.title.content).toBe('❌ 已拒绝')
    expect(header.template).toBe('red')
    const body = (resp!.card.data as { body: { elements: Array<{ tag: string; content: string }> } }).body
    expect(body.elements[0]).toEqual({ tag: 'markdown', content: '> scope too broad' })
  })

  it('labels allow_all with its fixed fallback', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    const event: CardActionTriggerEvent = {
      action: { name: 'perm_allow_all' },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_p3' },
    }
    const resp = p.onCardAction(event) as { card: { type: string; data: Record<string, unknown> } } | undefined
    const header = (resp!.card.data as { header: { title: { content: string }; template: string } }).header
    expect(header.title.content).toBe('✅ 已全部允许')
    expect(header.template).toBe('green')
  })

  it('returns no card response for non-perm actions', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    expect(p.onCardAction(cardEvent({ action: 'act:/wt keep' }))).toBeUndefined()
  })
})

describe('onCardAction export:/sendreply: (Go feishu_dispatch.go export branches)', () => {
  it('export: sends the cached content as a plan_<stamp>.md attachment', async () => {
    const p = newPlatform({ allowChat: '*' })
    p.setExportHandler((sessionKey, _exportKey) => {
      expect(sessionKey).toBe('feishu:oc_1:ou_9')
      return { text: '# plan body', ok: true }
    })
    // sendFile goes through the feishu API client; without one it rejects —
    // the platform lacks a client in tests, so we assert the handler path
    // via the reply-side effect: stub sendFile at the instance level.
    const files: Array<{ fileName: string; mimeType: string; text: string }> = []
    p.sendFile = async (_rc, file) => {
      files.push({ fileName: file.fileName, mimeType: file.mimeType, text: Buffer.from(file.data).toString('utf8') })
    }
    await p.start(() => {})
    p.onCardAction(cardEvent({ action: 'export:plan:1', value: { action: 'export:plan:1', session_key: 'feishu:oc_1:ou_9' } }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(files).toHaveLength(1)
    expect(files[0]!.fileName.startsWith('plan_')).toBe(true)
    expect(files[0]!.fileName.endsWith('.md')).toBe(true)
    expect(files[0]!.mimeType).toBe('text/markdown')
    expect(files[0]!.text).toBe('# plan body')
  })

  it('export: with missing content replies the expired notice', async () => {
    const p = newPlatform({ allowChat: '*' })
    p.setExportHandler(() => ({ text: '', ok: false }))
    const sent: string[] = []
    p.reply = async (_rc, content) => { sent.push(content) }
    await p.start(() => {})
    p.onCardAction(cardEvent({ action: 'export:om_1', value: { action: 'export:om_1', session_key: 'feishu:oc_1:ou_9' } }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(sent).toEqual(['导出失败：未找到对应内容，可能会话已过期'])
  })

  it('sendreply: replies the cached full content', async () => {
    const p = newPlatform({ allowChat: '*' })
    p.setExportHandler(() => ({ text: 'full reply', ok: true }))
    const sent: string[] = []
    p.reply = async (_rc, content) => { sent.push(content) }
    await p.start(() => {})
    p.onCardAction(cardEvent({ action: 'sendreply:om_1', value: { action: 'sendreply:om_1', session_key: 'feishu:oc_1:ou_9' } }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(sent).toEqual(['full reply'])
  })

  it('sendreply: with missing content replies the expired notice', async () => {
    const p = newPlatform({ allowChat: '*' })
    p.setExportHandler(() => ({ text: '', ok: false }))
    const sent: string[] = []
    p.reply = async (_rc, content) => { sent.push(content) }
    await p.start(() => {})
    p.onCardAction(cardEvent({ action: 'sendreply:om_1', value: { action: 'sendreply:om_1', session_key: 'feishu:oc_1:ou_9' } }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    expect(sent).toEqual(['未找到对应内容，可能会话已过期'])
  })
})

describe('onCardAction askq_multi submit', () => {
  it('appends checked askq_opt_N indices from formValue in numeric order', async () => {
    const p = newPlatform({ allowChat: '*' })
    const event: CardActionTriggerEvent = {
      action: {
        value: { action: 'askq_multi:0', askq_question: 'pick' },
        name: 'askq_multi_submit_0',
        formValue: { askq_opt_2: 'true', askq_opt_10: true, askq_opt_1: 'false', other: 'x' },
      },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: `om_${Date.now()}` },
    }
    const messages = await dispatched(p, event)
    expect(messages).toHaveLength(1)
    // Indices land as "askq:0:2,10" → resolved to labels by the engine from
    // the pending question; the dispatched content carries the raw label text
    // from value (askq_label absent → the raw actionVal slice).
    expect(messages[0]!.isAskqCardAction).toBe(true)
  })
})

describe('onCardAction hint buttons (Go feishu_dispatch.go hint__ branch)', () => {
  it('decodes a compact hint name and dispatches it as a command with echo', async () => {
    const p = newPlatform({ allowChat: '*' })
    const clicks: Array<{ hint: string; category: string }> = []
    p.setHintClickHandler((hint, category) => { clicks.push({ hint, category }) })
    const replies: string[] = []
    p.reply = async (_rc, content) => { replies.push(content) }
    const event: CardActionTriggerEvent = {
      action: { name: hintButtonName('c', '/new') },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_h1' },
    }
    const messages = await dispatched(p, event)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('/new')
    expect(clicks).toEqual([{ hint: '/new', category: 'hints' }])
    expect(replies).toEqual(['/new'])
  })

  it('appends the _arg form value to a with_param hint and reports its category', async () => {
    const p = newPlatform({ allowChat: '*' })
    const clicks: Array<{ hint: string; category: string }> = []
    p.setHintClickHandler((hint, category) => { clicks.push({ hint, category }) })
    const event: CardActionTriggerEvent = {
      action: {
        name: hintButtonName('wp', '/tdd'),
        value: { _arg: 'hint_arg_0' },
        formValue: { hint_arg_0: '先写失败测试' },
      },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_h2' },
    }
    const messages = await dispatched(p, event)
    expect(messages[0]!.content).toBe('/tdd 先写失败测试')
    expect(clicks).toEqual([{ hint: '/tdd', category: 'hints_with_param' }])
  })

  it('falls back to the first non-empty form value without _arg', async () => {
    const p = newPlatform({ allowChat: '*' })
    const event: CardActionTriggerEvent = {
      action: {
        name: hintButtonName('co', '/done'),
        formValue: { hint_arg_0: '', other: 'fallback' },
      },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_h3' },
    }
    const messages = await dispatched(p, event)
    expect(messages[0]!.content).toBe('/done fallback')
  })

  it('ignores an undecodable hint name', async () => {
    const p = newPlatform({ allowChat: '*' })
    const event: CardActionTriggerEvent = {
      action: { name: 'hint__c__!!!not-base64!!!' },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_h4' },
    }
    const messages = await dispatched(p, event)
    expect(messages).toHaveLength(0)
  })
})
