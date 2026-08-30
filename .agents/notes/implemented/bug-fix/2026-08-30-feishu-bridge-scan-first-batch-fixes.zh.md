# Agent Note: feishu-bridge × chatroom 并行扫描——第一批高危修复

Status: implemented

[English](2026-08-30-feishu-bridge-scan-first-batch-fixes.md) | 中文

## Problem

对 `packages/acp/feishu-bridge`（4.67 万行）与 `packages/acp/feishu-bridge-chatroom`（5.1 千行）做了五路并行只读扫描——engine 核心、Feishu 平台层、插件接入层、chatroom 包、横切面卫生——共产出 41 条发现。其中 8 条经逐行验证为高危 bug，本批修复；其余记录为下文 backlog。共性问题有三类：Go→JS 移植中 Go 运行时模型免费覆盖的空档（微任务语义、取消）、单项目时代设计在多项目部署下的残留（审批瀑布）、chatroom 抽包的缝合伤（persona workdir 键）。

每项修复都测试先行：失败的复现测试先以正确的原因变红，修复才落地。

## Decision

**A1——debounce 微任务自旋（engine.ts:4117）。** `Promise.race([plainSleep(...), Promise.resolve()])` 恒由预 settle 的分支胜出，合并循环退化为微任务自旋：默认 600ms 窗口内饿死进程里全部定时器与 I/O 回调——每次排队的消息 drain 都会冻结所有会话的流式 PATCH、cron tick 与 WS 接收。实测：每 100ms 窗口自旋 17.4 万次，5ms 定时器在窗口内无法触发。修法：直接轮询睡眠（`await plainSleep(Math.min(remaining, 10))`），即 Go 原版的语义。

**A2——approval/request 瀑布否决（adapter.ts:786）。** session 不认识时监听器不调 `next()` 直接返回 `'unavailable'`——在 cordis waterfall 语义下这会否决链上所有后续监听器（含 fail-closed 的 base）。多项目部署共享同一插件 ctx，第一个注册的 adapter 静默拒绝其余所有项目的审批卡。与 2026-08-22 userQuestions 事故同类，修法照搬其 `return next()` 范式。不带 `next` 的裸调用（测试路径）经 `next?.() ?? 'unavailable'` 仍然 fail-closed。

**A3——卡片按钮回调绕过 allow_from（platform.ts:975）。** `onCardAction` 只查 `allowChat`；`onMessage` 两道闸都查。被 `allow_from` 排除的用户能在允许的群里按 `perm:allow`/停止/导出按钮。修法：补上与消息路径相同的操作者闸（allow_from 为空仍是全放行）。

**A4——gather 超限拒绝留下孤儿 barrier（chatroom.ts:709）。** 研究轮次 cap 检查在 barrier 安装并持久化之后才跑：被拒绝的轮次留下一个无 timer、无广播、永远等不齐的 barrier，而 `pendingGather` 存在时 `end` 拒绝执行。修法：cap 检查移到一切状态安装之前；被拒绝的轮次不消耗 seq 也不消耗轮次计数。

**B1——chatroom 角色人设从未进入系统提示词（chatroom-policy.ts:182、200）。** persona 提示词用 `engine.sessionWorkDir(session.id)`——内部 `s${n}` 注册表 id——解析工作目录，而 `startChatroom` 持久化角色人设目录用的是 interactive session key。查询必然 miss、回退 agent 基目录，叠加 persona 会话 `complete: true` 整体替换系统提示与 cwd 指令注入抑制，每个角色都丢失自己的 CLAUDE.md 人设、全部共享基目录的文件。08e1428c75 重构引入此回归却声称 "zero behavior change"；既有测试恰好全部绕过这条解析链。修法：改用 `options.sessionKey` 解析（与写入侧同键同变换、直接读 override 表不依赖时序），并补端到端测试断言人设文本来自角色目录。

**B2——被中断的 ask 被迟到的 deliverCards 续体重新挂起（engine.ts:5000）。** park 写入位于 `deliverCards` 的第一个网络 await 之后；中断分支的清理守卫（`pendingAsk === pending`）在写入发生前是 no-op。stop 落在投递窗口内时，在途续体会把已取消的 ask 重新挂起——后续消息全部被路由进死权限请求并吞掉、idle reaper 跳过该会话、卡片冻结。修法：中断分支在清理前置位 `askInterrupted` 标志；续体在 park 前检查并退出。

