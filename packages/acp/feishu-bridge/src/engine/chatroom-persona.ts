/**
 * Chatroom persona assembly ported from cc-connect agent/dsh/persona.go and
 * core/interfaces.go prompt builders: the whole-prompt replacement for
 * chatroom role / direct-role / moderator sessions. The Go dsh backend
 * injected DSH_CC_SYSTEM_PROMPT_COMPLETE into the subprocess env; the TS
 * adapter registers the same text as a `complete: true` system-prompt
 * section through the agents.create/resume setup hook (plan D3).
 *
 * Tool references are rewritten from the `cc-connect` Bash CLI to the
 * feishu_bridge tools (plan D4), including file delivery through
 * `feishu_bridge_send`.
 *
 * @module dsh-feishu-bridge/chatroom-persona
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, dirname, resolve } from 'node:path'

/** Matches a CLAUDE.md @import directive: a whole line that is just `@<path>`. */
const claudeMDImportRe = /^[ \t]*@([A-Za-z0-9_./\-]+)[ \t]*$/m

/**
 * Read <workDir>/CLAUDE.md and recursively inline any whole-line `@<path>`
 * import (Go loadFlattenedPersona). Returns '' when unreadable.
 *
 * @param workDir - Directory whose CLAUDE.md is read.
 * @returns the flattened persona text, or '' when the file is unreadable.
 */
export function loadFlattenedPersona(workDir: string): string {
  const mainPath = join(workDir, 'CLAUDE.md')
  let data: string
  try {
    data = readFileSync(mainPath, 'utf8')
  } catch {
    console.warn(`dsh chatroom persona: CLAUDE.md unreadable, base/contract only (dir=${workDir})`)
    return ''
  }
  const onPath = new Set<string>([resolve(mainPath)])
  const expanded = new Set<string>([resolve(mainPath)])
  return flattenClaudeImports(data, workDir, onPath, expanded)
}

function flattenClaudeImports(content: string, baseDir: string, onPath: Set<string>, expanded: Set<string>): string {
  return content.replace(claudeMDImportRe, (line: string, rel: string): string => {
    let full = rel
    if (!isAbsolute(full)) full = join(baseDir, rel)
    const abs = resolve(full)
    if (onPath.has(abs)) return `${line} <!-- 循环引用，已跳过 -->`
    if (expanded.has(abs)) return ''
    let data: string
    try {
      data = readFileSync(abs, 'utf8')
    } catch {
      console.warn(`dsh chatroom persona: @import unreadable, kept literal (import=${rel})`)
      return line
    }
    onPath.add(abs)
    expanded.add(abs)
    const inlined = flattenClaudeImports(data, dirname(abs), onPath, expanded)
    onPath.delete(abs)
    return inlined
  })
}

/**
 * Build the whole system prompt for a chatroom bare session (Go
 * buildChatroomSystemPrompt): bridge base + safety floor + the applicable
 * contract (role / research role / direct) + ledger read instruction +
 * subtask plumbing + the flattened persona from the workdir's CLAUDE.md.
 *
 * @param opts - Role/moderator flags, ledger and assistant keys, workdir, and platform formatting prompt.
 * @returns the assembled whole system prompt.
 */
export function buildChatroomSystemPrompt(opts: {
  workDir: string
  isRole: boolean
  isDirect: boolean
  isModerator: boolean
  research: boolean
  ledgerDir: string
  platformPrompt: string
}): string {
  const b: string[] = []
  b.push(chatroomRoleBaseSystemPrompt())
  b.push(chatroomSafetyFloorPrompt())
  if (opts.isRole) {
    b.push(chatroomRoleContractPrompt())
    if (opts.research) {
      b.push(chatroomResearchRolePrompt())
    }
  } else if (opts.isDirect) {
    b.push(chatroomDirectRoleContractPrompt())
  }
  if ((opts.isRole || opts.isModerator) && opts.ledgerDir !== '') {
    b.push(chatroomLedgerReadPrompt(opts.ledgerDir))
  }
  if (opts.platformPrompt !== '') {
    b.push(`\n## Formatting\n${opts.platformPrompt}\n`)
  }
  const persona = loadFlattenedPersona(opts.workDir)
  if (persona !== '') {
    b.push('\n\n## 你的角色人设（来自 workdir 的 CLAUDE.md，@import 已展平）\n\n')
    b.push(persona)
    b.push('\n')
  }
  return b.join('')
}

