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
    expect(text).toContain('feishu_bridge_send')
    expect(text).toContain('把生成的图片或文件发回给用户')
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
            steer: () => {},
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
    a.setSessionEnv(['CC_SESSION_KEY=test:assistant-1', 'CC_SUBTASK=1', 'CC_RESEARCH_ASSISTANT=1'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发子任务的子 agent')
    expect(sections[0]?.text).toContain('并行研究作战室的研究助手')
  })

  it('registers the report-back preamble for a plain subtask child', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=test:child-1', 'CC_SUBTASK=1', 'CC_SUBTASK_DEPTH=1'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发子任务的子 agent')
    expect(sections[0]?.text).toContain('feishu_bridge_subtask')
  })

  it('registers the no-report preamble for a no-report subtask child', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=test:child-2', 'CC_SUBTASK=1', 'CC_SUBTASK_NO_REPORT=1'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发执行单一任务的子 agent')
    expect(sections[0]?.text).toContain('feishu_bridge_send')
    expect(sections[0]?.text).toContain('无需回报')
  })

  it('registers the agent conventions section for plain sessions', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_1:ou_9'])
    await a.startSession('')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('feishu-bridge-agent-conventions')
    expect(sections[0]?.order).toBe(10)
    expect(sections[0]?.complete).toBeUndefined()
    // Verbatim pin of the model-visible text.
    expect(sections[0]?.text).toBe(`
### 保持好奇心，主动上报
发现疑似 bug、数据不一致、可疑配置、与注释/文档不符、明显低效或脆弱设计时主动提出，不视而不见，也不擅自修。先验证、宁缺毋滥：上报前自行核实（读上下文和调用方、跑能跑的检查），只报有实际影响的，不报验证不成立的或风格偏好、微小重复、理论低效，没有发现是正常结果。密钥泄露等损害正在扩大的发现立即提，不等收尾。
方式：收尾回复单列一节「发现的问题 / 可优化点」，每条一行——短标题加一句验证依据；\`path:line\` 与建议动作只放进追问卡片的选项描述，不在正文重复。

### 收尾追问卡片
「发现的问题 / 可优化点」一节非空时，发出收尾文本后紧接着调用 ask_user_question 发一个多选问题：单个问题、multi_select 为 true、header 为「后续处理」；每个发现对应一个选项（label 为短标题，description 为 \`path:line\` 与建议动作一句话），并附一个「暂不处理」选项。选项按你推荐的处理优先级排序，推荐要处理的选项置前并设 recommended: true（卡片会默认勾选）。该节为空或缺失时不发卡片。用户提交的勾选视为授权，直接开始处理；「暂不处理」或与选项无关的自由文本答复则不处理任何条目，自由文本按新任务理解并执行。
`)
  })

  it('registers the conventions section before the workspace section', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    a.setSessionEnv(['CC_SESSION_KEY=feishu:oc_2:ou_9', 'CC_FEISHU_WIKI_SPACE_ID=7415'])
    await a.startSession('')
    expect(sections).toHaveLength(2)
    expect(sections[0]?.name).toBe('feishu-bridge-agent-conventions')
    expect(sections[0]?.order).toBe(10)
    expect(sections[1]?.name).toBe('feishu-bridge-workspace')
    expect(sections[1]?.order).toBe(110)
    expect(sections[1]?.text).toContain('CC_FEISHU_WIKI_SPACE_ID=7415')
  })
})
