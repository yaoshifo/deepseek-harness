/**
 * Plan-file persistence tests: ExitPlanMode presentation writes the full
 * plan to the configured plans directory, Claude-Code-aligned —
 * `<cwd-slug>-<title-slug>.md`, timestamp suffix when the name is taken by
 * different content, skip when identical, disabled by planDir '', and the
 * model-written plan file always wins untouched. The plan card header is the
 * localized version identifier, not a file-name derivation.
 *
 * @module dsh-feishu-bridge/tests-engine-plan-file
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Card } from '../../src/card.ts'
import { Engine, InteractiveState } from '../../src/engine/engine.ts'
import { savePlanFile } from '../../src/engine/plan-file.ts'
import {
  createStubAgent,
  createStubCardPlatform,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

/** Stub agent reporting a fixed work dir (the adapter's getWorkDir role). */
function agentWithWorkDir(wd: string): ReturnType<typeof createStubAgent> {
  return Object.assign(createStubAgent(), { getWorkDir: () => wd })
}

/** Run one turn's events through the engine loop, then drive a plan-review ask (B2 delegate). */
async function drivePlanReview(
  e: Engine, state: InteractiveState, sessionKey: string,
  events: Array<Record<string, unknown>>, plan = planBody,
): Promise<void> {
  const session = e.sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('s1')
  state.agentSession = agentSession
  e.interactiveStates.set(sessionKey, state)
  for (const ev of events) agentSession.channel.push(ev as never)
  agentSession.channel.push({ type: 'result', content: '', done: true })
  await e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
  const decision = e.askUser(sessionKey, { kind: 'plan-review', heading: plan.split('\n')[0] ?? plan, plan })
  await pollUntil(() => state.pendingAsk !== undefined, 2000)
  state.pendingAsk?.resolve({ outcome: 'allowed-once' })
  await decision
}

// ── savePlanFile helper ─────────────────────────────────────────────────────

describe('savePlanFile', () => {
  it('names the file <cwd-slug>-<title-slug>.md and writes the full content', () => {
    const dir = tempDir('plan-file-')
    const content = '# 重构登录流程\n\n1. 拆模块\n2. 接入'

    const path = savePlanFile(dir, '/Users/t/Proj A', content)

    expect(path).toBe(join(dir, 'users-t-proj-a-重构登录流程.md'))
    expect(readFileSync(path, 'utf8')).toBe(`${content}\n`)
  })

  it('creates missing directories', () => {
    const dir = join(tempDir('plan-file-'), 'nested', 'plans')

    const path = savePlanFile(dir, '/w', '# T')

    expect(existsSync(path)).toBe(true)
  })

  it('appends -YYYYMMDD-HHMMSS when the name is taken by different content', () => {
    const dir = tempDir('plan-file-')
    const existing = join(dir, 'users-t-proj-a-重构登录流程.md')
    writeFileSync(existing, '# older revision\n', 'utf8')

    const path = savePlanFile(dir, '/Users/t/Proj A', '# 重构登录流程\n\nrev2', new Date(2026, 7, 21, 14, 30, 15))

    expect(path).toBe(join(dir, 'users-t-proj-a-重构登录流程-20260821-143015.md'))
    expect(readFileSync(path, 'utf8')).toBe('# 重构登录流程\n\nrev2\n')
    expect(readFileSync(existing, 'utf8')).toBe('# older revision\n')
  })

  it('keeps the existing file when the content is identical', () => {
    const dir = tempDir('plan-file-')
    const existing = join(dir, 'users-t-proj-a-T.md')
    writeFileSync(existing, '# T\nbody\n', 'utf8')

    const path = savePlanFile(dir, '/Users/t/Proj A', '# T\nbody')

    expect(path).toBe(existing)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('falls back to the plan slug when the content has no heading', () => {
    const dir = tempDir('plan-file-')

    const path = savePlanFile(dir, '/w', 'no heading here')

    expect(path).toBe(join(dir, 'w-plan.md'))
  })
})

// ── engine event-loop integration ───────────────────────────────────────────

const planBody = '# 计划标题\n\n步骤一：封装\n步骤二：接入'

describe('processInteractiveEvents plan persistence', () => {
  it('ExitPlanModePersistsInlinePlan: presentation writes the full plan to planDir', async () => {
    const plansDir = tempDir('plan-file-')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [createStubPlatform('test')], '', 'en')
    e.planDir = plansDir
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'

    await drivePlanReview(e, state, 'slack:C1:U1', [])

    const expected = join(plansDir, 'users-t-proj-a-计划标题.md')
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected, 'utf8')).toBe(`${planBody}\n`)
    expect(p.getSent().join('\n')).toContain('步骤一：封装')
  })

  it('PlanDirEmptySkipsPersist: no file is written and the inline card is sent', async () => {
    const plansDir = tempDir('plan-file-')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [createStubPlatform('test')], '', 'en')
    e.planDir = ''
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'

    await drivePlanReview(e, state, 'slack:C1:U1', [])

    expect(readdirSync(plansDir)).toHaveLength(0)
    expect(p.getSent().join('\n')).toContain(planBody)
  })

  it('ModelWrittenPlanFileWins: a Write into .claude/plans is never overwritten', async () => {
    const root = tempDir('plan-file-')
    const modelDir = join(root, '.claude', 'plans')
    mkdirSync(modelDir, { recursive: true })
    const modelFile = join(modelDir, 'model-plan.md')
    writeFileSync(modelFile, '# model plan\n由模型写入', 'utf8')

    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [createStubPlatform('test')], '', 'en')
    e.planDir = modelDir
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'

    await drivePlanReview(e, state, 'slack:C1:U1', [
      { type: 'tool_use', content: '', toolName: 'write', toolID: 'w1', toolInputRaw: { file_path: modelFile, content: '由模型写入' }, done: false },
      { type: 'tool_result', content: '', toolID: 'w1', done: false },
    ])

    expect(readFileSync(modelFile, 'utf8')).toBe('# model plan\n由模型写入')
    expect(p.getSent().join('\n')).toContain('model plan')
  })

  it('WriteFailureFallsBackInline: an unwritable planDir sends the inline card without throwing', async () => {
    const blocker = join(tempDir('plan-file-'), 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [createStubPlatform('test')], '', 'en')
    e.planDir = join(blocker, 'sub', 'plans')
    const p = createStubPlatform('test')
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx'

    await drivePlanReview(e, state, 'slack:C1:U1', [])

    expect(p.getSent().join('\n')).toContain(planBody)
  })
})

