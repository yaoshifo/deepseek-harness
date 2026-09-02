---
description: "以 dsh bundle 层形态交付的飞书群聊 bot 桥：按项目配置的 bot、卡片化的轮次渲染与审批/计划卡、可汇报的原生子任务、cron、relay、监控与 lark 工具族——面向组装或排查飞书部署的运维者。"
kind: "package-bundle"
---

# dsh-feishu-bridge

[English](README.md) | 中文

## 概述

用一个长驻 dsh 进程运行飞书群聊 bot：每个配置的 project 得到一个 engine 加一个飞书长连接平台，群聊驱动真实 agent 会话，轮次渲染为实时进度卡、审批与追问卡、终态完成卡。用 `feishu_bridge_subtask` 派发并行工作——子任务作为原生可续会话运行并结算回父聊天——用 cron 排无人值守运行，用 `lark-cli` 工具调飞书开放 API。每个 project 是一条配置；斜杠命令族（`/reload`、`/spawn`、`/dir`、`/skills`、`/context` 等）、i18n 与按项目的工具可见性随层提供，机器级策略留在 profile。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

cc-connect 的编排能力（engine + 飞书平台）迁入 dsh 的单插件形态：一个长驻 dsh 进程按配置为每个 project 组装一个 Engine + 一个飞书 WS 平台（官方 node-sdk 长连接，D5），agent 会话经 `ctx.agents` 原生创建，不再有桥协议。迁移计划、里程碑与决策记录见 [docs/MIGRATION.md](docs/MIGRATION.md)；61 项 feature 对照见 [docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md)；部署与配置映射见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

插件结构：

| 目录 | 内容 |
|---|---|
| `src/engine/` | Go `core/` 保形移植：事件状态机、会话、命令、cron、relay、monitor、i18n、附件暂存 |
| `src/feishu/` | Go `platform/feishu/` 移植：WS、API client、卡片、进度卡、群管理、标签、头像、媒体、引用消息抓取 |
| `src/agent-dsh/` | Agent 接口 → `ctx.agents` 适配器（D1/D3：setup 钩子、provider 路由、审批/问题/plan 接线） |
| `src/tools/` | `feishu_bridge_subtask / cron / relay / lark / send` 工具族（D4：caller agent 路由，免 env；`feishu_bridge_chatroom` 工具族由兄弟插件 `@deepseek-ai/dsh-feishu-bridge-chatroom` 注册）；lark 工具注册名为 `lark-cli`——与官方 CLI 逐字一致，官方内嵌 skills 里的每处命令引用都能字面映射到工具调用，其 description 引导业务域任务先走 `skills list` / `skills read` |
| `skills/` | 桥接 skill（`feishu-bridge-` 前缀）与部署的工作风格 skill（`tdd`、`skillify`），由 `apply()` 自动挂载为独立 skill provider，无需配置 `customSkillDirs` |

