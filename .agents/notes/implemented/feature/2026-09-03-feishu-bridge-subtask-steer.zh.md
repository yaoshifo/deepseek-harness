# Agent Note：subtask send 增加 steer 投递档

Status: implemented

[English](2026-09-03-feishu-bridge-subtask-steer.md) | 中文

## Problem

`feishu_bridge_subtask send` 只能排队：跟进消息要等子 agent 当前回合结束才能被看到。上游 0.1.2-rc.1（同日并入 dev）带来了 steer 服务——`[deliverSubagentPrompt]` 新增 `queue | steer` 投递参数，steer 档让消息在正在运行的子 agent 最近的步骤边界被领取、空闲子 agent 被唤醒、已收尾子 agent 冷恢复。桥此前只消费了 queue 半边（`followupChild`，含 2026-08-27 的 AbortSignal 冷恢复修复）；steer 半边闲置，父 agent 想中途纠正长任务子 agent 只能 `interrupt`（整轮杀掉）或等它跑完。

## Decision

`send` 接受 `delivery: 'queue' | 'steer'`，默认 `queue`。该模式沿 `engine.sendToSubtask` → `ContinuableDelegator.followupChild` → `[deliverSubagentPrompt](..., delivery)` 透传；adapter 在两条臂上都保留既有 `AbortSignal.timeout`（冷恢复路径在任一模式下都会解引用它）。全部 steer 语义仍归 subagent runtime 所有——running/idle/settled 三档接纳、回合收尾竞态降级为下一回合送达、冷恢复都是服务行为，桥不重复实现。attended group 子 agent 被要求 steer 时响亮失败（`subtask: steer delivery is only supported for native subtasks`）：它没有 runtime inbox 可接纳 mid-turn 消息，静默降级成 queue 会把未命中藏在成功消息后面。

可发现性按模型可见面设计：`delivery` 参数描述携带决策指引（"prefer steer to correct course or add key context while a long-running subtask is still working"），spawn 结果消息现在写明干预通道（"send with delivery steer reaches it mid-turn"），让父 agent 在派发时刻就知道，而不是事后翻 schema 重新推导。

## Alternatives considered

**子 agent 在跑时自动 steer。** 否决：发完即走的批量跟进会遭遇不可预测的 mid-turn 转向；显式模式让 queue 语义保持默认，选择权留在掌握信息的地方。

**经 `AgentSession.steer` 支持 attended group 子 agent 的 steer。** 暂缓：group 路径围绕平台队列张贴可见卡片并重挂一次性 auto-report，是另一套投递机构；此处记录为后续项，出现需求再做。

## Consequences

工具 schema 每次请求都对模型可见（描述 + 新参数）；无新增 session 事件——runtime 的持久 inbox 已满足 model-visible ⟺ logged。默认路径与之前逐字节一致：settlement fallback 的提示发送（`monitor.ts`）不改地保持 queue 语义。

## Testing

`tests/agent-dsh/adapter-followup-signal.spec.ts`：fake subagents recorder 记录 delivery 参数；默认断言 `queue`，显式断言 `steer`。`tests/engine/engine-subtask.spec.ts`：`sendToSubtask` 把模式透传给 delegator 并重挂；attended group 子 agent 的 steer 请求被拒且不发跟进卡片；默认断言记录 `queue`。`tests/tools/subtask-tool.spec.ts`：schema 枚举与指引措辞、spawn 结果提示、按档位区分的结果消息。桥全量：180 个文件、3161 通过。

另外，新测试带来的调度时移确定性暴露了 `tests/engine/engine-stall-retry.spec.ts` 的既有竞态："Session terminated" 通知先于状态删除发出，删除发生在 `closeAgentSessionWithTimeout().finally()` 内（受该套件的 `closeTimeoutMs` 200ms 约束）；耗尽重试的测试原来同步断言删除。修复是把该断言包进 `vi.waitFor`——同文件姊妹测试对同一条件早已是这个写法。

## Related

上游 steer 服务：PR #3250（`feat/3220-steer-service`）与 agent-team mailbox 消费方（PR #3333）。进程内姊妹是 [/ps note](2026-08-21-feishu-bridge-ps-steer.zh.md)——同一个 next-step inbox 原语经直连 handle 到达，无服务间接层。B4 note 记录的 queue 模式对 Go busy-reject 的偏离作为默认值原样保留。