// ── plan card title derivation ──────────────────────────────────────────────

describe('plan card title', () => {
  it('sendPlanContent titles the first plan card with the localized bare Plan header', async () => {
    const dir = tempDir('plan-file-')
    const path = savePlanFile(dir, '/Users/t/Proj A', planBody)
    const p = createStubCardPlatform('feishu')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [p], '', 'en')

    await e.sendPlanContent(p, 'ctx', undefined, path, 1, 'plan:1')

    expect(p.sentCards).toHaveLength(1)
    expect((p.sentCards[0] as Card).header?.title).toBe('Plan')
  })

  it('sendPlanContent titles a revised plan card with the localized version header', async () => {
    const dir = tempDir('plan-file-')
    const path = savePlanFile(dir, '/Users/t/Proj A', planBody)
    const p = createStubCardPlatform('feishu')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [p], '', 'zh')

    await e.sendPlanContent(p, 'ctx', undefined, path, 2, 'plan:2')

    expect(p.sentCards).toHaveLength(1)
    expect((p.sentCards[0] as Card).header?.title).toBe('计划 (v2)')
  })

  it('sendInlinePlanContent titles the card like the file-backed path', async () => {
    const p = createStubCardPlatform('feishu')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [p], '', 'en')

    await e.sendInlinePlanContent(p, 'ctx', undefined, planBody, 1, 'plan:1')

    expect(p.sentCards).toHaveLength(1)
    expect((p.sentCards[0] as Card).header?.title).toBe('Plan')
  })

  it('sendInlinePlanContent titles a revised card with the version header', async () => {
    const p = createStubCardPlatform('feishu')
    const e = new Engine('test', agentWithWorkDir('/Users/t/Proj A'), [p], '', 'en')

    await e.sendInlinePlanContent(p, 'ctx', undefined, planBody, 2, 'plan:2')

    expect(p.sentCards).toHaveLength(1)
    expect((p.sentCards[0] as Card).header?.title).toBe('Plan (v2)')
  })
})
