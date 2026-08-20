# Agent Note：/dir 选择卡片与 act:/nav: 卡片动作前缀

Status: implemented

[English](2026-08-20-feishu-bridge-dir-card.md) | 中文

## Problem

feishu-bridge 的 `/dir` 命令此前只有纯文本形态，而 Go 原版（`engine_cmd_workspace.go`）渲染的是交互式选择卡片：分页历史行（`act:/dir select N` 按钮）、`act:/dir reset`/`act:/dir prev` 动作、`nav:/dir N` 翻页按钮。两个路由缺口阻塞了任何移植。其一，`handleCardAction` 对所有动作统一 `slice('act:'.length)` 剥前缀，无法区分 `act:` 值（先执行副作用再重渲染）与 `nav:` 值（仅重渲染）——Go 的 `handleCardNav` 按第一个冒号拆分，且只对 `act` 前缀执行 `executeCardAction`。其二，Feishu 平台只把 `act:` 前缀的值 dispatch 为卡片动作，`nav:` 被静默丢弃——这是一个存量死按钮：M4 cron 卡片的返回按钮 value 就是 `nav:/help`，从未生效过。

## Decision

`src/engine/dir-card.ts` 以纯渲染函数移植 `renderDirCard`/`renderDirCardSafe`（rune 级 56→53+省略号路径截断、每页 5 条、当前目录 primary 按钮、历史 ≥2 才出现 prev 按钮、仅分页时渲染页码 note）。`cmdDir` 在支持卡片的平台上发卡片——无参数列表和 `dirApply` 成功后都走卡片路径（后者带 `dir_session_reset` notice）——纯文本路径保留为 fallback。`handleCardAction` 改为按第一个冒号拆分动作值，只接受 `act`/`nav` 前缀，并处理 `/dir`：`act` 把 `select N`/`reset`/`prev` 映射到 `dirApply`（为此 export 了 `commandContext`）后重渲染第 1 页并带 notice；`nav` 仅解析页码、无副作用。两条路径都经 `asCardRefresher` 原位 PATCH 按下的卡片，失败时退回发新卡。`supportsCards` 从 `cron-commands.ts` 的私有函数移到 `core/types.ts` 的 `asCardSender` 旁，避免 `commands.ts ↔ cron-commands.ts` 的 import 环。

两个刻意的裁剪。`/dir` 卡片不带 Go 的 `cardBackButton()`：其 `nav:/help` 目标没有 handler，带上只会多一个死按钮；代码注释注明随 help 卡里程碑补回。`/cron` 分支改为仅 `act` 前缀执行副作用——今天可观察行为不变（不存在 `nav:/cron` 按钮），但让前缀语义统一：副作用从不在 `nav:` 上执行。

## Alternatives considered

**对任意动作剥掉 `act:` 来路由 `nav:`。** 否决：`slice('act:'.length)` 作用于 `nav:/dir 2` 恰好得到 `/dir 2`，但若某个 `nav:` 命令同时存在 `act:` 形态，翻页就会静默执行副作用，而 `nav:/help` 能切出 `/help` 只是前缀长度相同的巧合。

**同一次改动里移植 `renderHelpGroupCard`。** 否决：Go 的 help 卡是数十张 `nav:` 卡片（`engine_cmd_misc.go`）的导航枢纽，各自是独立的渲染域；捆绑进来会让 diff 和审查面失控。inert 的 `nav:/help` 按钮改记入 README 的 Known Limitations。

**把 `supportsCards` 留在 `cron-commands.ts` 由 `commands.ts` 导入。** 否决：`cron-commands.ts` 已经从 `commands.ts` 导入 `isAdmin`，反向导入会闭合一个 import 环；这个谓词本来就该挨着它包装的 `asCardSender` 能力判定。

## Consequences

live profile 配置 `dirScanPaths` 后，`/dir` 与 `/sp -d` 的裸名解析即恢复（纯配置缺口；代码自 M7-d 起已完整）。点击 cron 卡片返回按钮现在会打 "no handler" 日志而非凭空消失——是噪音，但如实提示 help 卡域缺失。未来遵循 Go `handleCardNav` switch 的卡片族都复用这个前缀拆分；新增 `nav:` 命令只需要一个重渲染分支，不需要副作用守卫。daemon 重启后遗留的旧 `/dir` 卡片在下一次 `/dir` 时正常重渲染（页码状态在按钮 value 里，不在服务端）。

## Testing

`tests/engine/dir-card.spec.ts` 钉死卡片结构（header 颜色、行的 value/type、当前目录 primary、分页钳制、空历史 note 且保留 reset 按钮、rune 边界截断、override 优先级、错误 fallback）。`tests/engine/commands.spec.ts` 覆盖 `cmdDir` 卡片路径与纯文本 fallback；`tests/engine/engine-card-action.spec.ts` 覆盖前缀拆分、`select`/`reset`/`prev`→`dirApply` 映射、非法序号时无 notice 重渲染、`nav:` 翻页无副作用、PATCH 失败 fallback、未知 `nav:` 的静默消费；`tests/feishu/card-action.spec.ts` 覆盖平台侧 `nav:` dispatch。真机点击（README 已知的回调测试局限）由冒烟覆盖。
