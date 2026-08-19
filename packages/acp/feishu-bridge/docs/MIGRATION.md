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

## 4. 迁移阶段（每阶段：测试先行 → 实现至绿 → 真机冒烟；上一阶段验收通过才进下一阶段）

**M0 骨架 + 纯逻辑地基**
- worktree 建立 + pnpm install；本计划落盘；新包骨架/vitest 接入/lint 接入；配置 schema 骨架；进程空转冒烟（新 profile `~/.dsh/profiles/feishu-bridge`，dsh-base + 新插件 link）；node-sdk 依赖引入 + API 覆盖盘点。
- 测试先行：纯逻辑套件——markdown_html(37)/lucide(12)/ratelimit(8)/dedup(4)/atomicwrite(4)/cli_escape/active_tag/card 核心/i18n——先移植先红，再移植对应纯函数至绿。
- 验收：新包测试绿；`dsh --profile feishu-bridge` 起进程不退出不报错。

**M1 Agent 适配器 + Engine 核心 + 文本收发**
- 测试先行：engine_test.go 核心事件段、session_test(51)、engine_cmd_session、stub 体系搭建（~20 个 stub struct → vi.fn 工厂）；DshAgentAdapter 单测。
- 实现：Agent/AgentSession/Platform 接口 TS 版；适配器（create/resume/followup/cancel/mode 切换/provider 路由）；Engine 骨架（入站路由、thread 隔离、消息排队 #13、idle reaper、基础命令 /new /stop /status /sessions /resume /dir）；飞书最小平台（WS + 文本收发 + @解析 + allow_chat #27）。
- 真机：记账驴切流（用户把该项目从旧 config 注释并手动重启旧 cc-connect；父会话起新进程）后一轮真实对话。
- 验收：移植测试绿；真机对话 + /new + /resume 通过。

**M2 卡片系统全量**
- 测试先行：card_test(8)/progress(5)/spinner(8)/streaming_test(68)/card_sanitize/feishu markdown 套件。
- 实现：Card Schema 2.0 构造器全集（markdown/hr/button/note/column_set/collapsible_panel/form/checker）；进度卡（流式合并 #32、tool_progress 合并 #10/#19、思考/执行 GIF #54、placeholder #23）；完成卡（✅ 通知 #2/#14、状态页脚 #26、累计 token #25）；TopNotice #22；PATCH 限流 + 重试 + 11310 fallback 发 .md。
- 验收：测试绿；真机长任务一轮，卡片与现网视觉对比（截图）。

**M3 审批 / 问题 / Plan + per-agent 组装**
- 测试先行：engine_test permission 段、plan 相关（两路径 #5/#6、plan_max_len #29）、AskUserQuestion（multi-select #4、卡片增强 #31）。
- 实现：approval/request → 审批卡；userQuestions provider → 问题卡；ExitPlanMode plan 卡；D3 的 setup 钩子全套（能力 prompt 工具版、restrict、mode 继承）；auto-approve 不跳过 #15；auto-compaction 卡 #24。
- 验收：测试绿；真机 plan 模式 + 审批 + 提问各一轮。

**M4 子任务群 + fork**
- 测试先行：engine_subtask_test(41)、engine_groupname_test、feishu_spawn/tag/avatar/media/members 套件。
- 实现：/spawn /fork /sp /fk、--worktree #39、--dir #37、/done --reply 回灌 #37、父子群 #38（跳转/notify/board）、群命名 #49 + Lucide 头像 #52、pin #35、深度限制；`feishu_bridge_subtask` 工具族 + 修订版 skill；/fork = agents.create + completedTurnPrefix seed（原生）。
- 验收：测试绿；真机 /spawn → 子群工作 → /done --reply 全链路。

**M5 聊天室**
- 测试先行：engine_chatroom_test(46)、gather/end/venv/roles/ledger 套件。
- 实现：/chatroom #41、角色挑选 #43、--research #57、随便聊聊 #59、`feishu_bridge_chatroom` 工具族、bare persona。
- 验收：测试绿；真机一轮三人 chatroom。

**M6 Monitor + Cron + Relay**
- 测试先行：engine_monitor_test(49)、monitor_cmd、cron_test(19)、feishu_monitor_poll。
- 实现：#53 全部（观察/规则+LLM 分诊/dispatch 模式/coalesce/no_report/轮询兜底//monitor 命令）；cron 全量移植；relay；`feishu_bridge_cron`/`feishu_bridge_relay` 工具。
- 验收：测试绿；真机监控群一条告警全链路 + 一条定时任务触发。

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
