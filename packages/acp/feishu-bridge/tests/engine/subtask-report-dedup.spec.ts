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
  it('the engine wires its noteAgentDirectMessage seam onto agents exposing the observation capability', () => {
    const p = createStubCardPlatformFull('test')
    const registered: Array<(parentSessionKey: string, fromKey: string, content: string) => void> = []
    const agent = Object.assign(createStubAgent(), {
      registerAgentDirectMessageNotifier(fn: (parentSessionKey: string, fromKey: string, content: string) => void): void {
        registered.push(fn)
      },
    })
    const e = new Engine('test', agent, [p], '', 'en')

    expect(registered).toHaveLength(1)
    // The registered callback routes into the engine seam: a recorded
    // direct message lands on the parent session.
    const parentKey = 'test:parent-chat:user-1'
    e.sessions.getOrCreateActive(parentKey)
    registered[0]!(parentKey, 'test:child-chat', FULL)
    expect(e.sessions.findActive(parentKey)?.lastAgentDirectMessage?.fromKey).toBe('test:child-chat')
  })

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

  it('a gather summary banks a one-line status for a child that already sent the same text directly', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    const childA = linkedChild(e, parentKey, 'test:child-a')
    childA.setName('child A')
    childA.setSubtaskDepth(1)
    const childB = linkedChild(e, parentKey, 'test:child-b')
    childB.setName('child B')
    childB.setSubtaskDepth(1)

    // Child A already woke the parent directly with the same body; the
    // gather barrier then banks both children's reports into one summary.
    e.noteAgentDirectMessage(parentKey, 'test:child-a', FULL)
    e.gatherSubtasks(parentKey)

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, childA, FULL)).toBe(true)
    await settle()
    expect(e.replyToParent(p, childB, 'child B finished its own work')).toBe(true)
    await settle()

    const summary = wake.mock.calls.at(-1)![1].content
    expect(wake, 'only the completed gather wakes the parent').toHaveBeenCalledTimes(1)
    expect(summary, `summary=${summary}`).toContain('child B finished its own work')
    expect(summary, `summary=${summary}`).toContain('内容与刚才的直发消息相同')
    expect(summary, `summary=${summary}`).not.toContain('细节行')
  })

  it('an oversized report still degrades to the one-line status against a prior identical direct send', async () => {
    const p = createStubCardPlatformFull('test')
    const e = newTestEngine(p)
    const parentKey = 'test:parent-chat:user-1'
    const child = linkedChild(e, parentKey, 'test:child-chat')
    const huge = '汇报正文。'.repeat(2200) // 11000 code points, over the report cap

    // The child already woke the parent directly with the same oversized
    // body; the dedup decision must hash the raw report, not the capped
    // delivery, or the wake would re-inject the (truncated) body.
    e.noteAgentDirectMessage(parentKey, 'test:child-chat', huge)

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, child, huge)).toBe(true)
    await settle()

    expect(wake).toHaveBeenCalledTimes(1)
    const wakeContent = wake.mock.calls[0]![1].content
    expect(wakeContent).toContain('与刚才的直发消息相同')
    expect(wakeContent).not.toContain('汇报正文。'.repeat(300))
  })
})