原生子任务（去包袱 B4）：profile 的 `dsh-base` bundle 挂 `SubagentRuntime`（`settlementNotice: 'external'`，经本 bundle patch 覆盖）与 in-process spawn/fork providers，`feishu_bridge_subtask` 的无人值守派发因此以原生 continuable 子会话运行——没有飞书群——世系、深度与冷恢复归原生运行时；引擎只保留父系记录（持久化于 project state、重启存活）与自己创建的 worktree。本 bundle patch 同时禁用 `tool-subagent-report`：其 `report` 工具直投 runtime 父收件箱——引擎观察不到的通道——子任务用它会造成双投递（runtime 拼接 + 引擎结算卡与唤醒，2026-08-27 oc_56801302）；`feishu_bridge_subtask` 的 action=report 是唯一回报面（subagents 服务的 reportFrom 路径保留给 native 父投递）。结算经 `subagent/end` 监听到达引擎：从未显式回报的子任务仍以群路径同款卡片 + `[子任务完成]` 唤醒投递其末条助手输出，追问的回答会重新武装该投递。每条机器唤醒（子任务回报、gather 汇总、聊天室主持人唤醒、追问注入）都走 `deliverMachineMessage`：忙碌中的父回合经 agent 会话 steer 原语在回合内收到它（多条唤醒合并进一个 step），而不是进入平台消息队列——队列的 📬 排队回执、内存存储与长度上限是人类会话语义；空闲父会话保持合成消息路径，唤醒带完整回合机制运行。daemon 重启会无声杀死在途子任务 epoch，因此 `recoverInterruptedNativeChildren` 在 platforms-ready 时运行：每个无存活 agent 的未回报子任务被结算，其父聊天收到红色警告卡与通知（可用 `send` 复活追问，send 会重新武装记录）——聊天室插件 barrier 恢复的子任务对位物；仍存活的子任务（HMR 重建保住了 runtime）不被触碰。结算文本携带终局原因——非 completed 的 stop reason 会加上失败语义前缀（error / max-tokens / refusal / aborted，外加 provider 诊断与「未留下收尾输出」注记），失败的工作不会被当成完成来汇报。`gather` 是同步投递契约：调用阻塞到所有在途子任务回报，或 gather 超时（默认 20 分钟）返回点名缺失者的部分汇总；汇总作为该调用自己的工具结果回到仍打开的父回合——调用在飞期间子任务工具活动实时流入其活跃进度卡，等待被中止（用户停止）时工具调用以中止提示结算——挂起的回合必须能够终结，否则 agent 永不静息、会话在 runtime 注册表泄漏为 live——已收集的回报仍经异步唤醒送达。等待集只含能结算屏障的子会话（带 subtask depth 的会话与原生子任务）；挂在 hub 下的聊天室角色群被排除——其回复经聊天室中继结算——无可收集子任务的父会话快速报错，不再武装一个只能等超时的屏障。`send` 排队到子任务当前轮之后（对 Go busy-reject 的刻意偏离），`interrupt` 停止当前轮而不销毁子任务，`/done` 与 chatroom end 排空原生后代（打断 + 干净 worktree 回收）。被排空的 worktree 若唯一脏因是已包含进其收敛目标的提交——祖先形式或 rebase 后的补丁等价——会被自动移除而不是保留；目标默认取 worktree 创建时 HEAD 所在分支（每仓库零配置），`spawn.integrateBranch` 作全局覆盖；未提交改动与未合并提交始终保留 worktree（群路径为逐子 Keep/Remove 卡保留），创建时基线分支分离或未知的 worktree 关闭自动移除。再挂一行 `dsh-subagent` 会在 provider 注册上与 `dsh-base` 相撞（DUPLICATE_PROVIDER 令整棵插件树加载失败）——runtime 与 spawn/fork providers 归 base 所有，本桥只经 bundle patch 覆盖投递模式。通用 `subagent` / `subagent_fork` 工具在本组合中保持禁用（其子任务对引擎不可见），因此同一 patch 还覆盖 plan-mode 段的委派句——base 的工具中立文案 "background subagent delegations" 会点名这些被禁用的工具，覆盖后改为派发 `feishu_bridge_subtask` spawns；其余段落与 base 逐字一致，锁步 spec（`tests/bundle-patch.spec.ts`）在 base 段落演进、句子未重新适配时变红（[Agent Note](../../../.agents/notes/implemented/architecture/2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.zh.md)）。同一 patch 还持有 profile 曾经手抄的其余部署类条目——goal 全家 / workflow / ralph / 第二编辑器的禁用、`tool-ask-user` 与 `dsh-memory` 的挂载、身份抑制、CLAUDE.md 指令候选——而每机策略（sandbox 与 permission preset、模型路由、MCP 与 lsp 挂载、凭证）留在 profile（[Agent Note](../../../.agents/notes/implemented/architecture/2026-09-01-feishu-bridge-deployment-class-config-in-bundle-patch.zh.md)）。attended 群（`/spawn`、monitor 子群、chatroom 预派助手）保持群路径不变，且群路径子任务获得了对等的失败通知：错误回合的自动汇报带失败标记与本回合自己的部分流式文本（绝不误报上一回合的陈旧回复），回合中进程退出以中断前缀投递部分输出，终止清理路径（stall 击杀、硬回合上限、agent 已死的发送失败）投递合成超时通知——父级不会永远干等。`features.subtaskQuiet: true` 抑制无人值守原生子任务的结算卡片——结果只经唤醒进入父 agent 上下文，与通用 `subagent` 工具的静默返回一致；attended 群子任务与 monitor 聊天始终保留卡片。未回报的原生子任务在运行期间保持可见：派发中的 turn 在停止按钮行显示 `subtasks_running_hint` 提示，每张定稿卡片标题追加 `· N 个子任务在途`（正文提示 + ✅ 完成推送同一行），计数在每个渲染点从持久化记录重算——Header 本身保持终态，因为父 turn 确实已结束。回合落定而子任务仍在运行时（无 gather 的逃逸路径），后台子任务实时面板发布一张独立卡片，每 `features.subtaskLivePanelIntervalMs`（默认 15s）原地 PATCH：header 沿用工具过程卡的「执行中」拼装——黄底模板、转圈图标（平台有 spinner 时）与最近活动时刻 `HH:MM:SS`，时刻随每次 PATCH 前进、全部停滞即冻结；任一子任务静默超过 `features.subtaskLivePanelStallMs`（默认 120s）后模板翻橙并追加停滞计数。每个在途子任务一行——标签、工具调用数、上次活跃的绝对时刻与相对时长——外加一个「停止全部」按钮打断所有运行中的子任务；集合清空后卡片定稿为 done（`/done` 时为 drained）终态。其数据来自 adapter 的子任务活动记录器，由每个被派发子任务的持久事件喂入、不依赖祖先投影（投影随父回合 detach 消亡——它只服务活跃回合的卡片）；gather 回合永不发面板，其活跃卡已在流式展示子任务活动。spawn 群的头像背景是五色生命周期信号：黄=尚无已批准的计划（讨论、直接干活、不做计划的运行同算），蓝=ExitPlanMode 卡挂起待批，绿=已批准，红=需要用户介入（挂起的提问/权限卡、出错回合、stall 超时），灰=`/done`；带 done 标记的群忽略其后的引擎回绘（停止结算的提问卡、回合终局回基线），直到 `/undone` 或下一条消息复活头像；同色转移被去重，每条飞书「更新了群头像」系统消息都对应真实状态变化，chatroom 家族与 brand 群保留群名哈希色、不参与该信号（[Agent Note](../../../.agents/notes/implemented/feature/2026-08-26-feishu-bridge-lifecycle-phase-avatar.zh.md)）。

