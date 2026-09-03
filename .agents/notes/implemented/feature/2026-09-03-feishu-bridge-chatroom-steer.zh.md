# Agent Note：chatroom 主持人回合中途引导经 ask 的 steer 档

Status: implemented

[English](2026-09-03-feishu-bridge-chatroom-steer.md) | 中文

## Problem

主持人够不到正在运行的角色：`askRole` 经 `receiveMessage` 注入问题，忙角色（上一问或 gather 轮进行中）会把问题压进平台人类消息队列——排队回执、仅内存、深度上限——恰是 `deliverMachineMessage` 专门挡在机器协调之外的语义（2026-08-27 oc_56801302 同类）。而反方向早已 steer 化：角色回复经 `deliverMachineMessage` 在主持人忙时中途唤醒。看着角色跑偏的主持人只有 `interrupt`（整轮杀掉）或干等回合结束，且 `ask` 守卫在 gather 武装期间一律拒绝。

## Decision

`askRole` 增加 `delivery: 'queue' | 'steer'`（默认 queue，沿 `askRoleInternal` 透传）。steer 档把注入改走 `e.deliverMachineMessage`：忙角色在最近步骤边界收到问题（与 /ps 同一个 agent 会话 steer 原语），空闲角色走机器唤醒管线、带完整回合机制。角色群里的可见问题卡片仍在注入前发出，一次性中继重挂不变——被 steer 的那轮回复仍经 `chatroomAsked` 门中继，因为回合中 steer 折进运行回合的回答。

gather 守卫按模式区分：queue 在 `pendingGather` 期间仍拒绝（回复两头落空——门已被 gather 问题消耗），steer 放行，且回复仍算该角色的 gather 回复——屏障按会话消费、不按回合。`pendingHumanQuestionRole` 与收尾屏障对两档维持拒绝。工具面对齐 `feishu_bridge_subtask send`：显式 `delivery` 参数带决策指引，加按档位区分的结果消息；`startChatroom` 与 `gatherRoles` 保持 queue 默认。

`SubtaskDelivery` 经桥的 `exports` 面导出——chatroom 包受支持的导入面。

## Alternatives considered

**角色忙时自动 steer。** 否决：显式模式让串行 ask 语义可预测，选择权留在主持人手里，与 subtask `send` 的取舍一致。

**等 subagent steer 服务覆盖。** 不适用：chatroom 角色是群会话（attended），不是 native continuable 子任务——服务的 `deliverSubagentPrompt` 到不了它们。正确的原语就是引擎自带的机器唤醒 seam。

## Consequences

回合中途纠偏在最值钱的场景可用：gather 武装期间，主持人可以纠正生成中的角色，不必杀它的回合、不必丢轮。回合中 steer 触发的 research 派发旗重置（`researchDispatched = false`）对运行回合无影响——该旗只在回合启动时武装。model-visible ⟺ logged 成立：steer 走 agent-loop 持久 inbox，无新增 session 事件。

## Testing

`tests/engine/engine-chatroom.spec.ts` AskRole：steer 进忙角色经 `steerCalls` 收到问题、卡片发出、中继重挂；空闲角色走管线（不经 steer 原语）；gather 武装期间 steer 放行而 queue 仍拒；收尾屏障下 steer 仍拒。`tests/tools/chatroom-tool.spec.ts`：`delivery` 参数 schema 与指引措辞，加一个全引擎路由证明（配置角色 → 启动聊天室 → 忙角色 → 工具 ask 带 steer → `steerCalls`）。chatroom 套件：22 文件、326 通过。

## Related

建于 [subtask send steer](2026-09-03-feishu-bridge-subtask-steer.zh.md) 消费上游 steer 服务的次日；本 note 记录姊妹路径——同一个 next-step inbox 原语，经引擎机器唤醒 seam 到达群托管的角色。此前的评估修正了一个错误初判：角色不是 `spawnSubtask` 托管的 native 子任务（只有研究助手是 `spawnSubtask` 群子任务；角色经 group spawner 直接建群）。
