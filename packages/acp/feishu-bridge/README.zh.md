# dsh-feishu-bridge

[English](README.md) | 中文

cc-connect 的编排能力（engine + 飞书平台）迁入 dsh 的单插件形态：一个长驻 dsh 进程按配置为每个 project 组装一个 Engine + 一个飞书 WS 平台（官方 node-sdk 长连接，D5），agent 会话经 `ctx.agents` 原生创建，不再有桥协议。迁移计划、里程碑与决策记录见 [docs/MIGRATION.md](docs/MIGRATION.md)；61 项 feature 对照见 [docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md)；部署与配置映射见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

插件结构：

| 目录 | 内容 |
|---|---|
| `src/engine/` | Go `core/` 保形移植：事件状态机、会话、命令、cron、relay、chatroom、monitor、i18n、附件暂存 |
| `src/feishu/` | Go `platform/feishu/` 移植：WS、API client、卡片、进度卡、群管理、标签、头像、媒体、引用消息抓取 |
| `src/agent-dsh/` | Agent 接口 → `ctx.agents` 适配器（D1/D3：setup 钩子、provider 路由、审批/问题/plan 接线） |
| `src/tools/` | `feishu_bridge_subtask / cron / relay / chatroom / lark / send` 工具族（D4：caller agent 路由，免 env） |
| `skills/` | 桥接 skill（`feishu-bridge-` 前缀）与部署的工作风格 skill（`tdd`、`skillify`），由 `apply()` 自动挂载为独立 skill provider，无需配置 `customSkillDirs` |

原生子任务（去包袱 B4）：profile 的 `dsh-base` bundle 挂 `SubagentRuntime`（`settlementNotice: 'external'`，经本 bundle patch 覆盖）与 in-process spawn/fork providers，`feishu_bridge_subtask` 的无人值守派发因此以原生 continuable 子会话运行——没有飞书群——世系、深度与冷恢复归原生运行时；引擎只保留父系记录（持久化于 project state、重启存活）与自己创建的 worktree。结算经 `subagent/end` 监听到达引擎：从未显式回报的子任务仍以群路径同款卡片 + `[子任务完成]` 唤醒投递其末条助手输出，追问的回答会重新武装该投递。`send` 排队到子任务当前轮之后（对 Go busy-reject 的刻意偏离），`interrupt` 停止当前轮而不销毁子任务，`/done` 与 chatroom end 排空原生后代（打断 + 干净 worktree 回收）。再显式挂 `dsh-subagent` 的 profile 会在 `subagents` 服务名上相撞——该服务归本桥所有。attended 群（`/spawn`、monitor 子群、chatroom 预派助手）保持群路径不变。

