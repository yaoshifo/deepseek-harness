# dsh-feishu-bridge：cc-connect 融入 dsh 插件迁移计划

> 本文件是 dsh-feishu-bridge 迁移的唯一权威计划（approved 2026-08-18）。所有子任务以本文件为准；改动计划需先更新本文件。
>
> 迁移源仓库：`/home/hm/workspace/cc-connect`（**只读**，任何情况下不得修改）。
> 目标 worktree：`/home/hm/workspace/dsh-wt-feishu-bridge`（分支 `feat/dsh-feishu-bridge`，基于 dev）。

## 0. 目标与总验收

把 cc-connect 的全部编排能力（engine + 飞书平台）从 Go 二进制迁入本仓库的一个 dsh 插件 **dsh-feishu-bridge**，替代「cc-connect (Go) + cc-connect-bridge (stdio JSON-RPC)」两层架构。dsh 进程长驻直连飞书（插件 apply() 持有的 WS 长连接撑住进程，systemd 监督——不引入任何新的 dsh daemon 机制），agent 会话经 `ctx.agents` 原生创建，不再有桥协议。新代码全部用 dsh-feishu-bridge 命名，不再使用 cc-connect 名称（旧仓库仅作行为参照）。

**总验收标准**：
1. 新包全部移植测试在 vitest 通过（按域约 600+ 用例，见各阶段清单）；`pnpm lint`（oxlint）与 typecheck 通过
2. cc-connect 仓库零改动（`git status` clean）
3. 「记账驴」bot（app `cli_a9635d39e9f85bdf`，workdir `/home/hm/workspace/money`）在新插件上真机跑通全功能冒烟清单（M8 附完整清单），日常使用 1-2 周无阻断性回归
4. 61 个 feature 逐项对照表：全量迁移 / 不适用裁剪（附理由）
5. 最终 cutover 后旧 cc-connect systemd 停用（由用户手动执行）

**范围声明（不做）**：Web UI / Management Server 不在本次范围；#55 /fork 回滚（claudecode-only）、#7、#44/#50、#58（Claude Code 特定机制，dsh 无此问题）不迁移；#16 指纹改写由 profile 的 llm 路由配置承担（plain model name 规避，已有先例）；**Go `core/providerproxy.go`（LLM 流量代理：TUI 指纹改写、overload-400 改写、thinking 注入）整体不迁移**——现状 dsh 后端本就不经过它（`agent/dsh/` 零引用，仅 env 传凭据，llm-pi-ai 直连网关；proxy 只服务 claudecode 路径，该路径整体退役），新架构按 D2 四条命名路由直连，thinking/effort 由路由 `forceAdaptiveThinking` 兼容项承担（现网已验证）、重试由 dsh `llm-retry` 承担。

## 1. 总体架构

```
dsh --profile feishu-bridge（长驻进程，systemd 监督、开机自启）
├── dsh-base + 现有 profile 行（lsp/claude-memory/ask-user/skill-filesystem…复用不动）
└── @deepseek-ai/dsh-feishu-bridge（新插件，packages/acp/feishu-bridge/，本计划全部工作）
    ├── engine/     ← Go core/ 保形移植（事件状态机、会话、命令、流式、subtask、chatroom、monitor、cron、i18n、cards、markdown…）
    ├── feishu/     ← Go platform/feishu/ 移植（WS、API、卡片、进度卡、群管理、标签、头像、媒体、轮询）
    ├── agent-dsh/  ← 新写：Agent 接口 → ctx.agents 适配器（替代 agent/dsh Go + JSON-RPC 桥）
    ├── tools/      ← 新写：feishu_bridge_* dsh 工具（send/subtask/chatroom/cron/relay/lark），替代 cc-connect CLI + Unix socket
    ├── skills/     ← 修订版技能（feishu-bridge-* 前缀），经 profile customSkillDirs 加载
    └── index.ts    ← Cordis apply：读配置 → 每 project 一个 Engine + 一个飞书 Platform → 启动 WS
```

单 daemon 进程管理全部 project/bot（与现状单 Go 进程等价）；飞书凭据、providers、projects 全部进插件 Config（schemastery），由 profile 的 `cordis.patch.yml` 承载（HMR 生效）。

### 与评估文档的两处关键偏离（含理由）

1. **子任务不映射到 `ctx.subagents`**。cc-connect 的 /spawn 语义是「每子任务 = 持久飞书群 + 用户可随时介入 + /done --reply 回灌」，与 dsh subagent（one-shot headless 委派）语义不等价。engine 的编排状态机（父子注册表、深度、worktree、回报路由）整体移植，子会话经 `ctx.agents.create({sessionId, meta:{cwd,parentSession}, setup})` 原生创建——这才是真正消除的桥开销层。
2. **cron 不映射 dsh schedule**。cc-connect cron 是标准 cron 表达式 + session 复用/新建 + mute + 编辑；dsh schedule 只有 after/every。直接移植 Go cron.go（914 行）为 TS。

其余按评估文档方向执行，但 engine 采用**保形移植**（保留 Platform/Agent 接口与 Engine 类形状）而非重写——这是 700+ 编排测试能机械移植的前提（stub 断言直接翻译，用例不重新设计）。

## 2. 关键设计决策（已验证可行性）

