/**
 * Preview-card cache tests ported from cc-connect platform/feishu
 * feishu_progress_cardcache_test.go (the non-callback suites; the
 * card-action tests arrive with the M3 card.action.trigger dispatch).
 * The Go httptest server becomes an injectable client that mints message
 * IDs and records PATCH bodies.
 *
 * @module dsh-feishu-bridge/tests-feishu-cardcache
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, FeishuPreviewHandle, type FeishuApiClient } from '../../src/feishu/platform.ts'

/** Client that mints om_card_N ids on create/reply and records patches. */
function cardCacheClient(): FeishuApiClient & { patches: Map<string, string> } {
  let seq = 0
  const patches = new Map<string, string>()
  return {
    patches,
    async reply() {
      seq++
      return { messageId: `om_card_${seq}` }
    },
    async create() {
      seq++
      return { messageId: `om_card_${seq}` }
    },
    async patch({ messageId, content }) {
      patches.set(messageId, content)
    },
    async delete() {},
  }
}

function newPlatform(api: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({ appID: 'cli_test', appSecret: 's', apiClient: api })
}

const rc = { messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'sk_shared' }

describe('per-card preview caches', () => {
  it('concurrent cards in one chat do not clobber each other', async () => {
    const api = cardCacheClient()
    const p = newPlatform(api)

    // Session A: create card, then PATCH it green.
    const hA = await p.sendPreviewStart(rc, { kind: 'text', text: 'CARD_A_BODY', status: { state: 'thinking', ts: '15:47:00', toolCallSeq: 0 } })
    await p.updateMessage(hA, { kind: 'text', text: 'CARD_A_BODY', status: { state: 'completed', ts: '15:47:00', toolCallSeq: 0 } })

    // Session B starts concurrently: a new yellow card in the same chat.
    await p.sendPreviewStart(rc, { kind: 'text', text: 'CARD_B_BODY', status: { state: 'thinking', ts: '15:47:09', toolCallSeq: 0 } })

    // Render-status PATCH lands on A's completed card — must rebuild from
    // A's own cached green JSON, not B's yellow one.
    await p.updateRenderStatus(rc, hA.messageID, '✅ 已交付')

    const got = api.patches.get(hA.messageID) ?? ''
    expect(got).toContain('CARD_A_BODY')
    expect(got).not.toContain('CARD_B_BODY')
    expect(got).toContain('已交付')
  })

  it('render status does not leak across cards in one chat', async () => {
    const api = cardCacheClient()
    const p = newPlatform(api)

    const hA = await p.sendPreviewStart(rc, { kind: 'text', text: 'CARD_A_BODY', status: { state: 'thinking', ts: '15:47:00', toolCallSeq: 0 } })
    await p.updateMessage(hA, { kind: 'text', text: 'CARD_A_BODY', status: { state: 'completed', ts: '15:47:00', toolCallSeq: 0 } })
    await p.updateRenderStatus(rc, hA.messageID, '🖼 渲染中')

    // Card B in the same chat must not carry A's render status.
    const hB = await p.sendPreviewStart(rc, { kind: 'text', text: 'CARD_B_BODY', status: { state: 'thinking', ts: '15:47:09', toolCallSeq: 0 } })
    await p.updateMessage(hB, { kind: 'text', text: 'CARD_B_BODY', status: { state: 'completed', ts: '15:47:09', toolCallSeq: 0 } })

    const gotA = api.patches.get(hA.messageID) ?? ''
    const gotB = api.patches.get(hB.messageID) ?? ''
    expect(gotA).toContain('渲染中')
    expect(gotB).not.toContain('渲染中')
    expect(gotB).toContain('CARD_B_BODY')
  })

  it('renderStoppedCard patches the stopped card from the cache', async () => {
    const api = cardCacheClient()
    const p = newPlatform(api)
    const runningRC = { ...rc, sessionKey: 'sk_running' }

    const h = await p.sendPreviewStart(runningRC, { kind: 'text', text: 'RUNNING_BODY', status: { state: 'thinking', ts: '15:47:00', toolCallSeq: 0 } })

    // Pass the real handle so the type check exercises the production path.
    await p.renderStoppedCard(runningRC, h)

    const patched = api.patches.get(h.messageID) ?? ''
    expect(patched).toContain('已停止')
    expect(patched).toContain('继续执行')
    expect(patched).not.toContain('执行失败')
    expect(patched).not.toContain('cmd:/stop')
    expect(patched).toContain('RUNNING_BODY')

    // Cache miss → error.
    await expect(p.renderStoppedCard(runningRC, new FeishuPreviewHandle('om_unknown', 'oc_chat', 'sk'))).rejects.toThrow()
  })

  it('render-status PATCH keeps the stop button on a running card', async () => {
    const api = cardCacheClient()
    const p = newPlatform(api)
    const runningRC = { ...rc, sessionKey: 'sk_running' }

    const h = await p.sendPreviewStart(runningRC, { kind: 'text', text: 'RUNNING_BODY', status: { state: 'thinking', ts: '15:47:00', toolCallSeq: 0 } })
    await p.updateRenderStatus(runningRC, h.messageID, '🖼 渲染中…')

    const patched = api.patches.get(h.messageID) ?? ''
    expect(patched).toContain('RUNNING_BODY')
    expect(patched).toContain('cmd:/stop')
    // Status text renders only on green cards; on a running card it is
    // cached for later, not shown inline.
  })

  it('a failed PATCH does not advance the pre-button cache', async () => {
    // Non-transient failure shape: withRetry gives up after one attempt, so
    // the rejected updateMessage cannot have landed on the card either.
    const fail = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { code: 230001, msg: 'rate limited' } },
    })
    const api = cardCacheClient()
    let patchCalls = 0
    api.patch = async (params: { messageId: string; content: string }) => {
      patchCalls++
      if (patchCalls === 1) throw fail
      api.patches.set(params.messageId, params.content)
    }
    const p = newPlatform(api)
    const runningRC = { ...rc, sessionKey: 'sk_running' }

    const h = await p.sendPreviewStart(runningRC, { kind: 'text', text: 'BODY_V1', status: { state: 'thinking', ts: '15:47:00', toolCallSeq: 0 } })
    await expect(p.updateMessage(h, { kind: 'text', text: 'BODY_V2', status: { state: 'completed', ts: '15:47:01', toolCallSeq: 1 } })).rejects.toThrow('Request failed with status code 400')

    // The stop-card rebuild works from what the card actually shows (V1);
    // caching V2 ahead of the failed PATCH would restyle content the chat
    // never received.
    await p.renderStoppedCard(runningRC, h)
    const patched = api.patches.get(h.messageID) ?? ''
    expect(patched).toContain('BODY_V1')
    expect(patched).not.toContain('BODY_V2')
  })
})