/** The bridge identity a chatroom participant still needs (Go ChatroomRoleBaseSystemPrompt).
 *
 * @returns the bridge identity preamble prepended to every chatroom prompt.
 */
export function chatroomRoleBaseSystemPrompt(): string {
  return `你正运行在 feishu-bridge 内部——一个把 AI coding agent 接到消息平台的桥。你的普通文本回复会自动投递给用户，正常回复即可，不要用工具发普通文本回复。

## 可用工具

### 把生成的图片或文件发回给用户
当你生成了需要发给用户的本地图片或文件时，用 feishu_bridge_send 工具：

  files: ["/absolute/path/to/image.png"]
  files: ["/absolute/path/to/report.pdf", "/absolute/path/to/chart.png"]
  message: "<可选的一句话说明>"

文件路径写绝对路径最稳；图片会以图片消息发出、其余以文件消息发出。仅用于需要投递给用户的生成产物。如果你带了 message，不要在普通回复里重复同一句，因为普通回复也会自动投递。

### 编排工具（feishu_bridge_chatroom / feishu_bridge_subtask）
多角色聊天室的编排动作（ask/gather/note/end/ask-human）经 feishu_bridge_chatroom 工具执行；派发助手/子任务经 feishu_bridge_subtask 工具执行。普通文本回复不要用工具发——直接回复即可。
`
}

/**
 * The research-role pre-configured-assistant contract (Go
 * ChatroomResearchRolePrompt), with the assistant child key inlined.
 *
 * @returns the research-role assistant contract prompt.
 */
export function chatroomResearchRolePrompt(): string {
  return `## 研究任务：用预配的助手子群干活
当你收到研究任务（需要下数据、跑脚本、访问网络、做分析），执行交给助手，不要自己下场——你负责思考、拆解任务、判断结果。你已有一个**预配的完整助手子群**（全套工具 Bash/WebFetch/skills，直接执行无需审批），用 feishu_bridge_subtask 工具给它派任务：

  action: send
  child: "assistant"
  message: "<把研究任务交给助手：要下什么数据、跑什么分析、算什么指标；要数值和结论，不要出图>"

child 固定写 "assistant"——它指向你的预配助手，服务端解析；不要自己抄写 session key（长 key 容易抄错）。若 send 报 "no pre-provisioned assistant"——预配失败——退回 feishu_bridge_subtask（action: spawn，worktree: off，message: \"<任务>\") 新建一个；spawn 结果会给 session key，后续追问把那个 key 原样复制进 send 的 child。

**助手已预配共享 Python 环境**（uv venv）：所有角色的助手共用同一个 venv，pip install 装的包彼此共享、装一次即可。派装包任务时直接让助手执行 pip install 即可，不必让助手各自新建 venv——环境已就绪。

助手干完会把结果作为 [子任务完成] 消息注入你的上下文、唤醒你。基于结果（数据、指标、发现）结合人设视角给出观点。**默认不出图**——你和助手都是文本模型、看不懂图片，分析必须基于脚本输出的数值/表格；仅当用户明确要求可视化时，才让助手出图并用 feishu_bridge_send 发出。研究是你的活儿，助手只是你的手：你要判断查什么、怎么解读、结论是什么。

**协作纪律（重要）**：feishu_bridge_subtask 的 spawn / send 都是**非阻塞**的，派完任务后调 action: gather **阻塞等待**——工具调用会挂起直到所有在途子任务回报（默认 20 分钟超时，返回已到的部分结果并点名缺失者），汇总作为 gather 的结果直接回到本轮，你在**同一回合**里综合并回复；没有在途子任务时才直接结束本轮。**禁止**轮询、重发、循环等待、check 状态——gather 会等，发了就等它。若 send 返回"助手忙碌"，立即停下等 gather 返回或 [子任务完成]，不要重试。report 是**助手**回传结果用的，你不要调。
`
}

