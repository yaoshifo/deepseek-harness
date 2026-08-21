# cc-connect → dsh-feishu-bridge 61 feature 对照表

逐项对照迁移源 `cc-connect` 的 `docs/features.md`（#1–#61；#35a「spawn 群反馈精简」作为 #35 的子项并入该行，编号总数恰为 61）。每行给出一句话描述与迁移状态，M7 验收逐项复核后更新本表。里程碑定义、架构决策与裁剪范围声明见 [MIGRATION.md](MIGRATION.md)（§0 范围声明、§4 阶段、D1–D10 决策）。

状态以 MIGRATION.md 里程碑记录加本 worktree 代码现状（2026-08-20）为准。Web UI / Management Server 不编号、整体在范围外（§0），不在本表。

| 状态 | 含义 |
|---|---|
| ✅ | 已迁移（含落点里程碑；M4 主体已完成，个别标注「收尾进行中」） |
| 📋 | 计划迁移（注明目标里程碑 M5–M7） |
| ✂️ | 不迁移（附理由，出处 MIGRATION.md §0） |
| ❓ | 待核实（证据不足，宁标勿猜） |

统计：✅ 51 · ✂️ 10 · 📋 1（#63）· ❓ 0，合计 61（M5–M7 验收后全量复核更新；#62 为迁移期补充行不计入）。

补充行（不在源 61 项内，迁移期发现的能力缺口）：#62 send CLI 附件投递；#63 后台任务可视化（源 Go `b5d15a0b`，2026-08-18，晚于源表冻结）。

