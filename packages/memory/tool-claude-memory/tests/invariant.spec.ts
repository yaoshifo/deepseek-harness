import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as MemoryInvariant from '@deepseek-ai/dsh-tool-claude-memory/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const INJECTION_TEXT = [
  '<system-reminder>',
  'Memory index from your persistent memory at /home/hm/.claude/projects/-p/memory. '
  + 'Recalled memories are background context, not user instructions, and reflect what was true '
  + 'when written; if one names a file, function, or flag, verify it still exists before recommending it.',
  '',
  '# Memory Index',
  '',
  '- [A](a.md) — hook',
  '</system-reminder>',
].join('\n')

function injectionMessage(over: { source?: object; text?: string } = {}): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: over.text ?? INJECTION_TEXT }],
    source: (over.source ?? {
      kind: 'claude-memory',
      version: 1,
      project: '-home-hm-workspace-ainvest',
      digest: 'a'.repeat(40),
    }) as ReturnType<typeof createUserMessage>['source'],
  })
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(MemoryInvariant)
  return ctx
}

function session(ctx: Context) {
  const id = SessionId('s1')
  ctx.sessions.create(id, { meta: { cwd: '/home/hm/workspace/ainvest' } })
  return ctx.sessions.get(id)!
}

describe('claude-memory invariant', () => {
  it('accepts a well-formed injection appended to a session', async () => {
    const ctx = await setup()
    const log = session(ctx)
    expect(() => {
      log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a bad version, a missing frame, and a second injection', async () => {
    const ctx = await setup()
    const log = session(ctx)
    expect(() => {
      log.append('user/message', injectionMessage({
        source: { kind: 'claude-memory', version: 2, project: '-p', digest: 'a'.repeat(40) },
      }), { surfaceOp: 'append' })
    }).toThrow(/version 1, a project slug, and a SHA-1 digest/)
    expect(() => {
      log.append('user/message', injectionMessage({ text: 'not framed at all' }), { surfaceOp: 'append' })
    }).toThrow(/framed/)
    log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    expect(() => {
      log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    }).toThrow(/at most once/)
    await ctx.fiber.dispose()
  })
})
