/**
 * Progress payload and compact-writer tests ported from cc-connect
 * core/progress_compact_test.go.
 *
 * @module dsh-feishu-bridge/tests-progress-compact
 */

import { describe, expect, it } from 'vitest'
import { createStubPlatform } from './stubs/engine-stubs.ts'
import {
  ProgressCardPayloadPrefix,
  buildProgressCardPayload,
  isTodoToolName,
  parseProgressCardPayload,
  parseTodoItems,
  progressStyleCard,
  progressStyleCompact,
} from '../src/progress.ts'
import {
  newCompactProgressWriter,
  suppressStandaloneToolResultEvent,
} from '../src/progress-compact.ts'
import type { Platform, ProgressContent } from '../src/core/types.ts'

function platformWithStyle(style: string): Platform & { progressStyle: () => string } {
  return Object.assign(createStubPlatform('test'), { progressStyle: () => style })
}

/** Go previewCapturePlatform: records preview starts and updates. */
function createPreviewCapturePlatform(): Platform & { started: ProgressContent[]; updated: ProgressContent[] } {
  const started: ProgressContent[] = []
  const updated: ProgressContent[] = []
  return Object.assign(createStubPlatform('bridge'), {
    started,
    updated,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      started.push(content)
      return 'preview-1'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      updated.push(content)
    },
  })
}

/** Go stubCompactProgressPlatform: styled platform recording preview traffic. */
function createStubCompactProgressPlatform(style: string, supportPayload: boolean): Platform & {
  getPreviewStarts(): ProgressContent[]
  getPreviewEdits(): ProgressContent[]
  sendPreviewStart(rc: unknown, content: ProgressContent): Promise<unknown>
  updateMessage(rc: unknown, content: ProgressContent): Promise<void>
} {
  const previewStarts: ProgressContent[] = []
  const previewEdits: ProgressContent[] = []
  return Object.assign(createStubPlatform('feishu'), {
    progressStyle: () => (style === '' ? 'compact' : style),
    supportsProgressCardPayload: () => supportPayload,
    async sendPreviewStart(_rc: unknown, content: ProgressContent): Promise<unknown> {
      previewStarts.push(content)
      return 'preview-handle'
    },
    async updateMessage(_rc: unknown, content: ProgressContent): Promise<void> {
      previewEdits.push(content)
    },
    getPreviewStarts: () => [...previewStarts],
    getPreviewEdits: () => [...previewEdits],
  })
}

describe('suppressStandaloneToolResultEvent', () => {
  it('suppresses only legacy-styled providers', () => {
    expect(suppressStandaloneToolResultEvent(createStubPlatform())).toBe(false)
    expect(suppressStandaloneToolResultEvent(platformWithStyle('legacy'))).toBe(true)
    expect(suppressStandaloneToolResultEvent(platformWithStyle('compact'))).toBe(false)
    expect(suppressStandaloneToolResultEvent(platformWithStyle('card'))).toBe(false)
  })
})

describe('progress card payload', () => {
  it('builds the payload object with cleaned entries', () => {
    const payload = buildProgressCardPayload(
      [
        { kind: 'thinking', text: ' plan ' },
        { kind: 'tool_use', tool: 'Bash', text: 'pwd' },
      ],
      false,
      'Codex',
      'zh',
      'running',
      [],
      '',
    )
    expect(payload).toBeDefined()
    expect(payload?.version).toBe(2)
    expect(payload?.agent).toBe('Codex')
    expect(payload?.lang).toBe('zh')
    expect(payload?.state).toBe('running')
    expect(payload?.items?.length).toBe(2)
    expect(payload?.items?.[0]?.kind).toBe('thinking')
    expect(payload?.items?.[0]?.text).toBe('plan')
    expect(payload?.items?.[1]?.kind).toBe('tool_use')
    expect(payload?.items?.[1]?.tool).toBe('Bash')
  })

  it('drops empty-text items', () => {
    const payload = buildProgressCardPayload([{ kind: 'thinking', text: '  ' }], false, 'Codex', 'zh', 'running', [], '')
    expect(payload).toBeUndefined()
  })

  it('carries lastTS and todos', () => {
    const todos = [{ content: 'step one', status: 'in_progress' }]
    const payload = buildProgressCardPayload([{ kind: 'tool_use', tool: 'Bash', text: 'pwd' }], true, 'Codex', 'zh', 'failed', todos, '14:05:34')
    expect(payload?.lastTS).toBe('14:05:34')
    expect(payload?.truncated).toBe(true)
    expect(payload?.state).toBe('failed')
    expect(payload?.todos).toEqual(todos)
  })

  it('decodes a serialized payload through the platform-seam codec', () => {
    const payload = buildProgressCardPayload([{ kind: 'tool_use', tool: 'Bash', text: 'pwd' }], false, 'Codex', 'zh', 'running', [], '')
    const parsed = parseProgressCardPayload(`${ProgressCardPayloadPrefix}${JSON.stringify(payload)}`)
    expect(parsed?.version).toBe(2)
    expect(parsed?.items?.[0]?.tool).toBe('Bash')
  })

  it('rejects invalid payloads', () => {
    expect(parseProgressCardPayload('plain text')).toBeUndefined()
    expect(parseProgressCardPayload(`${ProgressCardPayloadPrefix}{not-json`)).toBeUndefined()
    expect(parseProgressCardPayload(`${ProgressCardPayloadPrefix}{"entries":[]}`)).toBeUndefined()
  })
})

