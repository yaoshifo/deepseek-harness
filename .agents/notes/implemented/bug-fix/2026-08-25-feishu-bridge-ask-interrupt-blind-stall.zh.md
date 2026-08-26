# Agent Note: Ask 中断可在卡片投递中途结算；stall 看门狗交叉核对 agent 自身事件流

Status: implemented

[English](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.md) | 中文

## Problem

2026-08-25 oc_29bb 事故（群「mem0 MCP迁移到DSH」）暴露了一条三环故障链，终点是用户看到 `💀 Agent 长时间无响应（200 无输出，已重试 3 次均失败）`——而会话日志证明每个击杀窗口内 agent 都在连续出流：

1. **停车的 ask 在卡片投递期间无法被中断。** `Engine.askUser` 只在 pre-card flush、plan 卡发送、权限/问答卡发送全部完成*之后*才武装 stop/abort race。插件 reload（或任何引擎 stop）落在这个窗口内就会让平台在发送中途停止；挂起的发送把 ask 永久停住，exit_plan_mode 的 tool call 永不返回，而 `AgentHandle.dispose()`——内部 await `machine.whenIdle()`——永不完成。会话因此永远留在 `ctx.sessions`：live 注册泄漏。
2. **泄漏让该群在下一次唤醒时降级。** subtask gather 超时唤醒主群，resume 撞上 coordinator 的 live guard（`cannot prepare session ... while it is live`），重试预算耗尽，该群降级为全新会话——丢失全部对话上下文（与 2026-08-21 stall-retry 事故是同一个泄漏，reload 打断是其第二个触发路径）。
3. **stall 看门狗杀掉了它看不见的 turn。** 降级新会话上，派发泵丢失了事件供给而 agent 连续出流 16 个 step；`stallConfirmed` 只读 `state.lastEventAt`（泵的视角），于是 idle 触发以精确 200 秒节拍三次杀死健康出流——每次击杀还中止了该 turn 在飞的 exit_plan_mode ask（模型自述「提交七次均无效」）——最终落到 💀。

`Engine.stop()` 也从不触发 state 的 stop 信号（`markStopped`）；停车的等待者只能依赖 channel-close drain，而那条 drain 本身依赖被停车 ask 阻塞的 close 链。

## Decision

- **`Engine.askUser` 在任何投递 await 之前武装 stop/abort race。** pre-card flush、停车、卡片发送全部收进一个 `deliverCards` 闭包，与 `Promise.race([stopP, abortP])` 竞速；中断立即把 ask 结算为 `{ outcome: 'cancelled' }`、清理已落地的停车并返回。被中断投递的迟到卡片落地无害（ask 已不在，杂散回答无处路由）。abort 监听只在两条退出路径移除——若在交付 race 之后立刻移除，会解除后续 decision 等待的武装（被既有 aborted-ask spec 抓到）。
- **`Engine.stop()` 对有活跃 turn 的 state 触发 `markStopped()`**，泵与停车 ask 确定性地结算，不再依赖 channel-close drain；泵的 stop 臂对引擎停渲染 ⏹ 已停止卡（它本就区分用户停）。
- **`stallConfirmed` 交叉核对 agent 会话自身的事件流。** `AgentSession.lastStreamActivity()`（新增可选能力，dsh adapter 实现为其投影事件时间戳）仲裁：agent 投影事件比泵最后一次接收更新时，idle 触发记一条 `blind pump` 警告并拒绝击杀。该豁免以新鲜度为界——事件流自身静默满一个空闲窗口后 stall 照常确认——因为原先声称的硬性 turn 上限兜底是到达触发的，对收不到事件的 turn 无法生效（[2026-08-26 oc_b46da 事故](2026-08-26-feishu-bridge-frozen-stream-clock-stall.zh.md)）。

## Alternatives considered

**注册表级强制退休泄漏会话。** 弃用：`AgentHandle.dispose()` 是仅消费者持有的能力；在 `ctx.agents` 开后门强制摘除一个 agent 仍在跑的会话，会让僵尸向一个 resume 会话也在追加的日志追加（seq 冲突）。修中断路径是在源头消除泄漏。

**dispose 链上有界的 `machine.whenIdle()`。** 暂缓：对静默等待竞速后照常 detach 留下同样的僵尸窗口；ask 中断修复消除了观测到的挂起，任何*其他*永不结算的工具本来就违反文档化的 `exec.signal` 契约。

**自愈 resume（降级前强制关闭陈旧 wrapper）。** 泄漏源头修复后不再必要；既有的轮询后降级保留为最后手段。

## Consequences

- 投递中被中断的 ask 结算为 cancelled；agent 看到取消的评审并按自身处理继续（plan 模式把取消评审读作继续规划）。
- 2026-08-21 的 stall-retry 泄漏触发路径同样被覆盖：`restartAgentForStallRetry` 的 close 取消 turn，abort 信号现在贯穿整个投递阶段到达 ask，dispose 得以完成。
- 盲泵防护把「击杀健康流」换成有界等待：事件流静默满一个空闲窗口后豁免到期；`blind pump` 警告是「reload+降级序列下*哪个*消费者抢走通道」这一未解问题的诊断钩子。

## Testing

`tests/engine/engine-ask-interrupt.spec.ts`（新增，五条 spec）：平台发送挂起的 ask 在投递中途被 stop 信号、abort 信号、`engine.stop()` 三种方式触发时都结算为 cancelled；`stallConfirmed` 在 agent 会话事件流新于泵接收时拒绝击杀（断言 `blind pump` 警告）、两者都陈旧时确认击杀。`engine-ask.spec.ts` 既有的 aborted/stopped-ask spec 钉住 decision 等待语义（并在开发中抓到监听器移除回归）。feishu-bridge 全套：134 个文件 2334 条测试通过；仓库 typecheck 通过。
