/**
 * Subtask report cap (2026-09-16 plan): a child's report longer than
 * `subtask.reportMaxChars` (default 8192 code points) must not enter the
 * parent agent's context whole — the delivered text keeps the head (2/3) and
 * tail (1/3) of the budget, drops the middle, and ends with a notice line
 * naming the truncation and the full-text file path. The plan function is
 * pure: the caller assembles the notice (it owns the path) and the function
 * only splits and joins, so code-point safety and budget arithmetic are
 * unit-testable here. Engine-level delivery behavior (the wiring of the cap
 * into deliverParentReply, with disk spill) is covered by the second suite
 * below.
 *
 * @module dsh-feishu-bridge/tests-subtask-report-cap
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { ProjectStateStore } from '../../src/engine/project-state.ts'
import {
  DEFAULT_SUBTASK_REPORT_MAX_CHARS,
  MIN_SUBTASK_REPORT_MAX_CHARS,
  planSubtaskReportCap,
} from '../../src/engine/subtask-report-cap.ts'
import { createStubAgent, createStubCardPlatformFull, newControllableSession, type RecordedCard } from '../stubs/engine-stubs.ts'

/** Code points of `text` (the cap's counting unit — emoji count as 1). */
function runes(text: string): number {
  return Array.from(text).length
}

describe('planSubtaskReportCap (pure split/join)', () => {
  it('exposes the planned default and minimum cap constants', () => {
    expect(DEFAULT_SUBTASK_REPORT_MAX_CHARS).toBe(8192)
    expect(MIN_SUBTASK_REPORT_MAX_CHARS).toBe(1024)
  })

  it('returns null for a report within the cap — boundary: exactly cap code points', () => {
    const raw = 'x'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
    expect(planSubtaskReportCap(raw, DEFAULT_SUBTASK_REPORT_MAX_CHARS, '（说明）')).toBeNull()
  })

  it('caps an oversized report into head 2/3 + tail 1/3 + notice, total within cap', () => {
    const raw = 'a'.repeat(100)
    // Budget: cap 20 − notice 1 rune − '\n\n' join 2 − mid marker '\n…\n' 3 = 14;
    // head = ceil(14 × 2/3) = 10, tail = 4.
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(planned).not.toBeNull()
    const delivered = planned!.delivered
    expect(runes(delivered)).toBeLessThanOrEqual(20)
    expect(delivered).toContain('a'.repeat(10))
    expect(delivered).toContain('a'.repeat(4))
    expect(delivered.endsWith('\n\nN')).toBe(true)
    expect(planned!.omitted).toBe(100 - 14)
  })

  it('keeps the raw report\'s head and tail: head is a prefix, tail is a suffix', () => {
    const raw = 'HEAD-'.repeat(10) + 'MIDDLE-'.repeat(40) + '-TAIL'
    // head budget 10 → the first 10 runes ('HEAD-HEAD-'); tail budget 4 → the
    // last 4 runes ('TAIL' — the dash stays dropped in the middle).
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(planned!.delivered).toBe('HEAD-HEAD-\n…\nTAIL\n\nN')
  })

  it('counts code points, never splitting a surrogate pair', () => {
    const raw = '😀'.repeat(60) // 60 code points, 120 UTF-16 units
    const planned = planSubtaskReportCap(raw, 20, 'N')
    expect(runes(planned!.delivered)).toBeLessThanOrEqual(20)
    // Every retained rune is a complete emoji — no lone surrogates.
    for (const ch of planned!.delivered) {
      expect(ch).not.toMatch(/^[\uD800-\uDFFF]$/)
    }
    expect(planned!.delivered).toContain('😀😀😀😀')
  })

  it('degrades to notice-only when the notice alone eats the budget', () => {
    const planned = planSubtaskReportCap('x'.repeat(500), 10, 'N'.repeat(9))
    expect(planned!.delivered).toBe('N'.repeat(9))
    expect(planned!.omitted).toBe(500)
  })
})

// ── engine delivery wiring: deliverParentReply caps before anything reads ──

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

