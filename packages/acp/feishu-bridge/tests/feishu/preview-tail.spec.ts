/**
 * previewDisplaced (PreviewDisplacementProber) tests: the platform keeps a
 * per-chat activity ledger touched by inbound messages and non-preview
 * outbound sends; sendPreviewStart stays exempt so a card reissue never
 * displaces itself, thread-isolated handles never report displaced, and
 * recall events never touch (a reissue's own delete would otherwise loop).
 *
 * @module dsh-feishu-bridge/tests-feishu-preview-tail
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, FeishuPreviewHandle, type FeishuApiClient, type FeishuReceiveEvent } from '../../src/feishu/platform.js'
import { Card } from '../../src/card.js'
import type { ProgressContent } from '../../src/core/types.js'

function apiClient(): FeishuApiClient {
  return {
    async reply() {
      return { messageId: 'om_ok' }
    },
    async create() {
      return { messageId: 'om_ok' }
    },
  }
}

function newPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_tail',
    appSecret: 'sec_tail',
    botOpenID: 'ou_bot',
    apiClient: api,
    wsStart: async () => {},
  })
}

const replyCtx = { messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat' }

const textContent: ProgressContent = { kind: 'text', text: 'hello' }

let eventCounter = 0

function receiveEvent(overrides: Partial<FeishuReceiveEvent['message']>): FeishuReceiveEvent {
  eventCounter += 1
  return {
    message: {
      message_id: `om_${eventCounter}`,
      chat_id: 'oc_chat',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      chat_type: 'p2p',
      create_time: String(Date.now()),
      ...overrides,
    },
    sender: { sender_id: { open_id: 'ou_9' } },
  }
}

describe('previewDisplaced', () => {
  it('false with no chat activity after the card', () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    expect(p.previewDisplaced(handle, Date.now() - 1000)).toBe(false)
  })

  it('inbound messages touch the ledger', () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    const since = Date.now() - 1000
    p.onMessage(receiveEvent({}))
    expect(p.previewDisplaced(handle, since)).toBe(true)
    // A card sent after the activity is not displaced by it.
    expect(p.previewDisplaced(handle, Date.now())).toBe(false)
  })

  it('a group message the router drops still touches (it physically landed)', () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    const since = Date.now() - 1000
    p.onMessage(receiveEvent({ chat_type: 'group', mentions: [] }))
    expect(p.previewDisplaced(handle, since)).toBe(true)
  })

  it('recall events never touch the ledger', () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    const since = Date.now() - 1000
    p.onMessageRecalled({ message_id: 'om_other', chat_id: 'oc_chat' })
    expect(p.previewDisplaced(handle, since)).toBe(false)
  })

  it('outbound text sends touch the ledger', async () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    const since = Date.now() - 1000
    await p.send(replyCtx, 'plain answer')
    expect(p.previewDisplaced(handle, since)).toBe(true)
  })

  it('outbound card sends touch the ledger', async () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    const since = Date.now() - 1000
    await p.sendCardWithHandle(replyCtx, new Card())
    expect(p.previewDisplaced(handle, since)).toBe(true)
  })

  it('sendPreviewStart stays exempt so reissues never displace themselves', async () => {
    const p = newPlatform(apiClient())
    const since = Date.now() - 1000
    const sent = await p.sendPreviewStart(replyCtx, textContent)
    expect(p.previewDisplaced(sent, since)).toBe(false)
  })

  it('thread handles never report displaced', () => {
    const p = newPlatform(apiClient())
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat', true)
    p.onMessage(receiveEvent({}))
    expect(p.previewDisplaced(handle, 0)).toBe(false)
  })

  it('rejects a non-handle argument', () => {
    const p = newPlatform(apiClient())
    expect(() => p.previewDisplaced('om_not_a_handle', 0)).toThrow()
  })
})
