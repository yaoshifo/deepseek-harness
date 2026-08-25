# Agent Note: features.subtaskQuiet 下无人值守子任务结算不发卡

Status: implemented

[English](2026-08-25-feishu-bridge-subtask-quiet-settlement.md) | 中文

## Problem

无人值守的原生子任务每笔结算都无条件向父飞书群发一张 `[子任务完成]` 卡片——`deliverParentReply` 的 `sendAsCard` 没有任何门控。N 个并行子任务就是 N 张没人要的卡片：经 `feishu_bridge_subtask` 委派的用户要的是综合结果，不是逐子任务的可见性，通用 `subagent` 工具的静默返回才是参照语义。`features.quiet` 只关 thinking/工具调用的进度展示，表达不了这个诉求。

## Decision

`features.subtaskQuiet: true`（项目级）抑制无人值守原生子任务汇报的结算卡片。`deliverParentReply` 增加 `silentCard` 参数：原生路径的调用方（`replyNativeToParent`，同时服务显式汇报与 `subagent/end` 结算兜底）传入引擎开关；attended 群路径的调用方（`replyToParent`）恒传 `false`。父 agent 的唤醒——合成 `[子任务完成]` 消息与 gather 银行化——始终投递；被抑制的只有用户可见的卡片。attended 群子任务（`/spawn` 子群）、monitor 群与群路径的卡片不受影响：那些界面本来就是为了被围观而存在的。

## Alternatives considered

- **把 gather 批次压缩成一张汇总卡。** 否决：用户要的是静默不是浓缩，且不带 gather 时逐子任务卡片照发。
- **用一行简讯替代整张卡。** 否决：仍是逐子任务一条消息，而唤醒已把完整结果带进父上下文、综合回复落在那里。
- **让 quiet 成为默认。** 否决：带卡结算是 Go 移植的可观测契约；quiet 是按部署偏好选择的 opt-in。

## Consequences

- 用户失去原生子任务结算卡上的改动 diff 可视化；footprint 仍经汇报内容与父会话完成卡上的 `subtaskDiffElements` 到达 agent。`/spawn` 围观仍是可见性出口。
- 开关在 `buildProjectAssembly` 里与其他 feature 接线同位（`tests/assembly-config.spec.ts` 覆盖）；引擎行为由 `tests/engine/engine-subtask.spec.ts` 的 quiet 用例与 `tests/engine/native-subtask-assembly.spec.ts` 的 REAL 组装用例钉住。
- Mac 部署 profile 同时在自己的 patch 里禁用了通用 `tool-subagent` 两行，让 `feishu_bridge_subtask` 成为那里唯一的委派入口——这是记录在 profile 里的部署选择，不是 bundle 默认。
