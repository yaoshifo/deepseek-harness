/**
 * Hints-panel card elements ported from cc-connect core/engine_cmd_misc.go
 * (hintButtonName/ParseHintButtonName/buildHintsPanelElements/
 * buildHintsCommonElements): compact 3-per-row buttons, per-row param inputs,
 * frequency-ordered, with stable button names that decode back to command
 * text on form_submit callbacks.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardElement } from '../../src/card.js'
import { HintUsage } from '../../src/engine/hint-usage.js'
import {
  buildHintsCommonElements,
  buildHintsPanelElements,
  hintButtonName,
  parseHintButtonName,
} from '../../src/engine/hints-panel.js'

function textsOf(el: CardElement): string[] {
  if (el.kind === 'actions') return el.buttons.map(b => b.text)
  return []
}

describe('hintButtonName', () => {
  it('encodes and decodes short hints (base64url path)', () => {
    const name = hintButtonName('c', '/new')
    expect(name.startsWith('hint__c__')).toBe(true)
    const parsed = parseHintButtonName(name)
    expect(parsed).toEqual({ category: 'c', hintText: '/new' })
  })

  it('decodes unicode hints through the base64url path', () => {
    const name = hintButtonName('wp', '/draw 一张架构图')
    expect(parseHintButtonName(name)?.hintText).toBe('/draw 一张架构图')
  })

  it('hashes names over the 95-char cap and recovers them via the process map', () => {
    const long = '/shell bash ' + 'x'.repeat(120)
    const name = hintButtonName('co', long)
    expect(name.length).toBeLessThanOrEqual(95)
    expect(name.startsWith('hint__co__')).toBe(true)
    expect(parseHintButtonName(name)?.hintText).toBe(long)
  })

  it('rejects names without the hint__ prefix', () => {
    expect(parseHintButtonName('perm_allow')).toBeUndefined()
    expect(parseHintButtonName('hint__czzz')).toBeUndefined()
  })
})

describe('buildHintsPanelElements', () => {
  it('returns [] when nothing is configured', () => {
    expect(buildHintsPanelElements([], [], undefined)).toEqual([])
  })

  it('wraps compact hints 3 per row with equal-column actions', () => {
    const els = buildHintsPanelElements(['/a', '/b', '/c', '/d'], [], undefined)
    expect(els).toHaveLength(2)
    expect(textsOf(els[0]!)).toEqual(['/a', '/b', '/c'])
    expect(els[0]!.kind === 'actions' && els[0]!.layout).toBe('equal_columns')
    expect(textsOf(els[1]!)).toEqual(['/d'])
    if (els[0]!.kind === 'actions') {
      const btn = els[0]!.buttons[0]!
      expect(btn.value).toBe('cmd:/a')
      expect(btn.actionType).toBe('form_submit')
      expect(btn.name).toBe(hintButtonName('c', '/a'))
    }
  })

  it('places a divider between the two groups and builds param rows', () => {
    const els = buildHintsPanelElements(['/a'], ['/tdd', '/html'], undefined)
    expect(els[1]!.kind).toBe('divider')
    const row0 = els[2]
    const row1 = els[3]
    expect(row0?.kind).toBe('columnSet')
    expect(row1?.kind).toBe('columnSet')
    if (row0?.kind === 'columnSet' && row1?.kind === 'columnSet') {
      const [btnCol, inputCol] = row0.columns
      const [btnCol1] = row1.columns
      expect(btnCol?.width).toBe('auto')
      expect(inputCol?.width).toBe('weighted')
      expect(inputCol?.weight).toBe(1)
      const btn = btnCol?.elements[0]
      if (btn?.kind === 'actions') {
        expect(btn.buttons[0]?.type).toBe('primary')
        expect(btn.buttons[0]?.value).toBe('cmd:/tdd')
        expect(btn.buttons[0]?.extra).toEqual({ _arg: 'hint_arg_0' })
      }
      const input = inputCol?.elements[0]
      expect(input?.kind).toBe('input')
      if (input?.kind === 'input') {
        expect(input.name).toBe('hint_arg_0')
        expect(input.maxLength).toBe(1000)
      }
      if (btnCol1?.elements[0]?.kind === 'actions') {
        expect(btnCol1.elements[0].buttons[0]?.extra).toEqual({ _arg: 'hint_arg_1' })
      }
    }
  })

  it('orders both groups by click frequency', () => {
    const usage = new HintUsage(mkdtempSync(join(tmpdir(), 'hint-usage-')))
    usage.increment('hints_with_param', '/html')
    const els = buildHintsPanelElements(['/a', '/b'], ['/tdd', '/html'], usage)
    // Param group now starts with /html (row after divider).
    const firstParamRow = els[2]
    if (firstParamRow?.kind === 'columnSet') {
      const btn = firstParamRow.columns[0]?.elements[0]
      if (btn?.kind === 'actions') expect(btn.buttons[0]?.text).toBe('/html')
    }
  })
})

describe('buildHintsCommonElements', () => {
  it('returns [] when nothing is configured', () => {
    expect(buildHintsCommonElements([], undefined)).toEqual([])
  })

  it('wraps common hints 3 per row and frequency-orders them', () => {
    const usage = new HintUsage(mkdtempSync(join(tmpdir(), 'hint-usage-')))
    usage.increment('hints_common', '好')
    const els = buildHintsCommonElements(['/done', '好', '/spawn'], usage)
    expect(els).toHaveLength(1)
    expect(textsOf(els[0]!)).toEqual(['好', '/done', '/spawn'])
    if (els[0]!.kind === 'actions') {
      expect(els[0]!.buttons[0]?.name).toBe(hintButtonName('co', '好'))
      expect(els[0]!.buttons[0]?.value).toBe('cmd:好')
    }
  })
})
