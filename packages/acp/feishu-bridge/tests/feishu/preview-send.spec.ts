/**
 * Preview-start routing tests (Go feishu.go SendPreviewStart): the streaming /
 * tool-progress card is a NEW message in the chat — it must not reply to (and
 * thus quote) the user's trigger message. Only thread isolation routes it
 * through the reply API, so the card lands in the triggering thread.
 *
 * @module dsh-feishu-bridge/tests-feishu-preview-send
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'

/** Client recording which outbound verb each send used, and card contents. */
function recordingClient(): FeishuApiClient & { replies: number; creates: number; replyInThread: boolean[]; cardContents: string[] } {
  return {
    replies: 0,
    creates: 0,
    replyInThread: [],
    cardContents: [],
    async reply({ replyInThread, content }) {
      this.replies++
      this.replyInThread.push(replyInThread === true)
      this.cardContents.push(content)
      return { messageId: `om_reply_${this.replies}` }
    },
    async create({ content }) {
      this.creates++
      this.cardContents.push(content)
      return { messageId: `om_create_${this.creates}` }
    },
    async patch({ content }) {
      this.cardContents.push(content)
    },
  }
}

function newPlatform(api: FeishuApiClient, options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 's',
    apiClient: api,
    ...options,
  })
}

const rc = { messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:ou_u' }

describe('sendPreviewStart routing', () => {
  it('sends the progress card as a new message, not a reply', async () => {
    const api = recordingClient()
    const p = newPlatform(api)
    await p.sendPreviewStart(rc, { kind: 'text', text: 'thinking…' })
    expect(api.creates).toBe(1)
    expect(api.replies).toBe(0)
  })

  it('replies in the thread under thread isolation', async () => {
    const api = recordingClient()
    const p = newPlatform(api, { threadIsolation: true })
    await p.sendPreviewStart(
      { messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:thread:omt_1' },
      { kind: 'text', text: 'thinking…' },
    )
    expect(api.replies).toBe(1)
    expect(api.replyInThread).toEqual([true])
    expect(api.creates).toBe(0)
  })
})

interface CardRow { tag: string; columns?: Array<unknown> }

/** Last body element of a card JSON, asserted to be the injected button row. */
function lastRow(cardJSON: string): CardRow {
  const card = JSON.parse(cardJSON) as { body: { elements: CardRow[] } }
  const row = card.body.elements.at(-1)
  expect(row?.tag).toBe('column_set')
  return row as CardRow
}

describe('background hint on the stop-button row', () => {
  it('renders beside the stop button on create and PATCH', async () => {
    const api = recordingClient()
    const p = newPlatform(api)
    const handle = await p.sendPreviewStart(rc, { kind: 'text', text: 'thinking…', bgTaskHint: '💡 1 个后台任务' })
    const startColumns = lastRow(api.cardContents[0] ?? '').columns ?? []
    expect(startColumns).toHaveLength(2)
    expect(JSON.stringify(startColumns[0])).toContain('cmd:/stop')
    expect(JSON.stringify(startColumns[1])).toContain('💡 1 个后台任务')

    await p.updateMessage(handle, {
      kind: 'text',
      text: 'still working…',
      status: { state: 'running', ts: '12:00:01', toolCallSeq: 2 },
      bgTaskHint: '💡 3 个后台任务',
    })
    const patchColumns = lastRow(api.cardContents[1] ?? '').columns ?? []
    expect(patchColumns).toHaveLength(2)
    expect(JSON.stringify(patchColumns[0])).toContain('cmd:/stop')
    expect(JSON.stringify(patchColumns[1])).toContain('💡 3 个后台任务')
  })

  it('omits the hint column when the content carries none', async () => {
    const api = recordingClient()
    const p = newPlatform(api)
    await p.sendPreviewStart(rc, { kind: 'text', text: 'thinking…' })
    const startColumns = lastRow(api.cardContents[0] ?? '').columns ?? []
    expect(startColumns).toHaveLength(1)
    expect(JSON.stringify(startColumns[0])).toContain('cmd:/stop')
  })
})
