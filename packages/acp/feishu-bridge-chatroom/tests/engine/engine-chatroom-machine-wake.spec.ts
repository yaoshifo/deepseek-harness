/**
 * Machine wakes (chatroom moderator wake, subtask report) delivered through
 * Engine.deliverMachineMessage must not be claimed by the chatroom's
 * pending-ask-human router: the router exists for human replies, and a
 * machine wake claiming it clears the pending flag and feeds the role a
 * bogus "human answer" of the wake's own text while the moderator never
 * receives its wake.
 *
 * @module dsh-feishu-bridge-chatroom/tests-engine-machine-wake
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine, emptyMessage, ProjectStateStore, registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.js'
import { startChatroom, routePendingHumanReply } from '../../src/engine/chatroom.js'
import { chatroomState } from '../../src/chatroom-state.js'
import { chatroomConfig } from '../../src/chatroom-config.js'
import { createStubAgent, createStubChatroomSpawner } from '../stubs/engine-stubs.js'
import { chatroomPolicyFace } from '../stubs/bridge-policy.js'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import '../stubs/messages.js'

function newChatroomTestEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

async function scaffoldOneRole(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fb-machinewake-'))
  await mkdir(join(root, 'taleb'), { recursive: true })
  await writeFile(join(root, 'taleb', 'CLAUDE.md'), '# taleb\n', 'utf8')
  return root
}

describe('machine wake vs pending ask-human', () => {
  it('a chatroom machine wake is not claimed as the human reply', async () => {
    const p = createStubChatroomSpawner()
    const e = newChatroomTestEngine(p)
    chatroomConfig(e).applySection({ rolesDir: await scaffoldOneRole() })
    const hub = 'test:hub:user-1'
    await startChatroom(e, hub, ['taleb'], 'topic')
    const hubSess = e.sessions.getOrCreateActive(hub)
    // taleb asked the human and is parked waiting; the pending flag is armed.
    chatroomState(hubSess).pendingHumanQuestionRole = 'taleb'

    // taleb's turn ends and the relay path wakes the moderator through
    // deliverMachineMessage — a machine message, never the human's answer.
    e.deliverMachineMessage(p, {
      ...emptyMessage(),
      sessionKey: hub,
      platform: p.name(),
      userName: '[聊天室]',
      content: '【taleb】这是我的观点，请主持人继续',
      replyCtx: { messageID: 'om_wake', chatID: 'oc_hub', sessionKey: hub },
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // The pending flag survives for the real human reply…
    expect(chatroomState(hubSess).pendingHumanQuestionRole).toBe('taleb')
    // …which still routes to the role.
    expect(routePendingHumanReply(e, p, hub, '用户的真实回答')).toBe(true)
  })
})
