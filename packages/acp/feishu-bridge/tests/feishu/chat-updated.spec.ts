/**
 * im.chat.updated_v1 handling (Go onChatUpdated): a group rename refreshes
 * the chat-name cache and notifies the engine (session label sync), and a
 * name-or-avatar change notifies the chat-changed handler that bumps the
 * active preview card back to the chat tail.
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuChatUpdatedEvent } from '../../src/feishu/platform.js'

function newPlatform(options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    ...options,
  })
}

/** Capture the handler registrations for assertion. */
interface Handlers {
  renamed: Array<[string, string]>
  changed: string[]
}

function withHandlers(p: FeishuPlatform): Handlers {
  const h: Handlers = { renamed: [], changed: [] }
  p.setChatRenamedHandler((key, name) => { h.renamed.push([key, name]) })
  p.setChatChangedHandler((key) => { h.changed.push(key) })
  return h
}

describe('onChatUpdated', () => {
  it('caches the new name and fires both handlers on a rename', async () => {
    const p = newPlatform()
    const h = withHandlers(p)

    p.onChatUpdated({ chat_id: 'oc_1', after_change: { name: '新群名' } })

    expect(h.renamed).toEqual([['feishu:oc_1', '新群名']])
    expect(h.changed).toEqual(['feishu:oc_1'])
    // The rename landed in the chat-name cache (fresh entry).
    expect(p.chatNames.get('oc_1')).toMatchObject({ name: '新群名' })
  })

  it('fires only the changed handler on an avatar-only change', () => {
    const p = newPlatform()
    const h = withHandlers(p)

    p.onChatUpdated({ chat_id: 'oc_1', after_change: { avatar: 'img_v2_new' } })

    expect(h.renamed).toEqual([])
    expect(h.changed).toEqual(['feishu:oc_1'])
  })

  it('ignores blank names and missing after_change', () => {
    const p = newPlatform()
    const h = withHandlers(p)

    p.onChatUpdated({ chat_id: 'oc_1', after_change: { name: '   ' } })
    p.onChatUpdated({ chat_id: 'oc_1' })
    p.onChatUpdated({})

    expect(h.renamed).toEqual([])
    // Go fires the changed handler on the FIELD's presence — even a blank
    // name may come with an avatar change inserting a system notice.
    expect(h.changed).toEqual(['feishu:oc_1'])
  })

  it('routes the WS event type through onChatUpdated', async () => {
    let deliver: ((eventType: string, data: unknown) => void) | undefined
    const p = newPlatform({ wsStart: async (onRawEvent) => { deliver = onRawEvent } })
    const h = withHandlers(p)
    await p.start(() => {})

    deliver?.('im.chat.updated_v1', { chat_id: 'oc_1', after_change: { name: '改名' } } satisfies FeishuChatUpdatedEvent)

    expect(h.renamed).toEqual([['feishu:oc_1', '改名']])
  })
})
