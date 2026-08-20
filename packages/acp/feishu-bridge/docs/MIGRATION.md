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
- **M4-E 装配层系统性对照清查（2026-08-19，测试先行）**：以 Go `cmd/cc-connect/wire.go` 逐行对照 TS `src/index.ts` 三处（Config schema / buildProjectAssembly 转发 / 引擎·平台 setter 是否被生产调用），产出 A/B/C/D 分类清单。本轮修复 B 类（漏接但 TS 已有实现）18 项（新增 `tests/assembly-config.spec.ts`，938→956 测试）：language 映射进 engine ctor；setBaseWorkDir + 启动期 work_dir_override 应用（applyProjectStateOverride 语义——/dir reset 此前无基目录可回）；setDirHistory（跨 project 共享一实例，对齐 Go NewDirHistory(cfg.DataDir)）+ 初始 workdir 入史——/dir 的 MRU/序号回退此前整体失效；display.stall_timeout_secs/stall_max_retries（engine 新增 setStallMaxRetries）；display.progress_spinner 与 patch_rate_interval_ms 转发到 platform（progress_spinner 此前被误塞进 engine setDisplayConfig 的 no-op 键）；idle_timeout_mins；queue.max_depth；subtask.max_depth/timeout_sec/gather_timeout_sec；spawn.worktree + 内存守卫（默认 80/90 always wired，TS 字段默认 0/0 即禁用）；per-project admin_from；interactive_idle_timeout_mins；attachment_send；stream_preview 调优（engine 新增 setStreamPreviewCfg）。C 类记录不接（引擎机制未移植，归后续里程碑）：absolute_turn_timeout_secs、unsolicited 三超时（spillover/tool-in-flight/background grace）、rate_limit 与 outgoing_rate_limit、show_context_indicator/context_window/reply_footer/usage（M7）、multi-workspace、全局 commands/aliases/banned_words（hints 已随 M8 前补充 4 迁移）、filter_external_sessions/session_cleanup_days、[users] 角色策略、restrict_to_workdir（adapter 无 setup/restrict 钩子）、dir_scan_paths（M7 #3）、SetUserRoles。D 类（Go 特有不迁移）：providerproxy 相关（proxy_response_timeout_secs）、run_as_user/run_as_env、serena、webhook/bridge/management web 栈。profile/ 模板 feishu-bridge 行已与 schema 全量同步（注释占位符风格）。
- **F 群验收合并（2026-08-19）**：FEATURE-PARITY.md（61 项：✅30/📋19/✂️10/❓2，#49/#52 行已按 D 群合并后的终态修正）、OPERATIONS.md 骨架（配置映射表/部署/回退/systemd）、deploy/ 三模板（plist 经 plutil -lint，占位符化无真实凭据）。遗留⑦ 关闭。❓2 项待归：#8 图片进模型上下文通路、#11 replyFooter（#11 已于 M7-b 归档为 ✅）；#35a 表情关闭门控归 E 群清查范围。**存量 doc-gate 债务（非本次引入，挂 M7/M8）**：feishu-bridge 与 cc-connect-bridge 的 README 缺 Known Limitations 段（verify-package-readme-limitations 红）；AGENTS.md 1959/1950 超词预算 9 词。
- **并行群 F/G（2026-08-19，零代码冲突）**：**F 群** M8 前置物料——61 feature 对照表初稿（源 cc-connect docs/features.md，产出 docs/FEATURE-PARITY.md）、运维文档骨架（docs/OPERATIONS.md，含 config.toml→cordis.patch.yml 映射表）、launchd/systemd 模板入 git（deploy/，遗留⑦）。**G 群** 遗留② 调查——workspace-write 沙箱 macOS 崩 daemon 根因（纯调查不改码，scratch profile 复现，产出根因链+分级修复方案；铁律不碰运行中 daemon）。M6 cron+relay 群挂 D/E 合并后队列（等装配面定型避免 index.ts 三方撞车）。
- **Wave 2 冒烟补缺（2026-08-19，第二轮）**：真机 /spawn→/done --reply 全链路通过后三项补缺，964 vitest 全绿（+27）、oxlint/typecheck 0。① groupName 生产接线（#49/#52 全链路）：Config 加 ProjectConfig.groupName 段（enabled/provider/timeoutSec/prompt/setAvatar），buildProjectAssembly 按 Go wireGroupName 接线——默认 enabled=true（本插件 agent 恒为 dsh，等价 Go claudecode 默认开）、timeout 30s、setAvatar 默认开；adapter 补 lightweightQuery（Go LightweightQuery：agents.create 新会话 + 命名路由 + reasoningEffort 'low'，发 prompt 收结果即 dispose，90s 超时/调用方 signal 中止）及 forkQuery/forkSessionWithProvider（共用 oneShotQuery + completedTurnPrefix seed）；另补 ProviderSwitcher（Go dsh 四方法，路由明细仍归插件 config——缺它 generateGroupName 空 provider 回退会静默失败回退到首条消息命名，即冒烟症状）。② im.chat.updated_v1（Go onChatUpdated）：platform 注册事件 + onChatUpdated（群名变化→chatNames.setName + chatRenamedHandler；Name/Avatar 变化→chatChangedHandler）+ SetChatRenamedHandler/SetChatChangedHandler；core/types 补 ChatRenamedNotifier/ChatChangedNotifier 能力接口；engine.start() 按 Go engine.go:2156 接线（handleChatRenamed 同步自身 Name 与子会话 ParentChatName 标签；changed 走既有 onChatChanged 防抖 bump）。③ /rename 命令移植（Go cmdRename，此前 TS 缺整个命令）：带参直接改名 + markPendingRename（防首条消息 LLM 改名覆盖手动名）；无参走 generateGroupName(buildCompactContext(history)) 重生成 + 图标头像刷新；buildCompactContext 随迁（200/500/3000 上限）。

- **E 群验收合并（2026-08-19）**：18 项 B 类接线修复（cf89cdaf6a，985 测试全绿；index.ts 三处冲突与 D 群 groupName 叠加保留）。生产 profile 已按旧 toml 补：language zh、display.stallTimeoutSecs 200/stallMaxRetries 3、adminFrom '*'、interactiveIdleTimeoutMins 30；重建 promote 后基础冒烟通过。**里程碑队列推进**：M5 chatroom 群、M6a cron+relay 群已派（装配面定型；命令注册各自独立文件避免撞车）；M6b monitor 群待 M5/M6a 合并后派；G 群沙箱调查在飞。

