/**
 * Default WS dispatcher registration tests (Go feishu_lifecycle.go): the four
 * routed events pass through to the raw-event callback, and the reaction echo
 * events carry explicit no-op handlers — the bot's own add/removeReaction
 * triggers them, and without a handler the node-sdk warns
 * "no im.message.reaction.* handle" on every reaction.
 *
 * @module dsh-feishu-bridge/tests-feishu-ws-registrations
 */

import { describe, expect, it } from 'vitest'
import { wsEventRegistrations } from '../../src/feishu/platform.ts'

describe('wsEventRegistrations', () => {
  it('routes the four handled event types to the raw-event callback', () => {
    const seen: Array<[string, unknown]> = []
    const reg = wsEventRegistrations((eventType, data) => { seen.push([eventType, data]) })
    for (const type of ['im.message.receive_v1', 'card.action.trigger', 'im.chat.updated_v1', 'im.message.recalled_v1']) {
      reg[type]?.({ marker: type })
    }
    expect(seen).toEqual([
      ['im.message.receive_v1', { marker: 'im.message.receive_v1' }],
      ['card.action.trigger', { marker: 'card.action.trigger' }],
      ['im.chat.updated_v1', { marker: 'im.chat.updated_v1' }],
      ['im.message.recalled_v1', { marker: 'im.message.recalled_v1' }],
    ])
  })

  it('propagates the raw-event callback return value as the handler result', () => {
    const marker = { card: { type: 'raw', data: { schema: '2.0' } } }
    const reg = wsEventRegistrations(() => marker)
    expect(reg['card.action.trigger']?.({})).toBe(marker)
  })

  it('registers no-op handlers for the reaction echo events', () => {
    const seen: Array<[string, unknown]> = []
    const reg = wsEventRegistrations((eventType, data) => { seen.push([eventType, data]) })
    for (const type of ['im.message.reaction.created_v1', 'im.message.reaction.deleted_v1']) {
      expect(reg[type], type).toBeTypeOf('function')
      reg[type]?.({ echo: true })
    }
    expect(seen).toEqual([])
  })
})
