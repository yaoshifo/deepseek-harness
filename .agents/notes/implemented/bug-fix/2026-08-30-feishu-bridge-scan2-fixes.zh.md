# Agent Note: feishu-bridge × chatroom 第二轮扫描——批次 A/B 修复

Status: implemented

[English](2026-08-30-feishu-bridge-scan2-fixes.md) | 中文

## Problem

2026-08-30 第二轮六路并行只读扫描（调度派生、会话状态机、渲染管线、平台 IO、chatroom 全包、装配层工具面）产出 43 条发现。本批修复其中 6 条 high 与 12 条机械 medium/low，全部测试先行（失败复现测试以正确原因变红后才修）。策略类发现（会话记录增长、排水回合收割、cron 超时/叠加、workDir 传参、modeOverride、Map LRU、deadline 竞态取消、triage 串行化）留待拍板，未动。

## Decision

**H1——租户 token 失效自愈链三处连环失效。** ① `isTenantAccessTokenInvalid` 只扫 err.message，而 SDK 动词的 99991663 在 AxiosError 的 `response.data.code`（230020 修复时的形状失配未迁移到 token 分类器），且 token-retry 测试全用真实 SDK 不会产生的文本形状造假——测试绿、生产死；② `fetchFreshTenantAccessToken` 读 minter 缓存，「新鲜 token」可能就是刚被拒的那个；③ `disableTokenCache` 没真传，SDK formatPayload 无条件用自己缓存的 token 覆盖 `withTenantToken` 设置的 Authorization 头。修法：分类器改用 `feishuBusinessCode`（同文件已有）+ 保留 invalid-access-token 文本兜底；minter 挂 `invalidate()`（`TenantTokenMinter` 类型），stale 刷新先失效再重铸；Client 构造真传 `disableTokenCache: true` 并让每个 verb 显式携带 minter token（`tokened(opts)` 合并，显式 Authorization 优先）——minter 成为唯一 token 权威。假形状测试全部改为 SDK 真实 AxiosError 形状。**230011（回复目标撤回）兜底死代码同根同修**（feishuBusinessCode 判等），撤回后回合最终回答按设计转独立消息发送。

**H2——chatroom 机器唤醒被当人类回答吞掉。** 串行圆桌角色 ask-human 后，其回合末的 relay 唤醒经 `deliverMachineMessage` 入站命中 route-human-reply 瀑布（无来源判别）：主持人收不到唤醒、pending 标记被角色自己的发言清空、角色收到「人类回答：[自己的发言]」。修法：`Message.machine` 标志 + `deliverMachineMessage` idle 路径打标 + 瀑布 payload 带 `machine` + chatroom 监听对机器消息放行（返回 false 落回正常 agent 路径）。

**H3——appendText 残留定时器把进度卡打回纯文本卡。** 节流 timer 回调不查 progressMode；「文本→工具」常态顺序下到点 PATCH 无 status 内容，工具区/待办/实时播报全消失。修法双保险：timer 回调体加 progressMode 守卫；appendProgress/appendThinking 置位前 `cancelTimerLocked()`。