- **D1 Agent 适配器**：`ctx.agents.create/resume({agentOptions:{provider,model,reasoningEffort}})`、`agent.followup()`、`agent.cancel()`、`ctx.get('planMode').set()`、`ctx.get('approval').setPolicy()` 全部已在现 bridge 中使用，风险低。provider 切换（#9/#12）= dispose + `resume(同 sessionId, 新 agentOptions)`（transcript 保留）。
- **D2 provider 多路由**：现「env 注入单路由」不可用于多 agent 同进程。profile 的 llm-pi-ai 配置改为**每 provider 一条命名路由**（glm/minimax/mimo/turbo，inline key，参照现有 cc-provider 行格式），插件配置引用路由名；`glm-5.3[1m]` 的 `[1m]` 剥离逻辑随引擎移植。
- **D3 per-agent 组装**：`CreateAgentOptions.setup` 钩子在 agent scope 内注册——能力 prompt（替代 `DSH_CC_APPEND_SYSTEM_PROMPT`）、`CC_FEISHU_*` 上下文（工具自带 caller agent，无需进程 env）、`restrict()`（#20 restrict_to_workdir 的 dsh 原生等价物）、chatroom bare persona（`complete: true` section）。`ctx.systemPrompt` 是 scoped 服务，按 agent 隔离已验证。
- **D4 CLI → 工具化**：`cc-connect send/cron/subtask/chatroom/relay/lark` 全部注册为 dsh 工具（ToolRunContext 携带 caller agent → project/session 路由，免 env）。lark wrapper 注册为 `feishu_bridge_lark` 透传工具（插件内部 child_process 调 lark-cli 并注入正确 bot 凭据）。修订版 skills 用 `feishu-bridge-` 前缀放新包 `skills/` 目录——不动 cc-connect 仓库的 embedded skills。Unix socket API 不实现。
- **D5 飞书连接 = 官方 node-sdk WS 长连接（已定为最优，备选均已排除）**：`@larksuiteoapi/node-sdk` 内置长连接客户端，纯出站、免公网端点/证书/验签，收发消息 + 卡片 + card.action.trigger 按钮回调同一条连接；多 bot = 每 app 一个 client 实例。Webhook 模式（需公网 HTTPS 运维）、lark-cli event 流入站（split-brain）、独立连接器进程（回到两进程形状）均劣于此。SDK 自动重连之外加 watchdog：轻量 API 探活，失联超阈值退出交给 systemd 拉起，防「进程活着收不到消息」暗故障。M0 先盘点 Go 侧用到的 API 面（卡片 PATCH v4、群管理、标签、Pin、TopNotice、头像上传、轮询）确认 node-sdk 覆盖，缺口直调 OpenAPI HTTP。
- **D6 会话持久化**：沿用 `session-persistence-jsonl`，root 指向现有 `~/.dsh/cc-connect-sessions`（jsonl 按 meta.cwd 自动嵌套，与现有 `--home-hm-workspace-*--` 布局兼容；M1 首个 resume 验证布局对齐）。/sessions、fork seed 均走原生。磁盘 store（路由绑定/cron/账本）移植时保留现有文件格式与目录，重启即恢复。
- **D7 并发模型映射**：Go mutex→模块内串行化 async 互斥（简单 Mutex promise 队列）；channel 事件流→AsyncIterable/event emitter。测试时序用 fake timers。这是移植期最大工程风险，M1 先以 engine 核心事件循环打样定型。
- **D8 卡片渲染**：纯 JSON 构造 1:1 移植（`renderElement` 家族），markdown 硬约束（`\n\n` 换行等）原样搬运；两路径（发送+更新）共用同一渲染函数。进度卡/完成卡视觉以 JSON 断言 + 真机截图对比双重验收。
- **D9 长驻进程与自愈（重启语义与现状完全对齐）**：安装脚本生成 system unit 并 `systemctl enable`——服务器重启后 systemd 自动拉起 dsh 进程、插件自动重连飞书 WS，无需任何手动操作；进程内断线由 SDK 指数退避自动重连 + 探活 watchdog 兜底。重启后状态恢复：会话由 jsonl 日志在下一条消息时自动 resume（transcript 保留，桥时代已验证该机制）；路由/cron/账本从磁盘 store 恢复；进行中的 turn 回滚到最后完整 turn（与今天重启 cc-connect 语义一致）；宕机窗口内消息的长连接补投语义也与现状相同，非迁移引入的回归。TS 改动的生效 = 重启进程（提供 reload 脚本；profile yml 仍走 Cordis HMR）。不引入新的 dsh daemon 机制。
- **D10 分支与生产隔离**：feature 分支 `feat/dsh-feishu-bridge` 开在 git worktree（本目录），**主检出（/home/hm/workspace/deepseek-harness）保持在 dev 不动**——生产 profile（cc-connect + 现有会话）的 `link:` 依赖正指向主检出的包目录，在主检出上切分支会让生产跑在未验证代码上，这是硬约束。新 daemon 的 profile `link:` 指向 worktree 内的新包路径。包名 `packages/acp/feishu-bridge/`（`@deepseek-ai/dsh-feishu-bridge`，插件 id `feishu-bridge`），测试放 `tests/`（自动匹配 vitest include 模式 `packages/*/*/tests/**/*.spec.ts`，零根配置改动）。现有 `cc-connect-bridge` 包与 `~/.dsh/profiles/cc-connect` 完全不动（生产路径），cutover 后再归档；稳定后合回 dev 由用户决定。coverage per-file 100% 门控只在 CI coverage lane 生效，本迁移的门槛是「测试完整通过 + lint + typecheck」。

## 3. 执行模型（父会话编排 + 子任务群实施）

- **worktree 常驻**：所有里程碑都在 `/home/hm/workspace/dsh-wt-feishu-bridge` 累积提交。
- **按里程碑派子任务群**：每个 M（大 M 可拆 2 个）派一个子任务群，工作目录为本 worktree（自动加载本仓库 AGENTS.md 约定：oxlint、tests/ 目录、doc comment 风格）。brief 固定结构：① 本文件中该里程碑的范围（测试先行清单 + 实现清单 + 验收命令）；② 移植源文件绝对路径清单（cc-connect 仓库**只读**）；③ 完成后 `/done` 汇报测试结果。
- **父会话职责**：派发与 brief 质量、验收（在 worktree 跑 vitest/lint/typecheck）、真机冒烟与 E2E、跨里程碑技术决策、提交信息审查；不亲自写移植代码，上下文留给编排。
- **回灌**：子任务 `/done` 结果由父会话核验后计入里程碑完成，未过验收打回重派。
- **daemon worktree 与 promote 流程**（M1 真机期形成）：daemon 运行代码来自独立 worktree `/home/hm/workspace/dsh-wt-fb-daemon`，固定在**父会话验收过的 commit**（detached），profile 的全部 `link:` 指向它——开发 worktree 的 churn 不影响运行中的 daemon。promote 步骤：`git checkout --detach <验收commit>` → `pnpm run build:lib:host` → `systemctl --user restart feishu-bridge`。**不追分支 tip**：子任务可能在里程碑中途提交暂态（曾出现 WIP commit 破坏仓级 typecheck 被 promote 拉入的情况）。开发分支纪律：验收前不 push；promote 只认验收 commit。daemon 由 systemd user unit `feishu-bridge.service` 监督（开机自启、Restart=on-failure、journal 留痕死因）；llm 路由 key 走 `apiKeyEnv` 引用，实际值在 unit 的 `Environment=`（0600）。

## 4. 迁移阶段（每阶段：测试先行 → 实现至绿 → 真机冒烟；上一阶段验收通过才进下一阶段）

**M0 骨架 + 纯逻辑地基（✅ 完成 2026-08-19，107 测试）**
- worktree 建立 + pnpm install；本计划落盘；新包骨架/vitest 接入/lint 接入；配置 schema 骨架；进程空转冒烟（新 profile `~/.dsh/profiles/feishu-bridge`，dsh-base + 新插件 link）；node-sdk 依赖引入 + API 覆盖盘点。
- 测试先行：纯逻辑套件——markdown_html(37)/lucide(12)/ratelimit(8)/dedup(4)/atomicwrite(4)/cli_escape/active_tag/card 核心/i18n——先移植先红，再移植对应纯函数至绿。
- 验收：新包测试绿；`dsh --profile feishu-bridge` 起进程不退出不报错。

