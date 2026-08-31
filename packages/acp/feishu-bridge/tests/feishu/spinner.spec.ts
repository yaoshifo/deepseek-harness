/**
 * Spinner icon tests ported from cc-connect platform/feishu
 * feishu_spinner_test.go.
 *
 * @module dsh-feishu-bridge/tests-feishu-spinner
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgressCardPayload, type ProgressCardEntry } from '../../src/progress.ts'
import { FeishuPlatform, type FeishuApiClient } from '../../src/feishu/platform.ts'
import { buildPreviewCardJSON, buildProgressCardJSONFromPayload, markCardStopped } from '../../src/feishu/progress.ts'
import { noSpinner, resolveSpinnerAsset, type SpinnerCfg } from '../../src/feishu/spinner.ts'
import { retryTiming } from '../../src/feishu/retry.ts'
import type { ProgressStatus } from '../../src/core/types.ts'
import { jObj, jParse, jStr, type JsonObj } from '../stubs/json.ts'

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
      const payload = buildProgressCardPayload(entries, false, 'Claude', 'zh', state, [], '')
      expect(payload).toBeDefined()
      const cardJSON = buildProgressCardJSONFromPayload(payload!, spin)
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
    const payload = buildProgressCardPayload([{ kind: 'thinking', text: 'x' }], false, 'Claude', 'zh', 'running', [], '')
    expect(hasHeaderIcon(buildProgressCardJSONFromPayload(payload!, noSpinner))).toBe(false)
  })
})

describe('spinner gif upload (platform)', () => {
  /** Platform whose apiClient records every uploadImage call through `upload`. */
  function uploadPlatform(upload: (fileName: string) => Promise<string>): { p: FeishuPlatform; uploads: string[] } {
    const uploads: string[] = []
    const api: FeishuApiClient = {
      async reply() { return { messageId: 'om_ok' } },
      async create() { return { messageId: 'om_ok' } },
      async uploadImage({ fileName }) {
        uploads.push(fileName)
        return upload(fileName)
      },
    }
    return {
      p: new FeishuPlatform({ appID: 'cli_spin', appSecret: 's', apiClient: api, wsStart: async () => {} }),
      uploads,
    }
  }

  it('a transient upload failure retries within spinnerCfg', async () => {
    const saved = { ...retryTiming }
    retryTiming.initialDelay = 5
    retryTiming.maxDelay = 10
    const failedOnce = new Set<string>()
    try {
      const { p, uploads } = uploadPlatform(async (fileName) => {
        // First attempt per gif fails transiently; the retry must succeed.
        if (!failedOnce.has(fileName)) {
          failedOnce.add(fileName)
          throw new Error('dial tcp: i/o timeout')
        }
        return `img_${fileName}`
      })
      const cfg = await p.spinnerCfg()
      expect(cfg).toEqual({ enabled: true, thinkingKey: 'img_thinking.gif', executingKey: 'img_executing.gif' })
      expect(uploads).toEqual(['thinking.gif', 'thinking.gif', 'executing.gif', 'executing.gif'])
    } finally {
      Object.assign(retryTiming, saved)
    }
  })

  it('a failed upload attempt is not cached — the next spinnerCfg retries', async () => {
    let failAll = true
    const { p, uploads } = uploadPlatform(async (fileName) => {
      // Non-transient so the retry wrapper gives up immediately.
      if (failAll) throw new Error('feishu: upload image code=230001 msg=bad request')
      return `img_${fileName}`
    })

    expect(await p.spinnerCfg()).toEqual(noSpinner)
    failAll = false
    // The once-cache must not pin the failure: the next call retries.
    expect(await p.spinnerCfg()).toEqual({ enabled: true, thinkingKey: 'img_thinking.gif', executingKey: 'img_executing.gif' })
    expect(uploads).toHaveLength(4)
  })
})

describe('progress card spinner icon (text path)', () => {
  const spin: SpinnerCfg = { enabled: true, thinkingKey: 'img_think', executingKey: 'img_exec' }

  const cases: Array<[name: string, text: string, status: ProgressStatus | undefined, wantIcon: string]> = [
    ['thinking state', 'pondering the design', { state: 'thinking', ts: '14:05:34', toolCallSeq: 0 }, 'img_think'],
    ['running state (no status)', '**14:05:34** ⚙️ `Bash`\necho hello', undefined, 'img_exec'],
    ['completed state', 'done', { state: 'completed', ts: '14:05:35', toolCallSeq: 0 }, ''],
    ['failed state', 'boom', { state: 'failed', ts: '14:05:36', toolCallSeq: 0 }, ''],
    // Settled parked-ask headers are decision records, not live execution —
    // no icon, like the other terminal states.
    ['approved state', 'done', { state: 'approved', ts: '14:05:37', toolCallSeq: 2 }, ''],
    ['rejected state', 'denied', { state: 'rejected', ts: '14:05:37', toolCallSeq: 2 }, ''],
    ['answered state', 'answered', { state: 'answered', ts: '14:05:37', toolCallSeq: 2 }, ''],
    ['cancelled state', 'cancelled', { state: 'cancelled', ts: '14:05:37', toolCallSeq: 2 }, ''],
    // waiting keeps the executing indicator: the turn is still in flight
    // while parked on the user's answer.
    ['waiting state', 'pending', { state: 'waiting', ts: '14:05:37', toolCallSeq: 2 }, 'img_exec'],
  ]

  for (const [name, text, status, wantIcon] of cases) {
    it(name, () => {
      const cardJSON = buildPreviewCardJSON(text, spin, status)
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
    const payload = buildProgressCardPayload([{ kind: 'thinking', text: 'x' }], false, 'Claude', 'zh', 'running', [], '')
    const cardJSON = buildProgressCardJSONFromPayload(payload!, spin)
    expect(hasHeaderIcon(cardJSON)).toBe(true)
    const stopped = markCardStopped(cardJSON, 'sess-key')
    expect(hasHeaderIcon(stopped)).toBe(false)
    expect(stopped).toContain('已停止')
  })
})

describe('resolveSpinnerAsset', () => {
  it('resolves the packaged assets directory from the source plane', () => {
    const path = resolveSpinnerAsset('thinking.gif')
    expect(path).toBeDefined()
    expect(path?.endsWith(join('assets', 'thinking.gif'))).toBe(true)
  })

  it('resolves assets one level above a bundled module (tsdown lib plane)', async () => {
    // lib/index.js sits one level below the package root, like the tsdown
    // bundle output; assets stay at the package root.
    const pkg = await mkdtemp(join(tmpdir(), 'spinner-assets-'))
    await mkdir(join(pkg, 'assets'))
    await writeFile(join(pkg, 'assets', 'thinking.gif'), '')
    const moduleDir = join(pkg, 'lib')

    expect(resolveSpinnerAsset('thinking.gif', moduleDir)).toBe(join(pkg, 'assets', 'thinking.gif'))
  })

  it('returns undefined when no candidate directory holds the asset', () => {
    expect(resolveSpinnerAsset('missing.gif')).toBeUndefined()
  })
})
