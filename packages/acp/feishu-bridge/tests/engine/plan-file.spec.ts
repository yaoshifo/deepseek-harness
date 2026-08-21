/**
 * Plan-file persistence tests: ExitPlanMode presentation writes the full
 * plan to the configured plans directory, Claude-Code-aligned —
 * `<cwd-slug>-<title-slug>.md`, timestamp suffix when the name is taken by
 * different content, skip when identical, disabled by planDir '', and the
 * model-written plan file always wins untouched.
 *
 * @module dsh-feishu-bridge/tests-engine-plan-file
 */

import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { savePlanFile } from '../../src/engine/plan-file.js'
import {
  createStubAgent,
  createStubPlatform,
  newControllableSession,
} from '../stubs/engine-stubs.js'

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

/** Drive one turn's events through the engine loop (plan-render-fork pattern). */
async function driveLoop(e: Engine, state: InteractiveState, sessionKey: string, events: Array<Record<string, unknown>>): Promise<void> {
  const session = e.sessions.getOrCreateActive(sessionKey)
  const agentSession = newControllableSession('s1')
  state.agentSession = agentSession
  e.interactiveStates.set(sessionKey, state)
  for (const ev of events) agentSession.channel.push(ev as never)
  const loopDone = e.processInteractiveEvents(state, session, e.sessions, sessionKey, 'm1', undefined, state.replyCtx)
  // The permission card parks the turn; resolve it and end the turn.
  await pollUntil(() => state.pending !== undefined, 2000)
  state.pending?.resolve()
  agentSession.channel.push({ type: 'result', content: '', done: true })
  await loopDone
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

    await driveLoop(e, state, 'slack:C1:U1', [
      { type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false },
    ])

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

    await driveLoop(e, state, 'slack:C1:U1', [
      { type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false },
    ])

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

    await driveLoop(e, state, 'slack:C1:U1', [
      { type: 'tool_use', content: '', toolName: 'Write', toolInputRaw: { file_path: modelFile, content: '由模型写入' }, requestID: 'w1', done: false },
      { type: 'tool_result', content: '', toolName: 'Write', requestID: 'w1', done: true },
      { type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false },
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

    await driveLoop(e, state, 'slack:C1:U1', [
      { type: 'permission_request', content: '', toolName: 'ExitPlanMode', toolInputRaw: { plan: planBody }, requestID: 'r1', done: false },
    ])

    expect(p.getSent().join('\n')).toContain(planBody)
  })
})