**M1 Agent 适配器 + Engine 核心 + 文本收发（✅ 完成 2026-08-19，360 测试 + 真机全链路验证）**
- 测试先行：engine_test.go 核心事件段、session_test(51)、engine_cmd_session、stub 体系搭建（~20 个 stub struct → vi.fn 工厂）；DshAgentAdapter 单测。
- 实现：Agent/AgentSession/Platform 接口 TS 版；适配器（create/resume/followup/cancel/mode 切换/provider 路由）；Engine 骨架（入站路由、thread 隔离、消息排队 #13、idle reaper、基础命令 /new /stop /status /sessions /resume /dir）；飞书最小平台（WS + 文本收发 + @解析 + allow_chat #27）。
- 真机：记账驴切流（用户把该项目从旧 config 注释并手动重启旧 cc-connect；父会话起新进程）后一轮真实对话。
- 验收：移植测试绿；真机对话 + /new + /resume 通过。

**M2 卡片系统全量（✅ 代码验收 2026-08-19，587 测试；真机卡片冒烟待复测——见附录 B 遗留 1）**
- 测试先行：card_test(8)/progress(5)/spinner(8)/streaming_test(68)/card_sanitize/feishu markdown 套件。
- 实现：Card Schema 2.0 构造器全集（markdown/hr/button/note/column_set/collapsible_panel/form/checker）；进度卡（流式合并 #32、tool_progress 合并 #10/#19、思考/执行 GIF #54、placeholder #23）；完成卡（✅ 通知 #2/#14、状态页脚 #26、累计 token #25）；TopNotice #22；PATCH 限流 + 重试 + 11310 fallback 发 .md。
- 验收：测试绿；真机长任务一轮，卡片与现网视觉对比（截图）。
- **进度（2026-08-19）**：代码与移植测试完成——feishu markdown(34)/card 渲染(13)/spinner(11)/progress 注入(16)/cardcache(4)/patch ratelimit(7)/token retry(8)/transient retry(20)/streaming(65)/async sender(11)/progress payload+compact(21)/engine m2(16)，包内 587 vitest 全绿、包级 oxlint/typecheck 0。实现范围含：进度卡全路径（文本/结构化 payload、placeholder、思考 GIF、stop/export 按钮注入、per-card 缓存）、PATCH 令牌桶限流 + 瞬态/令牌双重重试、平台卡片收发（CardSender/WithUpdate/Preview/TopNotice/Pin/反应/完成通知）、engine 事件循环接入 preview（text/thinking/tool 事件、完成/失败/停止收尾、✅ 完成通知含 token 行、bump 防抖）。**未竟事项**：① 紫色通知卡与完整状态页脚（模型/ctx%/git 分支/RAM 行）依赖 M4 spawn 跳转/差异元素与 M7 usage 域，当前 ✅ 通知带精简 token 行；② card.action.trigger 回调分发与 askq/perm 卡片缓存读取（M3）；③ AskUserQuestion 纯文本 fallback 测试（M3）；④ 真机长任务冒烟（父会话）。另：仓级 lint 在 cc-connect-bridge 存在 16 个存量类型告警（M1 收尾提交即有，与迁移无关，包级门禁不受影响）。

**M3 审批 / 问题 / Plan + per-agent 组装（✅ 代码验收 + 真机 AskUserQuestion/Plan 验证 2026-08-19，646 测试）**
- 测试先行：engine_test permission 段、plan 相关（两路径 #5/#6、plan_max_len #29）、AskUserQuestion（multi-select #4、卡片增强 #31）。
- 实现：approval/request → 审批卡；userQuestions provider → 问题卡；ExitPlanMode plan 卡；D3 的 setup 钩子全套（能力 prompt 工具版、restrict、mode 继承）；auto-approve 不跳过 #15；auto-compaction 卡 #24。
- 验收：测试绿；真机 plan 模式 + 审批 + 提问各一轮。
- **进度（2026-08-19）**：代码验收 + 真机冒烟双通过。代码：646 vitest 全绿、oxlint/typecheck 0，实现含 `PendingPermission` 全路径、`sendPermissionPrompt`/`sendAskQuestionPrompt` 三路径降级、auto-approve/auto-deny/surface、idle reaper 跳过 permission-wait。适配器：approval answerer（ctx.on('approval/request')→emitPermissionRequest→awaitPermissionResponse→respondPermission）、userQuestions provider（延迟注册 + `awaitQuestionAnswer`/`deliverQuestionAnswers` 答案交付）、planMode 接线（`ctx.get('planMode').set()`）。平台：card.action.trigger 注册（perm:/askq: 动作解析→isPermissionAction/isAskqCardAction 分发）。**真机验证（开发虾 bot）**：① `/mode plan` 激活 plan 模式 ✅；② AskUserQuestion 问题卡渲染（含多问题序列 (1/2)→(2/2)、Recommended 标记、选项按钮）✅；③ 自由文本回答（"1"）解析为选项标签并回传 agent 继续 turn ✅；④ ✅ 确认卡 + 多轮问答后 agent 继续工作 ✅。**关键修复**：CardSender 接口方法名（sendWithCard→sendCard，问题卡走纯文本降级的根因）；事件循环阻塞 permission wait（对齐 Go）；handleMessage 全消息先走 handlePendingPermission（Go 语义）；答案交付拆分（awaitPermissionResponse=审批结果 / awaitQuestionAnswer=答案文本）。**遗留**：① ExitPlanMode plan-review intent 的答案编码（approve/decline 语义与普通问题不同）；② workspace-write 沙箱 macOS 崩溃阻断审批卡真机测试（card.action.trigger 按钮回调未真机验证）。

