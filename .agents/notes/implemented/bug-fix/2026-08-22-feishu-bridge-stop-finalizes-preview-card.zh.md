# Agent Note: feishu-bridge 用户停止现在自行终结预览卡

Status: implemented

[English](2026-08-22-feishu-bridge-stop-finalizes-preview-card.md) | 中文

## Problem

线上事故 2026-08-22（群 oc_74a7）：在一次视觉 MCP 工具调用进行中发出 `/done` 后，进度卡永远冻结在「执行中 · 17:01:02 · 6」——Running 头、工具计数、没有终态，而引擎其实在一秒内就完成了会话拆除（会话日志：`turn/end reason aborted(disposed)` 于 17:00:55.079；之后用户点冻结卡上的 ⏹ 得到「没有正在执行的任务」）。

停止卡渲染只存在于一个位置：事件循环的 'stop' race 分支，在 sender barrier 之后调用 `sp.markStopped()`。`stopInteractiveSession` 在同一个同步块里 resolve stop 信号并关闭事件 channel，于是停止落地时正处事件处理中途的循环回到 race 时两个分支均已 settle——`Promise.race` 的数组顺序（`recvOutcome` 在前）把胜利交给 'closed' 退出，`isStopped()` 的事件早退路径同样跳过渲染。事故中循环以这种方式停摆了约 5 秒：被限速的 `sendPreviewStart`（全局 PATCH 限流器在多群并发下积压）在占位卡 flush 里持有 preview 互斥锁，循环在 `appendProgress` 中等待。循环退出后，preview 的延迟 flush 定时器仍然武装着、`degraded` 未置位，于是它们在停止之后继续 PATCH Running 态内容——17:01:02 的标题——而终态卡永远没有渲染。[stop-is-silent note](../feature/2026-08-21-feishu-bridge-stop-silent.zh.md) 已把 ⏹ 卡作为停止的唯一成功反馈，跳过渲染也就意味着停止零反馈。

## Decision

`stopInteractiveSession` 在 `state.markStopped()` 之后立即自行终结活动预览：fire-and-forget 调用 `state.preview.markStoppedSync()`（此前是死代码——Go 的 `stopInteractiveSession` 在同一位置调用 `sp.markStoppedSync()`，注释描述的正是同样的覆盖症状；端口时被丢掉），失败告警。`markStoppedSync` 先置 `degraded`——迟到的节流 flush 与 append 变为 no-op——再 barrier 排空 per-state async sender，使已入队的 Running PATCH 先落地，然后内联 PATCH ⏹ 卡。它在 preview 互斥锁上排队、位于任何在途 flush 之后，因此与已排队 Running 内容的顺序无需协调即可保持。

`Engine.stop()` 在平台停止前为进行中的 turn 渲染同样的 ⏹ 终结（2026-08-22 oc_610e reload 事故：循环在进程退出前不再运行，别处无人能渲染），由并行的 reload 修复以 `e7a3233fc6` 交付，该提交还让 `flushLocked` 以 `stoppedCardRendered` 闭锁，节流 flush 无法覆盖 ⏹ 卡。直到 2026-08-23，这套终结在 SIGTERM 路径上从未运行：per-engine 的 effect disposer 写作 `void engine.stop()`，而 `profile-boot.ts` 在 `fiber.dispose()` 链排空后即退出——无人等待 stop，它在途的停止通知与 ⏹ PATCH 随进程一起消亡。当时一个无关的 env-fix 定时器在 chatroom 进行中执行了 `systemctl restart`，运行中的卡片冻结在「思考中 · 09:39:26 · 19」。disposer 现在返回 `engine.stop()` 的 promise；Cordis unload 会 await 异步 disposer，并以 profile-boot 的 5 秒关停超时为上界。

`StreamPreview` 增加 `stoppedCardRendered` 守卫（在 preview 锁下置位）：事件循环的 stop 分支与同步终结竞相渲染终态卡，输方直接返回、不再 PATCH。`resumeFromFreeze` 与 `degraded` 一同复位该守卫，维持「卡重新存活」这一单一不变量。自 2026-08-25 起该守卫同样约束 `bumpToEnd`（改名/头像通知的 bump 曾把停止卡重发为新运行卡），且 `stopInteractiveSession` 会同步解绑引擎级 activePreview 的 bump 绑定（[stray-card note](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.zh.md)）。

## Alternatives considered

**调整 race 数组顺序或在 'closed' 分支前检查 `isStopped()`。** 只覆盖 parked-race 窗口；事件处理中途的退出与 `isStopped()` 事件早退仍会跳过渲染。用户停止不应依赖事件循环恰好的调度位置——所以终结落在拥有停止的调用点。

**在 `handleChannelClosed` 里渲染停止卡。** 归属错误：channel-close 意味着 agent 退出（其通知逻辑以 `unexpectedExit` 为键），且循环也可能经由事件早退退出而不经过它。

**复用 `cancelRenders` 处理 preview。** 它中止的是 plan/reply-HTML 渲染分叉，是生命周期不同的另一套写入方；preview 需要的是终态渲染而非 abort。

## Consequences

用户停止（`/stop`、`/done`、`/new`、`/switch`、⏹ 按钮）在 preview 锁 turnover 且 sender 队列排空后确定性地渲染一次 ⏹ 终态卡，即使 PATCH 限流积压——事故中的多秒延迟变成「迟到但正确」的渲染而非冻结的 Running 卡。SIGTERM 或 daemon 重启遵循同一契约：停止通知与 ⏹ 卡在进程退出前落地；超出 profile-boot 5 秒预算的 stop 仍会强退，退回冻结卡结果。被中止工具调用背后的 MCP 服务端仍可能在服务端算完（事故里它在 abort 十秒后的 17:01:05 算完）——客户端取消无法阻止远端服务器，正确的 ⏹ 状态才是让用户不再被误导的手段。

## Testing

`tests/engine/engine-events.spec.ts`（"user stop mid-handler"）确定性复现事故：延迟的 `sendPreviewStart` 持有 preview 锁，循环停在 `appendProgress`，停止落地，闸门放开——卡片必须出现 `stopped:` 渲染且其后没有任何 `update:`/`start:`。`tests/streaming.spec.ts` 钉住 `markStoppedSync` + `markStopped` 的单次渲染守卫及 `resumeFromFreeze` 的复位。`tests/shutdown-assembly.spec.ts` 钉住被 await 的 disposer 契约：`fiber.dispose()` 在 `engine.stop()` 未 settle 前保持 pending。feishu-bridge 套件：2103 通过。