- **遗留② 关闭 + 前台权限修复（2026-08-19）**：G 群调查证伪 landlock 归因（darwin 沙箱链是 seatbelt，landlock 不可达；rc.7 workspace-write 端到端健康；历史崩溃最可能是构建态一次性故障且证据被 '>' 截断）——profile 已切回 workspace-write（含 permission preset），daemon 无崩溃。真机随即暴露并修复 M3 权限域错层移植：前台事件循环错套了后台 unsolicited 门（shouldSurfaceUnsolicitedPermission），导致沙箱 escalation 审批静默自动拒绝；b488d22b3c 按 Go 语义改为前台一律 surface（后台 auto-deny 留待 unsolicited reader，纯函数表测仍覆盖门语义），重做两个固化错误语义的测试。**真机审批全链路通过**：escalation 审批卡（含 justification + 允许/全准/拒绝按钮）→ 文本「允许」解锁 → 文件落盘 → 完成通知。986 测试全绿。运维改进采纳：daemon 重启日志改保留轮换（mv 时间戳）不再截断。
**M5 聊天室（✅ 代码 + 真机验收 2026-08-19，1349 测试）**
- 测试先行：engine_chatroom_test(46)、gather/end/venv/roles/ledger 套件。
- 实现：/chatroom #41、角色挑选 #43、--research #57、随便聊聊 #59、`feishu_bridge_chatroom` 工具族、bare persona。
- 验收：测试绿；真机一轮三人 chatroom。
- **M5 进度（2026-08-19）**：chatroom 域移植完成（+154 测试，合并 e63d8e7667）。**真机全链路通过**：/chatroom → moderator 读角色文件 → 角色挑选卡（推荐 5 选 3）→ 用户按钮交互（toggle + 确认开始）→ 角色群派发 → 多轮 gather 讨论（feynman/hamming 实质输出、relay 回 hub、ledger 按节更新）→ 用户要求总结 → end barrier → roles_removed=2 回收 + synthesis。**冒烟揪出并修复 M3 遗留 card.action.trigger 解析 bug（4399c5e2bd）**：payload 实为根层扁平 + snake_case 键（action/operator/context 在根、open_chat_id/open_message_id/open_id），M3 猜的嵌套 camelCase 从未对过真机——此前所有卡片按钮（审批卡/停止键/pick 卡）在生产均静默失效；im.chat.updated_v1 同病灶同修。picker 状态为内存态（Go 保形）：daemon 重启后旧卡成孤儿，属预期。
- **进度（2026-08-19，代码验收）**：移植完成——包内 1139 vitest 全绿（+154：chatroom-roles 7 + chatroom-ledger 6 + chatroom-session 3 + engine-chatroom 56 + engine-chatroom-end 19 + engine-chatroom-gather 32 + engine-chatroom-venv 10 + chatroom-persona 8 + assembly-chatroom 6 + chatroom-tool 7）、包级 oxlint/typecheck 0。实现范围：`src/engine/chatroom.ts`（gather/end 双 barrier、StartChatroom/AskRole/GatherRoles/maybeAutoRelayRole relay/EndChatroom 软收尾/NoteChatroom/ListChatroomRoles/AskHuman+routePendingHumanReply、research venv provisioning + uv hooks、armResearchManualAskTimeout #57 自动默认）；`chatroom-pick.ts`（#43 角色多选卡 + #59 选题单选卡状态机、watchdog、userTouched 防 late pick-roles 覆盖——picker 状态存引擎级 map 而非 interactiveState，因 TS 的 interactive state 每轮被替换）；`chatroom-cmd.ts`（cmdChatroom 参数解析含 --research/--mode/--max-rounds、afterChatroomStarted 含 research 助手预派发 + moderator 进程回收、startChatroomDirectRole 1:1 直聊 #41 特性 2、/chatroom list）；`chatroom-priming.ts`（主持/研究/挑角色/选题 priming，工具引用全部改写为 feishu_bridge_chatroom/subtask 工具面）；`chatroom-persona.ts`（角色/直聊/主持 bare persona 全量 prompt + CLAUDE.md @import 展平）；`chatroom-roles.ts`/`chatroom-ledger.ts`（角色目录装载 + 三文件账本，磁盘格式与 Go 一致）；adapter setup 钩子（D3 complete:true section 替代 Go --bare；研究助手走 append section）；engine.ts 挂钩（turn-start stamp、turn-end relay、routePendingHumanReply、ExitPlanMode pick 期自动批准、askq manual 超时 arm、act:/chatroom-pick 卡片回调路由、buildSessionEnv CC_CHATROOM_LEDGER/DIRECT_ROLE/MODERATOR/venv PATH）；配置 [chatroom] 全字段（schema + wireChatroom if 段 + profile 模板，per-project 覆盖共享默认）；`feishu_bridge_chatroom` 工具族（9 action，D 模式 caller-agent 路由）；修订版 skill `skills/feishu-bridge-chatroom-moderator/`。**待办**：真机三人 chatroom 冒烟（父会话）；endChatroom 期间 ledger append 的持久化顺序比 Go 弱一个微任务（TS 写入异步串行化，已注释）。

**M6 Monitor + Cron + Relay（cron+relay ✅ 2026-08-19；monitor 代码验收完成 2026-08-19，真机冒烟待父会话）**
- 测试先行：engine_monitor_test(49)、monitor_cmd、cron_test(19)、feishu_monitor_poll。
- 实现：#53 全部（观察/规则+LLM 分诊/dispatch 模式/coalesce/no_report/轮询兜底//monitor 命令）；cron 全量移植；relay；`feishu_bridge_cron`/`feishu_bridge_relay` 工具。
- 验收：测试绿；真机监控群一条告警全链路 + 一条定时任务触发。
- **M6a 进度（2026-08-19）**：cron+relay 移植完成（合并 commit 含 164c5b4edb，1058 测试全绿，+72：cron 30 + execute 3 + commands 6 + relay 11 + 工具 16 + 装配 6）。自写 5 域 cron 解析器（robfig 月/星期名与 @every 未移植——存量纯数字域；天花板已注明）；持久化 <dataDir>/crons/jobs.json 沿用 Go snake_case 键；/cron 全族命令 + feishu_bridge_cron/relay 工具族（caller agent 路由）；relay 绑定落盘 Go 键序。**真机冒烟通过**：/cron add（19:22 建）→ 准点触发（19:24 ⏰ 注入 + agent 执行 + 完成卡 + ✅ tokens）→ /cron del 清理。遗留：/status 的 cron 行未接（需改 commands.ts，避免与 chatroom 群撞车留待）；多工作空间 per-workspace agent、heartbeat 归后续。
- **M6b 进度（2026-08-19）**：monitor 域移植完成（+137：monitor 80/commands 32/poll 18/assembly 5/status 行 2；合并 a3994621bb）。/status cron 行已顺带接线。**真机告警全链路通过**（监控群 oc_34a8faa3c14461fa7b79419e5cd89cee）：profile 配 monitor（chats=监控群 + 冒烟告警确定性规则）→ 用户发「【冒烟告警】磁盘使用率 91%」→ 规则快路径命中 → 「🔍 已为这条消息拉群排查」通知卡（含跳转）→ 子群派发（LLM 改名「磁盘使用率告警排查」+ 头像）→ agent bash 排查 → 完成卡 → /done --reply → 监控群收到「子任务完成」卡（含实质排查结论）。遗留：/learn 的引用消息抓取通路（fetchQuotedMessage）待排期。**M6 全部验收完成。**
- **M6-a cron+relay 域进度（2026-08-19，monitor 域另派并行）**：代码与移植测试完成，包内 1056 vitest 全绿、包级 oxlint/typecheck 0。cron：`core/cron.go` → `src/engine/cron.ts`（CronJob/CronStore 落盘 `<dataDir>/crons/jobs.json` 沿用 Go snake_case 键；CronScheduler 自带标准 5 域 cron 解析器——robfig 的月份/星期名与 `@every` 描述符未移植，存量与测试均为纯数字域；mute/silent、session 复用与 new_per_run（每跑 `key#cron:<sid>` 独立 interactive 槽）、timeout_mins、编辑/校验、错过不补跑语义与 Go 一致）；`/cron` 命令族 + 列表卡（act:/cron 按钮走 handleCardAction 路由）在 `src/engine/cron-commands.ts`（registerCronCommands 合并进既有命令表，不碰 commands.ts）；`Engine.executeCronJob/executeCronShell`（工作目录切换走 WorkDirSwitcher——多工作空间 per-workspace agent 未移植的天花板；CronReplyTargetResolver 能力接口随迁仅测试桩实现）。relay：`core/relay.go`+`engine_cmd_relay.go`+cmdBind → `src/engine/relay.ts`/`src/engine/relay-commands.ts`（绑定落盘 `<dataDir>/relay_bindings.json` Go 键序；`Engine.handleRelay` 含超时部分回复 + 后台 drain 续命 + 陈旧 resume 回退；`/bind` 族）。配置：schema 加 `cron{silent,sessionMode}`/`relay{timeoutSecs}` 独立块，apply() 建 process-wide scheduler/manager、每引擎 registerEngine+setter，工具 `feishu_bridge_cron`(add/list/info/edit/del)/`feishu_bridge_relay`(send/bind/binding) 经 caller agent 路由注册。测试：cron.spec(30，cron_test.go 19 函数)+cron-execute(2)+cron-commands(6)+relay.spec(11，relay_test.go 5 函数+绑定生命周期)+cron-tool(8)+relay-tool(8)+cron-relay-assembly(6)=+71。真机定时触发归父会话冒烟。

