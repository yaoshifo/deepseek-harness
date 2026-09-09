# Agent Note: chatroom ask 通道加固——机器投递、诚实唤醒、上限前置

Status: implemented

[English](2026-09-09-chatroom-ask-channel-hardening.md) | 中文

## Problem

2026-09-08 oc_9b99f 复盘在 `1be82d7682` 修掉旧答案中继事故本身之后，又暴露三个潜在隐患。其一，串行追问的监督网 stall 唤醒文案摘录 `role.lastResult`——与事故中「旧答案以现状口吻出现」误导主持人是同一模式。其二，chatroom 的角色 ask 与 gather 广播经人类消息管道（`receiveMessage`）注入：busy 角色的队列上限 5 条、满则静默丢弃（QueueFull），限流拦截丢弃，agent 死亡丢队列——角色根本没被问到，`pendingSerialAsks` 条目残留，且无人知晓问题已丢。其三，所有绕过角色挑选卡的 start 路径（显式多角色命令、`--continue` 复用、moderator start 工具、start-picker continue）都只在 `startChatroom` 深处才校验 `maxRoles`——此前已做 venv 预备、mode 卡武装或 picker 状态删除——超限阵容先烧掉副作用才失败，重试等于重跑 `/chatroom`。

## Decision

- **串行 stall 唤醒去掉 lastResult 摘录**；角色名、等待分钟数、重问或推进的行动指引保留。steward 唤醒保留摘录——它是显式过去时口吻的承重事实（「最后一次回复：…」），测试记录了这一口径，主持人靠它权衡长任务与真挂起。
- **ask 与 gather 广播改经 `deliverMachineMessage` 投递。** 空闲角色走与旧管道相同的处理链——metadata（含 ask 身份）随行、turn-start 盖戳钩子不变——仅多 machine 标记。busy 且存活的角色由 steer 把问题注入当前 turn；恰落在 turn 边界则进 durable inbox 由下个 turn 消化。内容绝不静默丢失，人类管道的队列上限与限流不再门禁协调消息。因 steer 只带内容（不开 turn，盖戳钩子无从消费），ask 身份的预写盖戳改为无条件：busy-steer 的中继靠它路由，空闲路径 turn-start 以同值重盖（幂等）。
- **`assertChatroomRoleCount(e, names)`**（chatroom-roles.ts）抛与 `startChatroom` 兜底逐字相同的 `chatroom: too many roles (N > max M)`，兜底保留。每个绕过入口在首个副作用前调用——venv 预备、mode 武装、账本 inherit 扫描、picker 状态删除之前。card-action seam 把抛错换成红卡并保留 picker 状态。引导路径无需第五处校验：其阵容只能来自已预检的入口或挑选卡自身的 confirm 闸门。

## Alternatives considered

- **摘录加标注**（「旧回复，非本轮答案」）而非删除：仍是把旧答案文本喂给紧挨提问的 LLM 主持人；需要上次回复时账本里本就有。
- **扩机器通道参数让 metadata 穿越 steer**：steer 不开 turn，turn-start 盖戳钩子没有消费点；通道层参数解决不了原语层事实。
- **busy-steer 研究分发预写 `chatroomAwaitAssistant`**：被无关 turn 结束消费的延迟等待会错配研究归属；助手报告本就经 subtask report 唤醒独立到达。
- **只靠 `startChatroom` 兜底**（现状）：兜底保留，但早失败才是要点——抛错前的副作用正是失败成本所在。
- **超限自动截断**：静默丢弃用户/主持人的显式选择；fail-loud 拒绝加卡面明示上限才是设计路径。

## Consequences

- 测试钉住：无摘录的唤醒（fixture 保留 `lastResult` 以证明「有也不出现」）、ask/广播的机器投递（busy 走 steer、不再调 `receiveMessage`）、无条件身份预写、四个早失败入口（venv 步数=0、mode 未武装、inherit 扫描未跑、picker 状态保留）。四个既有测试适配新投递时序；路由断言不变，含 busy-steer 时序下的 oc_97be4a1c 保护场景。
- 已知残留：startup 与 dead-agent 窗口仍回退管道排队（机器通道既有 fallback，与 gather 注入、监督网唤醒共享）；`chatroomAwaitAssistant` 不随 busy-steer 研究分发（低频路径，内容仍经 report 唤醒到达）；steer 恰落在 turn 结束前会被吸收为轮答案、消息本身留 inbox——接受，内容不丢。
- 部署：bridge 重建 + `/reload`。