**H4——四反引号围栏被拦腰截断。** preprocess pass 1 按单字符扫描，在四反引号 run 中间插换行；pass 2 把代码块内 0 列 ``` 误当围栏切换。修法：pass 1 按整个反引号 run 走（run ≥3 且行中才在 run 前插换行）；pass 2 长度感知（纯反引号行 ≥ 开启长度才关闭）——同时让表格计数/折叠共享该语义（`FenceTracker`）：代码块内管道行是代码文本，不再被当表格折叠删行（旧测试钉住的「围栏内也计数」是移植期简化，随行为更新）。

**H5——/dir 卡片动作绕过 admin_from。** commandGate 只在文本 dispatchCommand 执行，handleCardAction 的 dir 动作直接跑 dirApply，而 /help 卡「系统」页自带 /dir 入口。修法：卡片路径调同一 `commandGate?.('dir', p, msg)` 槽（未注册命令的引擎保持与文本路径一致的放行）。

**H6——monitor 轮询高水位只随可处理消息推进。** platform 侧 `listMonitorMessages` 先过滤（bot 自身/无 sender 无 fallback_user/无文本）再返回，整页不可处理消息（webhook 卡片告警风暴）令水位卡死、后续告警全部被埋。修法：接口演进为 `MonitorPollPage { messages, latestTimeSec }`——latestTimeSec 覆盖全部原始取回条目（含被过滤的），水位无条件推进。

**批 B（机械项）。** 流式预览文本路径并入 `sanitizeFeishuMarkdownHTML`（无条件——containsMarkdown 不认裸 HTML 标签，纯 HTML 文本原本整段逃逸，触发 11311 三连败降级）；工具进度环形缓冲渲染改为从 `progressWriteIdx`（最旧槽）迭代，回绕后时间戳不再乱序、🚨 恒在末行；bare-HTTP 动词（getBotInfo/getMessage）的裸 fetch 加 `AbortSignal.timeout(retryTiming.requestTimeout)`（黑洞连接不再钉死 WS 启动 ~25 分钟）；lark-cli 工具声明 `timeoutMs: 300_000` 并把 `exec.signal` 透传到子进程与 TAT mint fetch（execFile signal 选项），`--page-limit` 帽 200 页；装配层 project 重名 fail-loud（重名静默共享 state/sessions 文件、lark-cli 注错 appId）；`ProjectStateStore.load` 形状校验（null/数组/原始值 JSON 回落空状态，不再让首个访问器炸掉插件启动）；ask 停靠期间文字+附件答复把附件 `stageAttachments`（不再无声丢失）；越界 askq 载荷（旧卡指向已不存在的问题）消费并回复过期提示，不再把 `askq:5:1` 原文排进模型提示词；agent 启动失败的占位 state 补 `beginTurn()`（与调用方 finally endTurn 配对，activeTurns 不再 -1）；`ChatNameCache` 瞬时网络失败不缓存（`isTransientError` 判别，确定性失败才吃 1h fail TTL）。

## Decision（追加：策略项批次，同日拍板后实施）

**P1——会话记录 TTL 清理（Go session_cleanup_days 语义回归）。** `SessionManager.setCleanupDays`（装配默认 30，0=禁用）：`saveLocked` 的全量重写顺带剔除「超过 idle 窗口且非任何 chat 活跃会话」的记录——cron new-per-run 的累积不再无界（`session_cleanup_days` 配置项接入 per-project）。

**P2——排水回合配对。** `drainPendingMessages` 的每个排水回合 `beginTurn`/`finally endTurn` 配对（此前 endTurn 先跑、排水期间 activeTurns=0 且无心跳，idle reaper 可中途收割 >2h 回合并丢弃剩余队列）。`drainOrphanedQueue` 复用同一路径自动受益。

**P3——cron 超时取消 + 叠加护栏。** `executeCronJob(job, signal?)`：abort 时对当前 run 的 interactiveState 调 `asAgentInterrupter(agentSession).cancelTurn()`——超时停止的是底层 turn 而非仅 await；`CronScheduler.executeJob` 拆出 `executeJobLocked`，`runningJobs` 集合让上一发仍在跑的 job 跳过本次 fire（不再叠加）。

**P4——cron workDir 不再全局切换。** `SessionStartOptions.workDir` 新增：adapter 的 `agents.create` 用 `options?.workDir ?? this.workDir`；engine 的 per-chat override 与 cron job.workDir 都写入 startOptions（`getOrCreateInteractiveStateWith` 新增 `startWorkDir` 参数，`processInteractiveMessageWith` 透传）；stall-retry 复用 `state.sessionStartOptions` 里的 workDir。Go 时代的 `applyWorkDirOverride` 全局切换（含 restore）删除——job 运行期间并发会话不再落进 cron 目录。

**P5——modeOverride live 复用可见性。** live 会话复用分支丢弃 modeOverride 时 console.warn（mode 固定于会话创建，live 无法切换——非静默丢弃）。

**P6——platform.ts per-message 缓存 LRU 化。** `BoundedMap`（插入序逐出，`platformCacheCapacity=4096`）替换八个 per-message Map（lastProgressCard、renderStatusText、permBodyCache、askqMetaCache、askqAnswered、cardActionMsgIDs、chatPhasePaints、pendingTypingRemovals）；chatActivity 保留（按 chatID 键控、随部署群数天然有界）。取舍已拍板：旧卡导出按钮在容量滚动后失效。

**P7——TAT mint 的 bare fetch 补 deadline。** platform minter 与 lark-cli 的 TAT mint 加 `AbortSignal.timeout`（30s；lark 侧 caller signal 优先）。**SDK 阻断部分如实上报**：`withTransientRetry` 30s deadline 竞态不取消在途请求的完整修复需要 node-sdk 的 verb opts 支持 abort signal（当前仅 OAuth 登录路径有）；非幂等动词（create/reply/createChat）的超时双发风险仍在，升级路径是等 SDK 支持或改走原生 fetch。

**P8——monitor triage per-chat 串行化。** `enqueueTriage`：同 chat 的 triageAndSpawn 以 promise 链串行——同批告警不再并发通过容量检查（TOCTOU 绕过 maxConcurrent）。

**P9——send/lark 全权文件读写：维持现状（裁定）。** Go 对齐的有意设计（会话沙箱对这两个外传通道无效），部署方若依赖会话级沙箱防外传需自行知晓。

**P10——/delete-mode 卡片补 admin 闸。** `privilegedCommands` 加 'delete-mode'，`/delete-mode` 卡片分支走同一 `commandGate`——list 卡的删除按钮不再绕过 admin_from（未配置 admin_from 的部署 fail-closed，与文本命令一致）。

## Alternatives considered

**H1 只传 disableTokenCache 不逐 verb 带 token。** 拒绝：缓存禁用后 SDK 不再注入任何 Authorization，普通请求裸奔 401。minter 逐 verb 显式携带（缓存命中时零网络开销）才能同时满足「普通请求有 token」与「刷新 token 真正生效」。

**H6 水位按过滤后消息的最大时间推进。** 拒绝：整页全被过滤时无消息可推，水位照样卡死——必须以原始取回条目为准。

**接口演进的兼容垫片（listMonitorMessages 双形状）。** 拒绝：pre-release 姿态（见根 AGENTS.md），直接改形状并同步 platform 实现、engine 消费与测试桩。

## Consequences

token 提前作废场景从「bot 哑 ~2h（时钟偏差则无限期）」变为一次重试自愈；撤回的回复目标不再丢回合回答；ask-human 串行圆桌主路径恢复（主持人收到唤醒、人类回答正确路由）；嵌套代码示例在预览卡与最终回复卡中完整；进度卡不再被残留 timer 降级、环形缓冲时间戳有序、代码块内管道行不再被折叠删除；任意群成员无法再从 /help 卡绕过 /dir 门禁；告警风暴不再埋掉后续告警；裸 HTML 预览不再触发 11311 降级；黑洞连接不再钉死启动；lark-cli 调用有界可取消；重名项目装配 fail-loud；损坏的 state 文件不再炸插件启动。

仍开放（策略项，待拍板）：会话记录增长（TTL vs 环形）、排水回合被空闲收割器误杀、cron 超时取消+叠加护栏、cron workDir 全局切换污染、modeOverride 静默丢弃、platform.ts Map 无上限增长（LRU 取舍）、30s deadline 竞态不取消在途请求、triage 容量 TOCTOU、send/lark 全权文件读写、/list 删除模式门禁。

## Testing

每条修复先写失败复现测试再修（TDD）：token-retry/tenant-token/transient-retry/default-client（SDK 真实 AxiosError 形状 + minter invalidate + disableTokenCache 构造断言 + hang-fetch deadline）、engine-chatroom-machine-wake（chatroomPolicyFace 全链路）、streaming（timer 守卫 + 环形顺序）、markdown（四反引号 run + 围栏内表格）、engine-card-action（非 admin 卡片按钮被闸）、monitor.spec（全过滤页推进水位）+ monitor-poll（latestTimeSec 计入被过滤条目）、card.spec（预览 HTML 剥离）、lark-tool（页帽）、plugin-entry（重名 fail-loud）、project-state-shape（null/数组/原始值回落）、engine-m3-askq（越界载荷消费 + 附件 stage + 占位 beginTurn）、chatname（瞬时不缓存）。

全量：feishu-bridge + feishu-bridge-chatroom 2821 测试全绿（基线 2807，新增 14）；`tsc -b` 两包通过；tsdown 构建（feishu-bridge 直构 + 根 workspace 聚合）通过；修复点在产物 bundle 中逐项 grep 核验（disableTokenCache / machine / invalidate / latestTimeSec / askq_stale_question / duplicate project name / maxListPages / payload.machine）。
