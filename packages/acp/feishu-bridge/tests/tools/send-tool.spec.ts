/**
 * Consumer-surface tests for the `feishu_bridge_send` tool over a REAL
 * Cordis Context + ToolRuntime (the registry is never bypassed): the caller
 * agent routes to its engine + session key (plan D4 — no env), local files
 * load and classify into image/file attachments by detected mime, relative
 * paths resolve against the session's work dir, the size gate and the
 * attachmentSend config gate fail loud, and registration disposes cleanly
 * (HMR safety).
 *
 * @module dsh-feishu-bridge/tests-tools-send
 */

import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Engine, InteractiveState } from '../../src/engine/engine.js'
import { ProjectStateStore } from '../../src/engine/project-state.js'
import {
  detectAttachmentMimeType,
  maxAttachmentSize,
  registerSendTool,
} from '../../src/tools/send.js'
import type { SubtaskRoute } from '../../src/tools/subtask.js'
import { createStubAgent, createStubMediaPlatform, createStubPlatform } from '../stubs/engine-stubs.js'

const signal = new AbortController().signal
const contexts: Context[] = []

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fb-sendtool-'))
}

/** A real Engine whose send path is spied (routing assertions). */
function newRoutedEngine(name: string): { engine: Engine; send: ReturnType<typeof vi.fn> } {
  const engine = new Engine(name, createStubAgent(), [createStubPlatform()], '', 'en')
  const send = vi.spyOn(engine, 'sendToSessionWithAttachments').mockResolvedValue(undefined)
  return { engine, send }
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly dispose: () => void
}

async function harness(route: (agent: unknown) => SubtaskRoute | undefined): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `send-tool-${Math.random()}`)
  ctx.agents.register(agent)
  const dispose = registerSendTool(ctx, route)
  return { ctx, agent, dispose }
}