模型可见面：入站消息（含引用链前缀、暂存附件路径注记）进 prompt；出站经卡片系统（进度卡/完成卡/审批卡）。以 error 为结束原因的 turn（如平台内容审查拒绝）把进度卡终态渲染为「执行失败」、错误文本替换实时播报段，并把错误文本记为该 turn 的回复；无活跃预览卡时错误以普通消息发出——工具调用之间的过渡叙述不会充当最终答复。每种 turn 退出都渲染终态卡：用户停与引擎停在事件循环走停臂、通道关闭竞速、插件 reload 三种落点下都落 ⏹ 已停止卡；stall 重试把停滞卡作废为 failed，agent 异常退出渲染失败卡；已停止渲染之后的迟到 Running PATCH 被丢弃。已停止渲染之后的迟到 Running PATCH 被丢弃。引擎停额外触发 state 的 stop 信号：卡片还在投递中就已停车的 ask 立即按 cancelled 结算，不再挂在已停平台上——停车的 tool call 不会活得比引擎更久、把会话泄漏成 coordinator 里的 live 注册。stall 看门狗交叉核对 agent 会话自身的事件流活跃度（`AgentSession.lastStreamActivity`）：agent 仍在出流的 turn 绝不会被 idle 触发杀死；被降级交接致盲的泵记一条 `blind pump` 警告，只经硬性 turn 上限收尾。进度卡统计由原生会话事件驱动：携带原生失败身份的 tool result 把对应条目标红并计入 🔴调用失败，compaction 生命周期事件递增 🗸 计数（无活跃预览卡时降级为聊天消息），任原生生产者的整表 todo 快照替换置顶待办段（子代理子会话的列表留在其自己的卡片上）。CC_FEISHU_* 工作空间路由经 D3 setup 钩子注入系统提示段。普通项目聊天会话恒定携带一段固定的 agent 约定系统提示段（异步自主工作方式、好奇心上报、对所报发现追加收尾 ask_user_question 多选卡片，选项按推荐排序、`recommended: true` 的选项默认勾选）；subtask 子会话与 chatroom 人设不含此段——它们的发现分别经父会话与各自人设呈现。无人值守会话（无人类在群的 agent 派发子任务、chatroom 角色/直聊人设）自动批准工具审批且不进 plan 模式——Go effectiveMode 的 bypassPermissions——AskUserQuestion 与 plan 卡仍照常出现（attended 子任务保留完整审批；聊天室 moderator 保留正常工具审批路径，但同样永不进入 plan 模式——继承的项目 plan 默认在会话启动时被降级，这是对 Go effectiveMode 唯一的刻意偏离）。cron prompt 运行同样绝不继承 plan 型项目默认：未设 mode 的任务以 `default` 启动（显式任务 mode 仍生效），因为无人能批准那张 ExitPlanMode 卡。引擎唤醒的 turn（后台 job 完成通知、后台 subagent 报告）运行在孤儿 turn 泵上，投递、审批桥接与权限豁免与消息 turn 完全一致。计划审批可以附带一条输入框文字；该补充以用户消息 steer 进运行中的轮次、紧随批准 tool_result，因为评审答案本身必须保持仅 `selected`（任何 `custom` 都会被读作「继续规划」反馈）。普通工具的拒绝理由同样经该 steer 通道逐字送达——审批 seam 只传 outcome，包装后的原生拒绝文案在下游会被丢弃。

## Model Experience

### 请求上下文与条件

#### 模型可见内容

本插件不直接构造 LLM 请求——所有模型输入经 dsh agent 层（会话日志可完整重放），插件贡献的模型可见文本均为条件注入且按 Go 原文保形：入站 prompt 携带用户文本、引用链前缀（`[Quoted message from X]:` 单条格式或 `--- Reply chain (n messages) ---` 编号链）、暂存附件路径 bullets 与 `(Images saved locally, please read them: <paths>)` / `(Files saved locally, ...)` 注记；配置了 feishuWorkspace 的项目经 setup 钩子随会话注入「默认飞书工作空间」系统提示段（CC_FEISHU_* 值 + 创建优先级；chatroom bare persona 整体替换系统提示、不含此段）；chatroom bare persona 会话同时调 `agentInstructions.suppress()` 抑制工作区指令注入（AGENTS.md/CLAUDE.md reminder 不再随 user 消息搭车，对齐 Go `--bare` 禁用 CLAUDE.md 自动发现），并以 `tools.restrict({ deny: ['skill'] })` 拒掉 `skill` 工具——`<available_skills>` 目录与加载器随之消失；配置了 `mcpServers`（MCP server 名允许列表，per-project MCP 工具可见性）的项目在同一 setup 钩子里额外拒掉其余所有 server 的 `mcp__*` 工具——掩码覆盖普通会话、resume、fork、chatroom 人设与 one-shot 查询，并以 `toolFilter` 转发给每个 continuable subtask 子会话（子会话不继承父会话的限制），由 `tests/agent-dsh/adapter-mcp-mask.spec.ts` 钉住；research assistant 子会话本质是 coding agent，与所有其他 subtask 子会话一样保留 cwd 指令发现——其共享工作区默认在 `<项目数据目录>/chatroom-research`（可配置），不在任何 chatroom 人设的 cwd 祖先链上，不会与其自身前导矛盾；每个普通项目聊天会话额外获得唯一一段非 Go 来源的提示贡献——固定的 agent 约定系统提示段（`feishu-bridge-agent-conventions`，order 10：异步自主工作方式与聊天投递规则、好奇心上报约定、对「发现的问题 / 可优化点」一节追加收尾 ask_user_question 多选卡片；subtask 子会话与 chatroom bare persona 不含），由 `tests/engine/chatroom-persona.spec.ts` 逐字钉住；`feishu_bridge_subtask / cron / relay / chatroom / lark / send` 工具族注册进 dsh 工具目录，lark 工具结果为 lark-cli 子进程 stdout/stderr 原文，`feishu_bridge_send`（Go `cc-connect send` CLI 的工具形）把本地文件以图片/文件消息投递到用户所在会话（经 `Engine.sendToSessionWithAttachments`）；chatroom bare persona 携带 Go `ChatroomRoleBaseSystemPrompt` 的产物投递段，subtask 子会话以非 complete 段追加回报/no-report 前导（Go `buildAppendSystemPrompt` 的 `CC_SUBTASK` 分支）。