模型可见面：入站消息（含引用链前缀、暂存附件路径注记）进 prompt；出站经卡片系统（进度卡/完成卡/审批卡）。以 error 为结束原因的 turn（如平台内容审查拒绝）把进度卡终态渲染为「执行失败」、错误文本替换实时播报段，并把错误文本记为该 turn 的回复；无活跃预览卡时错误以普通消息发出——工具调用之间的过渡叙述不会充当最终答复。每种 turn 退出都渲染终态卡：用户停与引擎停在事件循环走停臂、通道关闭竞速、插件 reload 三种落点下都落 ⏹ 已停止卡；stall 重试把停滞卡作废为 failed，agent 异常退出渲染失败卡，硬上限强杀同样先把运行卡渲染为失败、重置通知并说明挂起的追问/审批卡已随之失效；已停止渲染之后的迟到 Running PATCH 被丢弃。引擎停额外触发 state 的 stop 信号：卡片还在投递中就已停车的 ask 立即按 cancelled 结算，不再挂在已停平台上——停车的 tool call 不会活得比引擎更久、把会话泄漏成 coordinator 里的 live 注册；cron run 的调度器超时对其 `#cron:` 槽位触发同一停机信号，turn 停在 ask 上的无人值守运行也会在任务超时时结束（runtime 侧的 turn-cancel 单独到不了引擎侧的 ask 等待）。cron new-per-run 槽位上的 ask 与权限卡把回复上下文的裸 session key 盖进回调值，点击派发因此以裸键入站：ask 路由仅对卡片动作回落到最新的、带停泊 ask 的 `#cron:` 槽位——自由文本留在精确键上，普通聊天消息不得应答停泊的 cron ask（2026-08-31 cron-fbe6d268：点击当时掉落成普通 `askq:` 文本、排进了它本应结算的那个回合的队尾）。。ask 挂起时活跃预览卡以蓝色「等待中」收尾而非提前宣称「执行完成」（挂起前的段落已投递、turn 本身仍在等用户）；ask 结算时该卡头部原地 PATCH 为结果状态——已批准/已拒绝/已回答/已取消，导出/回复按钮保留、停止按钮让位给决策后的新卡——用户答完后不再有任何卡停留在「等待中」，且挂起期间的自然时间不计入硬回合上限——上限只在事件到达时评估，挂起的 ask 唯一等得到的事件就是用户的回答，不能被它唤醒的检查本身毁掉（2026-08-28 oc_9d385：隔夜追问的清晨回答正是这样被吞掉的）。stall 看门狗交叉核对 agent 会话自身的事件流活跃度（`AgentSession.lastStreamActivity`）：agent 仍在出流的 turn 绝不会被 idle 触发杀死；被降级交接致盲的泵记一条 `blind pump` 警告，且该豁免在事件流自身静默满一个空闲窗口后失效——冻结在「新于泵最后接收」位置上的流时钟不能再把会话锁永久钉死，孤儿泵启动日志会带上它开启时所依据的首事件。进度卡统计由原生会话事件驱动：携带原生失败身份的 tool result 把对应条目标红并计入 🔴调用失败，compaction 生命周期事件递增 🗸 计数（无活跃预览卡时降级为聊天消息），任原生生产者的整表 todo 快照替换置顶待办段（子代理子会话的列表留在其自己的卡片上）。CC_FEISHU_* 工作空间路由经 D3 setup 钩子注入系统提示段。普通项目聊天会话恒定携带一段固定的 agent 约定系统提示段（异步自主工作方式、好奇心上报、对所报发现追加收尾 ask_user_question 多选卡片，选项按推荐排序、`recommended: true` 的选项默认勾选，以及回合末一句话 skillify 提议）；普通会话与 subtask 子会话另携带 TDD 默认段（实现功能、修改行为、修复 bug 默认走 red-green-refactor 纪律，循环细节留给 `tdd` skill）；subtask 子会话与 chatroom 人设不含约定段——它们的发现分别经父会话与各自人设呈现。无人值守会话（无人类在群的 agent 派发子任务、chatroom 角色/直聊人设）自动批准工具审批且不进 plan 模式——Go effectiveMode 的 bypassPermissions——AskUserQuestion 与 plan 卡仍照常出现（attended 子任务保留完整审批；聊天室 moderator 保留正常工具审批路径，但同样永不进入 plan 模式——继承的项目 plan 默认在会话启动时被降级，这是对 Go effectiveMode 唯一的刻意偏离）。cron prompt 运行同样绝不继承 plan 型项目默认：未设 mode 的任务以 `default` 启动（显式任务 mode 仍生效），因为无人能批准那张 ExitPlanMode 卡。引擎唤醒的 turn（后台 job 完成通知、后台 subagent 报告）运行在孤儿 turn 泵上，投递、审批桥接与权限豁免与消息 turn 完全一致。计划审批可以附带一条输入框文字；该补充以用户消息 steer 进运行中的轮次、紧随批准 tool_result，因为评审答案本身必须保持仅 `selected`（任何 `custom` 都会被读作「继续规划」反馈）。配置了 `agent.planApprovalPreset` 的项目还会在同一时刻经 permission-presets 服务切换批准会话的权限预设：持久化的 preset / sandbox-mode / approval-policy 三事件在会话下一个受限调用生效（`danger-full-access` 档赋予计划执行期全文件访问、不再弹审批卡），拒绝、未配置或预设服务缺失则权限不变（缺失记为配置错误日志）。普通工具的拒绝理由同样经该 steer 通道逐字送达——审批 seam 只传 outcome，包装后的原生拒绝文案在下游会被丢弃。进度卡位移自愈保证活跃卡守住会话尾部——侧边栏摘要只跟踪最新消息，卡片只有占住尾部，原地 PATCH 才能持续刷新该摘要。平台维护按会话记的活动账本：入站消息与非预览出站消息（文本、卡片、文件投递）都会记入；内容刷新时发现卡片被压住，即以本次刷新内容在尾部重发（发新删旧），因此每条撤回墓碑都同时送达了新状态。卡片自身发送不记账，重发不会位移自己、并发预览卡也不会互相触发 bump 循环；改名/头像系统消息经其 im.chat.updated_v1 事件触达台账——由下一个内容节拍治愈，静默执行段由去抖后的 chat-changed 推送 bump 兜底（卡片头部 PATCH 与该系统消息存在竞速，不能只等内容节拍），bump 同样以台账位移为门，已占住尾部的卡（重发越过通知的卡、线程隔离卡）不再被无谓撤回重发；turn 结束的基线重绘挪到终态卡渲染之后执行、其系统消息落在一张永不重发的卡上；线程隔离卡永不重发（主群尾部对其无意义）。7668ddc9eb (docs(feishu-bridge): pair the cron ask-routing README sentences)

