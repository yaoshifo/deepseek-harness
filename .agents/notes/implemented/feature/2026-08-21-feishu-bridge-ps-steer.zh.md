# Agent Note：/ps mid-turn 投递改走 agent-loop next-step inbox

Status: implemented

[English](2026-08-21-feishu-bridge-ps-steer.md) | 中文

## Problem

`/ps` 向正在运行的任务追加文字。初次移植把 mid-turn 文字走 `AgentSession.send()` → `followup()`，而 followup 的语义是 next-turn FIFO：消息要等当前 turn 结束才成为下一轮的 prompt——这不过是引擎 busy-queue 的另一个名字，Go 原版「把文字写进正在运行任务的 stdin、模型在当前回合内看到」的行为在移植中丢失。移植的 `pending` 分支（turn 阻塞在权限审批时排队）绕的是同一个 stdin 问题：权限提示占住 CLI 输入队列时，直接写入会被吞。

## Decision

`AgentSession` 新增 `steer(prompt: string): void`；`dshAgentSession` 实现为刷新 `lastActivityAt` 后以纯文本 user 消息调用 `handle.agent.steer`。dsh core 的 `Agent.steer` 把消息追加进 agent 的 next-step inbox 并唤醒驱动器，驱动器在步骤之间领取 inbox，文字由此加入同一 turn 的下一次 LLM 请求。`cmdPs` 收为三个同步分支：空参 → 用法回复；idle → 剥前缀穿透为普通消息；其余 → `steer` 加 Done reaction。

`pending` 分支与 async send 链删除。进程内 inbox 没有 stdin 吞写问题：turn 等待权限时 steer 进去的文字，在审批落地后的下一个 pre-step 被领取——同轮送达，Go 只能靠排队近似达到。`ps_send_failed` i18n 键随删：steer 同步、没有失败路径。steer 恰在 turn 关闭时到达则留在 next-step inbox、由下一 turn 边界领取——送达降级为下一轮，不会丢。steer 文字与已排队 followup 并存：前者在当前 turn 的步骤间领取，后者在下一 turn 边界领取。

## Alternatives considered

**保留 `send()` 加权限阻塞排队。** 落选：`followup()` 又是 busy-queue，mid-turn 注入仍然丢失，且 async 路径需要 steer 路径不需要的失败回复。

**按结构探测可选 steer 而非接口方法。** 落选：dsh 每个会话都支持 steer；pre-release 无兼容垫片，接口方法让编译器点名任何缺它的桩。

**默认把所有 mid-turn 普通消息 steer 化。** 范围外：这是超出 `/ps` 的产品语义决定，此处不取。

## Consequences

mid-turn `/ps` 文字在当前 turn 内对模型可见。model-visible ⟺ logged 无需新 session 事件即成立：steer 走 agent-loop 的持久 inbox。abort 后的唤醒输入分类（`wakingAfterAbort`）由 agent-loop 拥有，bridge 无需处理。

## Testing

`tests/engine/misc-commands.spec.ts` 重写 `/ps` 块：mid-turn 断言 `steerCalls` 收到文字、`sendCalls` 为空并回 Done reaction；turn 阻塞在权限时仍 steer，`pendingMessages` 不增长、无排队回复；idle 剥前缀穿透。`tests/agent-dsh/adapter-steer.spec.ts`（2 例）：`steer()` 把 user 文本消息路由进 `handle.agent.steer` 而非 followup 队列；`send()` 留在 followup 队列。九处既有桩补 no-op `steer` 以满足接口。

## Related

取代[再迁七条 cc-connect 命令](2026-08-20-feishu-bridge-seven-commands.zh.md)的 `/ps` 部分；该 note 的其余六条命令与动态生成的 `/help` 不变。
