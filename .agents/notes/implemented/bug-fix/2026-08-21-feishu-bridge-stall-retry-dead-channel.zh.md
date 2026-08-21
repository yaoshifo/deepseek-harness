# Agent Note: feishu-bridge stall 重试把事件循环重臂到了已死的重试前 channel 上

Status: implemented

[English](2026-08-21-feishu-bridge-stall-retry-dead-channel.md) | 中文

## Problem

生产事故 2026-08-21 07:34（群 oc_07627）：模型流在推理中途挂起 200 秒，空闲看门狗按设计触发了 stall 重试（「⚠️ Agent 无响应超时（200），正在重试（1/3）」），2.4 秒后重试的 turn 却死于虚假的「⚠️ Agent 进程意外退出」——重启在开始三秒后就被自己的簿记杀掉了。会话最终恢复只是因为用户手动重发了「继续」。

`processInteractiveEvents` 把 agent 会话的事件 channel 捕获为循环局部的 `const channel`，并在每收到一个事件后从这个常量重臂接收 promise。`restartAgentForStallRetry` 把 `recvP` 换成了恢复会话的 channel，却没换 `channel`，于是重试 turn 的**第一个**事件把 `recvP` 重臂到了旧的、已关闭的 channel 上；循环下一轮迭代把这个关闭读成 select 的 `closed` 分支，走了 agent 退出路径（`handleChannelClosed` → 退出通知 + `cleanupInteractiveState`，后者把健康的恢复 agent dispose 掉）。会话日志里重试 turn 第一个 reasoning delta 与该 turn `aborted/disposed` 结束之间 28 毫秒的间隔，正好是一轮循环迭代。

排查最初怀疑 dsh 运行时（dispose 确实经由 factory dispose 跑了 `machine.cancel({kind:'disposed'})`），因为引擎侧所有主动关闭都会先标记 state stopped，不可能产生退出通知。一个内核层二分测试——对挂流 agent 做 turn 中 dispose、立即同 id resume、断言恢复的 turn 正常完成——通过了，证明 factory/registry 生命周期是干净的，把 bug 定位到引擎事件循环。

## Decision

用一个与 `recvP` 并存的 `let events` 跟踪活跃 channel：循环入口从会话的 channel 初始化两者，stall-retry 分支同时交换两者（`events = retry.events()`），每收到一个事件后以 `recvP = events.receive()` 重臂。旧的 `channel` 常量只保留作为传给 `restartAgentForStallRetry` 的 drain 目标。

## Alternatives considered

**每个事件从 `state.agentSession?.events()` 重臂。** 把循环的重臂步骤耦合到交互状态的变更时机；排队 turn 的转换会在事件之间换会话，在那里读 state 会重新引入另一类过期读取。

**只在重试里换 `recvP`（修复前的形态）。** 交换后收到的任何事件都会把重臂重置到死 channel 上——即本 bug。

## Consequences

stall 重试现在能在自己的第一个事件后存活；重试耗尽路径（N 次重试后「💀 Session terminated」+ 状态清理）重新可达——修复前重试的第一个事件总会把循环短路进退出路径，耗尽分支永远到不了。真实诱因（连接保持打开但 provider 流不再产出）仍按设计表现为 stall 通知。

## Testing

`tests/engine/engine-stall-retry.spec.ts` 是真组合（REAL-composition）测试套件：完整 Engine + DshAgentAdapter 跑在真实 Cordis 运行时（agent-loop、registry、jsonl 持久化）上，配一个脚本化 LLM adapter——首个请求流中途挂起、重试响应延迟首 chunk，即测试速度下的 incident 形态（空闲超时 400ms）。红灯运行逐字复现了两条聊天消息，并显示同一 session id 的两次 `agent/disposed`；绿灯运行完成重试 turn，第二个用例则耗尽三次重试走到终局 kill 且无任何退出通知。`packages/core/agent-loop/tests/stall-retry-resume.spec.ts` 把二分测试留作 factory 生命周期守卫。feishu-bridge + agent-loop 全量套件：2262 绿。

stall-retry 流程的应用级 transcript 快照未覆盖：快照 harness 回放录制的模型响应，没有定时 wire 故障注入能力，而 stall 场景恰恰需要。本次改动不扩 harness，暂时搁置；真组合套件作为覆盖替身。
