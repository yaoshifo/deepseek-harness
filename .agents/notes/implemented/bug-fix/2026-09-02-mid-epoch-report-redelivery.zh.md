# Agent Note: 同 epoch 内 report 重新投递

Status: implemented

[English](2026-09-02-mid-epoch-report-redelivery.md) | 中文

## Problem

在同一个 epoch 内先 report 再继续干活的子任务，其最终 report 会被搁死。`reportNativeChild` 丢弃首次之后的每一次 report（从 Go M4 移植的一次性幂等闸），且向子任务返回成功——空闲的父会话永远不会被唤醒；`settleNativeChild` 又因 `reported` 已为 true 跳过该 epoch 的 settlement 兜底。2026-09-02 G6 复放中现场观察到：typert 子任务于 13:35:07 发出中间状态 report、13:37:38 在同一 epoch 内发出最终 report，父会话卡死 13 分钟直到用户消息解卡。群路径的 `reportSubtask` 带着同一道闸。既有的 re-arm 机制——epoch 启动（`subagent/start` → `rearmNativeChild`）与父会话跟进（`sendToSubtask`）——只覆盖跨 epoch 续跑，从不覆盖同 epoch 内的多次 report。

## Decision

显式 report 一律投递；仅同一 report 的并发在途投递被跳过（竞态闸保留）。Settlement 保持一次性：`settleNativeChild` 保留自己的 `reported` 闸，群路径 auto-fallback 也保留各自闸门，因此一个 epoch 绝不会经兜底路径双重投递。被放弃的「模型重复调用 report 会轰炸父会话」顾虑输给实际观测到的故障：每次 report 都是活 turn 里一次刻意的工具调用，而静默丢弃产出的是一场 13 分钟的隐形死锁。

## Alternatives considered

- **保留一次性闸并加固子任务提示词**（report 恰好一次；不存在中间状态通道）。降低发生率；任何违规者仍会触发卡死故障模式。
- **第二次 report 大声报错。** 子任务没有任何恢复路径——send 只能父到子——报错同样把最终结果搁死。

## Consequences

- 两条投递路径（原生 `reportNativeChild`、群路径 `reportSubtask`）都会重新投递显式重复 report；`engine-subtask.spec.ts` 的回归测试钉住两条路径的「中间 report → 最终 report」形状。
- gather 的在途集合仍排除已 report 的子任务（首次 report 仍结束在途跟踪），父会话的 gather 可能提前返回——但最终 report 现在会唤醒它；卡死消除而 gather 语义不变。
- 部署：bridge 包重建 + `/reload`；dev 服务器需要同样的修复，走它自己的 pull 与重启流程。
