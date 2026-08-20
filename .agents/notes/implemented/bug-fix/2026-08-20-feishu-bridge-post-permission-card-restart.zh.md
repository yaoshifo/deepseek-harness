# Agent Note: feishu-bridge 权限解决后的预览卡重启

Status: implemented

[English](2026-08-20-feishu-bridge-post-permission-card-restart.md) | 中文

## Problem

Go 的交互事件循环（core/engine_events.go，`pending.Resolved` 之后的块）把每次解决 pending permission 的用户交互视为阶段边界：把未 flush 的文本段以纯消息发出、终结并 detach 交互前的流式卡、新建 streamPreview 与 compactProgressWriter、重绑 active preview、预建执行阶段占位卡——「后续执行信息出现在新消息里，而不是追加到交互前的卡上」。TS 对 `permission_request` 分支的移植（src/engine/engine.ts）只保留了 `textParts`/`segmentStart`/`silentHold` 重置：`sp`/`cp` 沿用旧句柄，于是用户批准 ExitPlanMode plan 卡后，批准后的工具进度继续 PATCH plan 之前的旧进度卡，而不是开新卡。

## Decision

在 `processInteractiveEvents` 的权限解决点保形移植该块：已启动的预览先以分段平台消息 flush `textParts[segmentStart:]`，再 `sp.completeAndDetach()`；随后重赋 `sp`/`cp`（均改为 `let`）、重绑 active preview、同步 `state.preview`，`display.toolProgress` 开启时展示新占位卡。`toolCount` 一并重置。该块覆盖此路径上的所有权限解决——plan 审批、普通工具审批与 AskUserQuestion 回答一视同仁，与 Go 一致。

## Alternatives considered

**只换 compact writer（`cp`）。** 否决：tool-progress 模式下占位卡与工具进度条目都在 `sp` 的卡上；两个 writer 共同持有交互前的卡，只换一个会让另一个继续 PATCH 旧消息。

**用 `cp.finalize('completed')` 代替 detach。** 否决：finalize 只 PATCH 终态但保留句柄，后续 append 仍会打到交互前的卡。

## Consequences

每次 turn 中途的权限交互现在把 turn 的卡片在交互点一分为二：交互前的卡被终结（转绿），执行在新卡上继续并带新占位卡。交互前未 flush 的文本段在旧卡 detach 前以纯消息投递，plan 卡之前的引导文本不会丢失。Go 在批准时归档 plan 文件的机制（`pendingPlanArchive`，批准时带时间戳后缀复制）未随本次移植——记为独立的迁移缺口。

## Testing

`tests/engine/engine-m3-permission.spec.ts` `PostPermissionCardRestart`：tool_use → write 权限 → resolve → tool_use → result，对着支持预览的 stub 平台；断言两次 preview start（turn 入口占位卡 + 批准后占位卡），且批准后的进度 PATCH 只落在新句柄上。包内 1844 测试全绿、oxlint/typecheck 0。真机验证：观察 plan 模式下 plan 卡之前有工具进度的 turn——批准后执行必须开新进度卡。