## Model Experience

### 请求上下文与条件

#### 模型可见内容

本插件不直接构造 LLM 请求——所有模型输入经 dsh agent 层（会话日志可完整重放），插件贡献的模型可见文本均为条件注入且按 Go 原文保形：入站 prompt 携带用户文本、引用链前缀（`[Quoted message from X]:` 单条格式或 `--- Reply chain (n messages) ---` 编号链）、暂存附件路径 bullets 与 `(Images saved locally, please read them: <paths>)` / `(Files saved locally, ...)` 注记；配置了 feishuWorkspace 的项目经 setup 钩子随会话注入「默认飞书工作空间」系统提示段（CC_FEISHU_* 值 + 创建优先级；chatroom bare persona 整体替换系统提示、不含此段）；chatroom bare persona 会话同时调 `agentInstructions.suppress()` 抑制工作区指令注入（AGENTS.md/CLAUDE.md reminder 不再随 user 消息搭车，对齐 Go `--bare` 禁用 CLAUDE.md 自动发现），并以 `tools.restrict({ deny: ['skill'] })` 拒掉 `skill` 工具——`<available_skills>` 目录与加载器随之消失；plan/reply 渲染 fork 的整体系统提示替换同样配以 `agentInstructions.suppress()`，并保留其工作工具（只拒全局 `skill` 工具、随之去掉 `<available_skills>` 目录——渲染 skill 正文已烤进其系统提示），workspace 指令因此不进渲染请求——该 fork 的事实只经 prompt 传递（html_path 加 plan-markdown / plan-rendered-html 块）；渲染 fork 与所有轻量旁路查询（群名生成、predict-next、turn summary、monitor triage）均以会话 origin `oneshot` 创建：按 cwd 派生的记忆索引不进其 user 消息，用完即弃的会话也不再生成 LLM 标题；轻量旁路查询完全 bare——一行式 complete 系统提示整体替换组装基线、`tools.restrict({ allow: [] })` 屏蔽全部工具——其请求只剩 prompt 本身；配置了 `mcpServers`（MCP server 名允许列表，per-project MCP 工具可见性）的项目在同一 setup 钩子里额外拒掉其余所有 server 的 `mcp__*` 工具——掩码覆盖普通会话、resume、fork、chatroom 人设与 one-shot 查询（bare 的 deny-all 查询把掩码折叠进其唯一一条限制），并以 `toolFilter` 转发给每个 continuable subtask 子会话（子会话不继承父会话的限制），由 `tests/agent-dsh/adapter-mcp-mask.spec.ts` 钉住；兄弟插件可在桥服务上登记按引擎的工具名掩码（`denyTools`），同一 setup 钩子把这些名字从该项目的会话中拒掉（并同样转发到子会话 `toolFilter`）——chatroom 插件对配置 `enabled: false` 的项目隐藏 `feishu_bridge_chatroom`，定义因此完全不进这些项目的请求；opt-in 的 `mcpHealth` 块注册 `feishu-bridge:mcp-health` runtime context，对每个被监视且启动宽限期后仍无任何 `mcp__<serverName>__*` 工具出现在进程级工具注册表中的 server 输出一行降级描述（含配置的 `fixHint`），让新会话在调用缺失工具前就知道该 MCP server 已降级——text 每次组装重新求值，全部被监视 server 的工具都在注册时零贡献；research assistant 子会话本质是 coding agent，与所有其他 subtask 子会话一样保留 cwd 指令发现——其共享工作区默认在 `<项目数据目录>/chatroom-research`（可配置），不在任何 chatroom 人设的 cwd 祖先链上，不会与其自身前导矛盾；每个普通项目聊天会话额外获得非 Go 来源的提示贡献——固定的 agent 约定系统提示段（`feishu-bridge-agent-conventions`，order 10：异步自主工作方式与聊天投递规则、好奇心上报约定、对「发现的问题 / 可优化点」一节追加收尾 ask_user_question 多选卡片、回合末 skillify 提议；subtask 子会话与 chatroom bare persona 不含）与 TDD 默认段（`feishu-bridge-tdd-default`，order 20：实现功能、修改行为、修复 bug 默认走 red-green-refactor 纪律，循环细节留给 `tdd` skill；普通会话与 subtask 子会话同样注册），均由 `tests/agent-dsh/adapter-persona.spec.ts` 逐字钉住；`feishu_bridge_subtask / cron / relay / lark / send` 工具族注册进 dsh 工具目录（chatroom 工具族来自兄弟 chatroom 插件），lark 工具结果为 lark-cli 子进程 stdout/stderr 原文，`feishu_bridge_send`（Go `cc-connect send` CLI 的工具形）把本地文件以图片/文件消息投递到用户所在会话（经 `Engine.sendToSessionWithAttachments`）；chatroom bare persona 携带 Go `ChatroomRoleBaseSystemPrompt` 的产物投递段，subtask 子会话以非 complete 段追加回报/no-report 前导（Go `buildAppendSystemPrompt` 的 `CC_SUBTASK` 分支）。