**B3——async-sender 队列满丢弃终态 PATCH（async-sender.ts:87）。** `markCompleted`/`markFailed`/`markStopped` 走普通 `enqueue`，其队满行为是静默丢弃：卡片永停运行色、同闭包里的答案投递永不执行（单个黑洞 PATCH 即可钉住队列约 124 秒）。修法：新增 `enqueueTerminal`——队满时告警并越过上限入队而非丢弃；终态每 turn 至多一次，溢出有界。三处终态调用点切换过去；coalescable 快照的丢弃语义不变（过期快照可丢，终态是卡片的最后一句话）。

**B4——陈旧的 ask-human 标记吞掉用户消息（chatroom.ts:953）。** 只有 `routePendingHumanReply` 清 `pendingHumanQuestionRole`；`finalizeChatroomEnd` 与 `interruptChatroom` 都不清，且该标记 durable、跨 `/new` 存活。聊天室带着未答问题被回收后，hub 的下一条普通消息被路由进只会 warn 的死 `askRole`，消息被引擎吞掉。修法：`finalizeChatroomEnd` 清除标记（interrupt 也落在它这里）；路由器前置校验角色会话仍存活——陈旧标记回落正常 agent 路径（`false`）而不是吃掉消息。

## Alternatives considered

**一次把扫描发现全修掉。** 拒绝：其余 33 条清晰分为性能/内存（per-messageID 与 exportKey map 的 LRU 上限、tenant token 缓存、appendThinking 节流）、健壮性（cron 超时取消、modeOverride fail-loud、重试分类、parsePicks 校验）、卫生（i18n 硬编码文案、幽灵依赖声明、死导出）——风险画像与评审面都不同；与 bug 修复混批会淹没后者。留作记录在案的 backlog。

**B2 用「清理前等 deliverCards 结束」代替标志位。** 拒绝：中断分支必须保持即时（要 settle 调用方），等待可能挂死的平台发送会重新引入该文件注释里防的 oc_29bb dispose 挂死类。

**B3 用 `enqueueOrInline`。** 内联路径会重入 StreamPreview 锁（markStopped 的 fallback 调 `this.locked`），且终态先于队列里的过期快照执行、随后被它们覆写。队满溢出入队保住了顺序与锁纪律。

## Consequences

多项目审批、卡片按钮鉴权、chatroom 角色人设恢复文档声明的工作方式。每次排队消息 drain 都让出事件循环（不再有 600ms 的全进程冻结）。被中断的 ask 不再黑洞化会话消息。终态 PATCH 在队列饱和下存活。被拒的研究轮次与被拆掉的聊天室不再留下陷阱状态。

本批未修（扫描 backlog，尚未行动）：platform.ts 的 per-messageID 缓存增长、InteractiveState 的 exportKey map 增长、每次调用新铸 tenant token、cron 超时不取消底层 turn、modeOverride 在 live 复用路径静默丢弃、HTTP 5xx 不重试、parsePicks 无 schema 校验、/context 与 engine 的硬编码中文卡面、`@deepseek-ai/cosmokit` 幽灵类型依赖、invariant.ts 测试缺口。

## Testing

- `tests/engine/engine-debounce.spec.ts`（新增）：5ms 定时器在 debounce 窗口内触发；窗口内入队的消息合并进 lead turn。两条在自旋实现下失败（301ms 饿死；无合并）。
- `tests/agent-dsh/adapter.spec.ts`：属于后注册 adapter 的 session 沿瀑布委托（delegateB 收到请求），而非第一个监听器把链整体 fail-closed。
- `tests/feishu/card-action.spec.ts`：被 `allow_from` 排除的操作者无法在允许的群里触发卡片按钮；列入名单的操作者照常。
- `tests/engine/engine-chatroom-gather.spec.ts`：被 cap 拒绝的轮次不装 barrier、不消耗 seq 与计数。
- `tests/engine/engine-chatroom.spec.ts`：角色 persona 提示词经 session key 解析到角色目录（含角色 CLAUDE.md 的 `#` 标题）。
- `tests/engine/engine-ask-interrupt.spec.ts`：park 写入前被中断的投递，平台发送恢复后不重新挂起已取消的 ask。
- `tests/streaming.spec.ts`：队列满时 markCompleted 仍投递终态 PATCH。
- `tests/async-sender.spec.ts`：enqueueTerminal 永不丢弃——backlog 排空后终态执行。
- `tests/engine/engine-chatroom-end.spec.ts`：finalizeChatroomEnd 清除陈旧 ask-human 标记；陈旧标记把下一条消息交还 agent（`false`）。

全量套件：feishu-bridge 2560 测试与 feishu-bridge-chatroom 219 测试全绿；两个编译面（`tsc -b tsconfig.host.json`、`tsconfig.client.json`）与工作区 tsdown 构建通过，8 处修复均已在产物 bundle 中 grep 核验。
