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

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type CardActionTriggerEvent } from '../../src/feishu/platform.js'
import type { Message } from '../../src/core/types.js'

let counter = 0

function cardEvent(overrides: {
  action?: string
  chatID?: string
  userID?: string
  value?: Record<string, string>
}): CardActionTriggerEvent {
  counter += 1
  return {
    action: { value: { action: overrides.action ?? '', ...(overrides.value ?? {}) } },
    operator: { open_id: overrides.userID ?? 'ou_9' },
    context: { open_chat_id: overrides.chatID ?? 'oc_1', open_message_id: `om_${counter}` },
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

  it('still routes perm: actions through the permission path', async () => {
    const p = newPlatform({ allowChat: '*' })
    const messages = await dispatched(p, cardEvent({ action: 'perm:allow' }))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.isPermissionAction).toBe(true)
    expect(messages[0]!.isCardAction).toBe(false)
    expect(messages[0]!.content).toBe('allow')
  })
})
