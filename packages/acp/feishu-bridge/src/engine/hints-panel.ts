/**
 * Hints-panel card elements ported from cc-connect core/engine_cmd_misc.go:
 * compact hints as equal-width 3-per-row form_submit buttons, hints with a
 * param as button-plus-input rows, and common hints as an always-visible
 * button row — all frequency-ordered. Button names encode the category and
 * hint text so Feishu form_submit callbacks (which omit action.value) can
 * recover the command.
 *
 * @module dsh-feishu-bridge/hints-panel
 */

import type { CardButton, CardElement } from '../card.js'
import type { HintUsage } from './hint-usage.js'

/** Button-name category codes: compact, with_param, common (Go c/wp/co). */
type HintCategoryCode = 'c' | 'wp' | 'co'

const codeByCategory: Record<'hints' | 'hints_with_param' | 'hints_common', HintCategoryCode> = {
  hints: 'c',
  hints_with_param: 'wp',
  hints_common: 'co',
}

/** Encoded button names longer than this fall back to a hash (Go maxHintNameLen). */
const maxHintNameLen = 95

/** Hashed (over-cap) button names mapped back to their hint text; process-lifetime, like Go's sync.Map. */
const hashedHintNames = new Map<string, string>()

/** FNV-1a 32-bit hash (Go fnv.New32a). */
function fnv1a32(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    // 32-bit FNV prime multiplication via shifts.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Encode category and hint text into a stable form button name
 * (Go hintButtonName): `hint__<category>__<base64url(text)>`, or an FNV-1a
 * hash when the name would exceed {@link maxHintNameLen}.
 * @param category - The category code the button belongs to.
 * @param hintText - The hint's command text.
 * @returns The button name, at most {@link maxHintNameLen} characters.
 */
export function hintButtonName(category: HintCategoryCode, hintText: string): string {
  const encoded = Buffer.from(hintText, 'utf8').toString('base64url')
  const name = `hint__${category}__${encoded}`
  if (name.length <= maxHintNameLen) return name
  const hashed = `hint__${category}__${fnv1a32(`${category}:${hintText}`)}`
  hashedHintNames.set(hashed, hintText)
  return hashed
}

/**
 * Decode a hint form button name back into its category code and hint text.
 * @param name - The button name from the card callback.
 * @returns The decoded pair, or undefined when the name is not a hint button.
 */
export function parseHintButtonName(name: string): { category: HintCategoryCode; hintText: string } | undefined {
  if (!name.startsWith('hint__')) return undefined
  const payload = name.slice('hint__'.length)
  const idx = payload.indexOf('__')
  if (idx < 0) return undefined
  const category = payload.slice(0, idx) as HintCategoryCode
  const hashed = hashedHintNames.get(name)
  if (hashed !== undefined) return { category, hintText: hashed }
  const encoded = payload.slice(idx + 2)
  try {
    const buf = Buffer.from(encoded, 'base64url')
    // Node silently skips invalid base64url chars where Go errors out; the
    // re-encode check rejects those non-canonical names.
    if (buf.toString('base64url') !== encoded) return undefined
    return { category, hintText: buf.toString('utf8') }
  } catch {
    return undefined
  }
}

/** Compact buttons per row (Go hintsPerRow). */
const hintsPerRow = 3

function ordered(usage: HintUsage | undefined, category: 'hints' | 'hints_with_param' | 'hints_common', hints: string[]): string[] {
  return usage === undefined ? hints : usage.sortedByFrequency(category, hints)
}

/**
 * Build the collapsed hints panel: compact equal-width button rows, a
 * divider, then one button-plus-input row per param hint (Go
 * buildHintsPanelElements).
 * @param hints - Compact hint command texts.
 * @param hintsWithParam - Hints that append an input field's value.
 * @param usage - Click counts ordering both groups; undefined keeps config order.
 * @returns Panel elements, empty when neither group is configured.
 */
export function buildHintsPanelElements(
  hints: string[],
  hintsWithParam: string[],
  usage: HintUsage | undefined,
): CardElement[] {
  if (hints.length === 0 && hintsWithParam.length === 0) return []
  const panel: CardElement[] = []

  if (hints.length > 0) {
    let btns: CardButton[] = []
    for (const h of ordered(usage, 'hints', hints)) {
      btns.push({
        text: h,
        type: 'default',
        value: `cmd:${h}`,
        actionType: 'form_submit',
        name: hintButtonName('c', h),
      })
      if (btns.length === hintsPerRow) {
        panel.push({ kind: 'actions', buttons: btns, layout: 'equal_columns' })
        btns = []
      }
    }
    if (btns.length > 0) panel.push({ kind: 'actions', buttons: btns, layout: 'equal_columns' })
  }

  if (hints.length > 0 && hintsWithParam.length > 0) panel.push({ kind: 'divider' })

  if (hintsWithParam.length > 0) {
    for (const [i, h] of ordered(usage, 'hints_with_param', hintsWithParam).entries()) {
      const argName = `hint_arg_${i}`
      panel.push({
        kind: 'columnSet',
        columns: [
          {
            width: 'auto',
            elements: [{
              kind: 'actions',
              buttons: [{
                text: h,
                type: 'primary',
                value: `cmd:${h}`,
                actionType: 'form_submit',
                name: hintButtonName('wp', h),
                extra: { _arg: argName },
              }],
              layout: 'row',
            }],
          },
          {
            width: 'weighted',
            weight: 1,
            elements: [{ kind: 'input', name: argName, placeholder: '参数', maxLength: 1000 }],
          },
        ],
      })
    }
  }

  return panel
}

/**
 * Build the always-visible common hint button rows (Go buildHintsCommonElements).
 * @param hintsCommon - Common hint command texts.
 * @param usage - Click counts ordering the buttons; undefined keeps config order.
 * @returns Button-row elements, empty when none are configured.
 */
export function buildHintsCommonElements(hintsCommon: string[], usage: HintUsage | undefined): CardElement[] {
  if (hintsCommon.length === 0) return []
  const elements: CardElement[] = []
  let btns: CardButton[] = []
  for (const h of ordered(usage, 'hints_common', hintsCommon)) {
    btns.push({
      text: h,
      type: 'default',
      value: `cmd:${h}`,
      actionType: 'form_submit',
      name: hintButtonName('co', h),
    })
    if (btns.length === hintsPerRow) {
      elements.push({ kind: 'actions', buttons: btns, layout: 'equal_columns' })
      btns = []
    }
  }
  if (btns.length > 0) elements.push({ kind: 'actions', buttons: btns, layout: 'equal_columns' })
  return elements
}

/**
 * Map a button-name category code back to its config category (Go feishu_dispatch).
 * @param code - The category code from a parsed hint button name.
 * @returns The config category the code denotes.
 */
export function hintCategoryOfCode(code: HintCategoryCode): 'hints' | 'hints_with_param' | 'hints_common' {
  for (const [category, c] of Object.entries(codeByCategory) as Array<['hints' | 'hints_with_param' | 'hints_common', HintCategoryCode]>) {
    if (c === code) return category
  }
  return 'hints'
}
