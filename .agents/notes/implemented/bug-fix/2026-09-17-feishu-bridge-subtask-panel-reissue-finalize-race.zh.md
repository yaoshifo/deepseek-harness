# Agent Note: 迟到的子任务面板重发不得删除已终局的卡片

Status: implemented

[English](2026-09-17-feishu-bridge-subtask-panel-reissue-finalize-race.md) | 中文

## Problem

跟随尾部重发（[feature note](../feature/2026-09-17-feishu-bridge-subtask-panel-follow-tail.zh.md)）与面板终局互为异步，双方都无法观察对方的进度：

- 终局——刷新 tick 的零行分支与 `/done` 的 `clearSubtaskPanel`——先发终态 PATCH，等它落地后才撤下面板登记（`clearInterval` + `subtaskPanels.delete`）。
- 重发的 resolve 回调无条件执行：`panel.handle = handle`，随后 `deletePreviewMessage(old)`。

于是，重发 send 在终态 PATCH 在途期间 resolve 时，回调看到 map 条目仍在，删掉正接收终态内容的卡片，留下刚发出的运行卡作为面板唯一的幸存者——所有子任务已汇报之后，聊天里永久显示「后台子任务 · N 个运行中」，且没有任何 map 条目或 timer 留下来纠正它。reject 侧有镜像缺陷：兜底 PATCH 把运行态内容写上刚取得终态的卡片。

## Decision

终局同步撤登记；重发回调在落定时校验面板身份：

- **先撤登记、终态 PATCH 后发**（`refreshSubtaskPanel`、`clearSubtaskPanel`）：`clearInterval(panel.timer)` + `subtaskPanels.delete(parentKey)` + activity forget 在作出终局决定时同步执行；终态 PATCH 随后 fire-and-forget 发到撤登记前捕获的句柄。tick 的 map 守卫天然挡住后续 tick，死卡 catch 路径随之简化为 warn——任何 timer 或 map 条目都不可能活过决定终局的那次 tick。
- **代际守卫**（`reissueSubtaskPanel`，两个回调）：`this.subtaskPanels.get(parentKey) !== panel`——即 `stopInteractiveSession` 应对同类竞态的精确条目比对——表示 send 在途期间面板已终局。resolve 侧删除刚落地的运行卡（它是面板孤儿），不写 `panel.handle`、不写 `placedAtMs`、不打 reissued 日志；reject 侧跳过兜底 PATCH，运行态内容绝不落到终态卡上。
- 清理平台在发起时捕获：`reissueSubtaskPanel` 接收调用方的平台（tick 里解析出的平台，或 reclaim 的 report-capable 平台），闭包持有其 `asPreviewCleaner` 视图，而非回调内重新解析 `reportCapablePlatform() ?? platforms[0]`。卡片发送与删除走同一平台，即使 report-capable 集合在途中变化。

## Alternatives considered

- **等终态 PATCH 落地再撤登记，维持原顺序。** 暴露窗口被拉长而非关闭：await 期间任何重发 resolve 仍会删掉终态卡。否决。
- **在面板状态上加 `finalizing` 标志供重发回调轮询。** 给两态对象引入第三态，而 map 身份已表达同一事实；精确条目比对是本引擎处理并发拆除竞态的既定模式。否决。
- **让迟到的重发获胜，把终态内容 PATCH 到新卡上。** 每次终局多一次终态 PATCH，且存在运行态内容占据尾部的窗口；删除孤儿卡是一次操作，并让终态卡留在用户最后看到的位置。否决。

## Consequences

- 定稿卡一定活过自己的终局：之后落地的重发只移除自己的卡。可见代价是一张在尾部出现、又在 send-to-resolve 窗口内消失的卡（罕见——需要位移与终局同落在该窗口内）。
- 两条终局路径统一为一种顺序——先撤登记，再 fire-and-forget 终态 PATCH——此前 tick 路径要等 PATCH 落地才清理（`clearSubtaskPanel` 本就先撤登记）。
- 终态 PATCH 失败（卡片被撤回、聊天被删）不留下 map 条目与 timer；warn 日志是唯一痕迹。
- send 比面板活得久的重发不再在回调内重新解析平台，report-capable 集合的途中变化不会把卡片发送与其清理拆到两个平台上。

## Tests

`tests/engine/subtask-panel.spec.ts` `panel reissue vs finalization race` 用可控延迟的 `sendCardWithHandle` / `updateCardWithHandle` stub 驱动四组交错：重发在终态 PATCH 落地之后 resolve、在已撤登记而 PATCH 在途的窗口内 resolve（最紧交错）、在终局之前 resolve（守卫不过火的钉子——被重发的卡才是终局的那张）、以及迟到的失败兜底。每组断言哪个句柄承载终态内容、哪个句柄被删、`subtaskPanels` 无残留条目、后续 tick 不再 PATCH。
