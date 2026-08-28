# Agent Note: feishu-bridge 权限解决后的预览卡重启

Status: implemented

[English](2026-08-20-feishu-bridge-post-permission-card-restart.md) | 中文

## Problem

Go 的交互事件循环把 pending permission 视为两步的阶段边界。权限卡发出时（core/engine_events.go ~4192-4225）：从活卡上剥掉已流式输出的 plan 文本（`sp.removeText`）、仅在预览降级时把累积文本段以纯消息发出（无论是否发出都推进 `segmentStart`）、随后在**用户回答之前**就终结并 detach 活卡。解决后（`pending.Resolved` 之后的块）：flush 剩余文本段、detach 仍处启动态的预览、新建 streamPreview 与 compactProgressWriter、重绑 active preview、预建执行阶段占位卡——「后续执行信息出现在新消息里，而不是追加到交互前的卡上」。TS 对 `permission_request` 分支的移植（src/engine/engine.ts）两半都没有：只保留了 `textParts`/`segmentStart`/`silentHold` 重置。症状：用户批准 ExitPlanMode plan 卡后，批准后的工具进度继续 PATCH plan 之前的旧进度卡，而不是开新卡。

## Decision

保形移植 Go 权限处理的两个半边。**权限卡发出时**（Go engine_events.go ~4192-4225）：剥离活卡上的 plan 流式文本（`sp.removeText`）、预览降级时才以纯消息 flush 累积文本段（`segmentStart` 无论如何都推进）、`barrier()` + `sp.completeAndDetach()`——活卡在用户回答之前就被终结，投机性 reply 渲染在 detach 前捕获快照（触发条件补上 `!session.shouldSuppressAutoRender()`）。**解决后**（`pending.Resolved` 之后的块）：flush 剩余文本段、仍处启动态的预览则 detach、重赋 `sp`/`cp`（均改为 `let`）、重绑 active preview、同步 `state.preview`，`display.toolProgress` 开启时展示新占位卡；`toolCount` 一并重置。解决后的 detach 在正常流程里是兜底——权限卡时的 detach 已经找到并终结了活卡；该块覆盖此路径上的所有权限解决——plan 审批、普通工具审批与 AskUserQuestion 回答一视同仁，与 Go 一致。自 2026-08-25 起，重启仅在提问以用户决定收场时执行：stopped/aborted 结局（会话拆除或回收）跳过重启，否则占位卡会滞留一张永远无人收尾的运行卡（[stray-card note](2026-08-25-feishu-bridge-done-during-parked-ask-stray-card.zh.md)）。

## Alternatives considered

**只换 compact writer（`cp`）。** 否决：tool-progress 模式下占位卡与工具进度条目都在 `sp` 的卡上；两个 writer 共同持有交互前的卡，只换一个会让另一个继续 PATCH 旧消息。

**用 `cp.finalize('completed')` 代替 detach。** 否决：finalize 只 PATCH 终态但保留句柄，后续 append 仍会打到交互前的卡。

**只在解决后 detach。** 本修复的第一版正是如此；真机冒烟随即暴露：批准与新进度卡之间会把交互前累积文本 flush 成一张独立普通卡，重复完成卡上已有的文本。Go 在权限卡发出时就 detach 并推进 `segmentStart`，解决后的 flush 因此通常为空——这个顺序才是真正的承重半边。

## Consequences

权限卡（或 AskUserQuestion 卡）发出时，活进度卡当场终结（自 2026-08-28 起转蓝显示「等待中」——turn 仍在等用户，见[挂起追问上限豁免笔记](2026-08-28-feishu-bridge-parked-ask-cap-exemption-waiting-card.zh.md)；导出按钮从捕获快照起即可用）；批准后的执行开新占位卡继续。预览活跃时交互前文本留在完成卡上——只有预览降级才以纯消息重发，与 Go 一致。Go 在批准时归档 plan 文件的机制（`pendingPlanArchive`，批准时带时间戳后缀复制）未随本次移植——记为独立的迁移缺口。

## Testing

`tests/engine/engine-m3-permission.spec.ts` `PostPermissionCardRestart`：text → tool_use → write 权限 → resolve → tool_use → result，对着支持预览的 stub 平台；断言两次 preview start（turn 入口占位卡 + 批准后占位卡）、批准后进度 PATCH 只落新句柄、权限卡发出后旧卡不再收到任何更新（卡前 detach）、预览活跃时交互前文本不以纯消息重发。包内 1844 测试全绿、oxlint/typecheck 0。真机冒烟（2026-08-20 开发虾群）：plan 卡出现的瞬间工具进度卡即转绿；批准后执行直接开新进度卡、中间无多余普通文本卡；plan 磁盘执行正确。
