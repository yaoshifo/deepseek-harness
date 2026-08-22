# Agent Note: 迁移完整性审计与低垂接线批次

Status: implemented

[English](2026-08-21-feishu-bridge-audit-wiring.md) | 中文

## Problem

用户要求以代码级方式核实 cc-connect → dsh-feishu-bridge 的迁移是否真的完成，而不是相信 FEATURE-PARITY 的「51 ✅ / 10 ✂️」。对照只读 Go 仓库的三路审计（命令清单 / 配置与装配键 / 非命令能力面）在已跟踪的 M8 遗留之外查出四类缺口：两行假 ✅（#20 restrict_to_workdir 声称由 D3 setup 钩子的 restrict() 承担，而 TS 全库不存在该通路；#35a 表情链在平台层已移植、但引擎从不调用 `startTyping`）、一笔安全相关的 B 类接线丢失（`allow_from` 在 `platform.ts` 已实现、却从配置不可达）、另外八个「已实现但不可配置」的平台选项键、M0 移植后从未接线的入站 `RateLimiter`（无洪泛防护，仅 `queue.maxDepth` 兜深度）、以及慢滴流回合无墙钟上限（idle 型 stall 检测只在事件停止到达时触发）。

## Decision

**接线批次（全部落地）：**

- `feishu.allowFrom/groupOnly/shareSessionInChannel/threadIsolation/replyToTrigger/respondToAtEveryoneAndHere/enableFeishuCard/progressStyle/activeTagName` 进入 Config schema 与装配转发。`replyToTrigger` 映射到取反的平台旗标（仅显式 false 时 `noReplyToTrigger: true`，Go 默认 true）；`enableFeishuCard` → `useInteractiveCard`；`activeTagName` → `activeTagOverride`。未设键保持 undefined，平台默认值照常生效。
- 入站限流：`config.rateLimit`（装配时按 Go wire.go 默认恒定启用 20 条/60 秒；`maxMessages: 0` 关闭）→ `engine.setRateLimitCfg` → `checkRateLimit`（sessionKey 键，Go legacy 路径；`[users]` 角色路径为既有裁定裁剪）→ 挂进 `handleMessage` 内容合并之后、permission/chatroom 路由之前（Go engine.go:2470 的位置），回复此前为死键的 `rate_limited` i18n 文案。
- 绝对回合上限：`display.absoluteTurnTimeoutSecs`（未设 = 2× idle、0 关闭）→ `absoluteTurnMax` → **3× 硬上限在事件到达时**于 `processInteractiveEvents` 强制执行，用此前为死键的 `watchdog_reset` 文案收尾。到达时执行是有意的 TS 形态：事件循环没有可轮询的 watchdog 协程，而慢滴流恰是「事件不断到达」的情形；安静情形已由 stall-retry 路径（TS 的设计主路径；Go 的 watchdog 本就只是 backstop）接管。research 会话经保形的 `isResearchSession` 谓词（assistant 旗标或 research-hub 角色）豁免。时钟**按轮计量**：排队消息接管时重置（对 Go per-run 时钟的有意偏离，见[看门狗按轮重置 note](../bug-fix/2026-08-21-feishu-bridge-watchdog-per-turn-reset.zh.md)）；stall-retry 路径不重置。
- 三处别名缺口：`dir` 补 chdir/workdir、`hint` 补 ht、`compress` 补 compact（后者原先完全不可达——TS 前缀匹配要求 ≥2 字符且 "compact" 不是 "compress" 的前缀）。

**有意不接：** `resolve_mentions`（属未移植的 mention-resolution 能力）与 `stream_preview.partial`（Go 仅用它驱动 claudecode 的 `--include-partial-messages`；dsh 适配器事件流无此区分——暴露它就是死旋钮，违反 no-dead-tunables 规则）。

**用户裁定（2026-08-21）：** 此前 19 条无裁定缺失命令为有意筛选——设计上不迁（`/tts` 另待语音能力面裁定）。记入 README Known Limitations 与 MIGRATION.md 补充 16；builtinCommands 基数修正 52 → 53，`/skills` 记为文档笔误（Go 无此命令）。

**文档修正：** FEATURE-PARITY #20 改 📋（M8 裁定），#35a 注记改为表情链的真实状态，OPERATIONS.md 过时的 language/mode TODO 改为真实映射，README 的 reply_footer 限制更新为真实状态（M7-b 已接线；仅余额段待 adapter 生长）。

## Alternatives considered

**整体移植 Go 的 watchdog 协程（四分之一周期轮询 + decideWatchdog 裁决）。** 否决：TS 事件循环的结构下，轮询循环会成为 turn 状态的第二真相源；「到达时硬上限检查 + 既有 stall-retry 路径」覆盖了 Go 两个有意义的裁决（soft-cap-quiet 收敛进 stall 路径，hard-cap 才是真正缺失的那个）。

**为了配置对等仍然暴露 `stream_preview.partial`。** 否决：无消费方的配置键正是仓库禁止的 misconfiguration-fails-loud 违例。

## Consequences

生产在零 profile 改动下获得洪泛防护与慢滴流兜底（Go 默认值直接生效）。审计的 P2 清单——语音消息转写（当前入站 audio 被丢弃；旧生产配置启用了 `[speech]`）、失败分类+脱敏、`[hooks]`、评论会话驱动、`[references]`、两个 embedded skills（feishu-search / lark-guide）、lark_skills 同步、sessions_tui / feishu setup 向导、heartbeat / skill_presets、#35a 表情链、restrict_to_workdir（#20）——当日由用户裁定全部不迁；每笔裁剪已记入 README Known Limitations、FEATURE-PARITY（#20 → ✂️）与 MIGRATION.md 补充 16。审计另确认 Go 的子代理事件泄漏修复（9323dd8d）在 TS 已由适配器的 session id + lineage 路由结构性解决。

## Testing

`tests/assembly-config.spec.ts`：平台选项转发（取值、默认、取反的 replyToTrigger）、限流接线含 20/60 默认与 0 关闭、绝对上限接线含 2× 回退。`tests/engine/engine-events.spec.ts`：第三条消息被限流丢弃（忙会话排队形态）、无限制器默认放行、absoluteTurnMax 默认值、isResearchSession 谓词、400ms idle 下 150ms 滴流的硬上限击杀、research 豁免越过上限存活。别名覆盖随既有 matchPrefix 与 compress 解析器测试。