- **M6-b monitor 域进度（2026-08-19，测试先行）**：代码与移植测试完成，包内 1195 vitest 全绿（+137）、包级 oxlint 0（顺手修掉 engine-m3-permission.spec 一笔基线存量 `String(x)` 冗余转换）/typecheck 0。monitor：`core/engine_monitor.go`+`engine_monitor_cmd.go` → `src/engine/monitor.ts`（MonitorCore 持全部 monitor 状态、经 `engine.monitor` 触达；规则快路 + LLM 分诊 LightweightQuery（provider 显式→active 回退）、dispatch/monitor 双模式 prompt、目录澄清卡（含 dispatch 模式 dir_scan 池）、/learn few-shot（MonitorExampleStore 落盘 `<projectDataDir>/monitor_examples.json`，corrupt 文件 `.corrupt` 副本保全）、coalesce（同目录窗口内并群，meta 内存态重启即失效安全回退新拉群）、no_report、maxConcurrent 上限卡、OnIt/Done reaction 生命周期、`/monitor` 命令族在 `src/engine/monitor-commands.ts`（registerMonitorCommands 合并既有命令表不碰 commands.ts；/monitor 进 Go privilegedCommands 对应的 admin 门）；命令运行时改 chats/mode 经注入 save 函数持久化——Go 重写 config.toml，TS 侧 cordis.yml 运行时只读，故落 ProjectStateStore（monitor_chats/monitor_mode，装配时覆盖配置值））。轮询兜底：`platform/feishu/feishu_monitor_poll.go` → feishu 平台 `latestMessageTime`/`listMonitorMessages`（MonitorPoller 能力）+ `extract.ts` 补 `unwrapCardContent`/`extractInteractiveCardText`（schema 2.0 递归 + legacy 根级 text，表格/列表/column_set 随迁）/`extractCardImageKeys`；api client 加 `listMessages` verb（raw_card_content）；`cmd:` 卡片按钮动作分发（/learn 删除按钮）。平台 @-drop 与 allow_chat 闸对监控群与 /monitor 命令豁免（对齐 Go dispatch）。M6a 遗留的 /status cron 行已接（commands.ts 对齐 Go engine_cmd_misc.go，含测试）。配置：schema 加 `monitor{enabled,chats,contextWindow,spawnNotice,maxConcurrent,triageProvider,triagePrompt,dirs[],rules[],learnEnabled,learnMaxExamples,reactEmoji,pollIntervalSec,fallbackUser,mode,coalesceEnabled,coalesceWindowSec}` 块，wireMonitor 按 Go main.go 默认值装配（spawn_notice 5/learn 20/Get/30s/coalesce 300s；无效 rule pattern 告警跳过）。Go api.go 无 monitor handler，故不加工具。测试：monitor.spec(80，engine_monitor_test.go 49 用例全量)+monitor-commands(32，engine_monitor_cmd_test.go)+monitor-poll(18，feishu_monitor_poll_test.go)+monitor-assembly(5)+commands.spec cron 行(2)=+137。**天花板**：① feishu 事件路径未移植引用消息抓取（Go fetchQuotedMessage/formatReplyChain），真机 /learn 需引用消息的通路缺失（引擎侧 extractQuotedText 已就绪并有测试）——归后续里程碑或父会话决策；② dispatch 分诊 listChatMembers 的 Go「partial roster + error」语义经 error.partial 字段桥接（TS throw 契约）；③ ChatMemberManager 平台实现的 partial 已在 listChatMembers 落盘。真机监控告警全链路（监控群配置+webhook 卡兜底+分诊拉群）归父会话冒烟。

**M7 渲染 + Provider + 剩余 features（✅ 代码 + 真机验收 2026-08-19，1769 测试）**
- 测试先行：engine_plan_render_test(~50)、engine_cmd_* 余量、usage/provider 相关。
- 实现：#47/#48 plan/reply HTML（渲染会话 = create + seed + complete prompt + 无工具 + stall 重试）、#51 Lucide、predict_next #33、turn_summary、NO_REPLY #28、撤回取消 #30、dir_scan #3、usage #1、/provider #9/#12、feishu_workspace #18（CC_FEISHU_* 进工具上下文）、`feishu_bridge_lark` 工具。
- 验收：测试绿；feature 对照表初稿（61 项全列）——对照表由 F 群提前完成并随各群合并持续刷新（当前 ✅33/📋20/✂️10/❓0）。
- **M7-d 验收合并 + 真机收官（2026-08-19）**：d 群完成（+102 测试：lark 工具 75/引用链 9/附件通路 9 等；合并 392723d2b8，四群合计 1349→1769）。#8/#11 核实关闭（图片落盘保形通路 / reply_footer 移植默认关）；/learn 引用抓取关闭；README Known Limitations 落盘（本包 doc-sync 红灯转绿，cc-connect-bridge 红灯挂 M8 归档）。**真机冒烟（修复 01510b91ef 后）**：① 渲染管线全链路首通——长回复触发 → 渲染会话（HTML 1790B）→ render-png.sh PNG → 上传 → 群内「🖼️ 回复·HTTPS 完整握手流程」图片卡；② 通知卡完整状态页脚真机生效（📁 workdir·branch·时长·t/s 头 + 💾 RAM/Disk❗ + 🤖📊🍵 折叠面板，/new 卡同款）；③ /provider 命令族（当前/列表卡；switch 机制单测覆盖，生产单路由未演练）；④ feishu_bridge_lark 工具 agent 实调成功（chat-list + 交叉定位群名）。**真机揪出并修复三笔**：飞书 300123 拒绝无 submit 的 form 包装（collapsible_panel 直出 + appendIntoLastCollapsible 双形态）；渲染 skill prompt 字面 {{ICONS}} 触发 dsh 变量名校验（重写措辞）；recalled_v1 告警核查（注册在位）。**留日常验证**：真实消息撤回取消（lark-cli 无撤回命令）、/provider 双路由切换。
- **M7 后用户日常使用反馈修复（2026-08-19 深夜，共 5 笔 1774 测试）**：
  1. 渲染提速 → planRender effort off（glm-5.2 经 mify 忽略 effort 档位，仅 off 真降级；整链 42s 主回复+渲染 <90s）
  2. 头像白方框（ed01be9d18→5c0086e8b6）：librsvg vs oksvg 描边几何差异，oksvg-14 实测等效 6 仍偏粗，用户从 4 档对比图挑定 3；常量旁记录三段测量史
  3. AskUserQuestion 单选卡复刻 Go ListItemBtnExtra（4e484936ab）：label+说明全文左、序号小按钮右——此前 label 整段塞按钮被飞书截断省略号；顺带修复多选表单提交从未收集勾选项的隐藏 bug（collectAskqMultiSelectedFromFormValue 漏移植）
  4. 工具结果回填空白（295ad933b3）：dsh 真实工具结果包在 {type:tool-result, content:[text]} 块里，textOfBlocks 只读裸 text 块——进度卡结果区恒空白；下钻内层 content
  5. plan 模式默认缺失（8ec5d80d61）：旧 toml [projects.agent.options] mode="plan" 无对应 schema 字段，会话裸奔 default 模式（删文件直接执行）；加 agent.mode → adapter 持久默认模式（/mode 单次覆盖优先、spawn 继承），真机验证计划卡+计划渲染图+ExitPlanMode 审批全链路
  用户反馈模式价值实证：五笔全是 stub/mock 测不到的「真实世界形状」偏差（渲染器几何、payload 块类型、卡片校验、配置默认值），M8 记账户驴日常使用回归正是为此设计。