#### token 开销

条件注入：普通会话恒定携带固定的 agent 约定段（每会话常量前缀，约 1100 个中文字符）；chatroom 人设整体替换系统提示、subtask 子会话不含此段，对它们而言无附件/无引用/无 workspace 配置时均为零直接 token 开销；引用链上限 5 条消息；附件注记只含路径不含字节。配置了 `mcpServers` 的项目把非允许 MCP server 的工具 schema 从其每一步模型请求中移除（schema 是随每次请求发送的模型输入，节省在每步复现）；MCP 连接仍是进程级全局——掩码只管可见性。

#### KV Cache 影响

引用前缀与附件注记附加在每条用户消息内（append-only 对话前缀，缓存友好）；agent 约定段与 workspace 系统提示段是每会话固定前缀段，会话内 prefix-stable；lark 工具结果作为工具消息一次性进入上下文，不回改历史。

## Known Limitations and Deferred Work

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
- **fork 源彻底消失时静默降级**：seed 先取 live 注册表、再取 sessionPersistence 持久化日志（daemon 重启或 idle 回收后的仅持久化父会话也能 fork，与 Go 读盘一致）；只有源两边都找不到时才退化为全新会话，仅留日志 warn、不回复群消息。
- **chatroom picker 状态为内存态**：daemon 重启后已武装的 picker 丢失；孤儿选择卡的下一次点击会把卡原地替换为灰色「已失效」卡并提示重新 `/chatroom`（Go 的孤儿按钮为静默或假确认）；plan-render/usage/predict-next 等 M7 剩余域按 MIGRATION.md 队列推进。
- **`nav:/help` 按钮无效**：cron 卡片的返回按钮指向 Go 的 help 卡体系（`renderHelpGroupCard` + `nav:` 帮助导航），该体系未移植；点击会进 engine 打 "no handler" 日志而非静默消失。根治是移植 help 卡族；`/dir` 选择卡同样因此不带返回按钮。
- **`/list`、`/status`、`/switch` 仍是纯文本**：Go 侧渲染 `renderListCardSafe`/`renderStatusCard` 卡片并带 `act:/list switch|delete N` 动作；TS 命令保持文本输出，待该渲染域移植。
- **Go 命令清单为有意筛选**：`/shell`+`!`、`/tag`、`/untag`、`/undone`、`/notify`、`/board`、`/help`、`/ps` 已落地（Agent Note `feature/2026-08-20-feishu-bridge-shell-command.md` 与 `feature/2026-08-20-feishu-bridge-seven-commands.md`）；TS 原生另加 `/reload`（admin，detached 运行 reload.sh，见 OPERATIONS.md §3.3；非 Go `/restart` 的移植）；`/help` 列表从注册表动态生成、不会漂移。Go 53 条 builtin 命令剩余约 27 条为有意裁剪（用户裁定 2026-08-21）：upgrade/restart/web/doctor/version 属 D 类，其余（`/whoami`、`/history`、`/current`、`/search`、`/delete`、`/name`、`/memory`、`/model`、`/reasoning`、`/mode`、`/lang`、`/quiet`、`/tts`、`/allow`、`/config`、`/show`、`/diff` 等）设计上不迁；`/tts` 另依赖待裁定的语音能力面。