| # | 特性 | 状态 | 里程碑 | 落点 / 理由 |
|---|---|---|---|---|
| 1 | UsageProvider：配置式服务商余量信息（/usage + buildCompletionUsage + ActiveDetector） | ✅ | M7-b | `src/engine/usage.ts`（glm/minimax 工厂注册 + 5min 缓存 + ActiveDetector/SyncUsageFetcher 能力面）+ `usage_providers` 配置块；/usage 命令本体未移植（Go 无对应输出需求方，quota 已上 ✅ 页脚 ⌛ 行） |
| 2 | notify_on_complete：任务完成后触发飞书通知红点 | ✅ | M2 | `projects[].feishu.notifyOnComplete`；真机验证（✅ 通知 tokens 行） |
| 3 | dir_scan_paths：自动扫描子目录加入 /dir 列表 | ✅ | M7-d | `dirScanPaths` 配置 + `setScanPaths` 装配 + 模糊兜底（resolveScanPathFuzzy 随迁），/dir 建议列表与裸名解析全链路 |
| 4 | 多选问题（MultiSelect）：checker+form 渲染 | ✅ | M3 | askq_multi 回调路径 |
| 5 | Inline Plan 去重（两条路径不重复显示） | ✅ | M3 | plan 域 |
| 6 | ExitPlanMode 前先以 markdown 展示 plan 内容 | ✅ | M3 | plan 域 |
| 7 | flip minimax 修复（IsActive 纯缓存名比对） | ✂️ | — | §0 裁定；新架构 provider 切换为 dispose + 同 sessionId resume 重建（D1），无旧缓存比对路径 |
| 8 | 图片发送改用文件路径（不 base64 内嵌） | ✅ | M7-d | 核实结论：Go dsh 后端从不把图片字节放进模型上下文——纯附件消息落盘 `<workDir>/.cc-connect/pending/<hash>/` 暂存（Go 原名，TS 改名 `.feishu-bridge`）、下一条文本消息以路径 bullets 拼进 prompt；带文字消息经 dshSession.Send 落盘 attachments 目录并附路径注记。TS 已接线（stageAttachments/drain/splice/discard + adapter.send 落盘注记）；暂存根目录有意改名 `.feishu-bridge`（cc-connect 退役，M8 前补充 7），子结构与语义不变 |
| 9 | 全局 Providers：跨项目共享模型配置 + /provider 切换 | ✅ | M7-c | /provider list/switch/current/clear + provider_shortcuts（/strong 等）+ 切换持久化（project state）；add/remove/presets 不迁移——provider = profile 命名路由，运行时不可创建 |
| 10 | tool_progress：quiet 模式工具进度卡片 | ✅ | M2 | 真机验证（display 转发补齐后） |
| 11 | reply_footer 默认关闭（ctx/余额只走 ✅ 通知） | ✅ | M7-b | 已核实并接线：Go 语义 = 每条非静默回复尾部追加 `*model · effort · 余额% · workdir*`（engine_send.go buildReplyFooter），默认关。TS 完整移植（`status-footer.ts` buildReplyFooter，能力面探测 getSession→agent）；天花板：dsh adapter 无 UsageReporter/ContextUsageReporter，生产页脚只含 model · effort · workdir（余额段空缺，能力面就绪待 adapter 生长） |
| 12 | per-provider context_window | ✅ | M8 前 | `providers[].contextWindow` 配置 → adapter 路由携带 → `getActiveProvider()` 带出 → 装配与 /provider 全部切换点（switch / --resume / clear / shortcut）后 `applyActiveProviderContextWindow()` 重算；未声明窗口的路由回退 project 级 `contextWindow`（默认 200k）。补齐 FEATURE-PARITY 复核时发现的天花板 |
| 13 | 消息排队机制（session 启动期不丢弃） | ✅ | M1 | engine 事件循环 |
| 14 | ctx indicator 移至 ✅ 通知（原始 token 累积值） | ✅ | M7-b | 完整版：SDK token 累积（turnDelta/cum + cache delta/cum + numTurns + compaction）与 self-report `[ctx: ~N%]` 剥离均已接入 |
| 15 | auto-approve 不跳过 AskUserQuestion / ExitPlanMode | ✅ | M3 | 审批域 |
| 16 | GLM 反爬指纹绕过（rewrite_tui_fingerprint） | ✂️ | — | §0：由 profile 的 llm 路由承担（plain model name 规避 + forceAdaptiveThinking 兼容项）；providerproxy 整体不迁移 |
| 17 | --as user 透传 + lark-auth 编排 | ✅ | M7-d | `feishu_bridge_lark` 透传工具：bot 进程内 mint TAT + LARKSUITE_CLI_* 注入，`--as user` / auth 子命令走 `--profile <app_id>` 前置，`im +chat-messages-list` 原生直调 raw_card_content |
| 18 | feishu_workspace：每 bot 默认飞书空间（CC_FEISHU_* 注入） | ✅ | M7-d | `feishuWorkspace` 配置块 → engine `setFeishuWorkspace`/`feishuWorkspaceEnv`（含 relay 注入）→ adapter setup 钩子注入系统提示段（D3 替代进程 env） |
| 19 | tool_progress 合并 entry + ToolID 匹配 + 失败保留 | ✅ | M2 | progress 域 |
| 20 | restrict_to_workdir：限制 bot 只访问项目目录 | ✂️ | — | 2026-08-21 审计核实：本行原标 ✅「D3 setup 钩子 restrict() 承担」不实——TS 全库无 restrict 通路；生产旧配置未启用该键。用户裁定不迁移（如将来需要，dsh 原生 restrict 能力是升级路径） |
| 21 | Feishu Card Schema 2.0 迁移 | ✅ | M2 | card 构造器全集 |
| 22 | TopNotice First Message（置顶横幅，单条） | ✅ | M2 | ChatTopNotice 路径 |
| 23 | Placeholder Card：首条推送通知加速 | ✅ | M2 | showPlaceholder |
| 24 | Auto-Compaction 检测与通知 | ✅ | M3 | compaction 卡 |
| 25 | 累计 Token 追踪 + 每轮增量显示 | ✅ | M2 | 完成通知 ctx 行 |
| 26 | 统一多行状态页脚（model/ctx/workdir/git/RAM） | ✅ | M7-b | 完整页脚落地：🤖 模型·模式 / 📊 ctx / 🍵 缓存命中 / 📂 workdir·git 分支+📝 改动文件 / ⌛ 费用 / 💾 RAM·磁盘 / 会话·chat ID / 🔗 editor_url；紫色通知卡完整形态（headerSuffix+折叠面板+sendCardWithHandle+notificationHandle 状态+spawn 跳转链+subtask diff）；RAM 改用 os.totalmem（Go 读 /proc/meminfo 在 macOS 无 RAM 行，刻意分歧） |
| 27 | allow_chat 白名单过滤 + 共享 WebSocket | ✅ | M1 | 共享 WS 由 node-sdk 每 app 一个 client 天然承担 |
| 28 | NO_REPLY 标记静默回复 | ✅ | M2 | isSilentReply/stripTrailingSilent 引擎 reply 路径（M2 移植）；M7-c 补引擎级投递抑制测试 |
| 29 | plan_max_len 配置 | ✅ | M3 | display.planMaxLen |
| 30 | 消息撤回取消排队消息 | ✅ | M7-c | cancelQueuedByMessageID + platform im.message.recalled_v1（根层扁平 snake_case）+ engine.start 接线 |
| 31 | AskUserQuestion 卡片增强（header + 选项预览） | ✅ | M3 | 问题卡渲染 |
| 32 | 流式卡片合并（progress + summary 统一卡片） | ✅ | M2 | streaming 域 |
| 33 | Predict Next：回复后预测用户下一步 | ✅ | M7-c | generatePrediction（lightweight/resume 双模式）+ 洞察卡（发送/屏蔽按钮，turnSeq 防过期）+ turn_summary 合并卡片 + /btw 旁路提问 |
| 34 | /spawn（/sp）：快速创建独立任务群聊 | ✅ | M4 | 真机三轮冒烟通过 |
| 35 | Pin 每条用户消息到 Pin 面板（spawn 群） | ✅ | M4 | MessagePinAppender；子项 #35a（spawn 群反馈精简）：topnotice 门控已对齐（spawn 群默认关）；表情链裁定不迁（2026-08-21 用户裁定）——platform 的 startTyping/Done/CrossMark 机制已移植但引擎不接调用点（Go engine_events.go:1370/4981/5317、engine_predict.go:81），进度卡/完成卡已承担全部反馈 |
| 36 | /fork（/fk）：复制上下文的隔离分支群 | ✅ | M4 | completedTurnPrefix seed（原生 agents.create）；M8 前补充 19 解除 live-only 天花板：seed live 优先、持久化兜底（Go 读盘对齐） |
| 37 | /done --reply 回灌父会话 + /spawn --dir 换目录 | ✅ | M4 | 真机验证（--dir 修复后） |
| 38 | 父子群视觉关联（跳转按钮 + /notify + /board 树形） | ✅ | M4 | 跳转卡完成；/notify /board 命令本体 2026-08-20 补齐（M4 时仅 spawn 通知卡在，命令未注册）；im.chat.updated_v1 改名同步属 M4 收尾（D 群补缺进行中） |
| 39 | /spawn /fork --worktree：子群跑独立 git worktree | ✅ | M4 | act:/wt Keep/Remove 卡回调完成 |
| 40 | subtask CLI：agent 自主多 agent 协作（spawn/report） | ✅ | M4 | feishu_bridge_subtask 工具族 + 修订版 skill；真机全链路 |
| 41 | /chatroom：多 agent 圆桌聊天室 | ✅ | M5 | 真机全链路：角色挑选卡 → 多轮 gather relay → end barrier → synthesis + roles_removed 回收 |
| 42 | subtask gather：批量回报屏障（父 agent 等齐再综合） | ✅ | M4 | `feishu_bridge_subtask` gather action + subtask.gather_timeout_sec 装配（M4-E 接线）；chatroom gather 屏障同源（M5） |
| 43 | /chatroom 角色挑选多选卡 + 单角色直聊 | ✅ | M5 | chatroom-pick.ts 状态机 + startChatroomDirectRole 1:1 直聊 |
| 44 | 禁用 Claude Code 后台 subagent（env 注入） | ✂️ | — | CLAUDE_CODE_* env 注入是 CLI 子进程 spawn 契约；dsh 原生 agent 无 stream-json turn 边界溢出问题（§0） |
| 45 | opencode agent 后端（第三后端） | ✂️ | — | 多 CLI 后端模型退役：agent 会话经 ctx.agents 原生创建（§1），无 CLI 子进程后端 |
| 46 | mimocode agent 后端（第四后端） | ✂️ | — | 同 #45 |
| 47 | plan→HTML engine 派生渲染（ExitPlanMode 异步出 HTML） | ✅ | M7 | plan-render.ts 渲染会话（create + seed + 无工具 + stall 重试）；真机首通（HTML→PNG→群内图片卡） |
| 48 | 回复 speculative 自动投递 HTML | ✅ | M7 | 复用渲染会话 fork 机制；真机长回复触发自动渲染投递 |
| 49 | 子群 LLM 自动命名（engine 侧 fork） | ✅ | M4 | 全链路完成并真机验证（2026-08-19：占位名「开发虾 副本」→ LLM 改名「登录页CSS对齐修复」）；config schema + setGroupNameConfig + adapter lightweightQuery 已随 D 群补缺合并 |
| 50 | 防 MCP 工具自动后台化（env 注入） | ✂️ | — | 同 #44（CLAUDE_CODE_* spawn 契约族） |
| 51 | Lucide 图标库增强 HTML 渲染 | ✅ | M7 | lucide/sprite.ts 抽取 + plan-render-templates.ts 模板注入（M0 纯逻辑随迁） |
| 52 | /spawn 子群按群名自动设 Lucide 图标头像 | ✅ | M4 | 真机验证：align-center-vertical 彩色+灰度双 key 上传（2026-08-19） |
| 53 | Monitor 群监控 → 自主拉群排查 / 中枢分发 | ✅ | M6 | 规则快路 + LLM 分诊 + dispatch/monitor 双模式 + coalesce + no_report + 轮询兜底 + /monitor；真机告警全链路（拉群排查 → /done --reply 回报） |
| 54 | 进度卡 header 思考/执行 GIF | ✅ | M2 | M4-C 修资源解析路径，真机确认 |
| 55 | /fork 回滚（引用历史消息 fork 到某个 turn） | ✅ | M8 | 经 sessionPersistence inspect 定位（10 分钟时间窗 + 文本前缀匹配，Go locateForkCut 保形）+ 截断前缀 create/append 到新 id，`__forkat__` 哨兵 resume；父会话无需 live（优于 #36 的 live-only 天花板，仅此路径）。引用计划卡 `/spawn` 回滚（Go spawnFromQuotedPlan）不迁移（用户裁定 2026-08-21）：与 #55 路径功能重叠（引用计划卡 + `/fork` 已覆盖「带调研上下文回滚到计划 turn」），`feishu_bridge_subtask` 的 fork 已覆盖派发场景 |
| 56 | monitor no_report 规则（子群免回报父群） | ✅ | M6 | monitor.ts no_report，随 #53 全量 |
| 57 | /chatroom --research 并行研究作战室 | ✅ | M5 | research venv provisioning + uv hooks + armResearchManualAskTimeout |
| 58 | 跨会话消息观察（SendMessage/ListAgents 核查记录） | ✂️ | — | Claude Code 特定机制的升级核查记录；dsh 无此问题（§0） |
| 59 | /chatroom 随便聊聊（topic-pick 单选卡） | ✅ | M5 | chatroom-pick.ts 选题单选卡状态机 |
| 60 | dsh agent 后端（三层桥接入） | ✂️ | — | 被新架构本体取代：旧三层桥（Go agent/dsh + stdio JSON-RPC + bridge profile）正是本次迁移消除的层（§0）；能力由 agent-dsh/ 适配器直接承担 |
| 61 | dsh bash sandbox 关闭（danger-full-access） | ✂️ | — | 配置层承担：feishu-bridge profile 的 sandbox-policy override（cordis.patch.yml），无引擎代码可迁 |
| 62 | `cc-connect send` CLI：agent 把生成的文件/图片作为消息投递给用户（side-channel 附件回传） | ✅ | M8 前 | `src/tools/send.ts` `feishu_bridge_send` 工具（D4 caller-agent 路由）→ `Engine.sendToSessionWithAttachments`（引擎/平台侧 M1 起已在，只缺工具层消费方）；chatroom persona 恢复 Go `ChatroomRoleBaseSystemPrompt` 投递段；天花板：本地路径 only（Go 的 http 拉取不移植）、mime 按「单一 files 参数 + 检测分类」。i18n `relay_setup_ok`/`cron_setup_ok` 为残留（Go 记忆文件写入机制在 dsh 下过时，见 README Known Limitations） |
| 63 | 后台任务可视化：前台进度卡「💡 有 N 个后台任务正在运行」提示 + 未请求回合 header「🔄 后台任务完成，正在处理...」 | 📋 | M8 前 | 渲染半边已随 M2 迁入（`streaming.ts` `setBackgroundHint`/`bgTaskHint`；i18n `bg_task_running`/`bg_task_processing` 为死键，保留待接线，勿删）；缺引擎接线：adapter `tool/call` 检测 `run_in_background` → 引擎 `backgroundTasksPending` 计数 → 设/清卡片提示。**依赖**：计数递减与 🔄 header 文案在 Go `runUnsolicitedReader` 内（engine_events.go:3043 / :2628），即 M4-E C 类「unsolicited 三超时」同源机制——接线须与 unsolicited reader 移植同批，单独接线提示只增不减 |
