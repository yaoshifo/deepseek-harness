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

import { describe, expect, it, vi } from 'vitest'
import { FeishuPlatform, type CardActionTriggerEvent, type FeishuApiClient } from '../../src/feishu/platform.js'
import { newCard } from '../../src/card.js'
import { hintButtonName } from '../../src/engine/hints-panel.js'
import type { Message } from '../../src/core/types.js'

let counter = 0

function cardEvent(overrides: {
  action?: string
  chatID?: string
  userID?: string
  messageID?: string
  value?: Record<string, string>
}): CardActionTriggerEvent {
  counter += 1
  return {
    action: { value: { action: overrides.action ?? '', ...(overrides.value ?? {}) } },
    operator: { open_id: overrides.userID ?? 'ou_9' },
    context: { open_chat_id: overrides.chatID ?? 'oc_1', open_message_id: overrides.messageID ?? `om_${counter}` },
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

  it('still routes perm: actions through the permission path (B2: structured payload verbatim)', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({ action: 'perm:allow' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.isPermissionAction).toBe(true)
    expect(messages[0]!.isCardAction).toBe(false)
    expect(messages[0]!.content).toBe('perm:allow')
  })
})

describe('onCardAction perm: in-place card update (Go feishu_dispatch.go perm branch)', () => {
  it('builds the resolved card from the button value extras when present', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.permBodyCache.set('feishu:oc_1:ou_9', 'stale body from an earlier card')
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
    // The cached body is consumed even when the extras carried their own copy
    // — a stale entry must not leak into the next permission card.
    expect(p.permBodyCache.has('feishu:oc_1:ou_9')).toBe(false)
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
      action: { name: 'perm_deny', form_value: { perm_note: '  scope too broad  ' } },
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

  it('encodes the note as an allow supplement on a card allow', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, {
      action: { name: 'perm_allow', form_value: { perm_note: ' also add tests ' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_pa1' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('perm:allow\x00also add tests')
  })

  it('encodes the note as an allow_all supplement on a card allow_all', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, {
      action: { name: 'perm_allow_all', form_value: { perm_note: 'also add tests' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_paa1' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('perm:allow_all\x00also add tests')
  })

  it('quotes the supplement under the resolved body on a card allow', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.permBodyCache.set('feishu:oc_1:ou_9', 'cached perm body')
    const event: CardActionTriggerEvent = {
      action: { name: 'perm_allow', form_value: { perm_note: 'also add tests' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_pa2' },
    }
    const resp = p.onCardAction(event) as { card: { type: string; data: Record<string, unknown> } } | undefined
    const header = (resp!.card.data as { header: { title: { content: string }; template: string } }).header
    expect(header.title.content).toBe('✅ 已允许')
    const body = (resp!.card.data as { body: { elements: Array<{ tag: string; content?: string }> } }).body
    expect(body.elements[0]).toEqual({ tag: 'markdown', content: 'cached perm body\n\n> also add tests' })
  })

  it('sends a bare allow when the note field is empty', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, {
      action: { name: 'perm_allow', form_value: { perm_note: '   ' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_pa3' },
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('perm:allow')
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
  it('appends checked askq_opt_N indices from form_value in numeric order', async () => {
    const p = newPlatform({ allowChat: '*' })
    const event: CardActionTriggerEvent = {
      action: {
        value: { action: 'askq_multi:0', askq_question: 'pick' },
        name: 'askq_multi_submit_0',
        form_value: { askq_opt_2: 'true', askq_opt_10: true, askq_opt_1: 'false', other: 'x' },
      },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: `om_${Date.now()}` },
    }
    const messages = await dispatched(p, event)
    expect(messages).toHaveLength(1)
    // Indices land as "askq:0:2,10" → resolved to labels by the engine from
    // the pending question; the dispatched content carries the raw label text
    // from value (askq_label absent → the raw actionVal slice).
    expect(messages[0]!.content).toBe('askq:0:2,10')
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
        form_value: { hint_arg_0: '先写失败测试' },
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
        form_value: { hint_arg_0: '', other: 'fallback' },
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

describe('onCardAction ask card replacement (B2 multi-question card)', () => {
  /** Client whose create/reply mint message ids so sendCard succeeds offline. */
  function apiClient(): FeishuApiClient {
    let seq = 0
    return {
      async create() {
        seq += 1
        return { messageId: `om_askq_${seq}` }
      },
      async reply() {
        seq += 1
        return { messageId: `om_askq_${seq}` }
      },
    }
  }

  function cardBody(resp: { card: { data: Record<string, unknown> } }): { title: string; template: string; markdown: string } {
    const header = (resp.card.data as { header?: { title: { content: string }; template: string } }).header
    const elements = (resp.card.data as { body: { elements: Array<{ tag: string; content?: string }> } }).body.elements
    return { title: header?.title.content ?? '', template: header?.template ?? '', markdown: elements.map(e => e.content ?? '').join('\n') }
  }

  it('caches the full multi-select question set at send time', async () => {
    const p = newPlatform({ allowChat: '*', apiClient: apiClient() })
    await p.start(() => {})
    const card = newCard().checkOptions('Pick tools', [
      { label: 'Bash', description: 'run commands' },
      { label: 'Read', description: 'read files' },
    ], 'askq_multi:0', { askq_question: 'Pick tools' }).build()
    await p.sendCard({ messageID: 'om_t', chatID: 'oc_1', sessionKey: 'feishu:oc_1:ou_9' }, card)
    const meta = p.askqMetaCache.get('feishu:oc_1:ou_9')
    expect(meta?.questions).toEqual([{
      question: 'Pick tools',
      header: '',
      options: [
        { label: 'Bash', description: 'run commands' },
        { label: 'Read', description: 'read files' },
      ],
      multiSelect: true,
    }])
  })

  it('caches the single-select question set at send time', async () => {
    const p = newPlatform({ allowChat: '*', apiClient: apiClient() })
    await p.start(() => {})
    const cb = newCard()
    for (const [i, label] of ['Option A', 'Option B'].entries()) {
      cb.listItemBtnExtra(label, '', String(i + 1), 'default', `askq:0:${i + 1}`,
        { askq_label: label, askq_question: 'Pick one' })
    }
    await p.sendCard({ messageID: 'om_t', chatID: 'oc_1', sessionKey: 'feishu:oc_1:ou_9' }, cb.build())
    const meta = p.askqMetaCache.get('feishu:oc_1:ou_9')
    expect(meta?.questions).toEqual([{
      question: 'Pick one',
      header: '',
      options: [
        { label: 'Option A', description: '' },
        { label: 'Option B', description: '' },
      ],
      multiSelect: false,
    }])
  })

  it('multi submit replaces the card with the selection marked and the question frozen', async () => {
    const p = newPlatform({ allowChat: '*', apiClient: apiClient() })
    await p.start(() => {})
    const messages: Message[] = []
    void p.start((_platform, msg) => { messages.push(msg) })
    const card = newCard().checkOptions('Pick tools', [
      { label: 'Bash', description: 'run commands' },
      { label: 'Read', description: 'read files' },
    ], 'askq_multi:0', { askq_question: 'Pick tools' }).build()
    await p.sendCard({ messageID: 'om_t', chatID: 'oc_1', sessionKey: 'feishu:oc_1:ou_9' }, card)

    const event: CardActionTriggerEvent = {
      action: { name: 'askq_multi_submit_0', form_value: { askq_opt_1: 'true', askq_opt_2: true } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_askq_1' },
    }
    const resp = p.onCardAction(event) as { card: { data: Record<string, unknown> } } | undefined
    expect(resp).toBeDefined()
    const replaced = cardBody(resp!)
    expect(replaced.markdown).toContain('Pick tools')
    expect(replaced.markdown).toContain('✅ **Bash**')
    expect(replaced.markdown).toContain('✅ **Read**')
    // The dispatched answer still reaches the engine exactly once.
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('askq:0:1,2')
    expect(messages[0]!.isAskqCardAction).toBe(true)
    // Every question answered: the meta cache is consumed.
    expect(p.askqMetaCache.has('feishu:oc_1:ou_9')).toBe(false)
  })

  it('multi submit marks only the checked subset', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.askqMetaCache.set('feishu:oc_1:ou_9', {
      title: '',
      questions: [{
        question: 'Pick tools',
        header: '',
        options: [
          { label: 'Bash', description: '' },
          { label: 'Read', description: '' },
        ],
        multiSelect: true,
      }],
    })
    const event: CardActionTriggerEvent = {
      action: { name: 'askq_multi_submit_0', form_value: { askq_opt_2: true } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_m2' },
    }
    const resp = p.onCardAction(event) as { card: { data: Record<string, unknown> } } | undefined
    const replaced = cardBody(resp!)
    expect(replaced.markdown).toContain('◻️ **Bash**')
    expect(replaced.markdown).toContain('✅ **Read**')
  })

  it('a single-select click freezes its question and keeps later questions interactive', async () => {
    const p = newPlatform({ allowChat: '*' })
    await p.start(() => {})
    p.askqMetaCache.set('feishu:oc_1:ou_9', {
      title: '‼️ Ask',
      questions: [
        {
          question: 'Pick one',
          header: '',
          options: [
            { label: 'Option A', description: 'first' },
            { label: 'Option B', description: 'second' },
          ],
          multiSelect: false,
        },
        {
          question: 'Pick next',
          header: '',
          options: [{ label: 'Next A', description: '' }],
          multiSelect: false,
        },
      ],
    })
    const resp = p.onCardAction(cardEvent({
      action: 'askq:0:2',
      value: { action: 'askq:0:2', askq_label: 'Option B', askq_question: 'Pick one' },
    })) as { card: { data: Record<string, unknown> } } | undefined
    expect(resp).toBeDefined()
    const replaced = cardBody(resp!)
    expect(replaced.title).toBe('‼️ Ask')
    expect(replaced.markdown).toContain('◻️ **Option A**')
    expect(replaced.markdown).toContain('✅ **Option B**')
    // The second question stays clickable: its row button survives.
    const raw = JSON.stringify(resp!.card.data)
    expect(raw).toContain('askq:1:1')
    // One question of two answered: the cache survives for the next callback.
    expect(p.askqMetaCache.has('feishu:oc_1:ou_9')).toBe(true)
  })

  it('without the meta cache the answer still dispatches (no card replacement)', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    const resp = p.onCardAction(cardEvent({
      action: 'askq:0:2',
      value: { action: 'askq:0:2', askq_label: 'Option B', askq_question: 'Pick one' },
    })) as { card: { data: Record<string, unknown> } } | undefined
    expect(resp).toBeUndefined()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('askq:0:2')
  })

  it('dedups repeated callbacks on the same card message', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    p.askqMetaCache.set('feishu:oc_1:ou_9', {
      title: '',
      questions: [{
        question: 'Pick one',
        header: '',
        options: [{ label: 'Option A', description: '' }, { label: 'Option B', description: '' }],
        multiSelect: false,
      }],
    })
    const event: CardActionTriggerEvent = {
      action: { value: { action: 'askq:0:2', askq_label: 'Option B' } },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_dup' },
    }
    expect(p.onCardAction(event)).toBeDefined()
    expect(p.onCardAction(event)).toBeUndefined()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(1)
  })
})

describe('onCardAction cmd: dedup (▶ 继续执行 one-shot guard)', () => {
  /** A ▶ 继续执行 click on one stopped card: same messageID across repeats. */
  function continueEvent(messageID: string): CardActionTriggerEvent {
    return cardEvent({ action: 'cmd:继续', messageID, value: { session_key: 'feishu:oc_1:ou_9' } })
  }

  it('forwards the first 「继续」 and drops a repeat on the same card', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    const event = continueEvent('om_resume_1')
    p.onCardAction(event)
    expect(p.onCardAction(event)).toBeUndefined()
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('继续')
  })

  it('forwards 「继续」 from a different stopped card', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    p.onCardAction(continueEvent('om_resume_1'))
    p.onCardAction(continueEvent('om_resume_2'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(2)
  })

  it('keeps repeatable cmd: buttons outside the dedup', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    const event = cardEvent({ action: 'cmd:/board', messageID: 'om_board' })
    p.onCardAction(event)
    p.onCardAction(event)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(2)
  })

  it('lets a hint button named 「继续」 repeat', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    const event: CardActionTriggerEvent = {
      action: { name: hintButtonName('c', '继续') },
      operator: { open_id: 'ou_9' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_hint_resume' },
    }
    p.onCardAction(event)
    p.onCardAction(event)
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(messages).toHaveLength(2)
  })

  it('lets the same card through again after the 60s dedup window', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages: Message[] = []
    await p.start((_platform, msg) => { messages.push(msg) })
    vi.useFakeTimers()
    try {
      const event = continueEvent('om_resume_1')
      p.onCardAction(event)
      await vi.advanceTimersByTimeAsync(10)
      expect(messages).toHaveLength(1)
      vi.setSystemTime(Date.now() + 61_000)
      p.onCardAction(event)
      await vi.advanceTimersByTimeAsync(10)
      expect(messages).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
