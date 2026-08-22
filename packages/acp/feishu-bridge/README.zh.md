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
| `skills/` | 修订版技能（`feishu-bridge-` 前缀），经 profile `customSkillDirs` 加载 |

模型可见面：入站消息（含引用链前缀、暂存附件路径注记）进 prompt；出站经卡片系统（进度卡/完成卡/审批卡）。以 error 为结束原因的 turn（如平台内容审查拒绝）把进度卡终态渲染为「执行失败」、错误文本替换实时播报段，并把错误文本记为该 turn 的回复；无活跃预览卡时错误以普通消息发出——工具调用之间的过渡叙述不会充当最终答复。CC_FEISHU_* 工作空间路由经 D3 setup 钩子注入系统提示段。无人值守会话（无人类在群的 agent 派发子任务、chatroom 角色/直聊人设）自动批准工具审批且不进 plan 模式——Go effectiveMode 的 bypassPermissions——AskUserQuestion 与 plan 卡仍照常出现（attended 子任务与 moderator 保留完整审批）。计划审批可以附带一条输入框文字；该补充以用户消息 steer 进运行中的轮次、紧随批准 tool_result，因为评审答案本身必须保持仅 `selected`（任何 `custom` 都会被读作「继续规划」反馈）。普通工具的拒绝理由同样经该 steer 通道逐字送达——审批 seam 只传 outcome，包装后的原生拒绝文案在下游会被丢弃。

## Model Experience

### 请求上下文与条件

#### 模型可见内容

本插件不直接构造 LLM 请求——所有模型输入经 dsh agent 层（会话日志可完整重放），插件贡献的模型可见文本均为条件注入且按 Go 原文保形：入站 prompt 携带用户文本、引用链前缀（`[Quoted message from X]:` 单条格式或 `--- Reply chain (n messages) ---` 编号链）、暂存附件路径 bullets 与 `(Images saved locally, please read them: <paths>)` / `(Files saved locally, ...)` 注记；配置了 feishuWorkspace 的项目经 setup 钩子随会话注入「默认飞书工作空间」系统提示段（CC_FEISHU_* 值 + 创建优先级；chatroom bare persona 整体替换系统提示、不含此段）；`feishu_bridge_subtask / cron / relay / chatroom / lark / send` 工具族注册进 dsh 工具目录，lark 工具结果为 lark-cli 子进程 stdout/stderr 原文，`feishu_bridge_send`（Go `cc-connect send` CLI 的工具形）把本地文件以图片/文件消息投递到用户所在会话（经 `Engine.sendToSessionWithAttachments`）；chatroom bare persona 携带 Go `ChatroomRoleBaseSystemPrompt` 的产物投递段，subtask 子会话以非 complete 段追加回报/no-report 前导（Go `buildAppendSystemPrompt` 的 `CC_SUBTASK` 分支）。

#### token 开销

条件注入：无附件/无引用/无 workspace 配置时均为零直接 token 开销；引用链上限 5 条消息；附件注记只含路径不含字节。

#### KV Cache 影响

引用前缀与附件注记附加在每条用户消息内（append-only 对话前缀，缓存友好）；workspace 系统提示段是每会话固定前缀段，会话内 prefix-stable；lark 工具结果作为工具消息一次性进入上下文，不回改历史。

## Known Limitations and Deferred Work

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
- **chatroom picker 状态为内存态**：daemon 重启后旧选择卡成孤儿（Go 保形）；plan-render/usage/predict-next 等 M7 剩余域按 MIGRATION.md 队列推进。
- **`nav:/help` 按钮无效**：cron 卡片的返回按钮指向 Go 的 help 卡体系（`renderHelpGroupCard` + `nav:` 帮助导航），该体系未移植；点击会进 engine 打 "no handler" 日志而非静默消失。根治是移植 help 卡族；`/dir` 选择卡同样因此不带返回按钮。
- **`/list`、`/status`、`/switch` 仍是纯文本**：Go 侧渲染 `renderListCardSafe`/`renderStatusCard` 卡片并带 `act:/list switch|delete N` 动作；TS 命令保持文本输出，待该渲染域移植。
- **Go 命令清单为有意筛选**：`/shell`+`!`、`/tag`、`/untag`、`/undone`、`/notify`、`/board`、`/help`、`/ps` 已落地（Agent Note `feature/2026-08-20-feishu-bridge-shell-command.md` 与 `feature/2026-08-20-feishu-bridge-seven-commands.md`）；TS 原生另加 `/reload`（admin，detached 运行 reload.sh，见 OPERATIONS.md §3.3；非 Go `/restart` 的移植）；`/help` 列表从注册表动态生成、不会漂移。Go 53 条 builtin 命令剩余约 27 条为有意裁剪（用户裁定 2026-08-21）：upgrade/restart/web/doctor/version 属 D 类，其余（`/whoami`、`/history`、`/current`、`/search`、`/delete`、`/name`、`/memory`、`/model`、`/reasoning`、`/mode`、`/lang`、`/quiet`、`/tts`、`/allow`、`/config`、`/show`、`/diff` 等）设计上不迁；`/tts` 另依赖待裁定的语音能力面。
