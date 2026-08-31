/**
 * Monitor poll-path tests ported 1:1 from cc-connect
 * platform/feishu/feishu_monitor_poll_test.go (#53): poll text extraction
 * (post plain-array / locale-wrapped, card unwrap, image keys), the
 * poll-item→Message conversion (bot/app sender skip, image-only drop,
 * text-card screenshot attach, no-fallback skip), and create-time parsing.
 * The Go httptest mock server becomes a mock FeishuApiClient whose
 * downloadMessageResource counts image downloads.
 *
 * @module dsh-feishu-bridge/tests-feishu-monitor-poll
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient, type FeishuListItem } from '../../src/feishu/platform.ts'
import {
  extractCardImageKeys,
  extractPollText,
  unwrapCardContent,
} from '../../src/feishu/extract.ts'

/** Escape s as a JSON string body (for nesting raw_card_content). */
function jsonEscape(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** A poll-item fixture: an interactive card wrapped in raw_card_content. */
function cardItem(inner: string, messageID: string): FeishuListItem {
  return {
    messageId: messageID,
    msgType: 'interactive',
    content: `{"type":"raw_card_content","raw_card_content":"${jsonEscape(inner)}"}`,
    createTime: '1690000000000',
    sender: { id: 'cli_webhook', idType: 'app_id', senderType: 'app' },
  }
}

/** A mock api client whose downloads and listing are configurable (Go newPollTestPlatform). */
function pollApi(opts: { downloads?: { n: number }; items: FeishuListItem[] }): FeishuApiClient {
  return {
    async reply() {
      return { messageId: 'om_ok' }
    },
    async create() {
      return { messageId: 'om_ok' }
    },
    async downloadMessageResource() {
      if (opts.downloads !== undefined) opts.downloads.n++
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x0a])
    },
    async listMessages() {
      return opts.items
    },
  }
}

/** A poll-test platform (Go newPollTestPlatform): bot + fallback configured. */
function newPollPlatform(api: FeishuApiClient, fallbackUser = 'ou_fallback'): FeishuPlatform {
  const p = new FeishuPlatform({
    appID: 'cli_poll',
    appSecret: 'sec_poll',
    botOpenID: 'ou_ourbot',
    apiClient: api,
    wsStart: async () => {},
  })
  p.setMonitorFallbackUser(fallbackUser)
  return p
}

describe('extractPollText', () => {
  it('extracts the pure-array post form im.message.list returns', () => {
    const card = '{"title":"告警","content":[[{"tag":"text","text":"支付 500"}],[{"tag":"text","text":"详见日志"}]]}'
    expect(extractPollText('post', card)).toBe('告警\n支付 500\n详见日志')
  })

  it('regression-guards the locale-wrapped whole-post form', () => {
    const card = '{"zh_cn":{"title":"告警","content":[[{"tag":"text","text":"支付 500"}]]}}'
    expect(extractPollText('post', card)).toBe('告警\n支付 500')
  })
})

describe('unwrapCardContent', () => {
  const cases: Array<{ name: string; content: string; want: string }> = [
    { name: 'raw_card_content wrapper', content: '{"type":"raw_card_content","raw_card_content":"{\\"elements\\":[1]}"}', want: '{"elements":[1]}' },
    { name: 'json_card wrapper', content: '{"json_card":"{\\"x\\":1}"}', want: '{"x":1}' },
    { name: 'direct card json', content: '{"elements":[{"tag":"img"}]}', want: '{"elements":[{"tag":"img"}]}' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(unwrapCardContent(c.content)).toBe(c.want)
    })
  }
})

describe('extractCardImageKeys', () => {
  const cases: Array<{ name: string; cardJSON: string; want: string[] }> = [
    { name: 'schema2 img_key', cardJSON: '{"elements":[{"tag":"img","img_key":"img_v3_a"}]}', want: ['img_v3_a'] },
    { name: 'schema1 image_key', cardJSON: '{"image_key":"img_v3_b"}', want: ['img_v3_b'] },
    { name: 'mixed + dedup', cardJSON: '{"a":{"img_key":"k1"},"b":{"image_key":"k2"},"c":{"img_key":"k1"}}', want: ['k1', 'k2'] },
    { name: 'none', cardJSON: '{"elements":[{"tag":"div","text":"hi"}]}', want: [] },
    { name: 'empty key skipped', cardJSON: '{"img_key":""}', want: [] },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(extractCardImageKeys(c.cardJSON)).toEqual(c.want)
    })
  }
})

