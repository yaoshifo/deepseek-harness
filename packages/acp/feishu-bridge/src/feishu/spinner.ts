/**
 * Running-state header GIF selection ported from cc-connect
 * platform/feishu/feishu_spinner.go (pure selection logic; the GIF upload
 * lives on the platform). thinking.gif is a violet pulse ring (思考中);
 * executing.gif a Material-style spinner (执行中).
 *
 * @module dsh-feishu-bridge/feishu-spinner
 */

import type { ProgressCardEntry } from '../progress.js'

/** Uploaded spinner image keys; enabled is false when both uploads failed. */
export interface SpinnerCfg {
  enabled: boolean
  /** Violet pulse ring — 思考中 / placeholder / latest thinking entry. */
  thinkingKey: string
  /** Material spinner — latest tool_use/tool_result entry. */
  executingKey: string
}

export const noSpinner: SpinnerCfg = { enabled: false, thinkingKey: '', executingKey: '' }

/**
 * Header-icon key for a text-path progress card: "thinking" → thinkingKey,
 * "" / "running" → executingKey, terminal states → none. An empty chosen key
 * falls back to the other so one failed upload doesn't suppress the icon.
 */
export function spinnerKeyForState(spin: SpinnerCfg, state: string): string {
  if (!spin.enabled) return ''
  let key: string
  switch (state) {
    case 'completed':
    case 'failed':
      return ''
    case 'thinking':
      key = spin.thinkingKey
      break
    default: // "" or "running" → 执行中
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
