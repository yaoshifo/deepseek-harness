/**
 * Subtask report dedup (2026-09-13 chatroom postmortem): a child that first
 * woke its parent with send_message carrying the full result, then reported
 * the same text through reportSubtask → replyToParent, made the parent model
 * read the same body twice. The engine records the last agent-message a
 * source delivered straight into the parent (noteAgentDirectMessage — the
 * seam the runtime agent-message projection feeds) and swaps the injected
 * wake for a one-line status when the report is verbatim identical; the
 * parent-facing card keeps the full text either way.
 *
 * @module dsh-feishu-bridge/tests-subtask-report-dedup
 */

import { describe, expect, it, vi } from 'vitest'
import { Engine } from '../../src/engine/engine.ts'
import { createStubAgent, createStubCardPlatformFull, type RecordedCard } from '../stubs/engine-stubs.ts'
import type { Platform } from '../../src/core/types.ts'

function newTestEngine(p: Platform): Engine {
  return new Engine('test', createStubAgent(), [p], '', 'en')
}

/** The markdown body of a recorded card. */
function cardBody(card: unknown): string {
  const c = card as RecordedCard
  const first = c.elements[0]
  return first?.kind === 'markdown' ? (first.content ?? '') : ''
}

/** Parent + linked child sessions; returns the child. */
function linkedChild(e: Engine, parentKey: string, childKey: string) {
  e.sessions.getOrCreateActive(parentKey)
  const child = e.sessions.getOrCreateActive(childKey)
  child.setName('render child')
  child.setParentSessionKey(parentKey)
  return child
}

/** One macrotask tick: flushes the fire-and-forget delivery chain. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

const FULL = '修复完成：4 项改动，全部测试通过。' + '细节行。'.repeat(40)

describe('subtask report dedup against a prior direct send_message', () => {
  it('a verbatim-identical report injects the short status while the card keeps the full text', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    const child = linkedChild(e, parentKey, 'test:child-chat')

    // The child already woke the parent directly with the same body.
    e.noteAgentDirectMessage(parentKey, 'test:child-chat', FULL)

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, child, FULL)).toBe(true)
    await settle()

    // The parent-facing card carries the full report.
    expect(p.sentCards).toHaveLength(1)
    expect(cardBody(p.sentCards[0])).toContain('修复完成')
    // The injected wake is the one-line status, not the body again — but it
    // keeps the follow-up hint so the parent can still send to the child.
    expect(wake).toHaveBeenCalledTimes(1)
    const wakeContent = wake.mock.calls[0]![1].content
    expect(wakeContent).toContain('与刚才的直发消息相同')
    expect(wakeContent).not.toContain('细节行')
    expect(wakeContent).toContain('test:child-chat')
  })

  it('a report whose body differs from the direct message injects the full text', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    const child = linkedChild(e, parentKey, 'test:child-chat')

    e.noteAgentDirectMessage(parentKey, 'test:child-chat', '早先的中间汇报，内容不同')

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, child, FULL)).toBe(true)
    await settle()

    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0]![1].content).toContain('细节行')
    expect(cardBody(p.sentCards[0])).toContain('修复完成')
  })

  it('a direct message from a different source never suppresses this child\'s report', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    const child = linkedChild(e, parentKey, 'test:child-chat')

    // A sibling child sent the same body directly.
    e.noteAgentDirectMessage(parentKey, 'test:other-child', FULL)

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, child, FULL)).toBe(true)
    await settle()

    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake.mock.calls[0]![1].content).toContain('细节行')
  })

  it('the direct-message record survives on the parent session record for later reports', () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    e.sessions.getOrCreateActive(parentKey)

    e.noteAgentDirectMessage(parentKey, 'test:child-chat', '正文')

    const rec = e.sessions.findActive(parentKey)
    expect(rec?.lastAgentDirectMessage?.fromKey).toBe('test:child-chat')
    expect(rec?.lastAgentDirectMessage?.at).toBeGreaterThan(0)
  })
})
