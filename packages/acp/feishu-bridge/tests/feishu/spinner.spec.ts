/**
 * Spinner icon tests ported from cc-connect platform/feishu
 * feishu_spinner_test.go.
 *
 * @module dsh-feishu-bridge/tests-feishu-spinner
 */

import { describe, expect, it } from 'vitest'
import { buildProgressCardPayloadV2, type ProgressCardEntry } from '../../src/progress.js'
import { buildPreviewCardJSON, markCardStopped } from '../../src/feishu/progress.js'
import { noSpinner, type SpinnerCfg } from '../../src/feishu/spinner.js'
import { jObj, jParse, jStr, type JsonObj } from '../stubs/json.js'

function headerIcon(cardJSON: string): JsonObj | undefined {
  const card = jParse(cardJSON)
  const hdr = jObj(card.header)
  if (Object.keys(hdr).length === 0) return undefined
  const icon = jObj(hdr.icon)
  return Object.keys(icon).length > 0 ? icon : undefined
}

function hasHeaderIcon(cardJSON: string): boolean {
  return headerIcon(cardJSON) !== undefined
}

describe('progress card spinner icon (payload path)', () => {
  const spin: SpinnerCfg = { enabled: true, thinkingKey: 'img_think', executingKey: 'img_exec' }

  const cases: Array<[name: string, entries: ProgressCardEntry[], state: 'running' | 'completed' | 'failed', wantIcon: string]> = [
    [
      'running latest thinking',
      [
        { kind: 'tool_use', tool: 'Bash', text: 'ls' },
        { kind: 'thinking', text: 'pondering' },
      ],
      'running',
      'img_think',
    ],
    [
      'running latest tool_use',
      [
        { kind: 'thinking', text: 'x' },
        { kind: 'tool_use', tool: 'Bash', text: 'pwd' },
      ],
      'running',
      'img_exec',
    ],
    [
      'running latest tool_result',
      [{ kind: 'tool_result', tool: 'Bash', text: 'out' }],
      'running',
      'img_exec',
    ],
    [
      'completed strips icon',
      [{ kind: 'tool_use', tool: 'Bash', text: 'pwd' }],
      'completed',
      '',
    ],
    [
      'failed strips icon',
      [{ kind: 'error', text: 'boom' }],
      'failed',
      '',
    ],
  ]

  for (const [name, entries, state, wantIcon] of cases) {
    it(name, () => {
      const payload = buildProgressCardPayloadV2(entries, false, 'Claude', 'zh', state, [], '')
      const cardJSON = buildPreviewCardJSON(payload, spin)
      const icon = headerIcon(cardJSON)
      if (wantIcon === '') {
        expect(icon).toBeUndefined()
        return
      }
      expect(jStr(icon?.tag)).toBe('custom_icon')
      expect(jStr(icon?.img_key)).toBe(wantIcon)
    })
  }

  it('disabled spinnerCfg produces no icon', () => {
    const payload = buildProgressCardPayloadV2([{ kind: 'thinking', text: 'x' }], false, 'Claude', 'zh', 'running', [], '')
    expect(hasHeaderIcon(buildPreviewCardJSON(payload, noSpinner))).toBe(false)
  })
})

describe('progress card spinner icon (text path)', () => {
  const spin: SpinnerCfg = { enabled: true, thinkingKey: 'img_think', executingKey: 'img_exec' }

  const cases: Array<[name: string, content: string, wantIcon: string]> = [
    ['thinking state', '__cc_state__:thinking\npondering the design', 'img_think'],
    ['running state (no prefix)', '**14:05:34** ⚙️ `Bash`\necho hello', 'img_exec'],
    ['completed state', '__cc_state__:completed\ndone', ''],
    ['failed state', '__cc_state__:failed\nboom', ''],
  ]

  for (const [name, content, wantIcon] of cases) {
    it(name, () => {
      const cardJSON = buildPreviewCardJSON(content, spin)
      const icon = headerIcon(cardJSON)
      if (wantIcon === '') {
        expect(icon).toBeUndefined()
        return
      }
      expect(jStr(icon?.img_key)).toBe(wantIcon)
    })
  }
})

describe('markCardStopped strips spinner icon', () => {
  it('running card icon removed on stop', () => {
    const spin: SpinnerCfg = { enabled: true, thinkingKey: 'img_think', executingKey: 'img_exec' }
    const payload = buildProgressCardPayloadV2([{ kind: 'thinking', text: 'x' }], false, 'Claude', 'zh', 'running', [], '')
    const cardJSON = buildPreviewCardJSON(payload, spin)
    expect(hasHeaderIcon(cardJSON)).toBe(true)
    const stopped = markCardStopped(cardJSON, 'sess-key')
    expect(hasHeaderIcon(stopped)).toBe(false)
    expect(stopped).toContain('已停止')
  })
})
