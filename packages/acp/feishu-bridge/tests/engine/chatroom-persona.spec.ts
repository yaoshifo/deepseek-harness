/**
 * Chatroom persona tests: the flattened persona loader and the whole-prompt
 * assembly (Go agent/dsh/persona.go behavior, exercised through the TS
 * builders), plus the adapter's setup-hook wiring (plan D3).
 *
 * @module dsh-feishu-bridge/tests-engine-chatroom-persona
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildChatroomSystemPrompt,
  loadFlattenedPersona,
} from '../../src/engine/chatroom-persona.js'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'

describe('loadFlattenedPersona', () => {
  it('reads CLAUDE.md and inlines @imports recursively', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Taleb\n\n@essence.md\n\n正文\n', 'utf8')
    await writeFile(join(dir, 'essence.md'), '本质：厚尾。\n', 'utf8')

    const persona = loadFlattenedPersona(dir)
    expect(persona).toContain('# Taleb')
    expect(persona).toContain('本质：厚尾。')
    expect(persona).toContain('正文')
    expect(persona).not.toContain('@essence.md')
  })

  it('returns empty when CLAUDE.md is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-empty-'))
    expect(loadFlattenedPersona(dir)).toBe('')
  })
})

describe('buildChatroomSystemPrompt', () => {
  it('assembles the role persona with contract and persona text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-build-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Munger\n多元思维格栅。\n', 'utf8')

    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: true,
      isDirect: false,
      isModerator: false,
      research: false,
      researchAssistantChild: '',
      ledgerDir: '/data/ledgers/abc',
      platformPrompt: '',
    })
    expect(text).toContain('feishu-bridge')
    expect(text).toContain('多角色聊天室的一个参与者')
    expect(text).toContain('共享账本——回答前先读')
    expect(text).toContain('/data/ledgers/abc')
    expect(text).toContain('# Munger')
  })

  it('adds the research contract only in research mode with the child key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-research-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# R\n', 'utf8')
    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: true,
      isDirect: false,
      isModerator: false,
      research: true,
      researchAssistantChild: 'test:assistant-9',
      ledgerDir: '',
      platformPrompt: '',
    })
    expect(text).toContain('研究任务：用预配的助手子群干活')
    expect(text).toContain('test:assistant-9')
  })

  it('uses the direct contract for 1:1 sessions and no ledger section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-persona-direct-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# R\n', 'utf8')
    const text = buildChatroomSystemPrompt({
      workDir: dir,
      isRole: false,
      isDirect: true,
      isModerator: false,
      research: false,
      researchAssistantChild: '',
      ledgerDir: '/data/ledgers/abc',
      platformPrompt: '',
    })
    expect(text).toContain('1:1 回答用户')
    expect(text).not.toContain('共享账本——回答前先读')
    expect(text).not.toContain('多角色聊天室的一个参与者')
  })
})

describe('DshAgentAdapter bare persona setup hook', () => {
  interface RecordedSection {
    name: string
    order: number
    text: string
    complete?: boolean
  }

  function createHarness(opts: { sections: RecordedSection[] }): DshContextLike {
    const agents: Array<DshAgentLike & { id: string; disposed: boolean }> = []
    const ctx: DshContextLike = {
      agents: {
        create: async (options: DshCreateOptionsLike) => {
          const agent = {
            id: `agent-${agents.length + 1}`,
            status: 'idle' as const,
            session: { events: [] },
            disposed: false,
            followup: () => {},
            cancel: () => {},
          }
          agents.push(agent)
          if (options.setup !== undefined) {
            void options.setup({
              get: (name: string): unknown => {
                if (name !== 'systemPrompt') return undefined
                return {
                  section: (section: RecordedSection): (() => void) => {
                    opts.sections.push(section)
                    return () => {}
                  },
                }
              },
            } as unknown as Parameters<NonNullable<DshCreateOptionsLike['setup']>>[0])
          }
          const handle: DshAgentHandleLike = {
            agent,
            dispose: async () => { agent.disposed = true },
          }
          return handle
        },
        resume: async () => { throw new Error('not used') },
        get: (id: unknown) => agents.find(a => a.id === String(id)),
      },
      on: () => () => {},
      get: () => undefined,
    }
    return ctx
  }

  function newAdapter(ctx: DshContextLike, cwd: string): DshAgentAdapter {
    return new DshAgentAdapter(ctx, {
      agentName: 'dsh',
      cwd,
      providers: [{ name: 'glm', provider: 'glm-route', model: 'glm-5.3' }],
      activeProvider: 'glm',
    })
  }

  it('registers a complete section for a moderator session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-adapter-mod-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Mod\n', 'utf8')
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), dir)
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_1:ou_9', 'CC_CHATROOM_MODERATOR=1'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBe(true)
    expect(sections[0]?.text).toContain('# Mod')
  })

  it('registers the research-assistant preamble as a non-complete section', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=test:assistant-1', 'CC_RESEARCH_ASSISTANT=1'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('并行研究作战室的研究助手')
  })

  it('registers nothing for plain sessions', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_1:ou_9'])
    await a.startSession('')
    expect(sections).toHaveLength(0)
  })
})
