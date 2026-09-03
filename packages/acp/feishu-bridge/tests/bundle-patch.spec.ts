/**
 * Bundle-patch composition tests: applying dsh-base's patch list and then
 * this package's own bundle patch (the profile `dsh.profile.bundles` order)
 * must replace the generic plan-mode section — whose delegation sentence
 * names the native subagent tools this composition disables — with the
 * feishu_bridge_subtask-adapted guidance.
 *
 * @module dsh-feishu-bridge/tests-bundle-patch
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include'

const bridgeRoot = fileURLToPath(new URL('..', import.meta.url))

// The drift lockstep reads the sibling base bundle in-tree: the sync duty
// belongs to this package, so its gate fails inside this package's suite.
const basePatchFile = resolve(bridgeRoot, '../../bundle/base/cordis.patch.yml')
const bridgePatchFile = resolve(bridgeRoot, 'cordis.patch.yml')

function loadPatches(file: string): PatchOptions[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`patch file must parse to a patch list: ${file}`)
  return parsed as PatchOptions[]
}

function composeEntries(): { entries: ReturnType<typeof applyEntryPatches>; warnings: string[] } {
  const warnings: string[] = []
  const warn = (message: string): void => { warnings.push(message) }
  let entries: ReturnType<typeof applyEntryPatches> = []
  for (const file of [basePatchFile, bridgePatchFile]) {
    entries = applyEntryPatches(entries, loadPatches(file), warn)
  }
  return { entries, warnings }
}

function composePlanModeSection(patchFiles: string[]): { section: unknown; warnings: string[] } {
  const warnings: string[] = []
  const warn = (message: string): void => { warnings.push(message) }
  let entries: ReturnType<typeof applyEntryPatches> = []
  for (const file of patchFiles) {
    entries = applyEntryPatches(entries, loadPatches(file), warn)
  }
  const row = entries.find(entry => entry.id === 'plan-mode')
  // row.config is `any` from the parsed patch file (a file boundary): narrow
  // through a structural cast before reading.
  const config = row?.config as Record<string, unknown> | undefined
  return { section: config?.section, warnings }
}

/** Row lookup with the file-boundary config narrowed to a plain record. */
function findRow(entries: ReturnType<typeof applyEntryPatches>, id: string):
{ name?: string; disabled?: boolean | { __jsExpr?: string }; config?: Record<string, unknown> } | undefined {
  const row = entries.find(entry => entry.id === id)
  return row as { name?: string; disabled?: boolean | { __jsExpr?: string }; config?: Record<string, unknown> } | undefined
}

function asSectionText(section: unknown): string {
  expect(typeof section).toBe('string')
  return section as string
}

describe('bridge bundle patch', () => {
  it('overrides the dsh-base plan-mode section with the feishu_bridge_subtask-adapted guidance', () => {
    const { section, warnings } = composePlanModeSection([basePatchFile, bridgePatchFile])
    const text = asSectionText(section)
    expect(text).toContain('feishu_bridge_subtask spawns')
    expect(text).toContain('2–5 independent angles')
    expect(text).toContain('Keep exploration serial only for a single-focus question')
    expect(text).toContain('state the execution order — independent groups dispatched together as parallel subtask spawns when execution begins, serially dependent groups executed in order')
    // A rejection opens a discussion round: answer in the reply, end the turn,
    // re-present only on the user's request (2026-09 plan-rejection UX).
    expect(text).toContain('the feedback opens a discussion round')
    expect(text).toContain('end your turn without calling exit_plan_mode again')
    expect(text).toContain('only after the user asks for the updated plan')
    // The generic delegation sentence names native tools this composition disables.
    expect(text).not.toContain('background subagent delegations')
    expect(text).not.toContain('incorporate the feedback and present again')
    // An id-targeted patch that matches nothing is skipped with a warning: a
    // plan-mode warning here would mean the override never reached the row.
    expect(warnings.filter(message => message.includes('plan-mode'))).toEqual([])
  })

  it('mounts the ask-user and memory rows base does not ship', () => {
    const { entries, warnings } = composeEntries()
    const askUser = findRow(entries, 'tool-ask-user')
    expect(askUser?.config).toBeUndefined()
    expect(askUser?.disabled).not.toBe(true)
    const memory = findRow(entries, 'dsh-memory')
    expect(memory?.disabled).not.toBe(true)
    expect(memory?.config).toMatchObject({ maxIndexBytes: 25600, global: { maxIndexBytes: 8192 } })
    expect(warnings.filter(message => message.includes('ask-user') || message.includes('dsh-memory'))).toEqual([])
  })

  it('mounts the agent-instruction-suppression registry base does not ship', () => {
    const { entries, warnings } = composeEntries()
    const suppression = findRow(entries, 'agent-instruction-suppression')
    // Bare-persona and complete-prompt sessions suppress workspace-instruction
    // injection through this registry; an id-targeted patch entry can never
    // mount a row base does not define (it warns and is skipped).
    expect(suppression?.name).toBe('@deepseek-ai/dsh-agent-instructions/suppression')
    expect(suppression?.disabled).not.toBe(true)
    expect(warnings.filter(message => message.includes('agent-instruction-suppression'))).toEqual([])
  })

  it('curates the deployment tool roster: goal family, workflow, ralph, and the second editor stay disabled', () => {
    const { entries } = composeEntries()
    for (const id of [
      'goal', 'goal-round-driver', 'command-goal', 'tool-goal',
      'tool-workflow', 'workflow-worker-thread', 'tool-ralph',
      'tool-str-replace-editor',
    ]) {
      const row = findRow(entries, id)
      expect(row, `${id} must be mounted by dsh-base`).toBeDefined()
      expect(row?.disabled, `${id} must be disabled by the bundle patch`).toBe(true)
    }
  })

  it('suppresses harness identity and pins the CLAUDE.md instruction candidates', () => {
    const { entries } = composeEntries()
    const systemPrompt = findRow(entries, 'system-prompt')
    expect(systemPrompt?.config).toEqual({ includeHarnessIdentity: false, persona: '' })
    const instructions = findRow(entries, 'agent-instructions')
    expect(instructions?.config).toEqual({
      maxBytes: 65536,
      instructionFileCandidates: ['CLAUDE.md'],
      localInstructionFileCandidates: ['CLAUDE.local.md'],
    })
  })

  it('keeps the section in lockstep with dsh-base modulo the one delegation sentence', () => {
    const base = asSectionText(composePlanModeSection([basePatchFile]).section)
    const bridge = asSectionText(composePlanModeSection([basePatchFile, bridgePatchFile]).section)
    // Guard the adaptation source: when dsh-base rewords its delegation
    // sentence, this assertion fails first with a pointer at the base text.
    expect(base).toContain('start them together as background subagent delegations in one assistant message, each with a focused, self-contained prompt')
    expect(base).not.toContain('feishu_bridge_subtask')
    const adapted = base.replace(
      'start them together as background subagent delegations in one assistant message, each with a focused, self-contained prompt',
      'dispatch them together as feishu_bridge_subtask spawns in one assistant message, each with a focused, self-contained brief',
    )
    expect(bridge).toBe(adapted)
  })
})
