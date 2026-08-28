# Agent Note: feishu-bridge 第五轮子任务收尾——安静排空、interrupt 契约

Status: implemented

[English](2026-08-28-feishu-bridge-subtask-drain-quiet.md) | 中文

## Problem

2026-08-28 第五轮复查实机验证了第四轮修复（oc_c2e7f659：两波 gather 均 in-turn 结算，in-flight 重复回报守卫在真实负载下触发两次），并发现两处残留缺陷：

1. daemon 重启后的 `/done` 排空会为无事可停的子任务打故障日志。`drainNativeDescendants` 对每条待排空记录无条件调用 `interruptNativeChild`；父 agent 随旧进程死去（重启、HMR 重建）后 runtime 拒绝该中断——"the parent agent session is not live"——每次排空三条 warn，让例行清理读起来像故障。单进程内父与子 agent 同生共死，父已死意味着子也没有活着的 turn：这次 interrupt 本来就不可能做任何事。
2. `feishu_bridge_subtask` 工具描述没有写明 interrupt 动作的覆盖范围：interrupt 走 `interruptNativeChild`、只接受 native 子任务 id，模型对群子任务尝试只会得到 "not a native child of this project"，契约里事先没有任何提示。第四轮的措辞修正钉住了 send 的 busy-reject 不对称；interrupt 是漏网的同类缺口。

## Decision

- 排空前先探测：`drainNativeDescendants` 解析一次 `ContinuableDelegator`，仅当 `childLive(childId)` 报告有活 agent 时才调用该子的 interrupt。这与 `recoverInterruptedNativeChildren` 区分重启孤儿与仍在运行的子任务用的是同一探针、同一语义。记录清理、worktree 回收、屏障死亡销账对死子任务照常执行——排空保持完整，只跳过不可能成立的 interrupt。
- 工具描述在模型阅读的两处都写明 interrupt 限制：动作句（"native subtasks' current turn … attended group children are stopped from their own chat"）与 `child` 参数（"interrupt accepts native subtask ids only"）。

## Alternatives considered

- **把排空路径的 warn 降级为 info。** 否决：它保留注定失败的 interrupt 调用及其抛错；探测活性直接删掉这次不可能的调用，而不是给它的失败改分类。
- **无活父时回退到记录里的 `parent_agent_session_id`。** `interruptNativeChild` 内部已是该行为；失败点在重启后根本不存在任何 authority，不在于试错了 id。

## Consequences

- 没有可选 `childLive` 探针的 delegator（今天不存在；dsh adapter 实现了它）报告「无活子任务」，排空不中断任何子——与重启恢复依赖的保守默认一致。
- 既有排空测试的 fake delegator 增加了可控的 `childLive`（默认全部存活），原断言语义不变。

## Testing

`tests/engine/engine-subtask.spec.ts`（排空只中断活子；死的孙任务不做 interrupt 尝试直接清理）、`tests/tools/subtask-tool.spec.ts`（interrupt 契约措辞钉）。套件：160 全过；`tsc -b packages/acp/feishu-bridge` 干净。