**M4 子任务群 + fork（✅ 代码 + 真机全链路验收 2026-08-19，967 测试）**
- 测试先行：engine_subtask_test(41)、engine_groupname_test、feishu_spawn/tag/avatar/media/members 套件。
- 实现：/spawn /fork /sp /fk、--worktree #39、--dir #37、/done --reply 回灌 #37、父子群 #38（跳转/notify/board）、群命名 #49 + Lucide 头像 #52、pin #35、深度限制；`feishu_bridge_subtask` 工具族 + 修订版 skill；/fork = agents.create + completedTurnPrefix seed（原生）。
- 验收：测试绿；真机 /spawn → 子群工作 → /done --reply 全链路。**真机收官（2026-08-19 第四轮）**：D 群三项补缺合并后（d8ecfacd8b，967 测试全绿）重建 promote，/spawn 全链路含群命名——子群以占位名「开发虾 副本」创建 → agent 完成 scratch 目录任务 → LLM 改名「登录页CSS对齐修复」+ Lucide 头像 align-center-vertical（彩色+灰度双 key 上传）。E 群装配清查的 B 类产出可能追加小修（不影响本验收结论）。
- **执行拆分（2026-08-19，按 §3「大 M 可拆」）**：Wave 1 三群并行（worktree 隔离，流水线合并）——A engine 子任务域（engine_subtask/groupname/worktree + engine.go 增量，stub platform）；B feishu 平台域（spawn/tag/avatar/media/members/chatname，真实 platform + mock lark client）；C M3 遗留小修（① plan-review intent 答案编码、⑥ spinner GIF 路径）。A/B 能力方法签名共同锚定 Go `interfaces.go`（camelCase 化，结构化能力检测对齐现有 `MediaPlatform` 模式）。Wave 2 一群：D 集成（engine↔platform 接线核验、/fork seed、`feishu_bridge_subtask` 工具族、修订版 skill）。父会话负责合并、门禁、两步构建 promote、lark-cli 真机冒烟。
- **Wave 1 进度（2026-08-19）**：A/B/C 三群全部验收合并（源 commits 275349280f/33eb27eac9/22ce03f97f，唯一冲突 platform.ts import 段已解）。包内 898 vitest 全绿（A +141：engine-subtask 59 + engine-groupname 82；B +101：tag/media/members/avatar/spawn-evict/chatname；C +10：plan-review 6 + answerer 守护 1 + spinner 3）、oxlint/typecheck 0。B 引入 sharp（SVG 栅格化/灰度，替代 Go oksvg/rasterx）。**Wave 1 集成缺口（D 必修）**：① `GroupSpawnOptions`/`SpawnedChatInfo` 在 core/types.ts（A，必选字段）与 feishu/spawn.ts（B，可选字段）重复定义且漂移——统一到 core/types.ts 单一定义，feishu 侧 re-export；② engine 传 `renameGroup` 的 AbortSignal（30s 改名超时）真实平台未接收/透传；③ `botDisplayName`（commands.ts 已消费，BotIdentityProvider）平台侧未实现（B 的 api client 已有 getBotInfo）。A 侧声明的 D 范围遗留：act:/wt 卡片回调路由（worktree Keep-Remove 卡）；M7 范围遗留：spawn-notify 完整状态页脚、引用计划卡 spawn 与 fork-at 回滚。
- **Wave 2 进度（2026-08-19）**：D 群验收通过，包内 933 vitest 全绿（+35：rename-abort 4 + bot-identity 3 + card-action 平台 6 + engine-card-action 4 + adapter-fork 5 + adapter 路由 1 + subtask-tool 12）、oxlint/typecheck 0。集成缺口三笔全修：① 类型统一至 core/types.ts（feishu/spawn.ts re-export，platform 的空 opts 字面量补零值）；② renameGroup/renameGroupAny 接收并透传 AbortSignal（renameChat 先检后发 + in-flight abort 及时拒绝，Go ctx 语义）；③ botDisplayName 落地（构造项预置 + probeBotInfo 填充 appName）。act:/wt 卡片回调路由完成：platform onCardAction 解析 act: 前缀（sessionKeyFromCardAction 对齐 Go：value.session_key 优先、spawned/share_session_in_channel 按 chat 键）→ 记录 cardActionMsgIDs → isCardAction 合成消息；engine handleMessage 路由到 handleCardAction → executeWorktreeAction → CardRefresher.refreshCard 原位 PATCH（无能力则发新卡）。/fork 真接线：adapter startSession 识别 `__fork__` sentinel，agents.create + completedTurnPrefix seed（对齐 Go 复制父会话已完成 turns；父会话需 live——Go 读持久化日志，此为已注释的天花板），prepareForkSession 失败即引擎跨目录守卫触发。`feishu_bridge_subtask` 工具族（src/tools/subtask.ts，单工具 action 参数：spawn/report/send/gather）经 index.ts apply 注册，caller agent → adapter.engineKeyForAgentID → 引擎+会话路由（免 env）；测试经真实 Cordis Context + ToolRuntime 断言方法路由与 HMR 注销。包首次补 src/invariant.ts companion（空 installer，测试起 Cordis root 所需）。修订版 skill 落 skills/feishu-bridge-subtask/（profile customSkillDirs 接线归父会话）。
- **Wave 2 真机冒烟（2026-08-19，父会话，三轮）**：主链路通过——/spawn 建群拉人、Group ready 卡（含 ↩ 跳转父群）、agent 自动开工完成、完成卡、/done --reply 回灌父群「子任务完成」卡、父 agent 被唤醒确认（事件回注生效）、--dir 修复后文件落在指定目录、C 的 spinner ENOENT 消失、B 的彩色/灰度头像上传成功。冒烟揪出三笔装配级 bug，父会话已修（commits 446e98ab03/9941ff2444/d7eda7f134，933→937 测试）：① engine 从未调用 applyWorkDirOverride + adapter 无 WorkDirSwitcher（--dir 全链路失效，文件写进父项目）；② 生产装配从未接 projectState store 与 platform dataDir/projectName（per-chat override 无处落盘、spawned 注册表/标签缓存纯内存）；③ 数据目录未创建（spawned 注册表保存 ENOENT）。测试 937 全绿后第三轮冒烟全过。**保形确认（非 bug）**：tag 402-without-id 留空不打标签 = Go 他 app 占名语义（孤儿 'smoke' 标签系早期无 dataDir 冒烟残留）；/spawn 成功时父群无通知 = Go 语义（通知卡只进子群）。**打回 D 群的 M4 补缺（进行中）**：groupName 生产接线全缺（config schema + setGroupNameConfig + adapter lightweightQuery，#49/#52 链路）、im.chat.updated_v1 事件处理（onChatUpdated：chatname 缓存 + session 标签 + 预览卡 bump）、/rename 的 markPendingRename 核查。
- **用户使用反馈两笔 + 装配清查群 E（2026-08-19）**：① 进度卡无工具调用信息 → display 字段转发缺口（a461ac1a4b 补齐 toolProgress/toolMaxLen/planMaxLen/progressSpinner 转发 + profile display.toolProgress）已真机验证；② 完成后无 ✅ 通知卡 → platform options 六项整段未接（8fdfa2a507 补齐 schema+转发+profile，含 workDir 标签种子）已真机验证（✅ 完成 · tokens 行）。至此装配层「实现完好、接线丢失」类 bug 累计 5 笔，派 **E 群**做 Go wire.go 逐行 vs TS index.ts 系统性清查（分类 A 已接/B 漏接本轮修/C 后续里程碑/D 不迁移；B 类线索：stall 超时三参数、admin_from、user roles、dir history、spawn 阈值；同步 profile 模板），与 D 群并行、排除 groupName 域避免冲突。938 测试全绿。
- **M4-E 装配层系统性对照清查（2026-08-19，测试先行）**：以 Go `cmd/cc-connect/wire.go` 逐行对照 TS `src/index.ts` 三处（Config schema / buildProjectAssembly 转发 / 引擎·平台 setter 是否被生产调用），产出 A/B/C/D 分类清单。本轮修复 B 类（漏接但 TS 已有实现）18 项（新增 `tests/assembly-config.spec.ts`，938→956 测试）：language 映射进 engine ctor；setBaseWorkDir + 启动期 work_dir_override 应用（applyProjectStateOverride 语义——/dir reset 此前无基目录可回）；setDirHistory（跨 project 共享一实例，对齐 Go NewDirHistory(cfg.DataDir)）+ 初始 workdir 入史——/dir 的 MRU/序号回退此前整体失效；display.stall_timeout_secs/stall_max_retries（engine 新增 setStallMaxRetries）；display.progress_spinner 与 patch_rate_interval_ms 转发到 platform（progress_spinner 此前被误塞进 engine setDisplayConfig 的 no-op 键）；idle_timeout_mins；queue.max_depth；subtask.max_depth/timeout_sec/gather_timeout_sec；spawn.worktree + 内存守卫（默认 80/90 always wired，TS 字段默认 0/0 即禁用）；per-project admin_from；interactive_idle_timeout_mins；attachment_send；stream_preview 调优（engine 新增 setStreamPreviewCfg）。C 类记录不接（引擎机制未移植，归后续里程碑）：absolute_turn_timeout_secs、unsolicited 三超时（spillover/tool-in-flight/background grace）、rate_limit 与 outgoing_rate_limit、show_context_indicator/context_window/reply_footer/usage（M7）、multi-workspace、全局 commands/aliases/banned_words/hints、filter_external_sessions/session_cleanup_days、[users] 角色策略、restrict_to_workdir（adapter 无 setup/restrict 钩子）、dir_scan_paths（M7 #3）、SetUserRoles。D 类（Go 特有不迁移）：providerproxy 相关（proxy_response_timeout_secs）、run_as_user/run_as_env、serena、webhook/bridge/management web 栈。profile/ 模板 feishu-bridge 行已与 schema 全量同步（注释占位符风格）。
- **F 群验收合并（2026-08-19）**：FEATURE-PARITY.md（61 项：✅30/📋19/✂️10/❓2，#49/#52 行已按 D 群合并后的终态修正）、OPERATIONS.md 骨架（配置映射表/部署/回退/systemd）、deploy/ 三模板（plist 经 plutil -lint，占位符化无真实凭据）。遗留⑦ 关闭。❓2 项待归：#8 图片进模型上下文通路、#11 replyFooter；#35a 表情关闭门控归 E 群清查范围。**存量 doc-gate 债务（非本次引入，挂 M7/M8）**：feishu-bridge 与 cc-connect-bridge 的 README 缺 Known Limitations 段（verify-package-readme-limitations 红）；AGENTS.md 1959/1950 超词预算 9 词。
- **并行群 F/G（2026-08-19，零代码冲突）**：**F 群** M8 前置物料——61 feature 对照表初稿（源 cc-connect docs/features.md，产出 docs/FEATURE-PARITY.md）、运维文档骨架（docs/OPERATIONS.md，含 config.toml→cordis.patch.yml 映射表）、launchd/systemd 模板入 git（deploy/，遗留⑦）。**G 群** 遗留② 调查——workspace-write 沙箱 macOS 崩 daemon 根因（纯调查不改码，scratch profile 复现，产出根因链+分级修复方案；铁律不碰运行中 daemon）。M6 cron+relay 群挂 D/E 合并后队列（等装配面定型避免 index.ts 三方撞车）。
- **Wave 2 冒烟补缺（2026-08-19，第二轮）**：真机 /spawn→/done --reply 全链路通过后三项补缺，964 vitest 全绿（+27）、oxlint/typecheck 0。① groupName 生产接线（#49/#52 全链路）：Config 加 ProjectConfig.groupName 段（enabled/provider/timeoutSec/prompt/setAvatar），buildProjectAssembly 按 Go wireGroupName 接线——默认 enabled=true（本插件 agent 恒为 dsh，等价 Go claudecode 默认开）、timeout 30s、setAvatar 默认开；adapter 补 lightweightQuery（Go LightweightQuery：agents.create 新会话 + 命名路由 + reasoningEffort 'low'，发 prompt 收结果即 dispose，90s 超时/调用方 signal 中止）及 forkQuery/forkSessionWithProvider（共用 oneShotQuery + completedTurnPrefix seed）；另补 ProviderSwitcher（Go dsh 四方法，路由明细仍归插件 config——缺它 generateGroupName 空 provider 回退会静默失败回退到首条消息命名，即冒烟症状）。② im.chat.updated_v1（Go onChatUpdated）：platform 注册事件 + onChatUpdated（群名变化→chatNames.setName + chatRenamedHandler；Name/Avatar 变化→chatChangedHandler）+ SetChatRenamedHandler/SetChatChangedHandler；core/types 补 ChatRenamedNotifier/ChatChangedNotifier 能力接口；engine.start() 按 Go engine.go:2156 接线（handleChatRenamed 同步自身 Name 与子会话 ParentChatName 标签；changed 走既有 onChatChanged 防抖 bump）。③ /rename 命令移植（Go cmdRename，此前 TS 缺整个命令）：带参直接改名 + markPendingRename（防首条消息 LLM 改名覆盖手动名）；无参走 generateGroupName(buildCompactContext(history)) 重生成 + 图标头像刷新；buildCompactContext 随迁（200/500/3000 上限）。