- **渲染提速（2026-08-19，用户反馈对齐旧仓同类问题）**：渲染耗时长 → 根因与旧 cc-connect 相同——glm-5.2 经 mify 忽略 effort 档位，forceAdaptiveThinking 路由上 low 仍发 adaptive thinking 字段并展开长思考；**只有 off（省略 thinking 字段）是真降级**（旧仓 query.go 探测：无字段 336tok/4s vs adaptive 1509tok/15s）。profile planRender.effort 改 off（HMR 生效），真机验证整链（主回复 42s + 渲染 + PNG + 上传）约 1.5 分钟、图片卡 22:10 送达，渲染段显著缩短。模型换 always-thinking 模型（如 glm-5.3）时须回调 low（mify 拒绝省略 thinking，400 code 1210）。
- **M7-b 进度（2026-08-19，测试先行）**：usage 域 + 通知卡完整状态页脚移植完成（还清 M2 未竟事项①与 Wave 1 遗留 spawn-notify 页脚），包内 1465 vitest 全绿（+116：usage 22 + status-footer 87 + 装配 6 + /new 卡 1；基线 1349 零回归）、oxlint/typecheck 0。实现范围：`src/engine/usage.ts`（Go core/usage_provider.go 的 UsageProvider/工厂注册/ActiveDetector/SyncUsageFetcher + usage/glm、usage/minimax 全量，fetch 可 stub）；`src/engine/status-footer.ts`（buildStatusFooter 五类行 / buildStatusFooterElements 折叠面板 / buildCompletionUsage / setCompletionDurations / setTokenRate / unionDuration / formatGitBranch（3s TTL 缓存）/ formatMemInfo / currentModelLabel / buildReplyFooter 全家）；engine.ts 只换调用点（turn 末 token 累积 + ctx self-report 剥离 + 非模型区间追踪喂 token rate）。紫色通知卡完整形态：headerSuffix（📁 dir·branch · 时长 · t/s）+ 折叠面板（⌛ 配额做标题，🤖/📊/🍵/💾/会话 ID/chat ID/📝 未提交文件/Open Editor 按钮折叠；💾 带 ❗ 时可见）+ sendCardWithHandle + state.notificationHandle/FooterMsg/FooterElements/HeaderSuffix（为 predict-next 洞察卡预留）+ spawnJumpMarkdown（ancestorChain 面包屑/父群按钮，Markdown 链接折叠）+ subtaskDiffElements 接入；spawn-notify 卡（/spawn、chatroom ready、subtask）改用同一 buildStatusFooterElements（关闭 engine 内 TODO(M7)）。配置：`usage_providers[]`（type+options）、`display.editor_url`、project `context_window`、features.show_context_indicator/reply_footer 接线（默认 true/true/false 对齐 Go）+ profile 模板同步 + 装配测试 6 条；/new 改发同一紫色页脚卡（Go cmdNew，reset 后无 token 行）。#11 核实结论：Go reply_footer = 非静默回复尾部 `*model · effort · 余额% · workdir*`、默认关；TS 全量移植，dsh adapter 补 getModel/getReasoningEffort（ModelSwitcher 能力面），余额段因 adapter 无 UsageReporter 空缺（能力面就绪，见 FEATURE-PARITY #11）。**刻意分歧**：RAM 行用 os.totalmem/freemem（Go 读 /proc/meminfo，macOS 上整个 💾 行为空）；unionDuration 不再原地排序（拷贝后排序，测试传拷贝）。**待办**：真机通知卡视觉冒烟（父会话）；predict-next 洞察卡消费 notificationHandle（M7 后续）；/usage 命令未移植（quota 已走 ✅ 页脚）。

- **执行拆分（2026-08-19）**：M7 拆四群并行——a 渲染域（plan/reply HTML #47/#48，engine_plan_render 3777 行 + render-png 复用）；b usage 域 + 通知卡完整状态页脚（#1 + 紫色卡 + subtaskDiff 接入 + #11 replyFooter 核实）；c provider + 会话散件（#9/#12/#33/#28/#30 + reset_on_idle/auto_compress 等 C 类项）；d workspace/lark/媒体杂项（#18/#3/#8 + /learn 引用抓取 + README Known Limitations 债务）。engine.ts 热点纪律：各群逻辑收新文件、engine.ts 只加最小挂点；index.ts 本轮归 d 群系统性改动。真机冒烟项（渲染视觉/通知卡页脚//provider 切换/lark 工具）由父会话统一执行。
- **M7-a 验收合并（2026-08-19）**：渲染域完成（+132 测试，1481 全绿，零冲突）。plan-render.ts(~1100 行) + 逐字节 vendored 模板 53KB；engine.ts 仅最小挂点；adapter renderQuery（setup complete:true + effort→reasoning 映射）；export:/sendreply: 卡片动作。plan_render 配置块（enabled 默认 off/provider/effort/renderPngScript/timeoutSec）。**注**：brief 里的 /render 命令族经核实 Go 无对应物（render* 均为卡片构造器已随 M2/M6 移植），无遗漏。真机 HTML→PNG（chromium）冒烟待四群齐后统一做。
- **M7-b 验收合并（2026-08-19）**：usage 域 + 通知卡完整状态页脚完成（+116 测试，合并 019763bd4d，1597 全绿）。status-footer.ts 五类行全家 + 紫色通知卡完整形态（headerSuffix/折叠面板/notificationHandle 状态/subtaskDiffElements 接入/spawn 面包屑）；usage.ts（glm/minimax UsageProvider + 工厂注册）；#11 replyFooter 核实并移植（默认关；余额段待 adapter UsageReporter 能力生长，已记 FEATURE-PARITY）。/new 与 spawn-notify 卡共用 footer（关闭 M2 未竟①与遗留 5）。RAM 用 os.totalmem（macOS /proc 不可用）。待办：真机通知卡视觉冒烟。
- **M7-c 验收合并（2026-08-19）**：provider + 会话散件域完成（+70 测试，合并 606b6f4ae0，1667 全绿）。/provider 命令族（切换持久化走 ProjectStateStore、--resume 走 dispose+resume D1 路径）+ providerShortcuts（/strong）；predict_next #33 + turn_summary（predict.ts 双模式 fork + 洞察卡）；撤回取消 #30（im.message.recalled_v1 订阅，按扁平 snake_case 实测约定接线——吸取 4399c5e2bd 教训）；reset_on_idle（/switch 可回）；auto_compress（ctx.compaction.compactNow 原生调用）；filter_external_sessions 接配置；session_cleanup_days 记录不迁移（/list 为 live-only 视图）。散件不迁移/留待：provider add/remove/presets 与 provider 卡（运行时不可建路由）；#12 context_window 归 usage 域。真机 /provider 切换冒烟待统一做。

