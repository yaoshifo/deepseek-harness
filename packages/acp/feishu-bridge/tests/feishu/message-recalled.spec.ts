/**
 * im.message.recalled_v1 handling (Go onMessageRecalled, #30 消息撤回取消):
 * the recall event carries its fields at the ROOT of the parsed WS payload
 * in snake_case (the flattened convention confirmed live for
 * card.action.trigger and im.chat.updated_v1); the platform forwards the
 * recalled message_id to the engine's recall handler.
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform } from '../../src/feishu/platform.js'

function newPlatform(options: Partial<ConstructorParameters<typeof FeishuPlatform>[0]> = {}): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    ...options,
  })
}

describe('onMessageRecalled', () => {
  it('forwards the root-level message_id to the recall handler', () => {
    const p = newPlatform()
    const got: string[] = []
    p.setRecallHandler((messageID) => { got.push(messageID) })

    p.onMessageRecalled({ message_id: 'om_recalled', chat_id: 'oc_1' })

    expect(got).toEqual(['om_recalled'])
  })

  it('ignores events without a message id and missing handlers', () => {
    const p = newPlatform()
    const got: string[] = []
    p.setRecallHandler((messageID) => { got.push(messageID) })

    p.onMessageRecalled({ chat_id: 'oc_1' })
    p.onMessageRecalled({})

    expect(got).toEqual([])
  })

  it('routes the WS event type through onMessageRecalled', async () => {
    let deliver: ((eventType: string, data: unknown) => void) | undefined
    const p = newPlatform({ wsStart: async (onRawEvent) => { deliver = onRawEvent } })
    const got: string[] = []
    p.setRecallHandler((messageID) => { got.push(messageID) })
    await p.start(() => {})

    deliver?.('im.message.recalled_v1', { message_id: 'om_ws', chat_id: 'oc_1' })

    expect(got).toEqual(['om_ws'])
  })
})