- **E 群验收合并（2026-08-19）**：18 项 B 类接线修复（cf89cdaf6a，985 测试全绿；index.ts 三处冲突与 D 群 groupName 叠加保留）。生产 profile 已按旧 toml 补：language zh、display.stallTimeoutSecs 200/stallMaxRetries 3、adminFrom '*'、interactiveIdleTimeoutMins 30；重建 promote 后基础冒烟通过。**里程碑队列推进**：M5 chatroom 群、M6a cron+relay 群已派（装配面定型；命令注册各自独立文件避免撞车）；M6b monitor 群待 M5/M6a 合并后派；G 群沙箱调查在飞。

- **遗留② 关闭 + 前台权限修复（2026-08-19）**：G 群调查证伪 landlock 归因（darwin 沙箱链是 seatbelt，landlock 不可达；rc.7 workspace-write 端到端健康；历史崩溃最可能是构建态一次性故障且证据被 '>' 截断）——profile 已切回 workspace-write（含 permission preset），daemon 无崩溃。真机随即暴露并修复 M3 权限域错层移植：前台事件循环错套了后台 unsolicited 门（shouldSurfaceUnsolicitedPermission），导致沙箱 escalation 审批静默自动拒绝；b488d22b3c 按 Go 语义改为前台一律 surface（后台 auto-deny 留待 unsolicited reader，纯函数表测仍覆盖门语义），重做两个固化错误语义的测试。**真机审批全链路通过**：escalation 审批卡（含 justification + 允许/全准/拒绝按钮）→ 文本「允许」解锁 → 文件落盘 → 完成通知。986 测试全绿。运维改进采纳：daemon 重启日志改保留轮换（mv 时间戳）不再截断。
**M5 聊天室**
- 测试先行：engine_chatroom_test(46)、gather/end/venv/roles/ledger 套件。
- 实现：/chatroom #41、角色挑选 #43、--research #57、随便聊聊 #59、`feishu_bridge_chatroom` 工具族、bare persona。
- 验收：测试绿；真机一轮三人 chatroom。