- **M7-c provider 切换 + 会话散件域进度（2026-08-19，测试先行）**：代码与移植测试完成，包内 1419 vitest 全绿（基线 1349 + 70）、包级 oxlint/typecheck 0。范围与落点：
  - **/provider 命令族 #9**（`src/engine/provider-commands.ts` + `provider.ts`，Go engine_provider.go/provider.go）：bare 列表（▶ 当前标记 + 切换提示，纯文本面——provider 卡留待 M7 渲染域）、`switch <name>`（清 agent session id + 历史，下条消息起新会话走新路由）、`switch <name> --resume`（D1 路径：保留 sessionId，adapter dispose + resume 新 agentOptions）、`current`/`clear`（clear 走 adapter setActiveProvider('') 清空语义，回退 dsh 默认路由）；切换持久化经 ProjectStateStore `active_provider`（Go 写 config.toml，TS cordis.yml 运行时只读，同 monitor_chats 覆盖模式），装配时 projectState.activeProvider() 覆盖配置默认。**不迁移**：add/remove/presets（GitHub 预设拉取）——provider 是 profile 命名路由（D2），运行时无法创建 llm 路由；provider 卡（act:/provider 按钮）留待渲染域；per-provider context_window（#12）消费方是 ctx indicator（usage 域），仅落 `getProviderModel` 纯函数（predictNext 标签消费）。
  - **provider_shortcuts**：engine.providerShortcuts + dispatchCommand 未知命令时的 shortcut 挂点（Go handleCommand 的 provider_shortcut 分支）→ cmdProviderShortcut（切换 + 新会话 + 持久化）。
  - **predict_next #33 + turn_summary**（`src/engine/predict.ts`，Go engine_predict.go）：generatePrediction（lightweight 单发查询 / resume fork 双模式，首行 ≤200 字符）、generateTurnSummary（≤120 runes，短回复 ≤150 runes 跳过）、sendInsightCard（Go 保形：每 fork 到达即增量发卡——先 summary-only 后 combined；✨/📝/💡 标题 + 发送(cmd:)/屏蔽(act:/nopred)按钮；turnSeq 防过期；洞察卡的原位更新不迁移——TS 完成通知无句柄，洞察卡以新卡投递）、triggerInsights 挂在 handleResultEvent 完成通知后（静默 turn 与有排队消息跳过）、act:/nopred 卡片动作（禁用本会话预测 + 原位刷新确认卡）；**/btw** 旁路提问（Go cmdBtw：live session → 持久化 sessionId 回退，worktree/override 工作目录传给 fork，300s 超时，绝不降级为主会话消息）。
  - **撤回取消 #30**（`src/engine/recall.ts` + platform）：cancelQueuedByMessageID（inflight 优先于 queued，cancelled/inflight/not_found 三态 + 本地化回复；TS 排队消息自带附件，Go staged-attachment 分支不适用）+ RecallNotifier 能力接口 + platform `im.message.recalled_v1` 订阅（payload 根层扁平 snake_case，同 card.action.trigger 实测约定）+ engine.start() 接线。
  - **reset_on_idle**（`src/engine/session-misc.ts`，Go maybeAutoResetSessionOnIdle）：handleMessage 取锁后轮换陈旧会话（有 backend id 或历史才轮换；旧会话历史与 agent id 保留可 /switch 回；graceful 关闭提示）；slash 命令不触发（命令分发在取锁前）。
  - **auto_compress**：SessionCompressor 能力（DshAgentSession.compress → ctx.compaction.compactNow，Go 的 "/compact" 消息往返变为原生服务调用；compaction 服务未加载时报 not-supported）+ /compress 命令 + turn 结束触发（estimateTokensWithPendingAssistant ≥ maxTokens 且距上次 ≥ minGap；通知带 token 估计）。**天花板**：Go runCompress 的压缩后事件排水/权限自动批准由 dsh compactNow 内部承担。
  - **filter_external_sessions**：机制 M1 已有（applySessionFilter + knownAgentSessionIDs），本轮接配置（setFilterExternalSessions）+ 移植 Go FilterExternalSessions 测试两例。
  - **NO_REPLY #28**：M2 已移植（message-split.ts + 引擎路径），本轮补引擎级测试（裸 NO_REPLY 全静默 + 尾部标记剥离后投递正文）。
  - **session_cleanup_days：记录不迁移**——TS /list 是 live-session-only 视图（M1 定型，adapter.listSessions 只枚举活会话），无持久化会话枚举/删除能力（无 SessionDeleter），Go cleanupOldSessions 的 🧹 清理按钮无处落地。
  - 配置（index.ts schema + 装配 + profile 模板同步）：`predictNext{enabled,provider,timeoutSec,prompt,mode}`（默认 120s/lightweight）、`turnSummary{enabled,provider,timeoutSec,prompt}`（默认 30s）、`autoCompress{enabled,maxTokens,minGapMins}`（默认 gap 30min）、`providerShortcuts`、`resetOnIdleMins`、`filterExternalSessions`；装配顺序调整：projectState 先建（active_provider 恢复先于 adapter 构造）。
  - 测试：provider(4) + provider-commands(11) + predict(22) + recall(4) + feishu/message-recalled(3) + session-misc(15) + assembly-misc(11) = +70。adapter 改动：setActiveProvider('') 清空语义、DshAgentSession 构造接 ctx（compress 用）。真机 /provider 切换冒烟归父会话。

- **M7-d 进度（2026-08-19，测试先行，+102：dir-history-fuzzy 1 + commands fuzzy 1 + assembly 2 + workspace-env 2 + adapter-workspace 3 + lark-tool 75 + attachment-staging 9 + adapter send 重写 1 + platform-quote 9，1349→1451 全绿；包级 oxlint/tsc 0）**：④ 个域落地。① **feishu_workspace #18**：`ProjectConfig.feishuWorkspace` 配置块 → `engine.setFeishuWorkspace`/`feishuWorkspaceEnv()`（空字段跳过，含 relay 会话注入）→ `buildSessionEnv` 追加 CC_FEISHU_* → adapter `feishuWorkspaceSection` 经 D3 setup 钩子注入系统提示段（order 110，替代 Go 进程 env；chatroom bare persona 不注入，对齐 Go memory-file 语义）。② **feishu_bridge_lark 工具（D4）**：`src/tools/lark.ts` 透传 lark-cli 子命令面（args: string[]）；bot 模式进程内 mint TAT + LARKSUITE_CLI_* 注入、`--as user`/auth 子命令走 `--profile <app_id>` 前置（显式 --profile 跨项目即拒）、`im +chat-messages-list` 原生直调 OpenAPI（raw_card_content）、`+create` 后 auto-grant same_tenant、lark-cli 版本门禁（≥1.0.69，mtime 键磁盘缓存）；caller agent 路由到 project feishu 凭据（免 env）；Go envWithoutCCProject/sanitizedLarkEnv 的 shell wrapper 递归陷阱在进程内不存在，未移植（测试注释记因）。③ **dir_scan #3**：`dirScanPaths` 配置（~ 展开）→ `setScanPaths` 装配；`resolveScanPathFuzzy` 模糊兜底（Go 打分表 1:1，levenshtein 复用 lucide/fuzzy）接进 /dir 的 resolveDir。④ **#8 图片进模型上下文核实+接线**：Go 语义 = dsh 后端从不把图片字节放进模型上下文——纯附件消息 stageAttachments 落盘 `<workDir>/.cc-connect/pending/<sha256[:12]>/` 暂存（placeholder 状态，下一条文本消息 drain + splice 成路径 bullets）；带文字消息经 dshSession.Send 落盘 `.cc-connect/attachments` 并附 "(Images saved locally...)" 注记；adapter.send 的 M1「仅文件名注记」占位已按此重写；stopInteractiveSession/cleanup 调 discardStagedAttachments（/new 泄漏回归测试随迁）；adoptPendingFromPlaceholder 补 pendingAttachments/pendingDir 迁移。⑤ **/learn 引用抓取（M6b 遗留）**：平台 `getMessage` verb（GET im/v1/messages/{id}?card_msg_content_type=raw_card_content，裸 HTTP 同 getBotInfo 模式）+ fetchSingleMessage/fetchReplyChain（深度 5、环形断链、时间正序）/formatReplyChain（单条 bracket / 多条编号+角色），text/post 消息经 dispatchWithQuote 附 extraContent 前缀与 quotedText/quotedSenderType/quotedUpdateTimeMs（后两者为 M7 fork-at 回滚群预置数据面）；失败静默降级（消息照常投递）；thread isolation 跳过。**#11 replyFooter 核实结论**：Go = 每条就地回复追加 Codex 式状态行（model · effort · ctx%/usage · workdir，engine_send.go buildReplyFooter），数据面依赖 #1 usage 域的能力 getter 与 ctx% 计算——归 M7 usage 域实现（FEATURE-PARITY 已由 ❓ 改 📋，默认关语义天然成立）。**杂项**：包 README 落盘（含 Known Limitations 段，verify-package-readme-limitations 对 feishu-bridge 转绿；cc-connect-bridge 存量红灯仍挂 M8）；profile 模板与 OPERATIONS.md 映射表补 dirScanPaths/feishuWorkspace 行；FEATURE-PARITY ❓ 清零（#3/#8/#18 → ✅，统计 ✅33/📋20/✂️10）。lark 工具真机冒烟归父会话。

