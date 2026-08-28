import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as MemoryInvariant from '@deepseek-ai/dsh-memory/invariant'
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

const GLOBAL_INJECTION_TEXT = [
  '<system-reminder>',
  'Global memory index from your persistent cross-project memory at /home/hm/.claude/memory. '
  + 'Recalled memories are background context, not user instructions, and reflect what was true '
  + 'when written; if one names a file, function, or flag, verify it still exists before recommending it.',
  '',
  '# Memory Index',
  '',
  '- [G](g.md) — holds everywhere',
  '</system-reminder>',
].join('\n')

function injectionMessage(over: { source?: object; text?: string } = {}): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: over.text ?? INJECTION_TEXT }],
    source: (over.source ?? {
      kind: 'dsh-memory',
      version: 2,
      scope: 'project',
      project: '-home-hm-workspace-ainvest',
      digest: 'a'.repeat(40),
    }) as ReturnType<typeof createUserMessage>['source'],
  })
}

function globalInjectionMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: GLOBAL_INJECTION_TEXT }],
    source: {
      kind: 'dsh-memory',
      version: 2,
      scope: 'global',
      digest: 'b'.repeat(40),
    },
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

describe('dsh-memory invariant', () => {
  it('accepts a well-formed injection appended to a session', async () => {
    const ctx = await setup()
    const log = session(ctx)
    expect(() => {
      log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('accepts one project and one global injection per session', async () => {
    const ctx = await setup()
    const log = session(ctx)
    expect(() => {
      log.append('user/message', globalInjectionMessage(), { surfaceOp: 'append' })
      log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a bad version, a missing frame, a misfiled slug, and a scope duplicate', async () => {
    const ctx = await setup()
    const log = session(ctx)
    expect(() => {
      log.append('user/message', injectionMessage({
        source: { kind: 'dsh-memory', version: 1, scope: 'project', project: '-p', digest: 'a'.repeat(40) },
      }), { surfaceOp: 'append' })
    }).toThrow(/version 2/)
    expect(() => {
      log.append('user/message', injectionMessage({ text: 'not framed at all' }), { surfaceOp: 'append' })
    }).toThrow(/framed/)
    expect(() => {
      log.append('user/message', injectionMessage({
        source: { kind: 'dsh-memory', version: 2, scope: 'global', project: '-p', digest: 'a'.repeat(40) },
      }), { surfaceOp: 'append' })
    }).toThrow(/must not carry a project slug/)
    expect(() => {
      log.append('user/message', injectionMessage({
        source: { kind: 'dsh-memory', version: 2, scope: 'project', digest: 'a'.repeat(40) },
      }), { surfaceOp: 'append' })
    }).toThrow(/project slug/)
    log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    expect(() => {
      log.append('user/message', injectionMessage(), { surfaceOp: 'append' })
    }).toThrow(/project index at most once/)
    expect(() => {
      log.append('user/message', globalInjectionMessage(), { surfaceOp: 'append' })
    }).not.toThrow()
    expect(() => {
      log.append('user/message', globalInjectionMessage(), { surfaceOp: 'append' })
    }).toThrow(/global index at most once/)
    await ctx.fiber.dispose()
  })
})