#### token 开销

条件注入：普通会话恒定携带固定的 agent 约定段（每会话常量前缀，约 1450 个字符）与 TDD 默认段（约 360 个字符），subtask 子会话只携带 TDD 默认段；chatroom 人设整体替换系统提示、两段皆无，对它们而言无附件/无引用/无 workspace 配置时均为零直接 token 开销；渲染 fork 额外去掉 workspace 指令（AGENTS.md/CLAUDE.md baseline）、记忆索引与 skill 目录，其输入只剩渲染系统提示与任务 prompt；bare 轻量旁路查询进一步收缩为一行 bare 系统提示加查询 prompt（无工具、无目录、无注入——线上实测一次群名查询 ~16.4k input token，其中 95% 以上是 bare 查询去掉的注入）；引用链上限 5 条消息；附件注记只含路径不含字节。配置了 `mcpServers` 的项目把非允许 MCP server 的工具 schema 从其每一步模型请求中移除（schema 是随每次请求发送的模型输入，节省在每步复现）；MCP 连接仍是进程级全局——掩码只管可见性。服务登记的拒绝工具名（如 chatroom 禁用项目上的 chatroom 工具）以同样方式离开该项目的请求。`mcpHealth` context 在全部被监视 server 健康时贡献零 token；每个降级 server 每次组装增加一行。

