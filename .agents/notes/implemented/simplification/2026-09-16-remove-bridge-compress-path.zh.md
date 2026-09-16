# Agent Note: 移除 bridge 层压缩路径

Status: implemented

[English](2026-09-16-remove-bridge-compress-path.md) | 中文

## Problem

bridge 携带两条压缩面：`autoCompress` 配置（投影占用过线即自动压缩）与手动 `/compress` 命令。dev 服务器自迁移起配置 `autoCompress {maxTokens: 100k}`，2026-09-07 估算器修正后阈值变得可测、100k 对 1M 窗口过于激进——按裁定移除该配置、防线统一到核心层（`compaction-basic`，0.8 阈值自动开）；Mac 从未配置。`/compress` 在 21 天会话日志（2.4 GB、双 bot）中零次打字调用。

## Decision

bridge 不再自带压缩路径：删 `autoCompress` 配置键与装配、回合末触发块、`/compress` 及 `compact` 别名、`runCompress`、`SessionCompressor` 能力面与 adapter 的 `compress()`（bridge 唯一的 `compactNow` 调用方）、`projectedContextTokens`（触发块的占用读数）、五条 i18n 键。残留 `autoCompress` 键在装配时报错并给出删除指引（progressStyle 守卫同类）。`compactionCount` 保留：agent 会话的原生 `compaction` 事件仍是其写入方，继续供状态页脚「N zip」段。

## Alternatives considered

**保留 `/compress` 作手动逃生门。** 三周日志零使用；核心层已持有压缩。

**为无核心层的部署保留 `autoCompress`。** 两个部署都跑 `compaction-basic`；为一个假想部署携带第二套曾失准的触发器，正是本次移除偿付的投机泛化成本。

## Consequences

核心层压缩是唯一的上下文压力防线；撤掉它的部署将完全失去自动压缩。上下文压力仍可观测：/context 卡的投影概览读的就是触发块曾用的同一 token-meter 源。