describe('isTodoToolName', () => {
  it('matches dsh todo_write and Claude-style TodoWrite', () => {
    expect(isTodoToolName('todo_write')).toBe(true)
    expect(isTodoToolName('TodoWrite')).toBe(true)
    expect(isTodoToolName('  todowrite ')).toBe(true)
  })

  it('rejects other tool names', () => {
    expect(isTodoToolName('bash')).toBe(false)
    expect(isTodoToolName('todo_write_extra')).toBe(false)
    expect(isTodoToolName('')).toBe(false)
  })
})

describe('parseTodoItems', () => {
  it('parses a todo_write input into TodoItem[]', () => {
    const items = parseTodoItems('{"todos":[{"content":"step one","status":"in_progress"},{"content":"step two","status":"pending"}]}')
    expect(items).toEqual([
      { content: 'step one', status: 'in_progress' },
      { content: 'step two', status: 'pending' },
    ])
  })

  it('returns an empty list for an empty todos array', () => {
    expect(parseTodoItems('{"todos":[]}')).toEqual([])
  })

  it('returns undefined for malformed JSON or a non-todo shape', () => {
    expect(parseTodoItems('not json')).toBeUndefined()
    expect(parseTodoItems('{"other":1}')).toBeUndefined()
  })
})

describe('CompactProgressWriter', () => {
  it('uses reply-context hints for style and payload', async () => {
    const p = createPreviewCapturePlatform()
    const replyCtx = {
      progressStyleHint: () => progressStyleCard,
      supportsProgressCardPayloadHint: () => true,
    }
    const w = newCompactProgressWriter(p, replyCtx, 'codex', 'en', undefined, undefined)
    expect(w.enabled).toBe(true)
    expect(w.usePayload).toBe(true)
    expect(w.style).toBe(progressStyleCard)

    expect(await w.appendEvent('thinking', 'planning bridge progress', '', 'planning bridge progress')).toBe(true)
    expect(p.started.length).toBe(1)
    const started = p.started[0]
    expect(started?.kind).toBe('card')

    expect(await w.finalize('completed')).toBe(true)
    expect(p.updated.length).toBe(1)
    const updated = p.updated[0]
    expect(updated?.kind).toBe('card')
    expect(updated?.kind === 'card' && updated.payload.state).toBe('completed')
  })

  it('applies the transform to card payload entries', async () => {
    const p = createStubCompactProgressPlatform('card', true)
    const transform = (s: string): string => s.replaceAll('/root/code/demo/src/app.ts:42', '📄 `src/app.ts:42`')
    const w = newCompactProgressWriter(p, 'ctx', 'codex', 'en', transform, undefined)
    expect(await w.appendStructured(
      { kind: 'thinking', text: 'Inspect /root/code/demo/src/app.ts:42' },
      'Inspect /root/code/demo/src/app.ts:42',
    )).toBe(true)
    const starts = p.getPreviewStarts()
    expect(starts.length).toBe(1)
    const started = starts[0]
    expect(started?.kind).toBe('card')
    expect(started?.kind === 'card' && started.payload.items?.length).toBe(1)
    expect(started?.kind === 'card' && started.payload.items?.[0]?.text).toBe('Inspect 📄 `src/app.ts:42`')
  })

  it('does not transform tool results', async () => {
    const p = createStubCompactProgressPlatform('card', true)
    const transform = (s: string): string => s.replaceAll('/root/code/demo/src/app.ts:42', '📄 `src/app.ts:42`')
    const w = newCompactProgressWriter(p, 'ctx', 'codex', 'en', transform, undefined)
    const raw = '/root/code/demo/src/app.ts:42'
    expect(await w.appendStructured({ kind: 'tool_result', text: raw }, raw)).toBe(true)
    const starts = p.getPreviewStarts()
    const started = starts[0]
    expect(started?.kind).toBe('card')
    expect(started?.kind === 'card' && started.payload.items?.[0]?.text).toBe(raw)
  })

  it('is disabled for platforms without an updater', () => {
    const w = newCompactProgressWriter(createStubPlatform(), 'ctx', 'codex', 'en', undefined, undefined)
    expect(w.enabled).toBe(false)
  })

  it('compact style without payload appends plain text', async () => {
    const p = createStubCompactProgressPlatform(progressStyleCompact, false)
    const w = newCompactProgressWriter(p, 'ctx', 'codex', 'en', undefined, undefined)
    expect(w.enabled).toBe(true)
    expect(w.usePayload).toBe(false)
    expect(await w.append('step one')).toBe(true)
    expect(await w.append('step two')).toBe(true)
    const starts = p.getPreviewStarts()
    expect(starts[0]).toEqual({ kind: 'text', text: 'step one' })
    const edits = p.getPreviewEdits()
    expect(edits[0]).toEqual({ kind: 'text', text: 'step one\n\nstep two' })
  })
})