#### KV Cache 影响

引用前缀与附件注记附加在每条用户消息内（append-only 对话前缀，缓存友好）；agent 约定段、TDD 默认段与 workspace 系统提示段是每会话固定前缀段，会话内 prefix-stable；lark 工具结果作为工具消息一次性进入上下文，不回改历史。

## Known Limitations and Deferred Work

- **忙碌会话的消息队列仅服务人类消息且只存内存**：机器唤醒（子任务汇报、gather 汇总、chatroom 唤醒、follow-up 注入）经 steer 在回合中送达、从不入队，因此队列的语义——📬 排队通知回复、长度上限（`queue.maxDepth`，默认 5，溢出消息丢弃）、仅内存存储——如今只约束人类消息；排队与排空之间的一次 daemon 重启仍会丢失这些排队中的人类消息。Cron 提示按设计保留在消息管线上：其 mode 覆盖、workDir 切换与每轮新会话语义依赖完整消息路径。
- **`mcpHealth` 用「工具注册表存在性」推断降级，而非连接状态真值**：被监视 server 在无 scope 的注册表视图中看不到任何 `mcp__<serverName>__*` 工具即判「降级」——无法区分降因（token 过期、连接失败、重连耗尽），也没有精确的降级起始时刻（只有「启动宽限期之后」）。枚举假设 mcp-client 各行挂载在 profile 根层、注册因此落在全局工具层；挂进 agent-scoped preset 的 server 对全局视图不可见，会被判为永久降级。项目的 `mcpServers` 可见性掩码不影响该检测（它读的是注册真值，不是 per-session 可见性）。
- **被掩码的 MCP server 宕机期间创建的会话在其复活后泄漏其工具**：deny 掩码按会话创建时刻的 live 工具视图计算，而 deny 掩码放行晚到且未点名的全局工具——server 在会话启动后重连，其工具会回到该会话的视图，直到下次会话创建/resume 重算掩码。`mcpServers` 是可见性组合而非权限边界；server 名拼写错误与宕机不可区分（表现为该 server 工具缺席）。升级路径：core `tools` 的 pattern 化 restriction（见 per-project MCP 可见性 Agent Note）。

