# Agent Note: 引擎持有的每一处 agent 会话 close 都有界

Status: implemented

[English](2026-08-26-feishu-bridge-bounded-agent-close.md) | 中文

## Problem

三处引擎持有的等待调用 `AgentSession.close()` 时没有任何上限：`restartAgentForStallRetry`（stall retry 重启）、`Engine.stop()`（逐 state 收尾）、`DshAgentAdapter.stop()`（引擎停机时的 close-all）。一旦 close 底层的 dispose 永不结算——任何无视 `exec.signal` 契约的 tool call 都能造成——事件泵会永久停在 stall retry 内部（idle 计时早已消耗，没有任何看门狗能救），daemon 停机也会整体卡死。2026-08-25 的 ask 中断修复消除了已知的 dispose 挂起触发路径，但这些等待本身仍是无界的（[同族事故](2026-08-25-feishu-bridge-ask-interrupt-blind-stall.zh.md)）。

## Decision

三处等待全部把 close 与 `agentCloseTimeout`（默认 130 秒，Go 的值）竞速，到期放弃并打警告：

- stall retry 继续推进。adapter 的引擎键会话缓存（`sessionsByEngineKey`）此时会重新附着到仍存活的会话而不是让 resume 失败，turn 在重附着的会话上继续；该会话不再产出泵事件时，由盲泵防护与硬性 turn 上限接管后续循环。
- `Engine.stop()` 与 `DshAgentAdapter.stop()` 完成停机；被放弃的 agent fiber 交给进程退出处理。

该上限是一个旋钮：项目级 cordis 字段 `agentCloseSec` 同时供给引擎（`setAgentCloseTimeout`，实例字段替代原模块常量）与 adapter（`DshAdapterConfig.closeTimeoutMs`）。

## Alternatives considered

**dispose 链内有界的 `machine.whenIdle()`。** 与 2026-08-25 拒绝理由相同：静默等待中途 detach 会留下向一个 resume 会话也在追加的日志追加的僵尸。改为引擎侧停止等待；agent 侧保留有序 teardown。

**只给 stall retry 的 close 加界。** 回归测试后弃用：卡点只是移动到了 `Engine.stop()` → `DshAgentAdapter.stop()`。三处是同一操作上的同一等待。

## Consequences

- 挂起的 close 现在至多在每个等待点花费 `agentCloseTimeout`，随后带警告地失败（warn 日志），引擎保持响应；会话留在注册表直至进程退出，后续 resume 走既有的 live-guard 轮询/降级链。
- live-guard resume 预算保持 130 秒默认（此前与同一常量共用）；它经 `setLiveGuardRetryBudgetMs` 独立设置。

## Testing

`tests/engine/engine-stall-retry.spec.ts` 新增一个 REAL 组合 spec：首个会话的 `close()` 永不结算，断言 close 超时警告、stall-retry 通知、随后的盲泵警告（泵仍在循环而非停车），以及 `engine.stop()` 正常结算。feishu-bridge 全套：136 个文件 2377 个测试通过。