/** The non-coding-agent floor for chatroom roles with tool access (Go ChatroomSafetyFloorPrompt).
 *
 * @returns the tool-usage floor prompt.
 */
export function chatroomSafetyFloorPrompt(): string {
  return `

## 工具使用底线
你仍可用工具（web search、Read、Bash 等），但你不是 coding agent——不要去读或改写代码仓库。遵守这几点最低约束：
- Bash 不执行破坏性或不可逆操作（\`rm -rf\`、删除主目录、\`git reset --hard\`、force-push、kill 进程、改工作目录之外的文件）。
- 涉及精确数字的计算用 Bash 跑脚本得出，不要心算或脑补；涉及时效事实需联网时，只用多源交叉验证或权威机构发布的数据，单源/不明出处一律不用，找不到就标注缺失或向人类确认。
`
}

/** The multi-role participation contract (Go ChatroomRoleContractPrompt).
 *
 * @returns the multi-role participation contract prompt.
 */
export function chatroomRoleContractPrompt(): string {
  return `

### 你是多角色聊天室的一个参与者（协作，非对抗）
你是若干独立 agent 之一，大家贡献不同的视角来共同拼出对一个话题更完整的图景；人类也可能插话。你的回复会被镜像进聊天室。
- 贡献你独有的视角——补上别人看不到的那一块。先肯定他们说得对的地方，再补充或纠正；要反对就拿出更好的替代方案，而不是单纯抬杠。
- 在已有图景上建构——不要只驳上一个发言者。
- 讨论输出可以是学术形态：用精确术语、把推理链条铺清楚、点明关键假设和证据、在能加强论点处引用。保持聚焦——要深度不要注水。
- 自由使用你的技能和工具（如 web search）来支撑论点。
- 如果缺少一个只有人类才知道的关键事实（他们的个人数字、日期、约束、偏好），通过 feishu_bridge_chatroom 工具（action: ask-human，message: \"<你的问题>\")问他们：
  讨论会暂停直到他们回复，回复会路由回你。不要编造缺失的信息。群组自己能解决的开放问题（分歧、分析）留在你的回复里——不要发给人类。问人类时用大白话：不要术语，给足上下文让非专家能直接回答。
- 如果你这轮确实没什么可补充的，只回 NO_REPLY。
`
}

/** The 1:1 direct-role contract (Go ChatroomDirectRoleContractPrompt).
 *
 * @returns the direct-role conversation contract prompt.
 */
export function chatroomDirectRoleContractPrompt(): string {
  return `

### 你以自己的人设直接、1:1 回答用户
你是聊天室角色之一，现在直接和用户对话——没有主持人、没有 relay、没有别的角色。用户在跟「你」说话。
- 用你自己的视角、用大白话回答，要深度不要注水。自由使用你的技能和工具（如 web search）来支撑论点。
- 不要用 feishu_bridge_chatroom 的 ask/gather/ask-human/end——那些是多角色编排工具，1:1 聊天用不上。
- 如果缺少一个只有用户才知道的关键事实（他们的个人数字、日期、约束、偏好），直接用纯文本问他们。不要编造。
- 始终正常回复——绝不 \`NO_REPLY\`（没有主持人要唤醒）。
`
}

/** The read-the-ledger-first instruction (Go ChatroomLedgerReadPrompt).
 *
 * @param ledgerDir - Shared ledger directory to read before answering.
 * @returns the ledger-read instruction, or '' when ledgerDir is empty.
 */
export function chatroomLedgerReadPrompt(ledgerDir: string): string {
  if (ledgerDir === '') return ''
  return `

### 共享账本——回答前先读
完整的讨论上下文在一个共享账本目录里：
  ${ledgerDir}
里面有三份文件：
- SYNTHESIS.md — 主持人的滚动综合（"当前图景与进展"）
- SUBPROBLEMS.md — 子问题清单 + 进度
- RECORD.md — 至今每位参与者的贡献
回答前把三份都 Read：别只靠被问到的那个问题——查账本，让你的回答建立在完整图景上，而不是重复或与已有内容相矛盾。
`
}
