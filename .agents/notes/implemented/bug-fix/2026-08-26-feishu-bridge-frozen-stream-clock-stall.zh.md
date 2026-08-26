# Agent Note: feishu-bridge 孤儿泵被冻结的流时钟永久钉死

Status: implemented

[English](2026-08-26-feishu-bridge-frozen-stream-clock-stall.md) | 中文

## Problem

2026-08-26 晚间，聊天室 hub oc_b46da516（bot 教学驴，工作区 `/home/hm/workspace/books`）在讨论中途永久卡死。时间线：moderator 的 turn 于 19:03:46 干净结束（「追问已发给 popper，等其回复」）；unsolicited reader 于 19:04:31 在一个背后没有引擎唤醒 turn 的杂散实质帧上开启了孤儿 turn 泵（spillover 转发默认关闭，`unsolicitedSpilloverGrace = 0`）；runtime 于 19:05:49 又投射了一帧泵未消费的事件，把 `AgentSession.lastStreamActivity` 冻结在比泵的 `lastEventAt` 新 8 秒的位置上。此后一切唤醒都静默排队在泵持有的会话锁后面——聊天室角色回复中继的 `receiveMessage`（19:06:12，popper 的回复卡片渲染进群但 moderator turn 未启动）、原生 subtask 的回报、以及任何用户消息（`queueMessageForBusySession` 只回一条已排队提示、不开启 turn）。没有任何看门狗触发：`stallConfirmed` 的盲泵守卫（[为 oc_29bb 引入](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.zh.md)）比较的是两个冻结时钟（`streamLast > lastEventAt` 恒成立），而硬性 turn 上限只在事件到达时执行——一个收不到事件的 turn 永远走不到那项检查。19:25:41 的 journal 行 `stall check overridden: agent is streaming but the pump saw no event (last pump event 1200s ago, last stream event 1192s ago)` 就是该守卫在两个已冻结二十分钟的时钟上反复触发。泵本身即 [oc_9956 的孤儿 turn 泵](2026-08-23-feishu-bridge-orphan-turn-pump.zh.md)；它对任何实质帧的准入未变——缺的是可终结性。

留给后续排查的判别特征：`engine: orphan turn pump started` 日志之后会话日志零事件；`blind pump` 警告按空闲节奏反复出现且两个时间戳停止移动；群里每条后续消息只收到已排队提示。修复前的恢复手段：停家族命令（在锁之前分发）或重启 daemon。

## Decision

- `Engine.stallConfirmed` 只在事件流仍然新鲜时豁免泵：盲泵守卫追加要求 `now - streamLast < idle`。自身已静默满一个空闲窗口的事件流是冻结时钟对、不是在出流；stall 由此确认，既有的重试/终止机制接管收尾泵 turn。挂死被约束在流静默后约多等一个空闲窗口的量级（oc_29bb 的保护不变：持续投射的 agent 不断刷新 `streamLast`，绝不会被 idle 触发杀死）。
- 孤儿泵启动日志带上它开启时所依据的首事件（`first event <type> [工具名]`），下次事故的触发帧一条 journal 即可辨认，不再需要取证重建。

## Alternatives considered

- **对泵的首事件设准入门槛**（例如拒绝无 turn 佐证的 `tool_use`）。否决：合法的引擎唤醒 turn 完全可能先投射工具调用；帧身份在到达时刻无法区分杂散回声与真实唤醒。缺失的不变量是泵的可终结性，不是准入。
- **定时器版硬性 turn 上限**（不依赖事件到达即可触发）。本次否决：加上新鲜度判据后每个安静 turn 都会经 idle→stall 路径终止，再叠一个与所有 turn 语义重叠的看门狗得不偿失；到达触发上限与 Go 一致。若无事件挂死经其他路径复现再重议。
- **缩短 `unsolicitedToolInFlightTimeout`。** 否决：30 分钟预算对真实运行中的后台工具是正当的，且本次事故按 10 分钟的 event idle 节奏循环；操作者可按 profile 调 `toolInFlightTimeoutMs`，无需改代码。

## Consequences

- 冻结时钟对的泵 turn 最迟在杂散帧之后约两个空闲窗口内终止；窗口期内后续消息带已排队提示排队而非消失，锁释放后照常 drain。
- stall 重试可能重启一个其实健康只是安静的 agent；与之前一样受 `stallMaxRetries` 约束，且仅在事件流静默满一个预算之后发生。
- 遗留：19:04:31 杂散帧的确切来源（turn B 尾帧与泵退出的竞速、或合成投射）尚未钉死；若复发，增强后的泵启动日志会直接点名。
- 覆盖：`tests/engine/engine-ask-interrupt.spec.ts`（冻结时钟对确认 stall）、`tests/engine/engine-unsolicited.spec.ts`（杂散帧泵终止、释放锁、清空 interactive state）、`tests/engine/engine-stall-retry.spec.ts`（恢复后安静的泵终止而非永久循环——其旧断言钉住的恰是这种不朽性）。
