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

/** Client recording which outbound verb each send used. */
function recordingClient(): FeishuApiClient & { replies: number; creates: number; replyInThread: boolean[] } {
  return {
    replies: 0,
    creates: 0,
    replyInThread: [],
    async reply({ replyInThread }) {
      this.replies++
      this.replyInThread.push(replyInThread === true)
      return { messageId: `om_reply_${this.replies}` }
    },
    async create() {
      this.creates++
      return { messageId: `om_create_${this.creates}` }
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
    await p.sendPreviewStart(rc, 'thinking…')
    expect(api.creates).toBe(1)
    expect(api.replies).toBe(0)
  })

  it('replies in the thread under thread isolation', async () => {
    const api = recordingClient()
    const p = newPlatform(api, { threadIsolation: true })
    await p.sendPreviewStart(
      { messageID: 'om_trigger', chatID: 'oc_chat', sessionKey: 'feishu:oc_chat:thread:omt_1' },
      'thinking…',
    )
    expect(api.replies).toBe(1)
    expect(api.replyInThread).toEqual([true])
    expect(api.creates).toBe(0)
  })
})
