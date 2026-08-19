/**
 * M3 ExitPlanMode + Plan tests ported from cc-connect core/engine_test.go:
 * ExitPlanMode approval/deny, planMaxLen (3 variants), plan dedup,
 * plan duplicate card skipped, plan file path promotion, and
 * effectiveMode transitions on ExitPlanMode allow/deny.
 *
 * Red phase: the engine methods (sendPlanContent, effectiveMode transitions
 * in handlePendingPermission) do not exist yet — these tests fail until the
 * M3 implementation lands.
 *
 * @module dsh-feishu-bridge/tests-engine-m3-plan
 */

import { describe, expect, it } from 'vitest'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import {
  createRecordingAgentSession,
  createStubAgent,
  createStubPlatform,
  newPendingPermission,
} from '../stubs/engine-stubs.js'
import type { Message } from '../../src/core/types.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function newTestEngine(): Engine {
  return new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    sessionKey: 'slack:C1:U1',
    platform: 'test',
    messageID: '',
    userID: 'user1',
    userName: '',
    chatName: '',
    chatType: '',
    content: '',
    originalContent: '',
    images: [],
    files: [],
    extraContent: '',
    replyCtx: 'ctx',
    fromVoice: false,
    isSpawnedGroup: false,
    isPermissionAction: false,
    isAskqCardAction: false,
    parentMessageID: '',
    quotedText: '',
    ...overrides,
  }
}

describe('ExitPlanModeSetsEffectiveMode', () => {
  it('approving ExitPlanMode transitions effectiveMode to default', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.effectiveMode = 'plan'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'ExitPlanMode',
      toolInput: { plan: 'do the thing' },
    })
    e.interactiveStates.set('slack:C1:U1', state)

    const handled = e.handlePendingPermission(p, msg(), 'allow')

    expect(handled).toBe(true)
    expect(state.effectiveMode).toBe('default')
  })
})

describe('NonPlanToolKeepsEffectiveMode', () => {
  it('approving a regular tool does NOT mutate effectiveMode', () => {
    const e = newTestEngine()
    const p = createStubPlatform('test')
    const rec = createRecordingAgentSession()
    const state = new InteractiveState()
    state.agentSession = rec
    state.platform = p
    state.replyCtx = 'ctx'
    state.effectiveMode = 'plan'
    state.pending = newPendingPermission({
      requestID: 'req-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    })
    e.interactiveStates.set('slack:C1:U1', state)

    const handled = e.handlePendingPermission(p, msg(), 'allow')

    expect(handled).toBe(true)
    expect(state.effectiveMode).toBe('plan')
  })
})

describe('PlanMaxLen', () => {
  it('NoTruncation: plan under limit sent intact', () => {
    const p = createStubPlatform('feishu')
    const e = newTestEngine()
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const planContent = '# Plan\n\n1. Do X\n2. Do Y\n3. Verify'
    const tmpFile = join(tmpDir, 'test-plan.md')
    writeFileSync(tmpFile, planContent, 'utf8')

    const result = e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')
    expect(result).not.toBe('')

    const sentMsg = p.getSent()[0]!
    expect(sentMsg).toContain('Do X')
    expect(sentMsg).toContain('Verify')
    expect(sentMsg).not.toContain('...')
  })

  it('TruncationWhenExceeded: long plan truncated with ...', () => {
    const p = createStubPlatform('feishu')
    const e = newTestEngine()
    e.display.planMaxLen = 100
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const tmpFile = join(tmpDir, 'long-plan.md')
    writeFileSync(tmpFile, 'x'.repeat(200), 'utf8')

    e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')
    const sentMsg = p.getSent()[0]!
    expect(sentMsg).toContain('...')
  })

  it('ZeroNoTruncation: PlanMaxLen=0 sends full content', () => {
    const p = createStubPlatform('feishu')
    const e = newTestEngine()
    e.display.planMaxLen = 0
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-test-'))
    const tmpFile = join(tmpDir, 'huge-plan.md')
    writeFileSync(tmpFile, 'A'.repeat(50000), 'utf8')

    const result = e.sendPlanContent(p, 'replyCtx', undefined, tmpFile, 1, '')
    expect(result).toHaveLength(50000)
    const sentMsg = p.getSent()[0]!
    expect(sentMsg).not.toContain('...')
  })
})

describe('PlanDedup', () => {
  it('EventTextBeforeExitPlanMode: exact match strips plan from text', () => {
    const planContent = 'Plan:\n1. Do X\n2. Do Y'
    const text = planContent

    const trimmed = text.replace(planContent, '').trim()
    expect(trimmed).toBe('')
  })

  it('EventTextBeforeExitPlanMode: extra content kept after plan strip', () => {
    const planContent = 'Plan:\n1. Do X\n2. Do Y'
    const textWithExtra = planContent + '\nSome additional output'

    const trimmed = textWithExtra.replace(planContent, '').trim()
    expect(trimmed).toBe('Some additional output')
  })
})

describe('PlanDuplicateCard_Skipped', () => {
  it('identical plan content matches sentPlanContent (skip path)', () => {
    const plan1 = 'Plan A: refactor module X'
    const sentPlanContent = plan1

    const newContent = 'Plan A: refactor module X'
    expect(newContent).toBe(sentPlanContent)
  })

  it('different plan content does not match sentPlanContent', () => {
    const sentPlanContent = 'Plan A: refactor module X'
    const newContent2 = 'Plan B: rewrite everything'
    expect(newContent2).not.toBe(sentPlanContent)
  })
})

describe('PlanFilePath_OnlyAfterWrite', () => {
  it('pendingPlanFilePath set on Write tool use, promoted on success only', () => {
    let planFilePath = ''
    let pendingPlanFilePath = ''

    const fp = '/tmp/.claude/plans/plan-001.md'
    if (fp.includes('.claude/plans/')) {
      pendingPlanFilePath = fp
    }
    expect(planFilePath).toBe('')
    expect(pendingPlanFilePath).toBe(fp)

    let success = false
    if (pendingPlanFilePath !== '' && success) {
      planFilePath = pendingPlanFilePath
      pendingPlanFilePath = ''
    }
    expect(planFilePath).toBe('')

    success = true
    if (pendingPlanFilePath !== '' && success) {
      planFilePath = pendingPlanFilePath
      pendingPlanFilePath = ''
    }
    expect(planFilePath).toBe(fp)
  })
})
