/**
 * Restart pending-inbox visibility (engine logic): a daemon restart leaves
 * queued inbox input durable but unobserved — chats whose persisted session
 * still holds pending messages get a one-time notice at platforms-ready.
 * Visibility only; nothing is auto-woken.
 *
 * @module dsh-feishu-bridge/tests-engine-restart-pending-notice
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { createStubCardPlatformFull, newResultAgentSession } from '../stubs/engine-stubs.ts'
import type { Agent, EngineInboxReader } from '../../src/core/types.ts'

function stubAgent(): Agent {
  const session = newResultAgentSession('unused')
  return {
    name: () => 'stub',
    startSession: async () => session,
    listSessions: async () => [],
    stop: async () => {},
  }
}

function cardBody(card: unknown): string {
  const first: unknown = Array.isArray(card) ? card[0] : card
  if (first !== null && typeof first === 'object' && 'content' in first) {
    const content = (first as { content?: unknown }).content
    if (typeof content === 'string') return content
  }
  return JSON.stringify(card)
}

describe('restart pending-inbox visibility', () => {
  it('notifies chats whose persisted session holds pending input, and only those', async () => {
    const p = createStubCardPlatformFull('discord')
    const store = join(mkdtempSync(join(tmpdir(), 'fb-pending-')), 'sessions.json')
    const reader: EngineInboxReader = {
      pendingCount: async sessionId => sessionId === 'agent-sid-1' ? 2 : 0,
    }
    const e = new Engine('test', stubAgent(), [p], store, 'en', undefined, undefined, reader)
    e.sessions.getOrCreateActive('discord:c:u1')
    e.sessions.switchToAgentSession('discord:c:u1', 'agent-sid-1', 'dsh', 'summary')
    e.sessions.getOrCreateActive('discord:c:u2')
    e.sessions.switchToAgentSession('discord:c:u2', 'agent-sid-2', 'dsh', 'other')

    await e.start()
    await vi.waitFor(() => { expect(p.sentCards).toHaveLength(1) })
    expect(cardBody(p.sentCards[0])).toContain('left 2 undelivered')
    expect(cardBody(p.sentCards[0])).not.toContain('agent-sid-2')
  }, 15_000)

  it('skips relay and cron side sessions and stays silent without a reader', async () => {
    const p = createStubCardPlatformFull('discord')
    const store = join(mkdtempSync(join(tmpdir(), 'fb-pending-')), 'sessions.json')
    const reader: EngineInboxReader = {
      pendingCount: async () => 1,
    }
    const e = new Engine('test', stubAgent(), [p], store, 'en', undefined, undefined, reader)
    e.sessions.getOrCreateActive('relay:proj:chat')
    e.sessions.switchToAgentSession('relay:proj:chat', 'agent-relay', 'dsh', 'relay')
    e.sessions.getOrCreateActive('discord:c:u1#cron-job-1')
    e.sessions.switchToAgentSession('discord:c:u1#cron-job-1', 'agent-cron', 'dsh', 'cron')

    await e.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(p.sentCards).toHaveLength(0)

    // And an engine without a reader wired simply skips the report.
    const p2 = createStubCardPlatformFull('discord')
    const e2 = new Engine('test', stubAgent(), [p2], store, 'en')
    e2.sessions.getOrCreateActive('discord:c:u3')
    e2.sessions.switchToAgentSession('discord:c:u3', 'agent-sid-3', 'dsh', 'plain')
    await e2.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(p2.sentCards).toHaveLength(0)
  }, 15_000)
})
