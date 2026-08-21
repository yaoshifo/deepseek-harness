# Agent Note: feishu-bridge quiet 模式误杀流式「思考中」header

Status: implemented

[English](2026-08-21-feishu-bridge-quiet-thinking-header.md) | 中文

## Problem

live profile（项目「开发虾」，`features.quiet: true`）下，dsh agent 在工具调用间隙推理时，tool 进度卡片从不显示「思考中」header——整轮停在「执行中」（黄色）。相同 quiet 配置（`thinking_messages = false` + `tool_progress = true`）的 Go cc-connect 是显示的。迁移时的门控宽了一个条件：`engine.ts` 的 `case 'thinking_delta'` 把 `sp.appendThinking(...)` 挡在 `this.display.thinkingMessages` 后面，`thinkingText` 恒为空，`streaming.ts` 的 `buildProgressDisplayLocked` 永远不会发出 `__cc_state__:thinking`。cc-connect 的 `EventThinkingDelta`（`core/engine_events.go:4022`）没有这道门——它的 quiet 模式只抑制思考「消息」，从不抑制流式 💭 区块和状态头。同一批迁移还丢了两个相邻的安全网：`EventThinking` 在 `!ThinkingMessages` 分支之前就调用 `clearThinking`（`engine_events.go:3696`），`EventToolUse` 在工具开始时清除流式思考态（`engine_events.go:3781`）。

## Decision

quiet 模式继续抑制思考消息，但不再抑制流式预览，对齐 Go：`thinking_delta` 只要 `sp.canPreview()` 就写入 💭 区块；`case 'thinking'` 把 `clearThinking` 提到 quiet 早退之前（早退里跳过 `completeAndDetach` 与 segment flush 的行为保留——那半边修的是真实的重复回复回归，且与 Go `tool_progress` 下保持卡片存活一致）；`case 'tool_use'` 补上 Go 安全网——工具开始即清除思考态并重置 `thinkingAccum`——只发 delta、不发完整 thinking 块的 agent 不会把 header 卡死在「思考中」。`cp.appendEvent('thinking', ...)` 消息路径保留 `thinkingMessages` 门控；那半边才是正确的 Go 对位。

## Alternatives considered

**改由完整 `thinking` 块设置 header。** 不流式 delta 的 agent 会有 header 无正文；Go 的状态完全由 delta 驱动的 `thinkingText` 派生，且 dsh harness 流式发送 `reasoning-delta` chunk（`agent-dsh/adapter.ts` 已映射），delta 驱动既是对位形态也是真机形态。Go 为无 delta agent 准备的单行 "Thinking" 进度条目仍未移植——见下。

## Consequences

quiet 模式下卡片 header 随模型的推理/执行阶段切换 执行中 → 思考中 → 执行中，与 cc-connect 一致。已知未移植缺口（有意为之）：cc-connect 的 quiet 模式在 thinking 块未经 delta 流式直达时还会补一行 `Thinking` 进度条目（`engine_events.go:3704`，`formatThinkingProgressLine`）；TS 版没有等价物——只影响不发 delta 直接发完整块的 agent，dsh 路径不受影响。

## Testing

`tests/engine/engine-events.spec.ts` `quiet-mode thinking preview (cc-connect parity)`：在 `thinkingMessages: false` + `toolProgress: true` 下三个用例——delta 设置 `__cc_state__:thinking`、完整块清除（无 💭 残留、不发思考消息）、新工具调用清除。驱动器按 `progressFlushInterval`（300ms）间隔分批推事件，让被节流的 header PATCH 在回合中途落地，与真实多秒思考的时序一致。整包 1977 个测试全绿。