- **lark 工具仅支持 Feishu 域（open.feishu.cn）**：插件平台侧整体未移植 Go `larkCreds.Brand`（lark.com 双域名）；需要 lark 域时在 `src/tools/lark.ts` 与平台 client 引入 brand 维度。
- **send 工具只读本地路径**：Go CLI 的 `--image/--file` 还支持 http(s) URL 拉取；agent 产物都在磁盘上，该分支未移植。i18n 的 `relay_setup_ok`/`cron_setup_ok` 消息为保形移植残留：其 Go 调用方把 CLI 指令写进 agent 记忆文件，该机制在 dsh 下已过时（每个会话都有原生系统提示机制），不接线也不删除。
- **引用消息的发送者名不解析**：平台从不经通讯录 API 解析联系人名（M1 起的既定裁剪），引用链里发送者渲染为 `User`/`Bot`；需要真名时随平台补 `resolveUserName` 缓存。
- **`/learn` 引用仅在事件通路可用**：轮询兜底摄入的监控消息（`pollItemToMessage` 构造时不带 parent/引用信息）无法为 `/learn` 提供被引用示例；人类发的 `/learn` 走 WS 事件通路、能带上引用（监控群豁免 thread 隔离的引用抓取跳过）。
- **`reply_footer`（#11）余额段待 adapter 生长**：页脚本体已接线（M7-b，`status-footer.ts` buildReplyFooter，默认关）；余额段在 dsh adapter 长出 UsageReporter 前保持空缺（能力面已就绪）。
- **入站语音消息被丢弃（已裁定不迁）**：Go 经 `[speech]`（Whisper 兼容厂商）转写后喂给 agent；TS 平台按用户裁定（2026-08-21 审计）对 `audio` 消息直接丢弃。i18n 的 `voice_*` 文案为保形移植残留；将来需要语音输入时移植 speech.go 是升级路径。
- **agent 失败以原始报错呈现（已裁定不迁）**：Go 的 failure_classify.go（七类失败分类驱动用户文案）与 redact/（展示前脱敏）按同一裁定不移植；用户看到原始错误文本。
- **卡片按钮回调无法自动化测试**：`card.action.trigger` 只能真机点击验证（飞书平台无回调模拟 API）；按钮路径靠纯函数表测 + 真机冒烟覆盖。
- **多工作空间（multi-workspace）未迁移**：channel→workspace 绑定（Go workspace_binding.go）与 per-workspace agent 池未接线；单工作空间 + `/dir` per-chat override 承担现网需求，E 群清查记为 C 类。
- **fork 源彻底消失时静默降级**：seed 先取 live 注册表、再取 sessionPersistence 持久化日志（daemon 重启或 idle 回收后的仅持久化父会话也能 fork，与 Go 读盘一致）；带飞行中 turn 的父会话同样可种子——飞行 turn 在其最后一个平衡点被切割（悬空 tool call 以运行时 AbortError result 形状结算），并以合成 `step/end` + `turn/end(interrupted)` 收尾（`agent-dsh/fork-seed.ts`，扩展 Go 仅复制完成 turn 的语义）；只有源两边都找不到、或毫无可种子内容时才退化为全新会话，仅留日志 warn、不回复群消息。
- **`nav:/help` 按钮无效**：cron 卡片的返回按钮指向 Go 的 help 卡体系（`renderHelpGroupCard` + `nav:` 帮助导航），该体系未移植；点击会进 engine 打 "no handler" 日志而非静默消失。根治是移植 help 卡族；`/dir` 选择卡同样因此不带返回按钮。
- **位移自愈随内容节拍收敛，边界已知**：自愈搭在预览自身的节流刷新节拍上，被压住的卡在下一次状态变化落地时夺回尾部——静默工具执行期间侧栏继续显示压住它的消息（那本身就是最新信息）；不产生账本所记事件的位移类别（改名/头像之外的系统消息）在下一次被记活动前不治愈；chat-changed bump 与自愈共用台账门，其事件时刻只是系统消息落地的近似——落在消息落地与事件到达之间重发的卡仍会多付一次重发；合法重发的墓碑数等于被压次数——飞书除撤回重发外没有重排原语，turn 结束的头像重绘已不再贡献墓碑（挪到终态卡渲染之后），余下的复尾源只剩罕见的 attention 重绘（stall、子任务子会话死亡）与 turn 中途消息；同一群两个流式 bot 仍会互相压尾重发（现网单 bot 拓扑不存在该形态）。
- **`/list`、`/status`、`/switch` 仍是纯文本**：Go 侧渲染 `renderListCardSafe`/`renderStatusCard` 卡片并带 `act:/list switch|delete N` 动作；TS 命令保持文本输出，待该渲染域移植。
- **Go 命令清单为有意筛选**：`/shell`+`!`、`/tag`、`/untag`、`/undone`、`/notify`、`/board`、`/help`、`/ps` 已落地（Agent Note `feature/2026-08-20-feishu-bridge-shell-command.md` 与 `feature/2026-08-20-feishu-bridge-seven-commands.md`）；TS 原生另加 `/reload`（admin，detached 运行 reload.sh，见 OPERATIONS.md §3.3；非 Go `/restart` 的移植）、`/skills`、`/mcp`（只读查询：当前会话工作目录的运行时 skill 目录，以及在线 MCP 服务器清单，含降级与白名单遮蔽标注；无 Go 对应）与 `/context`（来自当前会话投影的上下文洞察卡：占用概览、六桶构成与逐轮趋势（原生 chart 元素）、最近上下文事件、会话统计与工具 schema 体积，卡片刷新按钮原地重读快照；未挂载 dsh-context 时降级为 token-meter 概览，无活跃 agent 会话时为友好空卡）；`/help` 列表从注册表动态生成、不会漂移。Go 53 条 builtin 命令剩余约 27 条为有意裁剪（用户裁定 2026-08-21）：upgrade/restart/web/doctor/version 属 D 类，其余（`/whoami`、`/history`、`/current`、`/search`、`/delete`、`/name`、`/memory`、`/model`、`/reasoning`、`/mode`、`/lang`、`/quiet`、`/tts`、`/allow`、`/config`、`/show`、`/diff` 等）设计上不迁；`/tts` 另依赖待裁定的语音能力面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
