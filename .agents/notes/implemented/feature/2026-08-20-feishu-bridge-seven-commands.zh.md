# Agent Note：再迁七条 cc-connect 命令——/tag /untag /undone /notify /board /help /ps

Status: implemented

[English](2026-08-20-feishu-bridge-seven-commands.md) | 中文

## Problem

`/shell` 落地后，命令清单 diff 仍显示 Go 52 条 builtin 命令中约 34 条未迁移。用户从按时间排序的多选卡（Go 仓库中最近改动的七条）中选中：`/tag`、`/untag`、`/undone`、`/notify`、`/board`、`/help`、`/ps`。其中 FEATURE-PARITY #38 原记「跳转/notify/board 完成」并不属实——只有 spawn 时的通知卡存在，`/notify` 与 `/board` 命令本体从未注册；`/help` 未注册，而随迁的 `message_help` 静态大段却在宣传几十条不存在的命令。

## Decision

两个按域模块，都沿用合并进既有命令表的注册模式：

**`src/engine/spawn-family-commands.ts`** 保形移植 Go `cmdTag`/`cmdUntag`/`cmdUndone`/`cmdNotify`/`cmdDashboard`。标签轴与头像轴保持独立：`/tag`/`/untag` 只动 ❤️ 标签（成功仅打 reaction 无文本回复），`/undone` 恢复彩色头像并把 spawned 注册表翻回 active——与 `/done` 的置灰对称。`/notify` 经既有 `spawnJumpMarkdown` + `buildSpawnNotifyCard` 助手重发 spawn 就绪卡，含无子群兜底注记与清零的 usage 页脚。`/board` 只展示当前群的任务子树：聚合全部平台的 `listActiveSpawnedChats`、从 `sessionKeyMap` 推 parent→child 链、`familyChats` 上溯最顶层 spawn 祖先后收整棵子树，树以折叠面板下的群链接渲染、当前群标 ←。

**`src/engine/misc-commands.ts`** 移植 `/help` 与 `/ps`。`/help` 有意偏离 Go：命令列表**动态生成**自 `e.commandHandlers` 键 × 各命令的 i18n 单行描述（加 provider 快捷行与前缀提示），`/help <cmd>` 经命令 resolver 解析到 `<cmd>_usage` i18n 键、缺失时回退单行描述。Go 的 `message_help` 静态大段、六个 `help_*_section` 条目、按钮式 help 卡族（`renderHelpGroupCard` + `nav:` 导航）删除不迁——手工维护的大段正是漂移出「宣传不存在命令」的机制本身。`/ps` 保形三分支：agent 空闲→剥前缀穿透为普通消息（handler 返回 false）；turn 中→直发 `agentSession.send` 加 Done reaction；turn 中且阻塞在权限审批→改排队为下一轮（直接写入会被 CLI 输入队列吞掉）。turn 中的投递现改走 agent-loop steer，见 [2026-08-21-feishu-bridge-ps-steer](2026-08-21-feishu-bridge-ps-steer.zh.md)。

## Alternatives considered

**移植 Go 的 help 卡族（逐命令导航按钮）。** 否决：`nav:` help 导航已记录为不移植（cron 卡返回按钮），且生成列表的按钮镜像会随每次未来命令增补变成需同步维护的面；`sendAsCard` 的 markdown 卡已覆盖发现需求。

**移植 dashboard 完成按钮快照机制（dashboardCardState、灰化行、原地刷新）。** 否决：现行 Go `renderDashboardTree` 只渲染链接——快照的 `done` map 在渲染路径无消费方——迁过来就是死代码。

## Consequences

命令数从 19 升至 26。`/help` 不再可能说谎：它列出的就是引擎注册的命令，凡有单行翻译的语言都成立。剩余缺口是约 27 条无逐条裁定的命令（`/whoami`、`/history`、`/current`、`/search`、`/delete`、`/name`、`/memory`、`/model`、`/reasoning`、`/mode`、`/lang`、`/quiet`、`/tts`、`/allow`、`/skills`、`/config`、`/show`、`/diff` 等），记入 README Known Limitations 待 M8 裁定；`/usage`、`/web`、`/upgrade`、`/restart`、`/doctor`、`/version`、`/workspace` 维持既有裁剪裁定。FEATURE-PARITY #38 已修正为命令面于 2026-08-20 落地。

## Testing

`tests/engine/spawn-family-commands.spec.ts`（14 例）：tag/untag/undone 能力路径与 reaction/错误回复、notify 在子群/父群/纯文本平台三种形态、board 家族树与当前标记、空与不在树提示、别名/前缀解析、注册合并/dispose。`tests/engine/misc-commands.spec.ts`（10 例）：生成的 help 列表排除未迁移命令、逐命令 usage 与单行回退、未知命令 hint、/ps 空参/turn 中/阻塞/空闲穿透、阻塞时排队。树与面包屑断言读卡片元素树——折叠面板无文本降级。
