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
    expect(text).toContain('mark which groups are independent enough to implement in parallel')
    // The generic delegation sentence names native tools this composition disables.
    expect(text).not.toContain('background subagent delegations')
    // An id-targeted patch that matches nothing is skipped with a warning: a
    // plan-mode warning here would mean the override never reached the row.
    expect(warnings.filter(message => message.includes('plan-mode'))).toEqual([])
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
