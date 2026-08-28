# Agent Note: feishu-bridge 挂起卡在决策落地时结算为结果状态

Status: implemented

[English](2026-08-28-feishu-bridge-parked-card-settles-with-ask-outcome.md) | 中文

## Problem

2026-08-28，oc_b20512 群（dsh-memory 改名）：turn 4 跑了 12 次工具调用，14:50:10 调用 `exit_plan_mode`，活跃进度卡挂起为蓝色「等待中 · 14:50:11 · 12」。用户 14:55:10 点了允许：权限卡原地换成 ✅ 已允许、会话相位头像变绿、决策后重启在尾部开出新卡接续整个 turn——功能链路全部正常。但挂起卡从此永远停在「等待中」：`completeAndDetach(park)` 丢弃预览句柄（`previewMsgID = undefined`），而所有终态渲染（`markCompleted`/`markFailed`/`markStopped`）都在句柄缺失时直接跳过，任何结算路径都无法再触到这张卡。用户已经回答过的卡一直在宣称 turn 还在等——事后翻聊天记录，审批看起来像从未生效。扩展 [挂起追问豁免上限/等待卡笔记](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.zh.md)：它定义了等待头，没有定义等待的结算。合并时与同日的等待卡导出按钮改动（蓝色卡挂按钮）相撞：结算重渲染会把用户刚获得的按钮在作答那一刻抹掉——因此合并同时把按钮资格改为按状态判定。

## Decision

- 挂起保留卡句柄供结算使用：`completeAndDetach` 现在返回被 detach 的句柄；ask 流程在挂起它的预览写入器旁边捕获该句柄。
- ask 结算时——decided、stopped、aborted 三种 outcome 一视同仁，投递中断竞速分支尽力而为——引擎在重启 surfaces 之前把挂起卡头部 PATCH 为 ask 结果：approved「已批准」（turquoise）、rejected「已拒绝」（红）、answered「已回答」（turquoise）、cancelled「已取消」（灰），由 `parkedOutcomeOf` 从 `AskDecision` 映射。结算 PATCH 是尽力而为：失败仅记日志、保留等待头。
- 结算头刻意不用绿色——绿色宣称「执行完成」，挂起前段落配不上这个宣称。结算卡保留其等待渲染携带的导出/回复按钮：`injectReplyButtons` 增加了按状态判定的资格（`buttonState` 来自 PATCH 内容；completed、waiting 与各结算态都有已注册的导出内容，运行中的黄/紫卡保持无按钮——点击才不会回退到上一 turn 的回复；按状态判定也把同为红模板的结算「已拒绝」与「执行失败」区分开）。⏹ 停止按钮离开结算卡：它的目标已经是决策后 turn 的新卡。
- 决策后卡片重启不动：决策后执行仍开新卡（[卡片重启笔记](2026-08-20-feishu-bridge-post-permission-card-restart.zh.md) 是承重设计），挂起卡保留挂起前段落的工具历史作为可见记录。
- 结算头不带 spinner 图标：`spinnerKeyForState` 把四个结算态按终态处理（与 completed/failed 同组），结算重渲染重建的卡没有 `header.icon`——转圈的「执行中」图标配在「已批准」旁会被读成仍在执行。waiting 保留执行指示：turn 挂在用户回答上时仍在途。

## Alternatives considered

- **复用同一张卡继续 PATCH 而非重启 surfaces。** 否决：重启会重置分阶段状态（`textParts`、`toolCount`），决策后执行从干净状态开始；复用会把挂起前卡片——连同携带全部旧条目的位移重发——拖过 plan 卡、权限卡、图片卡。
- **结算时删除挂起卡。** 否决：这张卡是挂起前段落的可见记录；删掉就丢了 plan 所依据的调研历史。
- **只结算 plan review。** 否决：权限审批与 AskUserQuestion 以同样方式挂起、滞留同样的冻结「等待中」卡；结算点是共享的，所有 ask 类型一起结算。

## Consequences

- 会话里不再有任何卡在 ask 已结算后仍宣称「等待中」；回翻记录读到的是已批准/已拒绝/已回答/已取消，带结算时间戳与挂起前工具数、不带运行中的转圈图标。
- 结算卡保留导出/回复按钮（已注册的挂起前回复仍可取回），且不带停止按钮。
- 挂起期间的用户停止现在留下终态灰色「已取消」卡，而不是孤立的蓝色等待卡（停止渲染本身仍因句柄已 detach 而 no-op）。
- 投递中断竞速（卡片还在发送途中停止落地的情形）可能错过结算——句柄在 `deliverCards` 内捕获，中断后它仍在后台运行；该罕见路径维持修复前的等待头。
- 无 `updateMessage` 的 stub 平台上的引擎测试看到的结算是 no-op；只有带预览记录能力的平台能观察到该 PATCH。

## Testing

`tests/engine/engine-m3-plan.spec.ts` `PlanReviewParkedCardSettle`（批准 → 挂起卡 PATCH 链 running→waiting→approved 且重启占位卡照常开出；拒绝 → rejected）；`tests/streaming.spec.ts` `settleParkedCard`（结果 PATCH 保留工具条目正文；未挂起时 no-op；二次结算幂等）与 `completeAndDetach(park)` 的句柄返回；`tests/feishu/card.spec.ts` 结算头渲染 turquoise/red/turquoise/grey 且永不绿色；`tests/feishu/spinner.spec.ts` 四个结算态渲染无头部图标而 waiting 保留执行指示；`tests/feishu/progress.spec.ts` 按状态的按钮资格（结算态保留两个按钮、failed 红保持无按钮）与结算模板隐藏停止按钮。包套件绿；包图 `tsc -b` 干净。
