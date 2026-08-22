# Agent Note: 计划卡标题剥离 cwd-slug 前缀

Status: implemented

[English](2026-08-22-feishu-bridge-plan-card-title-strips-cwd-slug.md) | 中文

## Problem

计划卡标题曾是 `计划·<计划文件 basename>`，而 basename 是 `<cwd-slug>-<标题slug>.md` —— [计划文件持久化](../../implemented/feature/2026-08-21-feishu-bridge-plan-file-persistence.zh.md) 把文件命名对齐 Claude Code，cwd slug 的职责是在同一个共享 plans 目录里区分项目。搬进聊天标题后，项目 workdir 的全路径 slug（如 `home-hm-workspace-cc-connect-`）以约 26 个字符的机器噪音开头，且零信息：一个飞书会话已绑定唯一的项目 workdir。该规则逐字继承自 Go `engine_send.go`，Go 里的同名 basename 来自 Claude Code 自己写的计划文件。

## Decision

卡片标题只保留标题部分。`planCardName`（`engine/plan-file.ts`）从计划文件 basename 去掉 `.md`、再去掉与当前会话 workdir 匹配的 `<cwd-slug>-` 前缀得到展示名；`sendPlanContent` 与 `sendInlinePlanContent`（`engine/engine.ts`）的卡片标题经它生成，传入 `planWorkDir()`。落盘文件名不变——cwd slug 仍然为共享 plans 目录去重。`-YYYYMMDD-HHMMSS` 修订后缀保留在标题里，共存的多个修订在聊天中仍可区分；不以 workdir slug 开头的 basename（worktree 会话里模型自写的计划文件）原样返回。这是对 Go parity 的一处刻意分歧，记录于 `docs/MIGRATION.md`。

## Alternatives considered

**保留 Go parity 的 basename 标题。** 落选：parity 是迁移的手段而非目标；在已绑定项目的聊天里该前缀是零信息噪音，需要定位文件的人点一下导出按钮就能拿到完整文件名。

**直接从计划正文标题取标题（对卡片正文跑 `extractMarkdownTitle`）。** 落选：同一个标题出现两条会漂移的推导（文件名 vs 卡片标题），且当卡片来自 `-YYYYMMDD-HHMMSS` 文件时，修订后缀会从标题里消失。

## Consequences

代价：卡片标题不再等于落盘 basename，仅凭标题无法定位文件；TS bridge 在这一个字符串上与 Go `engine_send.go` 不同。收益：计划卡直接读出计划主题；worktree 会话的标题保留有区分度的 workdir slug，而不是被一次不匹配的剥离丢掉。

## Testing

`tests/engine/plan-file.spec.ts`：`planCardName` 前缀剥离、时间戳后缀保留、前缀不匹配三类用例；经 stub 卡片平台断言 `sendPlanContent` 与 `sendInlinePlanContent` 的卡片标题，含无文件路径时的通用 `计划` 标题。