async function execute(
  test: Harness,
  args: unknown,
  agent: Agent = test.agent,
): Promise<ToolExecutionResult> {
  return test.ctx.agents.withInitiator(agent, () => test.ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${Math.random()}`),
    name: 'feishu_bridge_send',
    arguments: args,
    agent,
  }))
}

function value(result: ToolExecutionResult): { status: string; message: string } {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful value')
  return result.value as { status: string; message: string }
}

function errorText(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected an error result')
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('feishu_bridge_send registration', () => {
  it('registers on ctx.tools and disposes cleanly (HMR safety)', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:chat' }))
    expect(test.ctx.tools.get('feishu_bridge_send')?.name).toBe('feishu_bridge_send')
    test.dispose()
    test.dispose() // idempotent
    expect(test.ctx.tools.get('feishu_bridge_send')).toBeUndefined()
  })
})

describe('feishu_bridge_send delivery', () => {
  it('routes caller files to sendToSessionWithAttachments, images split from files', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    writeFileSync(join(dir, 'report.md'), '# hello\n')
    const r = newRoutedEngine('proj-x')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'feishu:chat-9:u1' }))
    const v = value(await execute(test, {
      files: [join(dir, 'chart.png'), join(dir, 'report.md')],
      message: '构建产物',
    }))
    expect(r.send).toHaveBeenCalledTimes(1)
    const [key, message, images, files] = r.send.mock.calls[0] as [
      string, string,
      Array<{ mimeType: string; fileName?: string }>,
      Array<{ mimeType: string; fileName: string }>,
    ]
    expect(key).toBe('feishu:chat-9:u1')
    expect(message).toBe('构建产物')
    expect(images).toHaveLength(1)
    expect(images[0]?.mimeType).toBe('image/png')
    expect(images[0]?.fileName).toBe('chart.png')
    expect(files).toHaveLength(1)
    expect(files[0]?.mimeType).toBe('text/markdown; charset=utf-8')
    expect(files[0]?.fileName).toBe('report.md')
    expect(v.message).toContain('Message sent successfully')
    expect(v.message).toContain('chart.png')
    expect(v.message).toContain('report.md')
  })

  it('allows a bare file list without a message', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'data.csv'), 'a,b\n')
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    value(await execute(test, { files: [join(dir, 'data.csv')] }))
    const [, message, images, files] = r.send.mock.calls[0] as [
      string, string, unknown[], unknown[],
    ]
    expect(message).toBe('')
    expect(images).toHaveLength(0)
    expect(files).toHaveLength(1)
  })

  it('resolves relative paths against the session work dir', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    const engine = new Engine('test', createStubAgent(), [createStubPlatform()], '', 'en')
    const store = new ProjectStateStore(join(dir, 'state.json'))
    store.setWorkspaceDirOverride(engine.dirOverrideKey('test:chat:u1'), dir)
    engine.setProjectStateStore(store)
    const send = vi.spyOn(engine, 'sendToSessionWithAttachments').mockResolvedValue(undefined)
    const test = await harness(() => ({ engine, sessionKey: 'test:chat:u1' }))
    value(await execute(test, { files: ['notes.txt'] }))
    const [, , , files] = send.mock.calls[0] as [string, string, unknown[], Array<{ fileName: string }>]
    expect(files[0]?.fileName).toBe('notes.txt')
  })

  it('fails loud for a missing file and an empty file list', async () => {
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const missing = await execute(test, { files: ['/nonexistent/path.bin'] })
    expect(missing.isError).toBe(true)
    expect(errorText(missing)).toContain('read attachment')
    const empty = await execute(test, { files: [] })
    expect(empty.isError).toBe(true)
    expect(r.send).not.toHaveBeenCalled()
  })

  it('rejects attachments over the size limit before reading', async () => {
    const dir = tempDir()
    const big = join(dir, 'big.bin')
    writeFileSync(big, '')
    truncateSync(big, maxAttachmentSize + 1)
    const r = newRoutedEngine('test')
    const test = await harness(() => ({ engine: r.engine, sessionKey: 'test:p' }))
    const result = await execute(test, { files: [big] })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('exceeds size limit (50 MB)')
    expect(r.send).not.toHaveBeenCalled()
  })
})

describe('feishu_bridge_send gating', () => {
  it('surfaces the attachmentSend-disabled engine error', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'x')
    const p = createStubMediaPlatform()
    const engine = new Engine('test', createStubAgent(), [p], '', 'en')
    engine.setAttachmentSendEnabled(false)
    const state = new InteractiveState()
    state.platform = p
    state.replyCtx = 'ctx-1'
    engine.interactiveStates.set('test:p', state)
    const test = await harness(() => ({ engine, sessionKey: 'test:p' }))
    const result = await execute(test, { files: [join(dir, 'a.txt')] })
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('attachment send is disabled')
    expect(p.getSent()).toEqual([])
  })

  it('fails loud for a caller the bridge does not own', async () => {
    const r = newRoutedEngine('test')
    const test = await harness((agent) => {
      const id = (agent as { id?: unknown } | undefined)?.id
      return typeof id === 'string' && id === 'foreign-agent' ? undefined : { engine: r.engine, sessionKey: 'test:p' }
    })
    const foreign = stubAgent(test.ctx, 'foreign-agent')
    test.ctx.agents.register(foreign)
    const result = await execute(test, { files: ['/tmp/x'] }, foreign)
    expect(result.isError).toBe(true)
    expect(errorText(result)).toContain('not owned')
  })
})

describe('detectAttachmentMimeType', () => {
  it('maps extensions, sniffs magic bytes, and falls back to octet-stream', () => {
    expect(detectAttachmentMimeType('a.md', Buffer.alloc(0))).toBe('text/markdown; charset=utf-8')
    expect(detectAttachmentMimeType('a.png', Buffer.alloc(0))).toBe('image/png')
    expect(detectAttachmentMimeType('a.unknown', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(detectAttachmentMimeType('a.unknown', Buffer.alloc(0))).toBe('application/octet-stream')
  })
})