/**
 * The report body inside a wake message, with the engine's wrapper lines
 * (completion header, follow-up hint) stripped so the cap can be asserted on
 * the report text alone.
 */
function wakeReportBody(wakeContent: string, label: string, childKey: string): string {
  const prefix = `[子任务完成] ${label}:\n\n`
  const suffix = `\n\n(如需追问该子任务: feishu_bridge_subtask 工具 action: send, child: ${childKey})`
  expect(wakeContent.startsWith(prefix), `wake=${wakeContent.slice(0, 60)}…`).toBe(true)
  expect(wakeContent.endsWith(suffix)).toBe(true)
  return wakeContent.slice(prefix.length, wakeContent.length - suffix.length)
}

/** The single file inside a spill directory, failing loudly when it is not exactly one. */
function onlySpillFile(dir: string): string {
  const files = readdirSync(dir)
  expect(files, `spill files=${files.join(',')}`).toHaveLength(1)
  return join(dir, files[0]!)
}

describe('deliverParentReply report cap (engine wiring)', () => {
  it('delivers an oversized group report capped, spilling the full text and naming the file in wake and card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-cap-spill-'))
    try {
      const p = createStubCardPlatformFull('test')
      const e = new Engine('test', createStubAgent(), [p], join(dir, 'sessions.json'), 'en')
      const parentKey = 'test:parent-chat:user-1'
      const childKey = 'test:child-chat'
      const child = linkedChild(e, parentKey, childKey)
      const raw = 'HEAD-START\n' + '中段内容。'.repeat(2200) + '\nTAIL-END'

      const wake = vi.spyOn(e, 'deliverMachineMessage')
      expect(e.replyToParent(p, child, raw)).toBe(true)
      await settle()

      expect(wake).toHaveBeenCalledTimes(1)
      const wakeContent = wake.mock.calls[0]![1].content
      const body = wakeReportBody(wakeContent, 'render child', childKey)
      expect(runes(body)).toBeLessThanOrEqual(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
      expect(body).toContain('HEAD-START')
      expect(body).toContain('TAIL-END')

      const spillDir = join(dir, 'subtask-reports')
      const file = onlySpillFile(spillDir)
      const sha12 = createHash('sha256').update(childKey).digest('hex').slice(0, 12)
      expect(file.startsWith(join(spillDir, `report-${sha12}-`))).toBe(true)
      expect(file.endsWith('.md')).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(raw)
      expect(wakeContent).toContain(file)
      expect(cardBody(p.sentCards[0])).toContain(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delivers a report of exactly cap code points verbatim and spills nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-cap-exact-'))
    try {
      const p = createStubCardPlatformFull('test')
      const e = new Engine('test', createStubAgent(), [p], join(dir, 'sessions.json'), 'en')
      const parentKey = 'test:parent-chat:user-1'
      const childKey = 'test:child-chat'
      const child = linkedChild(e, parentKey, childKey)
      const raw = 'x'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS)

      const wake = vi.spyOn(e, 'deliverMachineMessage')
      expect(e.replyToParent(p, child, raw)).toBe(true)
      await settle()

      // Boundary: exactly at the cap the report is delivered whole.
      expect(wake.mock.calls[0]![1].content).toContain(raw)
      expect(existsSync(join(dir, 'subtask-reports'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caps a report one code point over the cap and spills the full text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-cap-over-'))
    try {
      const p = createStubCardPlatformFull('test')
      const e = new Engine('test', createStubAgent(), [p], join(dir, 'sessions.json'), 'en')
      const parentKey = 'test:parent-chat:user-1'
      const childKey = 'test:child-chat'
      const child = linkedChild(e, parentKey, childKey)
      const raw = 'A'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS - 40) + 'B'.repeat(41)

      const wake = vi.spyOn(e, 'deliverMachineMessage')
      expect(e.replyToParent(p, child, raw)).toBe(true)
      await settle()

      const body = wakeReportBody(wake.mock.calls[0]![1].content, 'render child', childKey)
      expect(runes(body)).toBeLessThanOrEqual(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
      expect(body).not.toContain(raw)
      expect(readFileSync(onlySpillFile(join(dir, 'subtask-reports')), 'utf8')).toBe(raw)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades to the not-saved notice when no session store is configured', async () => {
    const p = createStubCardPlatformFull('test')
    const e = new Engine('test', createStubAgent(), [p], '', 'en')
    const parentKey = 'test:parent-chat:user-1'
    const childKey = 'test:child-chat'
    const child = linkedChild(e, parentKey, childKey)
    const raw = 'y'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS + 500)

    const wake = vi.spyOn(e, 'deliverMachineMessage')
    expect(e.replyToParent(p, child, raw)).toBe(true)
    await settle()

    // No spill: the wake still lands, carries the not-saved wording with the
    // follow-up guidance, and never names a file that was not written.
    expect(wake).toHaveBeenCalledTimes(1)
    const wakeContent = wake.mock.calls[0]![1].content
    const body = wakeReportBody(wakeContent, 'render child', childKey)
    expect(runes(body)).toBeLessThanOrEqual(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
    expect(wakeContent).toContain('could not be saved')
    expect(wakeContent).toContain('feishu_bridge_subtask action: send')
    expect(wakeContent).not.toContain('subtask-reports')
    expect(wakeContent).not.toContain('.md')
  })

  it('caps and spills a native child report the same way', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-cap-native-'))
    try {
      const p = createStubCardPlatformFull('test')
      const e = new Engine('test', createStubAgent(), [p], join(dir, 'sessions.json'), 'en')
      e.setProjectStateStore(new ProjectStateStore(''))
      const parentKey = 'test:parent-chat:u1'
      e.sessions.getOrCreateActive(parentKey)
      const state = new InteractiveState()
      state.agentSession = newControllableSession('parent-native-1')
      state.platform = p
      state.replyCtx = 'parent-rctx'
      e.interactiveStates.set(parentKey, state)
      e.projectState?.setNativeChild('native-child-1', {
        parent_key: parentKey,
        parent_agent_session_id: 'parent-native-1',
        label: 'render the summary',
        worktree_path: '', worktree_branch: '', worktree_base: '', worktree_base_branch: '', worktree_root: '',
        reported: false,
      })
      const raw = 'N-HEAD\n' + '正文内容'.repeat(2400) + '\nN-TAIL'

      const wake = vi.spyOn(e, 'deliverMachineMessage')
      await e.reportNativeChild('native-child-1', raw)
      await settle()

      expect(wake).toHaveBeenCalledTimes(1)
      const wakeContent = wake.mock.calls[0]![1].content
      const body = wakeReportBody(wakeContent, 'render the summary', 'native-child-1')
      expect(runes(body)).toBeLessThanOrEqual(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
      expect(body).toContain('N-HEAD')
      expect(body).toContain('N-TAIL')
      const file = onlySpillFile(join(dir, 'subtask-reports'))
      expect(readFileSync(file, 'utf8')).toBe(raw)
      expect(wakeContent).toContain(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never splits a surrogate pair when capping an emoji-heavy report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-cap-emoji-'))
    try {
      const p = createStubCardPlatformFull('test')
      const e = new Engine('test', createStubAgent(), [p], join(dir, 'sessions.json'), 'en')
      const parentKey = 'test:parent-chat:user-1'
      const childKey = 'test:child-chat'
      const child = linkedChild(e, parentKey, childKey)
      const raw = '😀'.repeat(DEFAULT_SUBTASK_REPORT_MAX_CHARS + 200)

      const wake = vi.spyOn(e, 'deliverMachineMessage')
      expect(e.replyToParent(p, child, raw)).toBe(true)
      await settle()

      const body = wakeReportBody(wake.mock.calls[0]![1].content, 'render child', childKey)
      expect(runes(body)).toBeLessThanOrEqual(DEFAULT_SUBTASK_REPORT_MAX_CHARS)
      for (const ch of body) {
        expect(ch).not.toMatch(/^[\uD800-\uDFFF]$/)
      }
      expect(readFileSync(onlySpillFile(join(dir, 'subtask-reports')), 'utf8')).toBe(raw)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
