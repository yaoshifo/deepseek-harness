/**
 * `/done` on a live chatroom hub routes through the chatroom interrupt: the
 * pre-done listener consumes the armed barriers, clears the persona flags,
 * writes the ledger's interrupted line, and claims the role groups' cleanup
 * so the bridge's own descendant loop does not re-clean them. An ended hub
 * (moderator flag already down) falls through to the plain /done path.
 *
 * @module dsh-feishu-bridge-chatroom/tests-engine-chatroom-done
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, ProjectStateStore, registerSessionCommands } from '@deepseek-ai/dsh-feishu-bridge/exports'
import type { Platform } from '@deepseek-ai/dsh-feishu-bridge/exports'
import { registerChatroomCommands } from '../../src/engine/chatroom-cmd.ts'
import { ChatroomGather, chatroomLedgerDirFor } from '../../src/engine/chatroom.ts'
import { chatroomConfig } from '../../src/chatroom-config.ts'
import { chatroomState } from '../../src/chatroom-state.ts'
import { chatroomPolicyFace } from '../stubs/bridge-policy.ts'
import { createStubAgent, createStubChatroomSpawnerEx, newStubMessage } from '../stubs/engine-stubs.ts'
import '../stubs/messages.js'

async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cond()) return
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`)
    await settle()
  }
}

function newEngine(p: Platform): Engine {
  const e = new Engine('test', createStubAgent(), [p], '', 'zh', chatroomPolicyFace())
  e.setProjectStateStore(new ProjectStateStore(''))
  registerSessionCommands(e)
  registerChatroomCommands(e)
  return e
}

const hubKey = 'test:hub:user-1'

/** A live chatroom: moderator flag up, an armed gather awaiting two roles. */
function armedChatroom(e: Engine): ChatroomGather {
  const hub = e.sessions.getOrCreateActive(hubKey)
  chatroomState(hub).chatroomModerator = true
  const g = new ChatroomGather('研究任务', 1)
  for (const name of ['taleb', 'munger']) {
    const key = `test:role-${name}`
    const s = e.sessions.getOrCreateActive(key)
    chatroomState(s).chatroomHubKey = hubKey
    s.setParentSessionKey(hubKey)
    chatroomState(s).chatroomRoleName = name
    g.expected.add(name)
  }
  chatroomState(hub).pendingGather = g
  return g
}

/** Pre-create the ledger a started chatroom would have written. */
async function scaffoldLedger(e: Engine): Promise<string> {
  const mod = await mkdtemp(join(tmpdir(), 'fb-done-mod-'))
  chatroomConfig(e).applySection({ moderatorDir: mod })
  const dir = chatroomLedgerDirFor(e, hubKey)!
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SYNTHESIS.md'), '# 聊天室账本：测试议题\n\n- 议题：测试议题\n- 角色：taleb, munger\n- 开始：2026-09-04 00:00:00\n\n## 当前图景\n', 'utf8')
  return join(dir, 'SYNTHESIS.md')
}

function doneMsg(): import('@deepseek-ai/dsh-feishu-bridge/exports').Message {
  return { ...newStubMessage(), sessionKey: hubKey, userID: 'u1', replyCtx: 'ctx', content: '/done', chatType: 'group' }
}

describe('/done on a chatroom hub', () => {
  it('interrupts a live chatroom: barriers consumed, flags cleared, ledger interrupted, roles cleaned once', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newEngine(p)
    const synthesis = await scaffoldLedger(e)
    armedChatroom(e)
    const recv = vi.spyOn(e, 'receiveMessage').mockImplementation(() => {})

    expect(e.dispatchCommand(p, doneMsg(), '/done')).toBe(true)
    await waitFor(() => !chatroomState(e.sessions.getOrCreateActive(hubKey)).chatroomModerator, 'chatroom interrupted')

    // The chatroom state the plain /done teardown never touched is gone.
    const hub = e.sessions.getOrCreateActive(hubKey)
    expect(chatroomState(hub).pendingGather).toBeUndefined()
    for (const name of ['taleb', 'munger']) {
      expect(chatroomState(e.sessions.getOrCreateActive(`test:role-${name}`)).chatroomHubKey).toBe('')
    }
    // No moderator wake: the interrupt card is the only terminal record.
    expect(recv.mock.calls).toHaveLength(0)
    expect(JSON.stringify(p.sentCards)).toContain('聊天室已中断')
    // The ledger records the interrupt.
    await waitFor(() => readFileSync(synthesis, 'utf8').includes('（已中断）'), 'ledger interrupted line')
    // The listener claimed the role groups: the bridge's own loop did not
    // re-clean them (each role marked done exactly once), the hub once.
    for (const name of ['taleb', 'munger']) {
      expect(p.doneKeys.filter(k => k === `test:role-${name}`)).toHaveLength(1)
    }
    expect(p.doneKeys.filter(k => k === hubKey)).toHaveLength(1)
  })

  it('an ended hub falls through: plain /done teardown, no interrupt card', async () => {
    const p = createStubChatroomSpawnerEx()
    const e = newEngine(p)
    // The chatroom ended earlier (moderator flag down); one plain /spawn
    // child still hangs under the hub.
    e.sessions.getOrCreateActive(hubKey)
    e.sessions.getOrCreateActive('test:plain-child:u1').setParentSessionKey(hubKey)

    expect(e.dispatchCommand(p, doneMsg(), '/done')).toBe(true)
    await waitFor(() => p.doneKeys.includes(hubKey), 'hub teardown')

    expect(p.sentCards.length).toBe(0)
    expect(p.doneKeys.filter(k => k === 'test:plain-child:u1')).toHaveLength(1)
    expect(p.doneKeys.filter(k => k === hubKey)).toHaveLength(1)
    expect(chatroomState(e.sessions.getOrCreateActive(hubKey)).chatroomModerator).toBe(false)
  })
})