**M6 Monitor + Cron + Relay（cron+relay ✅ 2026-08-19；monitor 代码验收完成 2026-08-19，真机冒烟待父会话）**
- 测试先行：engine_monitor_test(49)、monitor_cmd、cron_test(19)、feishu_monitor_poll。
- 实现：#53 全部（观察/规则+LLM 分诊/dispatch 模式/coalesce/no_report/轮询兜底//monitor 命令）；cron 全量移植；relay；`feishu_bridge_cron`/`feishu_bridge_relay` 工具。
- 验收：测试绿；真机监控群一条告警全链路 + 一条定时任务触发。
- **M6a 进度（2026-08-19）**：cron+relay 移植完成（合并 commit 含 164c5b4edb，1058 测试全绿，+72：cron 30 + execute 3 + commands 6 + relay 11 + 工具 16 + 装配 6）。自写 5 域 cron 解析器（robfig 月/星期名与 @every 未移植——存量纯数字域；天花板已注明）；持久化 <dataDir>/crons/jobs.json 沿用 Go snake_case 键；/cron 全族命令 + feishu_bridge_cron/relay 工具族（caller agent 路由）；relay 绑定落盘 Go 键序。**真机冒烟通过**：/cron add（19:22 建）→ 准点触发（19:24 ⏰ 注入 + agent 执行 + 完成卡 + ✅ tokens）→ /cron del 清理。遗留：/status 的 cron 行未接（需改 commands.ts，避免与 chatroom 群撞车留待）；多工作空间 per-workspace agent、heartbeat 归后续。
- **M6-a cron+relay 域进度（2026-08-19，monitor 域另派并行）**：代码与移植测试完成，包内 1056 vitest 全绿、包级 oxlint/typecheck 0。cron：`core/cron.go` → `src/engine/cron.ts`（CronJob/CronStore 落盘 `<dataDir>/crons/jobs.json` 沿用 Go snake_case 键；CronScheduler 自带标准 5 域 cron 解析器——robfig 的月份/星期名与 `@every` 描述符未移植，存量与测试均为纯数字域；mute/silent、session 复用与 new_per_run（每跑 `key#cron:<sid>` 独立 interactive 槽）、timeout_mins、编辑/校验、错过不补跑语义与 Go 一致）；`/cron` 命令族 + 列表卡（act:/cron 按钮走 handleCardAction 路由）在 `src/engine/cron-commands.ts`（registerCronCommands 合并进既有命令表，不碰 commands.ts）；`Engine.executeCronJob/executeCronShell`（工作目录切换走 WorkDirSwitcher——多工作空间 per-workspace agent 未移植的天花板；CronReplyTargetResolver 能力接口随迁仅测试桩实现）。relay：`core/relay.go`+`engine_cmd_relay.go`+cmdBind → `src/engine/relay.ts`/`src/engine/relay-commands.ts`（绑定落盘 `<dataDir>/relay_bindings.json` Go 键序；`Engine.handleRelay` 含超时部分回复 + 后台 drain 续命 + 陈旧 resume 回退；`/bind` 族）。配置：schema 加 `cron{silent,sessionMode}`/`relay{timeoutSecs}` 独立块，apply() 建 process-wide scheduler/manager、每引擎 registerEngine+setter，工具 `feishu_bridge_cron`(add/list/info/edit/del)/`feishu_bridge_relay`(send/bind/binding) 经 caller agent 路由注册。测试：cron.spec(30，cron_test.go 19 函数)+cron-execute(2)+cron-commands(6)+relay.spec(11，relay_test.go 5 函数+绑定生命周期)+cron-tool(8)+relay-tool(8)+cron-relay-assembly(6)=+71。真机定时触发归父会话冒烟。

- **M6-b monitor 域进度（2026-08-19，测试先行）**：代码与移植测试完成，包内 1195 vitest 全绿（+137）、包级 oxlint 0（顺手修掉 engine-m3-permission.spec 一笔基线存量 `String(x)` 冗余转换）/typecheck 0。monitor：`core/engine_monitor.go`+`engine_monitor_cmd.go` → `src/engine/monitor.ts`（MonitorCore 持全部 monitor 状态、经 `engine.monitor` 触达；规则快路 + LLM 分诊 LightweightQuery（provider 显式→active 回退）、dispatch/monitor 双模式 prompt、目录澄清卡（含 dispatch 模式 dir_scan 池）、/learn few-shot（MonitorExampleStore 落盘 `<projectDataDir>/monitor_examples.json`，corrupt 文件 `.corrupt` 副本保全）、coalesce（同目录窗口内并群，meta 内存态重启即失效安全回退新拉群）、no_report、maxConcurrent 上限卡、OnIt/Done reaction 生命周期、`/monitor` 命令族在 `src/engine/monitor-commands.ts`（registerMonitorCommands 合并既有命令表不碰 commands.ts；/monitor 进 Go privilegedCommands 对应的 admin 门）；命令运行时改 chats/mode 经注入 save 函数持久化——Go 重写 config.toml，TS 侧 cordis.yml 运行时只读，故落 ProjectStateStore（monitor_chats/monitor_mode，装配时覆盖配置值））。轮询兜底：`platform/feishu/feishu_monitor_poll.go` → feishu 平台 `latestMessageTime`/`listMonitorMessages`（MonitorPoller 能力）+ `extract.ts` 补 `unwrapCardContent`/`extractInteractiveCardText`（schema 2.0 递归 + legacy 根级 text，表格/列表/column_set 随迁）/`extractCardImageKeys`；api client 加 `listMessages` verb（raw_card_content）；`cmd:` 卡片按钮动作分发（/learn 删除按钮）。平台 @-drop 与 allow_chat 闸对监控群与 /monitor 命令豁免（对齐 Go dispatch）。M6a 遗留的 /status cron 行已接（commands.ts 对齐 Go engine_cmd_misc.go，含测试）。配置：schema 加 `monitor{enabled,chats,contextWindow,spawnNotice,maxConcurrent,triageProvider,triagePrompt,dirs[],rules[],learnEnabled,learnMaxExamples,reactEmoji,pollIntervalSec,fallbackUser,mode,coalesceEnabled,coalesceWindowSec}` 块，wireMonitor 按 Go main.go 默认值装配（spawn_notice 5/learn 20/Get/30s/coalesce 300s；无效 rule pattern 告警跳过）。Go api.go 无 monitor handler，故不加工具。测试：monitor.spec(80，engine_monitor_test.go 49 用例全量)+monitor-commands(32，engine_monitor_cmd_test.go)+monitor-poll(18，feishu_monitor_poll_test.go)+monitor-assembly(5)+commands.spec cron 行(2)=+137。**天花板**：① feishu 事件路径未移植引用消息抓取（Go fetchQuotedMessage/formatReplyChain），真机 /learn 需引用消息的通路缺失（引擎侧 extractQuotedText 已就绪并有测试）——归后续里程碑或父会话决策；② dispatch 分诊 listChatMembers 的 Go「partial roster + error」语义经 error.partial 字段桥接（TS throw 契约）；③ ChatMemberManager 平台实现的 partial 已在 listChatMembers 落盘。真机监控告警全链路（监控群配置+webhook 卡兜底+分诊拉群）归父会话冒烟。

**M7 渲染 + Provider + 剩余 features**
- 测试先行：engine_plan_render_test(~50)、engine_cmd_* 余量、usage/provider 相关。
- 实现：#47/#48 plan/reply HTML（渲染会话 = create + seed + complete prompt + 无工具 + stall 重试）、#51 Lucide、predict_next #33、turn_summary、NO_REPLY #28、撤回取消 #30、dir_scan #3、usage #1、/provider #9/#12、feishu_workspace #18（CC_FEISHU_* 进工具上下文）、`feishu_bridge_lark` 工具。
- 验收：测试绿；feature 对照表初稿（61 项全列）。

