# Agent Note: 会话 resume 降级前先等完 agent 会话拆除

Status: implemented

[English](2026-08-21-feishu-bridge-stop-resume-live-guard.md) | 中文

## Problem

生产事故 2026-08-21（群 oc_6ee6）：用户停止了一轮执行（⏹ 停止执行或 `/stop`），片刻后输入「继续」，引擎回复了 `session_resume_degraded`——整个群的对话上下文被静默丢弃。resume 失败于 dsh 的 live 守卫（`cannot prepare session "cc-…" while it is live`，coordinator 的 `prepare` 在 session 仍注册在案时立即抛错），原因是 `stopInteractiveSession` 同步删除 interactive state、用 `void close()` 发后即忘地关闭 agent 会话——与带有 `state.closing` 守卫的 `cleanupInteractiveState` 不同。`closeAgentSessionWithTimeout` 的 130 秒竞速静默落败也会进入同一个拆除窗口。两个叠加缺陷放大了事故：降级回退沿用了 `compareAndSetAgentSessionID` 的 sticky 语义，会话记录被钉死在不可恢复的 ID 上（降级后 s129 仍指向 `cc-…140944`）；且涉及的每条路径都不留日志——服务日志在该轮完成与失败的 resume 之间一片空白。

## Decision

`dsh-feishu-bridge` 引擎内三重防御，任意一条都足以避免观测到的降级：

1. `stopInteractiveSession` 改为先摘下 `agentSession`、把 close promise 挂到 `state.closing`，close 结算后才移除 map 条目（按身份比对，不误删更新的占位者）。`getOrCreateInteractiveStateWith` 既有的并发拆除等待随后会让抢跑的「继续」等到拆除完成，而不是去 resume 仍 live 的会话。
2. resume 被 live 守卫拒绝时，先在 `liveGuardRetryBudgetMs` 内轮询 `startAgentLocked`（默认 `agentCloseTimeout`，间隔 500 ms；测试钩子为 `setLiveGuardRetryBudgetMs`），再降级。非 live 守卫错误仍立即降级——只有「拆除进行中」值得等待。
3. 降级回退用 `setAgentSessionID` 换绑记录（旧 ID 移入 `pastAgentSessionIDs`），中毒 ID 不再钉死会话；正常 resume 路径保持 `compareAndSetAgentSessionID` 语义。

`stopInteractiveSession`、live 守卫重试告警、`closeAgentSessionWithTimeout` 的竞速落败现在都写日志，消除排查时的日志真空。测试：`tests/engine/engine-resume-race.spec.ts` 固定 stop→继续等待、live 守卫重试、降级换绑三个行为；`/stop` 命令测试更新为新契约（close 阻塞期间条目带 `closing` 滞留——对用户仍然立即返回，与之前一致）。

## Alternatives considered

**修 dsh 的 `prepare`，让它等待进行中的 live 拆除而不是抛错。** 根治但属于 coordinator 语义变更：该守卫同时防真正的第二个持有者，而在 `prepare` 内区分「拆除进行中」与「仍在使用」需要 coordinator 不掌握的注册表知识。暂缓；桥接层的等待已覆盖已知窗口。

**让 `/stop` 复用 `cleanupInteractiveState`。** 它内联等待完整 close（上界 130 秒）；`/stop` 必须立即返回用户（Go 对齐——/stop 测试固定 close 阻塞时 500 ms 内返回）。挂 `closing` 的变体保住返回契约的同时让竞态安全。

**保持发后即忘的 close，但在 stop 时清空记录 ID。** 每次停止都按设计丢弃转录；停止→继续是卡片主流程（⏹ 之后是 ▶ 继续执行），不是错误路径。

## Consequences

停止后立即输入的「继续」现在会先等拆除完成（上界为 close 超时）再开始本轮——短暂的延迟取代静默的上下文丢失。interactive-state map 会短暂保留一个带 `closing` 的已停条目；`getOrCreateInteractiveStateWith` 本就将其视为等待信号，检查 `agentSession` 的读者看到的是 `undefined`。若日后 dsh 在 prepare 侧改为等待，防御 2 即冗余可退役。工作区里未完成的 `/ps` i18n 删除（`Msg.PsSendFailed` 引用未清理）早于本改动，未被触碰。
