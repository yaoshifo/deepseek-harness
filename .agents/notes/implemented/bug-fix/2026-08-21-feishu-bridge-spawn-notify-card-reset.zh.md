# Agent Note: feishu-bridge /spawn 就绪卡的统计清零与发送可观测

Status: implemented

[English](2026-08-21-feishu-bridge-spawn-notify-card-reset.md) | 中文

## 问题

Go cc-connect 在 `/spawn`/`/fork` 建群后立刻向新群发送就绪卡，且发卡前先把引擎的回合级完成统计字段清零（`core/engine_cmd_session.go:1550`），因此该卡永远不会带上父会话上一回合的时长或输出 token 速率。TS 移植的 `spawnGroupCommon` 保留了卡片却丢掉了这两半行为：既没有 `buildCompletionUsage(0)` 清零，发送又是 fire-and-forget 的 `void buildSpawnNotifyCard(...).then(...)`——无 catch、无日志（Go 失败会 slog.Warn）。用户上报的现象「刚 spawn 的群第一张卡带 token 速率」，实际是子会话第一个回合的完成通知卡（统计真实、与 Go 一致），但其背后有两个真实缺陷：单测环境下就绪卡带父会话残留（红灯标题 `📁 repo · 18s · 500 t/s`）；真机 daemon 上就绪卡从未出现（2026-08-21 spawn 的三个群经完整消息历史核实）——且完全静默，因为旧代码失败时不打任何日志。

## 决策

`spawnGroupCommon`（`src/engine/commands.ts`）在建卡前先 `await e.buildCompletionUsage(全零字面量)`——与 subtask 路径（`engine.ts` spawnSubtask）和 `/notify`（`spawn-family-commands.ts`）同形态；三处平行的全零调用点，不抽 helper——然后经 awaited try/catch 发卡，失败时 warn `spawn: card send failed`。这是 Go 同步 SendCard + slog.Warn 的保形；`/spawn` 因此在注入首条消息前多等一次卡发送往返。chatroom 就绪卡刻意保留「不清零」：Go `engine_chatroom.go:726` 同样直接建卡。

## 备选方案

**抽取共享的 `zeroUsage()` helper。** 三处相同字面量是既有风格；该字面量对应 Go 的位置参数列表 `buildCompletionUsage(0, false, 0, ...)`，抽 helper 会遮蔽每个调用点对应的 Go 源码行。

## 影响

就绪卡只显示 workdir/branch，与 Go 一致；发送失败可观测。真机上卡片缺失无法用单测复现解释（stub 平台发送正常），遗留跟进项是合并 reload 后的真机冒烟：若卡仍不出现，新 warn 会指向飞书层；若出现，则旧 fire-and-forget 路径就是全部原因。

## 测试

`tests/engine/commands.spec.ts` `/spawn readiness card (Go buildCompletionUsage(0) parity)`：父会话残留（`500 t/s`、`18s`）不得出现在裸 spawn 与带消息 spawn 两条路径的卡标题或元素中，且发送后统计字段被清零。包内全套 1934 测试全绿。
