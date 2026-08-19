# cc-connect → dsh-feishu-bridge 61 feature 对照表

逐项对照迁移源 `cc-connect` 的 `docs/features.md`（#1–#61；#35a「spawn 群反馈精简」作为 #35 的子项并入该行，编号总数恰为 61）。每行给出一句话描述与迁移状态，M7 验收逐项复核后更新本表。里程碑定义、架构决策与裁剪范围声明见 [MIGRATION.md](MIGRATION.md)（§0 范围声明、§4 阶段、D1–D10 决策）。

状态以 MIGRATION.md 里程碑记录加本 worktree 代码现状（2026-08-19）为准。Web UI / Management Server 不编号、整体在范围外（§0），不在本表。

| 状态 | 含义 |
|---|---|
| ✅ | 已迁移（含落点里程碑；M4 主体已完成，个别标注「收尾进行中」） |
| 📋 | 计划迁移（注明目标里程碑 M5–M7） |
| ✂️ | 不迁移（附理由，出处 MIGRATION.md §0） |
| ❓ | 待核实（证据不足，宁标勿猜） |

统计：✅ 34 · 📋 15 · ✂️ 10 · ❓ 2，合计 61。

| # | 特性 | 状态 | 里程碑 | 落点 / 理由 |
|---|---|---|---|---|
| 1 | UsageProvider：配置式服务商余量信息（/usage + buildCompletionUsage + ActiveDetector） | 📋 | M7 | usage 域 |
| 2 | notify_on_complete：任务完成后触发飞书通知红点 | ✅ | M2 | `projects[].feishu.notifyOnComplete`；真机验证（✅ 通知 tokens 行） |
| 3 | dir_scan_paths：自动扫描子目录加入 /dir 列表 | 📋 | M7 | dir_scan |
| 4 | 多选问题（MultiSelect）：checker+form 渲染 | ✅ | M3 | askq_multi 回调路径 |
| 5 | Inline Plan 去重（两条路径不重复显示） | ✅ | M3 | plan 域 |
| 6 | ExitPlanMode 前先以 markdown 展示 plan 内容 | ✅ | M3 | plan 域 |
| 7 | flip minimax 修复（IsActive 纯缓存名比对） | ✂️ | — | §0 裁定；新架构 provider 切换为 dispose + 同 sessionId resume 重建（D1），无旧缓存比对路径 |
| 8 | 图片发送改用文件路径（不 base64 内嵌） | ❓ | — | 平台侧图片下载已实现（M4 media）；adapter.send 目前仅附文件名注记，图片进模型上下文的通路未接线——dsh 原生图片消息格式与归属里程碑待核实 |
| 9 | 全局 Providers：跨项目共享模型配置 + /provider 切换 | ✅ | M7-c | /provider list/switch/current/clear + provider_shortcuts（/strong 等）+ 切换持久化（project state）；add/remove/presets 不迁移——provider = profile 命名路由，运行时不可创建 |
| 10 | tool_progress：quiet 模式工具进度卡片 | ✅ | M2 | 真机验证（display 转发补齐后） |
| 11 | reply_footer 默认关闭（ctx/余额只走 ✅ 通知） | ❓ | — | `features.replyFooter` 键已声明但未见接线；「默认关」语义天然成立，Codex 式页脚本体是否单独实现待核实（完整状态页脚属 #26、M7） |
| 12 | per-provider context_window | 📋 | M7 | 消费方是 ctx indicator（#14/#26 完整状态页脚，usage 域）；/provider 切换本体已随 M7-c 落地 |
| 13 | 消息排队机制（session 启动期不丢弃） | ✅ | M1 | engine 事件循环 |
| 14 | ctx indicator 移至 ✅ 通知（原始 token 累积值） | ✅ | M2 | 完成通知 |
| 15 | auto-approve 不跳过 AskUserQuestion / ExitPlanMode | ✅ | M3 | 审批域 |
| 16 | GLM 反爬指纹绕过（rewrite_tui_fingerprint） | ✂️ | — | §0：由 profile 的 llm 路由承担（plain model name 规避 + forceAdaptiveThinking 兼容项）；providerproxy 整体不迁移 |
| 17 | --as user 透传 + lark-auth 编排 | 📋 | M7 | feishu_bridge_lark 透传工具（D4） |
| 18 | feishu_workspace：每 bot 默认飞书空间（CC_FEISHU_* 注入） | 📋 | M7 | CC_FEISHU_* 进工具上下文 |
| 19 | tool_progress 合并 entry + ToolID 匹配 + 失败保留 | ✅ | M2 | progress 域 |
| 20 | restrict_to_workdir：限制 bot 只访问项目目录 | ✅ | M3 | 以 D3 setup 钩子 restrict()（dsh 原生）承担，不再写 .claude/settings.local.json deny 规则 |
| 21 | Feishu Card Schema 2.0 迁移 | ✅ | M2 | card 构造器全集 |
| 22 | TopNotice First Message（置顶横幅，单条） | ✅ | M2 | ChatTopNotice 路径 |
| 23 | Placeholder Card：首条推送通知加速 | ✅ | M2 | showPlaceholder |
| 24 | Auto-Compaction 检测与通知 | ✅ | M3 | compaction 卡 |
| 25 | 累计 Token 追踪 + 每轮增量显示 | ✅ | M2 | 完成通知 ctx 行 |
| 26 | 统一多行状态页脚（model/ctx/workdir/git/RAM） | ✅ | M2 | 基础页脚完成；完整状态页脚（model/ctx%/git 分支/RAM 行）M7 补（engine 内 TODO(M7) 注记） |
| 27 | allow_chat 白名单过滤 + 共享 WebSocket | ✅ | M1 | 共享 WS 由 node-sdk 每 app 一个 client 天然承担 |
| 28 | NO_REPLY 标记静默回复 | ✅ | M2 | isSilentReply/stripTrailingSilent 引擎 reply 路径（M2 移植）；M7-c 补引擎级投递抑制测试 |
| 29 | plan_max_len 配置 | ✅ | M3 | display.planMaxLen |
| 30 | 消息撤回取消排队消息 | ✅ | M7-c | cancelQueuedByMessageID + platform im.message.recalled_v1（根层扁平 snake_case）+ engine.start 接线 |
| 31 | AskUserQuestion 卡片增强（header + 选项预览） | ✅ | M3 | 问题卡渲染 |
| 32 | 流式卡片合并（progress + summary 统一卡片） | ✅ | M2 | streaming 域 |
| 33 | Predict Next：回复后预测用户下一步 | ✅ | M7-c | generatePrediction（lightweight/resume 双模式）+ 洞察卡（发送/屏蔽按钮，turnSeq 防过期）+ turn_summary 合并卡片 + /btw 旁路提问 |
| 34 | /spawn（/sp）：快速创建独立任务群聊 | ✅ | M4 | 真机三轮冒烟通过 |
| 35 | Pin 每条用户消息到 Pin 面板（spawn 群） | ✅ | M4 | MessagePinAppender；子项 #35a（spawn 群反馈精简）：topnotice 门控已对齐（spawn 群默认关），表情关闭门控未见移植——TS 引擎尚未接线 startTyping/Done/CrossMark 反应链，随 E 群清查/M7 核实 |
| 36 | /fork（/fk）：复制上下文的隔离分支群 | ✅ | M4 | completedTurnPrefix seed（原生 agents.create）；天花板：父会话需 live（代码内已注记） |
| 37 | /done --reply 回灌父会话 + /spawn --dir 换目录 | ✅ | M4 | 真机验证（--dir 修复后） |
| 38 | 父子群视觉关联（跳转按钮 + /notify + /board 树形） | ✅ | M4 | 跳转/notify/board 完成；im.chat.updated_v1 改名同步属 M4 收尾（D 群补缺进行中） |
| 39 | /spawn /fork --worktree：子群跑独立 git worktree | ✅ | M4 | act:/wt Keep/Remove 卡回调完成 |
| 40 | subtask CLI：agent 自主多 agent 协作（spawn/report） | ✅ | M4 | feishu_bridge_subtask 工具族 + 修订版 skill；真机全链路 |
| 41 | /chatroom：多 agent 圆桌聊天室 | 📋 | M5 | chatroom 域 |
| 42 | subtask gather：批量回报屏障（父 agent 等齐再综合） | 📋 | M7 | 屏障机制与 M5 chatroom gather 同源，落点可能随排期提前 |
| 43 | /chatroom 角色挑选多选卡 + 单角色直聊 | 📋 | M5 | chatroom 域 |
| 44 | 禁用 Claude Code 后台 subagent（env 注入） | ✂️ | — | CLAUDE_CODE_* env 注入是 CLI 子进程 spawn 契约；dsh 原生 agent 无 stream-json turn 边界溢出问题（§0） |
| 45 | opencode agent 后端（第三后端） | ✂️ | — | 多 CLI 后端模型退役：agent 会话经 ctx.agents 原生创建（§1），无 CLI 子进程后端 |
| 46 | mimocode agent 后端（第四后端） | ✂️ | — | 同 #45 |
| 47 | plan→HTML engine 派生渲染（ExitPlanMode 异步出 HTML） | 📋 | M7 | 渲染会话 = create + seed + 无工具 + stall 重试 |
| 48 | 回复 speculative 自动投递 HTML | 📋 | M7 | 复用 #47 fork 机制 |
| 49 | 子群 LLM 自动命名（engine 侧 fork） | ✅ | M4 | 全链路完成并真机验证（2026-08-19：占位名「开发虾 副本」→ LLM 改名「登录页CSS对齐修复」）；config schema + setGroupNameConfig + adapter lightweightQuery 已随 D 群补缺合并 |
| 50 | 防 MCP 工具自动后台化（env 注入） | ✂️ | — | 同 #44（CLAUDE_CODE_* spawn 契约族） |
| 51 | Lucide 图标库增强 HTML 渲染 | 📋 | M7 | M0 已移植 lucide 纯逻辑（12 测试）；sprite 抽取/模板注入随 #47/#48 |
| 52 | /spawn 子群按群名自动设 Lucide 图标头像 | ✅ | M4 | 真机验证：align-center-vertical 彩色+灰度双 key 上传（2026-08-19） |
| 53 | Monitor 群监控 → 自主拉群排查 / 中枢分发 | 📋 | M6 | #53 全量（规则/LLM 分诊/coalesce/no_report/轮询兜底//monitor） |
| 54 | 进度卡 header 思考/执行 GIF | ✅ | M2 | M4-C 修资源解析路径，真机确认 |
| 55 | /fork 回滚（引用历史消息 fork 到某个 turn） | ✂️ | — | §0：claudecode-only。注：M4 Wave 1 记录曾将 fork-at 列为 M7 遗留（Go dsh 后端 #60 Phase 2 有 session-log 截断先例）；若 M7 决定以 dsh session log 实现，本行改 📋 |
| 56 | monitor no_report 规则（子群免回报父群） | 📋 | M6 | 随 #53 全量 |
| 57 | /chatroom --research 并行研究作战室 | 📋 | M5 | chatroom 域 |
| 58 | 跨会话消息观察（SendMessage/ListAgents 核查记录） | ✂️ | — | Claude Code 特定机制的升级核查记录；dsh 无此问题（§0） |
| 59 | /chatroom 随便聊聊（topic-pick 单选卡） | 📋 | M5 | chatroom 域 |
| 60 | dsh agent 后端（三层桥接入） | ✂️ | — | 被新架构本体取代：旧三层桥（Go agent/dsh + stdio JSON-RPC + bridge profile）正是本次迁移消除的层（§0）；能力由 agent-dsh/ 适配器直接承担 |
| 61 | dsh bash sandbox 关闭（danger-full-access） | ✂️ | — | 配置层承担：feishu-bridge profile 的 sandbox-policy override（cordis.patch.yml），无引擎代码可迁 |
