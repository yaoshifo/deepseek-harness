/**
 * Running-state header GIF selection ported from cc-connect
 * platform/feishu/feishu_spinner.go (selection logic and asset-path
 * resolution; the GIF upload lives on the platform). thinking.gif is a
 * violet pulse ring (思考中); executing.gif a Material-style spinner
 * (执行中).
 *
 * @module dsh-feishu-bridge/feishu-spinner
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProgressCardEntry } from '../progress.ts'

/** Uploaded spinner image keys; enabled is false when both uploads failed. */
export interface SpinnerCfg {
  enabled: boolean
  /** Violet pulse ring — 思考中 / placeholder / latest thinking entry. */
  thinkingKey: string
  /** Material spinner — latest tool_use/tool_result entry. */
  executingKey: string
}

/** Spinner config with uploads disabled: no header icons, empty keys. */
export const noSpinner: SpinnerCfg = { enabled: false, thinkingKey: '', executingKey: '' }

/**
 * Resolve a spinner GIF asset path across run planes: the source tree
 * (this module at src/feishu/ → package-root assets/), the tsdown bundle
 * (inlined into lib/index.js → package-root assets/), or an assets/
 * directory copied next to the built module. First existing candidate
 * wins; undefined when none holds the asset.
 *
 * @param name Asset file name, e.g. `thinking.gif`.
 * @param moduleDir Directory of the resolving module (defaults to this
 *   module's own location; tests inject a bundled-layout directory).
 * @returns The first existing candidate path, or undefined.
 */
export function resolveSpinnerAsset(name: string, moduleDir = dirname(fileURLToPath(import.meta.url))): string | undefined {
  for (const dir of [join(moduleDir, '../../assets'), join(moduleDir, '../assets'), join(moduleDir, 'assets')]) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Header-icon key for a text-path progress card: "thinking" → thinkingKey,
 * "" / "running" / "waiting" → executingKey, terminal and settled states →
 * none. An empty chosen key falls back to the other so one failed upload
 * doesn't suppress the icon.
 * @param spin - Uploaded spinner keys.
 * @param state - Progress state ('thinking', 'running', '', 'waiting',
 *   'completed', 'failed', or one of the four settled parked-ask states).
 * @returns The image key for the header icon, or '' when disabled or terminal.
 */
export function spinnerKeyForState(spin: SpinnerCfg, state: string): string {
  if (!spin.enabled) return ''
  let key: string
  switch (state) {
    case 'completed':
    case 'failed':
    // Settled parked-ask headers are decision records, not live execution:
    // the title/color carries the outcome, so the executing spinner beside
    // 已批准 misreads as still running.
    case 'approved':
    case 'rejected':
    case 'answered':
    case 'cancelled':
      return ''
    case 'thinking':
      key = spin.thinkingKey
      break
    default:
      // "" or "running" → 执行中. "waiting" keeps the activity indicator:
      // the turn is still in flight while parked on the user's answer.
      key = spin.executingKey
      break
  }
  if (key === '') key = spin.thinkingKey
  if (key === '') key = spin.executingKey
  return key
}

/**
 * Header-icon key for a running-state card by latest entry kind:
 * tool_use/tool_result → executing, anything else → thinking.
 * @param spin - Uploaded spinner keys.
 * @param items - Progress card entries, latest last.
 * @returns The image key for the header icon, or '' when disabled.
 */
export function spinnerKeyForItems(spin: SpinnerCfg, items: ProgressCardEntry[]): string {
  if (!spin.enabled) return ''
  let key = spin.thinkingKey
  if (items.length > 0) {
    const last = items[items.length - 1]
    if (last?.kind === 'tool_use' || last?.kind === 'tool_result') key = spin.executingKey
  }
  if (key === '') key = spin.executingKey
  if (key === '') key = spin.thinkingKey
  return key
}