**M8 Cutover**
- 记账驴日常使用回归 1-2 周 → 其余 8 个 project 逐个迁配置（用户操作旧系统摘除+重启，父会话加新配置+reload）→ 全量切换后用户停用旧 systemd、归档 cc-connect-bridge 包 → 新包 README + 运维文档（部署/回退/配置映射表/systemd 自启说明）。

## 5. E2E 测试策略（可自测的边界）

- **全自动**：全部 vitest 套件；dispatch 级集成测试（真 Platform 对象 + 合成 WS 事件 + 录制式 API client）；进程启动冒烟；卡片 JSON 与 Go 侧产物 diff 对比（可跑 Go 侧卡测试 dump baseline）。
- **真机自动化（记账驴）**：入站消息用 lark-cli `--as user`（用户授权）发到测试群——user 消息会正常触发 bot 的 im.message.receive_v1，出站直接验证真卡片投递。按钮回调类交互主要靠用户抽查。
- **需要用户**：卡片/群管理的人工视觉确认（各 M 真机冒烟时看一眼）；飞书开放平台一次性配置（记账驴事件订阅确认已是长连接模式）；旧系统侧的注释配置 + 手动重启（铁律：不重启 cc-connect）；最终按钮点击类交互抽查。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Go 并发→JS 映射引入时序 bug（最大工程风险） | M1 打样定型映射模式；700+ 移植测试含大量并发/边界用例兜底 |
| node-sdk 覆盖面缺口（标签/TopNotice/头像等冷门 API） | M0 盘点，缺口处直调 OpenAPI HTTP（Go 侧部分本就是裸 HTTP） |
| WS 静默掉线暗故障 | SDK 自动重连 + 插件探活 watchdog + systemd 拉起 |
| 卡片视觉不一致 | JSON 断言 1:1 + 真机截图对比；cc-connect docs/card_style_guide.md 基线 |
| dsh rc 阶段 API 变动 | fork 仓库锁定现状，升级单独评估 |
| 迁移半途双系统并行期长 | 记账驴先行全量验证 + 每 M 真机冒烟，风险前移 |
| npmmirror 大包安装失败（worktree 内 install） | 备有 pnpm fetch error23 三级 workaround 经验 |
| 子任务群产出不符验收 | 父会话逐 M 验收（测试+lint+冒烟），未过打回重派；本文件单一权威来源防 brief 漂移 |
| 记账驴切换期间服务中断 | 切流在空闲窗口执行，会话持久化兼容（同 root resume） |

## 7. 假设

1. dsh `0.1.0-rc.6/7` 的 AgentRegistry/SessionPersistence/setup 钩子在迁移期稳定（fork 已锁定）
2. 记账驴当前群/会话可承载测试流量；其 wiki 空间等配置原样迁移
3. 旧 cc-connect 在整个迁移期保持可用作行为参照与回退（最终 cutover 前不删）
4. lark-cli user 授权 token 在迁移期有效（用于自动化入站消息）
5. deepseek-harness 主检出停留在 dev，worktree 承载 feature 分支直到最终合并

## 附录 A：飞书 API 覆盖盘点（M0 结论：node-sdk 无缺口）

Go 侧调用面 → `@larksuiteoapi/node-sdk`（1.73.0）对等映射，全部覆盖：

**typed 调用**（Go SDK 方法 → node-sdk client 同名域）：
- `Im.Message`：Create / Reply / Patch（卡片更新）/ List / Get / Delete
- `Im.Image.Create`、`Im.File.Create`（媒体上传）
- `Im.Chat`：Create / Get / Update（建群/查群/改名等）
- `Im.ChatMembers`：Create / GetByIterator（成员管理）
- `Im.Pin.Create`（Pin 面板 #35）
- `Im.MessageReaction`：Create / Delete（表情回应）
- `Im.ChatTopNotice`：PutTopNotice / DeleteTopNotice（置顶横幅 #22）
- `Contact.User.Get`（用户信息）

**裸 HTTP**（TS 侧继续裸调，量小）：
- `GET /open-apis/im/v1/messages/{id}?card_msg_content_type=raw_card_content`（取卡片原文）
- `POST /open-apis/drive/v1/files/{token}/comments/{comment_id}/replies`（文档评论回复）
- `GET /open-apis/bot/v3/info`（bot 信息）
- tenant token 获取由 node-sdk 内部处理

WS 事件（im.message.receive_v1、card.action.trigger 等）走 node-sdk 内置长连接客户端。

## 附录 B：跨服务器交接（2026-08-19，2026-08-19 更新为本机 macOS 环境）

### 当前进度快照

- **M0 ✅** 骨架 + 纯逻辑（107 测试）
- **M1 ✅** Engine 核心 + 适配器 + 文本收发；真机全链路验证通过（记账驴，旧服务器）；真机修复三笔：inject 声明、apiKeyEnv 凭据引用、session 事件 payload 解包
- **M2 ✅** 卡片系统全量（587→646 测试）；真机卡片冒烟通过（本机 2026-08-19：流式卡更新 + 完成卡 + ✅ 通知，无重复发送——早期报告的「卡片+文本重复」未复现，根因是旧版本 CardSender 接口名错误）
- **M3 ✅ 代码 + 真机冒烟双通过（2026-08-19 本机）**：646 测试全绿、lint/typecheck 0。真机验证：`/mode plan` 激活 ✅、AskUserQuestion 问题卡（多问题序列 (1/2)→(2/2)、选项按钮、Recommended 标记）✅、自由文本回答 "1" 解析为选项标签 ✅、答案回传 agent 继续 turn ✅。关键修复 4 笔见 M3 段落。
- 后续 M4–M8 未开始；61 feature 对照表初稿未做

### 本机环境（macOS，2026-08-19 已搭建完毕）

| 项目 | 值 |
|------|-----|
| 仓库 | `/Users/hm/workspace/deepseek-harness`（分支 `feat/dsh-feishu-bridge`，主检出即开发树） |
| cc-connect 源（只读参照） | `/Users/hm/workspace/cc-connect`（Go 源码 + 运行中的旧二进制） |
| 测试 bot | 开发虾（app_id `cli_a92f9b460e259bc7`） |
| bot app_secret | macOS keychain：`security find-generic-password -a 'appsecret:cli_a92f9b460e259bc7' -w` |
| LLM 路由 | mify-dsh：本地代理 `http://127.0.0.1:18090`（`/Users/hm/workspace/op-dev/rate-limit-logger/proxy.js` 转发 model.mify.ai.srv），model `zhipuai/glm-5.2` |
| LLM API key | `~/.claude/rotate-key.sh`（3 key 轮换数组，任取其一）；profile 里 `apiKeyEnv: FB_MIFY_API_KEY` |
| dsh profile | `~/.dsh/profiles/feishu-bridge/`（cordis.patch.yml 已配好开发虾 project 段 + mify-dsh 路由） |
| launchd plist | `~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`（FB_MIFY_API_KEY 在 EnvironmentVariables） |
| daemon 日志 | `~/.dsh/feishu-bridge-stdout.log` / `~/.dsh/feishu-bridge-stderr.log` |
| 旧 cc-connect | launchd `com.cc-connect.service`，读 `~/.cc-connect/config.toml`；开发虾段已注释（备份 `config.toml.bak-feishu-bridge`），运维虾仍跑旧系统 |
| lark-cli | `~/.local/bin/lark-cli`（v1.0.69），user 身份已授权 `im:message`（发消息测冒烟用） |

