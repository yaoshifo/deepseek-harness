/**
 * The adapter's persona setup-hook wiring (plan D3): a session carrying a
 * precomputed persona prompt registers it as a `complete: true`
 * system-prompt section, forgoing workspace instruction injection and the
 * skill catalog; research assistants and other subtask children keep their
 * preambles and cwd discovery. Moved out of the chatroom persona spec when
 * the chatroom moved to its own package — these pin the bridge-side seam.
 *
 * @module dsh-feishu-bridge/tests-adapter-persona
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshAgentAdapter, type DshAgentHandleLike, type DshAgentLike, type DshCreateOptionsLike, type DshContextLike } from '../../src/agent-dsh/adapter.js'

describe('DshAgentAdapter bare persona setup hook', () => {
  interface RecordedSection {
    name: string
    order: number
    text: string
    complete?: boolean
  }

  function createHarness(opts: {
    sections: RecordedSection[]
    suppressions?: { count: number }
    skillDenies?: { count: number }
  }): DshContextLike {
    const agents: Array<DshAgentLike & { id: string; disposed: boolean }> = []
    const suppressions = opts.suppressions ?? { count: 0 }
    const skillDenies = opts.skillDenies ?? { count: 0 }
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
                if (name === 'agentInstructions') {
                  return {
                    suppress: (): (() => void) => {
                      suppressions.count += 1
                      return () => {}
                    },
                  }
                }
                if (name === 'tools') {
                  return {
                    get: (toolName: string): unknown => toolName === 'skill' ? { name: 'skill' } : undefined,
                    restrict: (filter: { deny: readonly string[] }): (() => void) => {
                      if (filter.deny.includes('skill')) skillDenies.count += 1
                      return () => {}
                    },
                  }
                }
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

  it('registers the persona prompt as a complete section (moderator persona)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-adapter-mod-'))
    await writeFile(join(dir, 'CLAUDE.md'), '# Mod\n', 'utf8')
    const sections: RecordedSection[] = []
    const suppressions = { count: 0 }
    const skillDenies = { count: 0 }
    const a = newAdapter(createHarness({ sections, suppressions, skillDenies }), dir)
    // The persona prompt is precomputed feature-side (the owning plugin
    // flattens the session's workdir CLAUDE.md); the adapter only consumes it.
    const prompt = '# Mod moderator persona prompt'
    await a.startSession('', {
      sessionKey: 'feishu:oc_1:ou_9',
      persona: { prompt, bypassPermissions: false, forceMode: 'default' },
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('feishu-bridge-persona')
    expect(sections[0]?.complete).toBe(true)
    expect(sections[0]?.text).toContain('# Mod')
    // Go --bare parity: a bare-persona session also forgoes workspace
    // instruction injection and the skill catalog (via the skill-tool deny).
    expect(suppressions.count).toBe(1)
    expect(skillDenies.count).toBe(1)
  })

  it('suppresses workspace instructions and skills for a role persona too', async () => {
    const sections: RecordedSection[] = []
    const suppressions = { count: 0 }
    const skillDenies = { count: 0 }
    const a = newAdapter(createHarness({ sections, suppressions, skillDenies }), '/ws')
    await a.startSession('', {
      sessionKey: 'feishu:oc_1:role',
      persona: { prompt: 'role persona prompt', bypassPermissions: true, forceMode: undefined },
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBe(true)
    expect(suppressions.count).toBe(1)
    expect(skillDenies.count).toBe(1)
  })

  it('keeps cwd discovery for every subtask child, research assistants included', async () => {
    const sections: RecordedSection[] = []
    const suppressions = { count: 0 }
    const skillDenies = { count: 0 }
    const a = newAdapter(createHarness({ sections, suppressions, skillDenies }), '/ws')
    await a.startSession('', { sessionKey: 'feishu:oc_1:ou_9' })
    await a.startSession('', {
      sessionKey: 'test:assistant-2',
      subtask: { attended: false, noReport: false, researchAssistant: true },
    })
    await a.startSession('', {
      sessionKey: 'test:child-3',
      subtask: { attended: false, noReport: false, researchAssistant: false },
    })
    // Research assistants are coding agents: their workspace lives under the
    // project data dir, off every chatroom persona's ancestor chain, so they
    // keep cwd instruction discovery exactly like plain subtask children.
    // No subtask child ever loses the skill tool.
    expect(suppressions.count).toBe(0)
    expect(skillDenies.count).toBe(0)
  })

  it('registers the research-assistant preamble as a non-complete section', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    await a.startSession('', {
      sessionKey: 'test:assistant-1',
      subtask: { attended: false, noReport: false, researchAssistant: true },
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发子任务的子 agent')
    expect(sections[0]?.text).toContain('并行研究作战室的研究助手')
    // Data-reliability hard constraints, distilled from the production
    // commodity-research practice: the assistant is the only participant
    // that actually fetches online data, and it never sees the role-side
    // safety floor.
    for (const want of ['只用权威一手数据', '两个相互独立源', '加总闭合', '不悄悄二选一', '不编造', '置信度']) {
      expect(sections[0]?.text).toContain(want)
    }
  })

  it('registers the report-back preamble for a plain subtask child', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    await a.startSession('', {
      sessionKey: 'test:child-1',
      subtask: { attended: false, noReport: false, researchAssistant: false },
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发子任务的子 agent')
    expect(sections[0]?.text).toContain('feishu_bridge_subtask')
  })

  it('registers the no-report preamble for a no-report subtask child', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    await a.startSession('', {
      sessionKey: 'test:child-2',
      subtask: { attended: false, noReport: true, researchAssistant: false },
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.complete).toBeUndefined()
    expect(sections[0]?.text).toContain('被派发执行单一任务的子 agent')
    expect(sections[0]?.text).toContain('feishu_bridge_send')
    expect(sections[0]?.text).toContain('无需回报')
  })

  it('registers the agent conventions section for plain sessions', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    await a.startSession('', { sessionKey: 'feishu:oc_1:ou_9' })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('feishu-bridge-agent-conventions')
    expect(sections[0]?.order).toBe(10)
    expect(sections[0]?.complete).toBeUndefined()
    // Verbatim pin of the model-visible text.
    expect(sections[0]?.text).toBe(`
### 异步自主的工作方式
你在异步聊天里工作——用户不实时盯着，"要不要我……？"式请示会阻塞工作直到用户回来。

- 请求的歧义会实质性改变要做的工作时，提一个聚焦的问题；不影响实际工作时，挑合理的解读继续并说明选了哪个。
- 源自原始请求的**可逆动作直接做**，不先请示；只在破坏性动作或真正的范围变更上停下来等用户。任务做完后提供后续选项没问题，做事前请求许可不行。
- 用户在描述问题、提问、或思考出声而非要求改动时，交付物是你的**评估**——报告发现即止，用户开口后再动手修。
- 你的工具调用对用户不可见——只有文字可见。第一次工具调用前用一句话说明要做什么；工作中在关键时刻给简短更新：一个发现、方向变化、一个阻塞。简洁是好的；沉默不是。
- 中间文本只是状态简报，可能不被完整展示；用户需要从本轮得到的全部内容——答案、结论、发现、交付物——必须完整出现在回合的最后一条消息里。
- **todo_write 勤更新**：用了待办清单，就每完成一项立刻调用 todo_write 把它标 \`completed\`、把下一项标 \`in_progress\`，不要攒到收尾批量更新——飞书卡片实时渲染这份清单，状态滞后会让人误以为工作没做。
- **回合结束自检**：发出最后一条消息前看它的最后一段——若是计划、分析、提问、或"接下来我要……"式的承诺，说明该做的还没做，现在就用工具做掉（含自己重试错误、自己补齐缺失信息）。只有任务完成、或被只有用户能提供的输入阻塞时才结束回合。

### 保持好奇心，主动上报
发现疑似 bug、数据不一致、可疑配置、与注释/文档不符、本次用到的 skill 有失效或可改进之处（以执行中实际撞到为准）、明显低效或脆弱设计时主动提出，不视而不见，也不擅自修。先验证、宁缺毋滥：上报前自行核实（读上下文和调用方、跑能跑的检查），只报有实际影响的，不报验证不成立的或风格偏好、微小重复、理论低效，没有发现是正常结果。密钥泄露等损害正在扩大的发现立即提，不等收尾。
方式：收尾回复单列一节「发现的问题 / 可优化点」，每条一行——短标题加一句验证依据；\`path:line\` 与建议动作只放进追问卡片的选项描述，不在正文重复。

### 收尾追问卡片
「发现的问题 / 可优化点」一节非空时，发出收尾文本后紧接着调用 ask_user_question 发一个多选问题：单个问题、multi_select 为 true、header 为「后续处理」；每个发现对应一个选项（label 为短标题，description 为 \`path:line\` 与建议动作一句话），并附一个「暂不处理」选项。选项按你推荐的处理优先级排序，推荐要处理的选项置前并设 recommended: true（卡片会默认勾选）。该节为空或缺失时不发卡片。用户提交的勾选视为授权，直接开始处理；「暂不处理」或与选项无关的自由文本答复则不处理任何条目，自由文本按新任务理解并执行。
`)
  })

  it('registers the conventions section before the workspace section', async () => {
    const sections: RecordedSection[] = []
    const a = newAdapter(createHarness({ sections }), '/ws')
    await a.startSession('', {
      sessionKey: 'feishu:oc_2:ou_9',
      feishuWorkspace: { wikiSpaceId: '7415', folderToken: '', wikiNodeToken: '', description: '' },
    })
    expect(sections).toHaveLength(2)
    expect(sections[0]?.name).toBe('feishu-bridge-agent-conventions')
    expect(sections[0]?.order).toBe(10)
    expect(sections[1]?.name).toBe('feishu-bridge-workspace')
    expect(sections[1]?.order).toBe(110)
    expect(sections[1]?.text).toContain('CC_FEISHU_WIKI_SPACE_ID=7415')
  })
})
