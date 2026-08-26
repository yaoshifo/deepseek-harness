/**
 * previewIsLatest (PreviewTailProber) tests: the tail-guard probe maps to a
 * newest-first single-item im.message.list and compares message ids, and
 * thread-isolated handles skip the query (the root-chat tail is meaningless
 * for them).
 *
 * @module dsh-feishu-bridge/tests-feishu-preview-tail
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, FeishuPreviewHandle, type FeishuApiClient, type FeishuListItem } from '../../src/feishu/platform.js'

/** Captured im.message.list query args, plus the configurable newest item. */
function tailApi(newest: FeishuListItem | undefined): { api: FeishuApiClient; queries: Array<Record<string, unknown>> } {
  const queries: Array<Record<string, unknown>> = []
  const api: FeishuApiClient = {
    async reply() {
      return { messageId: 'om_ok' }
    },
    async create() {
      return { messageId: 'om_ok' }
    },
    async listMessages(q?: Record<string, unknown>) {
      if (q !== undefined) queries.push(q)
      return newest === undefined ? [] : [newest]
    },
  }
  return { api, queries }
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

function otherMessage(messageId: string): FeishuListItem {
  return {
    messageId,
    msgType: 'text',
    content: '{"text":"displacer"}',
    createTime: '1690000001000',
    sender: { id: 'ou_user', idType: 'open_id', senderType: 'user' },
  }
}

describe('previewIsLatest', () => {
  it('queries newest-first with page size 1 and compares message ids', async () => {
    const { api, queries } = tailApi(otherMessage('om_other'))
    const p = newPlatform(api)
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')

    await expect(p.previewIsLatest(handle)).resolves.toBe(false)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatchObject({ chatId: 'oc_chat', sortType: 'ByCreateTimeDesc', pageSize: 1 })
  })

  it('true when the preview card itself is the newest message', async () => {
    const { api } = tailApi(otherMessage('om_mine'))
    const p = newPlatform(api)
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    await expect(p.previewIsLatest(handle)).resolves.toBe(true)
  })

  it('true for an empty chat (nothing displaced it)', async () => {
    const { api } = tailApi(undefined)
    const p = newPlatform(api)
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat')
    await expect(p.previewIsLatest(handle)).resolves.toBe(true)
  })

  it('thread handles skip the query entirely', async () => {
    const { api, queries } = tailApi(otherMessage('om_other'))
    const p = newPlatform(api)
    const handle = new FeishuPreviewHandle('om_mine', 'oc_chat', 'feishu:oc_chat', true)
    await expect(p.previewIsLatest(handle)).resolves.toBe(true)
    expect(queries).toHaveLength(0)
  })

  it('rejects a non-handle argument', async () => {
    const { api } = tailApi(undefined)
    const p = newPlatform(api)
    await expect(p.previewIsLatest('om_not_a_handle')).rejects.toThrow()
  })
})