describe('pollItemToMessage (via listMonitorMessages)', () => {
  it('drops an image-only card (no text to triage, nothing downloaded)', async () => {
    const downloads = { n: 0 }
    const p = newPollPlatform(pollApi({ downloads, items: [cardItem('{"elements":[{"tag":"img","img_key":"img_v3_alert"}]}', 'om_alert')] }))
    expect((await p.listMonitorMessages('oc_chat', 0, 20)).messages).toHaveLength(0)
    expect(downloads.n).toBe(0)
  })

  it('drops a card with no text and no image keys', async () => {
    const downloads = { n: 0 }
    const p = newPollPlatform(pollApi({ downloads, items: [cardItem('{"elements":[{"tag":"div","text":""}]}', 'om_alert2')] }))
    expect((await p.listMonitorMessages('oc_chat', 0, 20)).messages).toHaveLength(0)
    expect(downloads.n).toBe(0)
  })

  it('keeps a text card\'s text and attaches its screenshot', async () => {
    const downloads = { n: 0 }
    const inner = '{"header":{"title":{"content":"告警"}},"elements":[{"tag":"img","img_key":"img_v3_decor"},{"tag":"text","text":"支付 500"}]}'
    const p = newPollPlatform(pollApi({ downloads, items: [cardItem(inner, 'om_text')] }))
    const out = (await p.listMonitorMessages('oc_chat', 0, 20)).messages
    expect(out).toHaveLength(1)
    expect(downloads.n).toBe(1)
    expect(out[0]?.images).toHaveLength(1)
    expect(out[0]?.content).toContain('支付 500')
  })

  it('triages a title-only card and attaches its screenshot', async () => {
    const downloads = { n: 0 }
    const inner = '{"header":{"title":{"content":"支付告警"}},"elements":[{"tag":"img","img_key":"img_v3_shot"}]}'
    const p = newPollPlatform(pollApi({ downloads, items: [cardItem(inner, 'om_title')] }))
    const out = (await p.listMonitorMessages('oc_chat', 0, 20)).messages
    expect(out).toHaveLength(1)
    expect(downloads.n).toBe(1)
    expect(out[0]?.content).toContain('支付告警')
  })

  it('attaches embedded post images on the poll path', async () => {
    const downloads = { n: 0 }
    const p = newPollPlatform(pollApi({
      downloads,
      items: [{
        messageId: 'om_post',
        msgType: 'post',
        content: '{"content":[[{"tag":"text","text":"支付异常"},{"tag":"img","image_key":"img_v2_p"}]]}',
        createTime: '1690000000000',
        sender: { id: 'ou_u', idType: 'open_id', senderType: 'user' },
      }],
    }))
    const out = (await p.listMonitorMessages('oc_chat', 0, 20)).messages
    expect(out).toHaveLength(1)
    expect(downloads.n).toBe(1)
    expect(out[0]?.images).toHaveLength(1)
    expect(out[0]?.content).toContain('支付异常')
  })

  it('skips the bot\'s own messages (open_id and app_id senders)', async () => {
    const mk = (sender: NonNullable<FeishuListItem['sender']>): FeishuApiClient => pollApi({
      items: [{
        messageId: 'om_x',
        msgType: 'text',
        content: '{"text":"hi"}',
        createTime: '1690000000000',
        sender,
      }],
    })
    // App's own message (sender.id = our appID, sender_type = app).
    const p1 = new FeishuPlatform({
      appID: 'cli_app', appSecret: 'sec', botOpenID: 'ou_bot',
      apiClient: mk({ id: 'cli_app', senderType: 'app' }), wsStart: async () => {},
    })
    p1.setMonitorFallbackUser('ou_fallback')
    expect((await p1.listMonitorMessages('oc_c', 0, 20)).messages).toHaveLength(0)

    // Bot open_id sender.
    const p2 = new FeishuPlatform({
      appID: 'cli_app', appSecret: 'sec', botOpenID: 'ou_bot',
      apiClient: mk({ id: 'ou_bot', senderType: 'user' }), wsStart: async () => {},
    })
    p2.setMonitorFallbackUser('ou_fallback')
    const page2 = await p2.listMonitorMessages('oc_c', 0, 20)
    expect(page2.messages).toHaveLength(0)
    // The filtered-out message still advances the caller's watermark.
    expect(page2.latestTimeSec).toBe(1690000000)
  })

  it('skips a webhook card with no fallback_user before downloading', async () => {
    const downloads = { n: 0 }
    // No fallback configured (default '').
    const p = newPollPlatform(pollApi({ downloads, items: [cardItem('{"elements":[{"tag":"img","img_key":"img_v3_x"}]}', 'om_nofback')] }), '')
    expect((await p.listMonitorMessages('oc_chat', 0, 20)).messages).toHaveLength(0)
    expect(downloads.n).toBe(0)
  })
})

describe('latestMessageTime', () => {
  function platformWith(items: FeishuListItem[]): FeishuPlatform {
    return newPollPlatform(pollApi({ items }))
  }

  it('converts ms create_time to seconds and truncates sub-seconds', async () => {
    expect(await platformWith([{ messageId: 'om_1', msgType: 'text', content: '', createTime: '1690000000000' }]).latestMessageTime('oc_c')).toBe(1690000000)
    expect(await platformWith([{ messageId: 'om_1', msgType: 'text', content: '', createTime: '1690000000999' }]).latestMessageTime('oc_c')).toBe(1690000000)
  })

  it('returns 0 for an empty chat and for garbage timestamps', async () => {
    expect(await platformWith([]).latestMessageTime('oc_c')).toBe(0)
    expect(await platformWith([{ messageId: 'om_1', msgType: 'text', content: '', createTime: 'abc' }]).latestMessageTime('oc_c')).toBe(0)
  })
})