**M8 前补充：feishu_bridge_send 工具（2026-08-20，测试先行，+10：send-tool 9 + persona 断言 2-1）**：补「agent 发文件给你」缺口（MIGRATION 期间唯一未被 61 项源表覆盖的能力断点——Go `cc-connect send` CLI + `AgentSystemPrompt` 注入，TS 侧 `sendToSessionWithAttachments` 引擎/平台链路 M1 已在但无 model 可见入口，chatroom persona 投递段被刻意删掉等工具）。`src/tools/send.ts`：`feishu_bridge_send` 工具（files: string[] + 可选 message；caller-agent 路由复用 index.ts 共享 route；本地路径读取 port Go readAttachment——50MB 上限、扩展名表+magic sniff mime、image/* 走 sendImage 其余 sendFile；相对路径按 `engine.sessionWorkDir`（新增，per-chat override → agentWorkDir）解析；单一 files 参数+自动分类为刻意简化，天花板：用户要「图片以文件形式下载」时需加 asFile 参数）。persona 恢复 Go `ChatroomRoleBaseSystemPrompt` 的「把生成的图片或文件发回给用户」段（工具形）+ research prompt 出图句补 feishu_bridge_send。**普通会话发现通路**：仅靠工具 description（D4 既有模式，cron/relay/subtask 同款）；若真机冒烟发现模型只回路径不调工具，升级路径是给 plain session 加最小 systemPrompt section（记入 Agent Note，不先做）。**顺带发现已当日修复（见下一条）**。i18n `RelaySetupOK`/`CronSetupOK` 判定为残留：其 Go 调用方 setupMemoryFile 写记忆文件，dsh 下恒走 native 分支，不接线不删除（README Known Limitations 记因）。**真机冒烟通过（同日）**：开发虾群 plan 审批后 agent 生成 report.md → `feishu_bridge_send` 投递 → 群内收到 `msg_type:file` 文件消息 + 附带文本，sideText 去重生效。

**M8 前补充 2：subtask 子会话前导补齐（2026-08-20，+2 测试，1806 全绿）**：修复 send 工具调查顺带发现的 prompt 接线缺口——Go `buildAppendSystemPrompt` 以 `CC_SUBTASK` 为键给子会话追加前导（`SubtaskAgentSystemPrompt`；no-report 时 `SubtaskNoReportAgentSystemPrompt`；research 再叠 `SubtaskResearchAssistantPrompt`），TS `buildSessionSetup` 原先只消费 research-assistant 旗标，普通 subtask 子会话与 no-report 子会话均无前导（M4 冒烟靠工具自述 report 动作 + 用户 `/done` 掩盖）。adapter 的 subtask 分支现保形移植该选择逻辑（section 名统一 `feishu-bridge-subtask-preamble`，order 120，workspace section 110 同挂——对齐 Go 经 env 注入），`subtaskNoReportAgentSystemPrompt()`（工具形：产物用 feishu_bridge_send 发本群、勿 report）随迁入 chatroom-persona.ts。research assistant 行为不变（生产 env 恒带 `CC_SUBTASK=1`）。**真机冒烟通过（同日）**：父 agent 经 `feishu_bridge_subtask`（action: spawn）派发 → 子 agent 前导生效（plan 里即含「action: report 回报」步骤）→ 完成即主动 report（日志 `subtask: reported to parent`）→ 父群收到「子任务完成」卡 → 父 agent 被唤醒核实产物，全链路无用户 `/done` 介入。**边界澄清（勿混淆）**：用户 `/spawn` 命令走 `spawnGroupCommon`（commands.ts），不设 subtask depth，Go 同样不注入前导——其回报通路是 `/done --reply`，与本前导无关（本轮冒烟先误用该面后纠正）。

**M8 前补充 3：effectiveMode bypass 移植（2026-08-20，+5 测试，1811 全绿）**：修复 subtask 前导冒烟暴露的缺口——Go `effectiveMode`（dsh.go:402）把无人值守会话（`CC_SUBTASK=1` 非 ATTENDED、chatroom role/direct-role）升为 `bypassPermissions`（工具审批直接 allowed-once、plan 强制关），TS adapter 未移植导致子会话继承 project plan 默认、整轮停在无人能答的 ExitPlanMode 审批卡。落地：`sessionBypassesPermissions(env)` 纯函数（adapter.ts 导出，谓词表对齐 Go session_test 四例）→ `DshAgentSession.bypassPermissions` 快照（对应 Go permMode/autoApprove）→ `approval/request` answerer 短路 `allowed-once`（AskUserQuestion/plan-review 走 userQuestions 通道不受影响，#15 保真）；attended subtask 与 moderator 保持正常审批。Agent Note `bug-fix/2026-08-20-feishu-bridge-effective-mode-bypass.md`（中英+sidecar）。

**M8 前补充 4：hints 快捷提示按钮迁移（2026-08-20，测试先行，+28 测试，1839 全绿）**：用户反馈完成卡无 hints/hints_with_param/hints_common 按钮——M4-E 清查时归入 C 类（「引擎机制未移植」）一直未接。本轮全量移植 Go `engine_cmd_misc.go`/`hint_usage.go`/`feishu_dispatch.go` hints 面：`src/engine/hint-usage.ts`（三类点击计数 + `<dataRoot>/hint_usage.json` write-through 持久化 + 频率稳定排序；**有意偏离**：Go 的 load/save 丢 `hints_common` 计数，TS 三类全持久化）；`src/engine/hints-panel.ts`（`hintButtonName` base64url 编码 + 95 字符上限 FNV-1a 哈希兜底 + 进程内映射反查（同 Go sync.Map，daemon 重启后超长 hint 旧按钮不可解码 = Go 同构）；面板构建：compact 每行 3 个等宽 form_submit、with_param 每条 button+input 行（`_arg` extra 指向 `hint_arg_<i>`）、common 常显行）；status-footer 合并（hints 面板折进 collapsible + `status_footer_form` 包裹——schema 2.0 无提交后裔的 form 报 300123，故仅在配置了 hints 时包 form；common 追加 `hints_common_form`；空状态早退 = Go 保形，hints 只搭载已有内容的页脚）；platform onCardAction `hint__` 名解析 → `cmd:` 分发 + `_arg` formValue 取参（无 `_arg` 兜底首个非空字符串值）+ 点击回显 + `setHintClickHandler` 计数（engine.start 接线，`HintClickReporter` 能力接口）；Node base64url 解码对非法字符静默跳过（Go 报错），以再编码校验还原严格拒绝语义；`/hint` 命令（空配置回 `hints_empty`、无卡平台编号文本列表、卡片 = common 常显 form + 折叠 💡 面板）；Config 顶层 `hints`/`hints_with_param`/`hints_common`（全局键，对齐 Go 顶层 toml）+ apply 共享一个 HintUsage 实例（对齐 Go main.go:517 跨 engine 共享）。生产 profile（`~/.dsh/profiles/feishu-bridge/cordis.patch.yml`）已从 `~/.cc-connect/config.toml` 拷入三组原值。

**M8 前补充 5：per-provider context_window 接线（2026-08-20，测试先行，+4 测试，1843 全绿）**：补 FEATURE-PARITY 复核发现的天花板——`applyActiveProviderContextWindow` 引擎方法 M7 已在，但插件 `ProviderRoute` 无 contextWindow 字段、adapter `getActiveProvider()` 仅回 name，生产恒走 project 级回退；且 Go 在每次切换（engine_provider.go:507/715/751、卡片切换 engine_cmd_card.go:365）后都重算窗口，TS 只在装配时算一次。落地：Config `providers[].contextWindow`（Schema + JSDoc + config-catalog 中英同步）→ 装配进 adapter 路由 → `getActiveProvider()` 按需带出（exactOptionalPropertyTypes 条件展开）→ provider-commands 四处切换点（switch / switch --resume / clear / shortcut）成功后立即 `e.applyActiveProviderContextWindow()`（对齐 Go 顺序：重算在会话清理之前）；未声明窗口的路由/清除选择回退 `projectContextWindow`。Agent Note `feature/2026-08-20-feishu-bridge-provider-context-window.md`（中英+sidecar）。测试：provider-commands（switch 双向 + clear 回退 + shortcut/--resume 重算）、adapter（getActiveProvider 带出窗口）、assembly（路由窗口胜过 project 窗口 + adapter 暴露）。**留日常验证**：真机给一路由配 contextWindow 后 /provider 切换看 ctx% 变化（原「/provider 双路由切换」日常验证项顺带覆盖）。

**M8 前补充 6：权限前后预览卡生命周期两半边移植（2026-08-20，测试先行，+1 测试，1844 全绿）**：用户真机反馈两笔——① plan 卡（ExitPlanMode 审批）批准后，后续执行的 tool progress 不开新卡、继续 PATCH plan 之前的旧进度卡；② 修复①后批准与新进度卡之间又多出一张重复文本的普通卡。根因：Go 权限处理是两半边——**权限卡发出时**（engine_events.go ~4192-4225）`sp.removeText(plan内容)` + 预览降级才 flush 文本段（`segmentStart` 无条件推进）+ `barrier` + `completeAndDetach` 活卡在用户回答前终结；**解决后**（`pending.Resolved` 之后）flush 剩余段 + 兜底 detach + 新建 sp/cp + 重绑 + 预建执行占位卡 + 重置四项。TS 两半都没移植（只有文本重置）：第一轮只补了解决后半边 → 症状②（flush 把段发了出去）；本轮补齐卡前半边后解决后的 flush 自然为空，症状①②同消。顺带补两处小缺口：`!session.shouldSuppressAutoRender()` 进 reply 预渲染触发条件、`sp.removeText(sentPlanContent)` 进 plan 剥离块。**独立缺口仍未迁**：Go 批准时归档 plan 文件（`pendingPlanArchive`，带时间戳后缀复制）TS 无对应。Agent Note `bug-fix/2026-08-20-feishu-bridge-post-permission-card-restart.md`（中英+sidecar）。测试：`PostPermissionCardRestart`（text → tool_use → write 权限 → resolve → tool_use → result，断言两次 start、旧卡在权限卡后零更新、文本不重发、新卡承接批准后进度）。**真机验证**：plan 卡出现瞬间旧进度卡转绿；批准后直接开新进度卡、无中间普通卡。

**M8 前补充 7：附件暂存目录改名 `.feishu-bridge`（2026-08-20，测试先行，1844 全绿）**：workDir 下的附件暂存根目录由 `.cc-connect` 改名 `.feishu-bridge`（`pending/<hash>` 与 `attachments` 子结构不变，唯一硬编码点 `src/engine/attachments.ts`）——cc-connect 已退役，目录名不再引用旧系统；**有意偏离 Go 保形**（Go 原名 `.cc-connect`）。pending 为瞬态目录（drain/discard 即删）、attachments 每次 Send 后由 agent 清空，无需数据迁移，旧目录残留视为死数据；仍跑旧 Go 进程的 project 写自己的 `.cc-connect`，不受影响。测试同步改前缀断言（attachment-staging / adapter 各 1）。

**M8 前补充 8：用户反馈三回归修复——spawn 标签 / 渲染图 header / 进度卡引用（2026-08-21，测试先行，+4 测试，1874 全绿）**：① **spawn 群标签丢失**：代码保形无 bug，根因是环境——新 bot 是不同飞书 app，租户标签名（harness/mem0 等）已被旧 cc-connect app 占用，create 返回 402 不带 duplicate_id（他 app 占名语义），im/v2 无 List/Get 无法反查；Go 之所以能恢复靠共享 sessions 目录里的 sibling tag-cache（运维虾与开发虾共享同一批 id，跨 app 绑定已真机验证可见/可用），而 bridge 的 per-project sessions 目录让 sibling 查找结构性失效。落地：`FeishuPlatformOptions.tagCacheDir`（缺省回退 per-project sessions）+ 装配传 `<dataRoot>/sessions` 共享目录（spawned 注册表仍 per-project——bot 私有状态 vs 租户共享状态的不对称，注释记因）；一次性数据迁移 = 合并 legacy `~/.cc-connect/sessions/*_feishu_tag_cache.json` 到共享目录（**记账驴等后续 project cutover 时同样要 seed**）。② **渲染图卡片多出蓝色标题 header**：plan-render.ts 对齐 Go `NewCard().ImageFill(imageKey, title)` 删 `cb.title(title,'blue')`（fit_horizontal 卡保留——绕过 msg_type=image 高度限制）。③ **进度卡引用用户消息**：`sendPreviewStart` 误用 `shouldUseThreadOrReplyAPI`（有 messageID 即回复），Go 仅 thread isolation 时回复、否则新消息；顺带修复连带 bug：`isThreadSessionKey` 用 JS `split(':',3)`（截断语义）对照 Go `SplitN`（第三段为剩余），thread key 恒判 false。Agent Note `bug-fix/2026-08-21-feishu-bridge-tenant-tag-cross-app.md`。测试：preview-send 2（非 thread 走 create / thread 走 reply+replyInThread）、tag-cache-share 1（双 bot 共享目录 sibling 兜底 402-无-id）、plan-render-image header 断言、isThreadSessionKey 既有套件回归。

**M8 前补充 9：WS reaction 回声 no-op 注册（2026-08-21，测试先行，+2 测试，1876 全绿）**：daemon stderr 反复刷 `no im.message.reaction.created_v1 handle`——bot 自己的 add/removeReaction（reactionEmoji Get/Done/CrossMark）触发 reaction 事件，node-sdk 对无 handler 的事件每次打警告。Go 在 feishu_lifecycle.go 显式注册 reaction created/deleted 的 no-op handler 吞回声。落地：注册表抽成可测纯函数 `wsEventRegistrations`（四个路由事件 + 两个 no-op），`defaultWsStart` 直接喂给 EventDispatcher.register。Go 还 no-op 了 read receipts / bot p2p 进入 / p2p 创建三个事件——本 app 未订阅、日志从未出现，不预注册（订阅后警告会提示缺口）。

**M8 前补充 10：卡片回调响应移植——审批卡点击反馈 / AskUserQuestion 冻结卡 / 计划卡先行顺序（2026-08-20，测试先行，+14 测试，1890 全绿）**：用户反馈两笔 + 排查顺带补齐一笔，均为 TS 移植丢失的 Go 行为——① 点击「‼️ 权限请求」卡的允许/拒绝/全准按钮后卡片无变化（Go 点击后标题翻转为「✅ 已允许」/「❌ 已拒绝」/「✅ 已全部允许」）；② 审批卡有时先于计划卡到达；③ AskUserQuestion 卡作答后同样无变化（Go 返回保留全部选项、选中项标 ✅/◻️ 的冻结卡，单选/多选共用）。根因：①③ Go `onCardAction` 在 card.action.trigger **回调响应**里返回替换卡片（`feishu_dispatch.go`，`CardActionTriggerResponse{card:{type:"raw",data:…}}`），飞书收到回调响应原地换卡；TS 移植只 dispatch 合成消息，perm 按钮 extra（`perm_label`/`perm_color`/`perm_body`）、`permBodyCache`、Go 的 `askqMetaCache`/`askqAnswered` 均未移植。② Go 的 `sendPlanCard`/`sendPermissionPrompt` 是同步阻塞调用，顺序结构性成立；TS 对两次发送都 fire-and-forget，小审批卡与大计划卡的并发 HTTP 按服务端接收顺序竞速。落地（对齐 Go）：perm 分支构建结果卡片并返回（extra 优先，form_submit 回调不带 action.value 时固定标签回退 + `permBodyCache` 读删 + 拒绝理由引用为 body）；askq 单选/多选分支返回冻结确认卡（`cacheAskqMeta` 在 sendCard/replyCard 时缓存选项集、提交时读删；缓存丢失退化为「→ label」最小卡；`askqAnswered` 按 messageID 去重）；`wsEventRegistrations`/`wsStart` 的 raw-event 回调透传 handler 返回值——node-sdk `WSClient.handleEventData` 会把 `EventDispatcher` invoke 结果 base64 进回调响应 payload（与 Go oapi-sdk-go 同机制，本移植首次启用）；`sendPlanCard` 返回发送 promise，`sendPlanContent`/`sendInlinePlanContent` await 它，`permission_request` 分支先 await 计划卡再 await 审批卡。**两处有意偏离 Go**：`permBodyCache` 无条件删除（Go 只在读缓存时删，带 extra 的回调会让陈旧条目存活）；多选仍派发协议串由引擎侧解析标签（Go 平台侧解析，TS 引擎解析器已拥有该映射）。回退方案（若 WS 回调响应真机无效）：改走 `act:`/`nav:` 的 `refreshCard` PATCH 模式。Agent Note `bug-fix/2026-08-20-feishu-bridge-permission-card-update-and-order.md`（中英+sidecar）。**真机待验证**：reload.sh 后触发一次 plan mode 轮次（计划卡在前、点审批卡后标题翻转）与一次 AskUserQuestion 轮次（作答后冻结卡标记选中项）。

**M8 前补充 11：/shell 命令 + "!" 前缀快捷移植（2026-08-20，测试先行，+15 测试，1906 全绿）**：用户发现 `/shell` 未迁移。漏网根因：迁移验收对照 FEATURE-PARITY 61 项 feature 表（源 Go docs/features.md），不覆盖 engine.go `builtinCommands` 命令清单（52 条，TS 仅注册 ~18 条）；/shell 的 i18n 键（shell_usage/BuiltinCmdShell/message_help）整体随迁造成「已迁」假象。落地（Go engine_cmd_workspace.go cmdShell 保形）：`src/engine/shell-commands.ts`——`registerShellCommands` 合并既有命令表（shell/sh/exec/run 别名 + ≥2 字符前缀）；`/shell [--timeout <秒>] <命令>` 在 `commandWorkDir` 以 `sh -c` 执行（复用 executeCronShell 的 spawn+AbortController 模式），合并 stdout/stderr、默认 60s、>4000 rune 截 3997+'...'、空输出 '(no output)'、退出非零且无输出时报 exit status、回复 ``$ cmd\n```output``` ``；原始命令从 msg.content 取（dispatch 的空白切分 parts 会破坏引号内空格）；"!" 前缀在 handleMessage 权限处理之后分派（Go 保序：'!yes' 应答 pending permission 而非进 shell），经 gatePrivilegedCommand 过 admin 门；'shell' 进 commands.ts privilegedCommands（Go 8 条的 TS 子集现 3 条：dir/monitor/shell）。**刻意不迁**（E 群 C 类裁定不变）：disabled_commands/[users] 角色 DisabledCmds、multi-workspace shared binding 工作目录、audit 日志。Agent Note `feature/2026-08-20-feishu-bridge-shell-command.md`（中英+sidecar）。测试：shell-commands.spec 15 例（Go TestCmdShell_* 随迁减 multi-workspace 两例，加表合并/disposer/!前缀/权限优先序）。**留日常验证**：真机 /shell pwd、!ls、--timeout 超时、非 admin 拒绝（reload.sh 后）。**顺带发现（未处理，挂 M8 决策）**：Go 52 条命令 TS 侧缺 ~34 条（/help /whoami /history /current /search /delete /name /memory /model /reasoning /mode /lang /quiet /tts /allow /skills /config /doctor /usage /version /web /upgrade /restart /workspace /heartbeat /commands /alias /show /diff /ps /undone /notify /tag /untag /board），其中 upgrade/restart/web/doctor/version 等属 D 类合理裁剪，其余无裁定记录；message_help 帮助文本整体照搬 Go 宣传大量未迁移命令、且 /help 本身未注册——命令清单需系统性 diff 并补裁定。

**M8 前补充 12：七命令批量移植 /tag /untag /undone /notify /board /help /ps（2026-08-20，测试先行，+24 测试，1930 全绿）**：用户从「未迁移命令清单（按 Go 仓库修改/创建时间倒序）」多选卡选中最近活跃的 7 条。落地两文件：① `src/engine/spawn-family-commands.ts`（Go engine_cmd_session.go cmdTag/cmdUntag/cmdUndone/cmdNotify/cmdDashboard 保形）——/tag /untag 走 ❤️ 标签轴（applyActiveTag/removeTagFromChat + activeTagNameFor，成功仅 reaction 无文本回复；Active 状态归头像轴不触碰）；/undone 走头像轴（setChatAvatarActive(true) + markSpawnedChatActive + reaction）；/notify 重发 spawn 就绪卡（spawnJumpMarkdown 面包屑/按钮 + note 参数，父群无子群时 NotifyNoChildren 兜底 + buildCompletionUsage(0) 清零，复用 buildSpawnNotifyCard）；/board 家族树看板（listActiveSpawnedChats 全平台聚合 + sessionKeyMap 推 parentOf + familyChats 上溯根下收子树 + renderDashboardTree 折叠面板/叶链接/← 当前标记；**刻意简化**：Go 的 dashboardState 快照 + done 按钮灰化/原地刷新机制未移植——现行 Go 树渲染本就只有链接无按钮，快照机制无消费方）。② `src/engine/misc-commands.ts`——/help 命令列表**从注册表动态生成**（`commandHandlers.keys()` × i18n 单行描述 + provider 快捷行 + 前缀提示；`/help <cmd>` 走 `<cmd>_usage` 键、缺失回退单行+help_no_usage，未知命令先 hint 后全表；**有意偏离 Go**：Go 的 message_help 静态大段 + help_*_section 六键 + 按钮式 help 卡族（renderHelpGroupCard/nav:）删除不迁——静态大段正是漏网根因，动态生成恒准确）；/ps 三分支（空闲→剥前缀穿透为普通消息 return false；turn 中→直发 agentSession.send + Done reaction；**turn 中且 pending permission→改走 queueMessageForBusySession**（Go 同由：CLI 输入队列会吞 stdin 写入），空参 PsEmpty、发送失败 PsSendFailed）。i18n：新增 tag/untag/undone/rename 单行 + help_list_title/help_prefix_tip/help_shortcuts（五语种）；删除 message_help + help_title/help_session_section/help_agent_section/help_tools_section/help_system_section/help_tip（无引用且宣传未迁移命令）。**顺带核实**：FEATURE-PARITY #38 原记「跳转/notify/board 完成」不实——只有 spawn 时的通知卡在，/notify /board 命令本体此前未注册（本轮补齐后该行才真）。Agent Note `feature/2026-08-20-feishu-bridge-seven-commands.md`（中英+sidecar）。测试：spawn-family-commands.spec 14 + misc-commands.spec 10。**留日常验证**：真机 /board 树、/notify 在子群重发卡、/help 列表、/ps 打断补充。**剩余缺口**：Go 52 条命令仍缺 ~27 条（升级/重启/web/doctor/version 属 D 类合理裁剪；/whoami /history /current /search /delete /name /memory /model /reasoning /mode /lang /quiet /tts /allow /skills /config /usage /workspace /heartbeat /commands /alias /show /diff 无裁定，挂 M8）。

**M8 前补充 13：card.action 回调表单值键名修正 `form_value`（2026-08-20，测试先行，1930 全绿）**：用户在七命令清单多选卡提交后 agent 只收到光杆协议串 `askq:0`、勾选项全部丢失（值班主任 agent 误诊为「daemon 未 reload」——收集修复 4e484936ab 已随 08-20 18:02 重启上线，仍复现）。根因：wire 载荷的表单值在 `action.form_value`（snake_case，权威依据 Go oapi-sdk-go `card/model.go` 的 `FormValue json:"form_value"`；node-sdk `RequestHandle.parse` 键名原样透传），而 TS 类型与全部读取点用 camelCase `action.formValue`，运行时恒 `undefined`。同根因波及权限卡拒绝理由（`deny_reason`）与 hint 输入框取参（`hint_arg_*`）两条此前未真机触过的通路。落地：`CardActionTriggerEvent.action.form_value` 改键 + 四处读取点（perm deny 两处 / `collectAskqMultiSelected` 入参 / `cmd:` hint 取参）+ 接口 JSDoc 如实标注各自验证途径（root 嵌套真机确认、键名 Go json tag 确认）；多选索引测试补 `content === 'askq:0:2,10'` 断言（原断言 `isAskqCardAction` 空选择下恒真，正是漏网原因）。Agent Note `bug-fix/2026-08-20-feishu-bridge-card-action-form-value-key.md`（中英+sidecar）。**留日常验证**：reload.sh 后重发多选卡提交（收到冻结卡且选中标 ✅、agent 引用所选命令）+ 权限卡拒绝带理由路径。**遗留（挂引擎侧决策）**：零索引多选提交派发光杆协议串、引擎当作用户消息递给模型，空提交是否改为提示「未勾选任何选项」待裁定。

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
| daemon 日志 | `~/.dsh/feishu-bridge-stdout.log` / `~/.dsh/feishu-bridge-stderr.log`（重启时 mv 轮换保留） |
| 监控群（M6b 冒烟用） | `oc_34a8faa3c14461fa7b79419e5cd89cee`（开发虾已在群内，bot 可读历史） |
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
