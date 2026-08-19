/**
 * Rename AbortSignal passthrough (Go RenameGroup/RenameGroupAny ctx
 * propagation): an aborted signal must fail the rename without reaching the
 * chat-update API, an in-flight abort must reject promptly, and a live signal
 * must not interfere. Ported from the Go semantics of
 * platform/feishu/feishu_spawn.go renameChat(ctx, …).
 */

import { describe, expect, it } from 'vitest'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.js'

interface RecordingClient extends FeishuApiClient {
  renames: Array<{ chatId: string; name?: string }>
  unblock(): void
}

/** A client whose updateChat optionally blocks until `unblock()` (in-flight abort tests). */
function newClient(block = false): RecordingClient {
  const renames: Array<{ chatId: string; name?: string }> = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const client: RecordingClient = {
    renames,
    unblock: () => { release() },
    reply: async () => undefined,
    create: async () => undefined,
    updateChat: async (params) => {
      if (block) await gate
      renames.push({ chatId: params.chatId, name: params.name })
      return { code: 0, msg: '' }
    },
  }
  return client
}

function newPlatform(client: FeishuApiClient): FeishuPlatform {
  return new FeishuPlatform({
    appID: 'cli_test',
    appSecret: 'secret',
    wsStart: async () => {},
    apiClient: client,
    isSpawnedChat: chatID => chatID === 'oc_spawn',
  })
}

describe('renameGroup AbortSignal passthrough', () => {
  it('fails without an API call when the signal is already aborted', async () => {
    const client = newClient()
    const p = newPlatform(client)
    const ctl = new AbortController()
    ctl.abort()
    await expect(p.renameGroup('feishu:oc_spawn', '新名', ctl.signal)).rejects.toThrow()
    await expect(p.renameGroupAny('feishu:oc_any', '新名', ctl.signal)).rejects.toThrow()
    expect(client.renames).toHaveLength(0)
  })

  it('rejects promptly when the signal aborts mid-flight', async () => {
    const client = newClient(true)
    const p = newPlatform(client)
    const ctl = new AbortController()
    const pending = p.renameGroup('feishu:oc_spawn', '新名', ctl.signal)
    ctl.abort()
    await expect(pending).rejects.toThrow()
    client.unblock()
  })

  it('renames normally with a live signal and without one', async () => {
    const client = newClient()
    const p = newPlatform(client)
    await p.renameGroup('feishu:oc_spawn', 'LLM 名', new AbortController().signal)
    await p.renameGroupAny('feishu:oc_any', '任意群', undefined)
    expect(client.renames).toEqual([
      { chatId: 'oc_spawn', name: 'LLM 名' },
      { chatId: 'oc_any', name: '任意群' },
    ])
  })

  it('renameGroup still skips non-spawned chats', async () => {
    const client = newClient()
    const p = newPlatform(client)
    await p.renameGroup('feishu:oc_other', '新名', new AbortController().signal)
    expect(client.renames).toHaveLength(0)
  })
})