### daemon 操作命令

```sh
# 重启（改代码后必须：build 两步 + reload）
cd /Users/hm/workspace/deepseek-harness
npx tsc -b packages/acp/feishu-bridge/tsconfig.json --force   # 第一步：tsc 产出 lib/types/*.js
npx tsdown --env.DSH_BUILD_FACE host                            # 第二步：tsdown 从 lib/types 打包 lib/index.js
launchctl unload ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist
> ~/.dsh/feishu-bridge-stdout.log; > ~/.dsh/feishu-bridge-stderr.log
launchctl load ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist
```

**关键坑：build 必须两步**。tsdown 的入口是 `lib/types/{index,invariant,startup}.js`（tsc 的产物），不直接读 `src/*.ts`。只跑 tsdown 会用旧的 lib/types 导致改动不生效（本轮调试时多次踩坑）。

### 自动化冒烟测试流程（lark-cli 以 user 身份发消息）

前置：`lark-cli auth status` 确认 user 身份 ready 且含 `im:message` scope（2026-08-19 已授权；过期则 `lark-cli auth login --scope "im:message.send_as_user im:message"`，拿 URL 给用户浏览器确认）。

```sh
CHAT=oc_8716afd14efebc177d6cab518d5d6374   # 开发虾测试群（bot 所在）

# 1. 基础收发
lark-cli im +messages-send --as user --chat-id $CHAT --text "/new"
sleep 10
lark-cli im +messages-send --as user --chat-id $CHAT --text "你好"
sleep 25   # 等 agent 回复

# 2. Plan 模式
lark-cli im +messages-send --as user --chat-id $CHAT --text "/mode plan"
sleep 8
lark-cli im +messages-send --as user --chat-id $CHAT --text "加一个健康检查接口"

# 3. AskUserQuestion（等待 agent 发问题卡后回答）
lark-cli im +messages-send --as user --chat-id $CHAT --text "1"   # 数字索引=选项
# 多问题会逐个发卡 (1/2) (2/2)，每张卡回答一次

# 4. 验证结果：查群里最新消息
lark-cli im +chat-messages-list --as bot --chat-id $CHAT | python3 -c "
import sys, json
d = json.load(sys.stdin)
for msg in d.get('data',{}).get('messages',[])[:4]:
    print(f\"{msg.get('create_time')} | {msg.get('msg_type')} | {msg.get('content','')[:150]}\")"

# 5. 查 daemon 日志排障
grep -v '^\[info\]' ~/.dsh/feishu-bridge-stdout.log | tail -5
grep -v 'message_read\|card.action\|spinner' ~/.dsh/feishu-bridge-stderr.log | tail -5
```

**注意**：
- bot 自己发的消息（`--as bot`）不触发引擎回复——引擎只对用户消息响应；冒烟必须 `--as user`
- 群消息默认需要 @bot，但 profile 里 `features.allowChat: true` 已关掉 @ 门槛
- LLM 回复有随机性：同一任务 agent 可能这次问问题、下次直接给方案；要稳定触发 AskUserQuestion，在指令里明确写「用 ask_user_question 工具问我」
- 卡片按钮回调（card.action.trigger）只能真实点击验证，无法用 API 模拟

### WS 独占（切换时序，重要）

开发虾 app 的 WS 事件同一时刻只归一个进程消费。当前状态：**新 feishu-bridge daemon 持有开发虾 WS**；旧 cc-connect 只剩运维虾。回滚方法：取消注释 `~/.cc-connect/config.toml` 的开发虾段 → `launchctl kickstart -k gui/$(id -u)/com.cc-connect.service` → `launchctl unload ~/Library/LaunchAgents/com.dsh.feishu-bridge.plist`。

### 遗留清单（下次继续）

1. **ExitPlanMode plan-review intent 答案编码**：✅（M4-C，2026-08-19）adapter 的 userQuestions provider 识别 `intent.kind='plan-review'`，按 Go `planReviewItem` 语义渲染为 ExitPlanMode 权限卡（heading=plan 首行），allow→`selected:[intent.approve]`，deny→`selected:[]`+`custom:拒绝消息`（plan-mode 据此保持规划并回喂反馈）
2. ~~**审批卡真机测试**~~ ✅ 已关闭（2026-08-19）：G 群证伪 landlock 归因（darwin 走 seatbelt），workspace-write 切回后无崩溃；前台权限错层移植修复后审批卡真机全链路通过（见 M4 段记录）
3. **card.action.trigger 按钮回调真机验证**：代码已就绪（platform.ts onCardAction + engine handleMessage 路由），但问题卡的按钮点击未被真实测试过——文本回答已验证，按钮回调路径相同但未跑通
4. **profile 模板更新**：`packages/acp/feishu-bridge/profile/` 里的模板还是 Linux 路径（/home/hm）+ glm 路由；本机用的是 profile 实例（install.sh 不覆盖），模板与实例已分叉——合并回 dev 前需统一
5. **M2 遗留**：✅ 完成卡的完整状态页脚（model/workdir/RAM）与紫色通知卡依赖 M4/M7
6. **spinner GIF 资源缺失**：✅（M4-C，2026-08-19）`resolveSpinnerAsset`（src/feishu/spinner.ts）按候选目录解析（src 源码平面 `../../assets`、tsdown 打包后 `../assets`、输出旁 `assets`），platform.ts 上传处改用它；待 daemon 重建后真机确认 stderr 不再报 ENOENT
7. 最终 cutover 时补：launchd plist 模板入 git、61 feature 对照表、运维文档

### M3 提交记录（feat/dsh-feishu-bridge，全部已 commit 未 push）

| commit | 内容 |
|--------|------|
| `db4ce0f52b` | M3 permission/question/plan 域移植（58 测试，646 全绿） |
| `8bdbb94103` | adapter approval answerer 接线（ctx.on('approval/request')） |
| `e48ab2bff5` | card.action.trigger 注册 + handleMessage permission 路由 |
| `fc98d577f0` | lazy userQuestions provider + question 数据传递 |
| `672ae772de` | CardSender 接口名修复（sendCard）——问题卡渲染根因 |
| `c86779ae21` | 事件循环阻塞 permission wait + planMode 接线 |
| `90de6e9004` | AskUserQuestion 答案交付拆分（awaitQuestionAnswer） |
| `1cf0453557` | MIGRATION.md 真机验证记录 |
