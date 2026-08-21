# Agent Note: wiring the todo-list tool into feishu-bridge progress cards

Status: implemented

[English](2026-08-20-feishu-bridge-todo-write-progress-section.md) | 中文

## Problem

dsh agent 会调用 `todo_write`(packages/todo/tool-todo),但 feishu-bridge 的工具进度卡片从不显示置顶待办区。三个叠加的缺口:(1) `StreamPreview.updateTodoSection` 和 `CompactProgressWriter.setTodos` 在 M2 Go 移植中落地后一直没有生产调用方(只有测试直接调用),因此没有任何代码把 todo 工具调用解析成卡片的 todo items;(2) 逐条渲染的兜底 `isTodoWriteToolName` 只匹配 Claude 风格的 `TodoWrite`,不匹配 dsh 的 `todo_write`;(3) 真机冒烟又暴露了 queued 跟进轮的两个缺陷——消息在运行中的轮次后面排队、由队列接管的新 turn 连工具进度都不渲染(不只是待办区)。用 scratchpad 脚本直接驱动源码 Engine 复现确认了两者:上一轮的收尾会把复用的 `StreamPreview` 置为降态(`canPreview()` 为 false,所有 append 被跳过);队列接管分支对 channel 的重复 re-arm 把同一迭代早前挂起的 receive waiter 孤儿化,该孤儿随后偷走接管轮的第一个事件(冒烟中正是 `todo_write` 的 tool_use 本身)。

## Decision

engine 的 `tool_use` 分支(src/engine/engine.ts)按工具名识别 todo 工具,解析工具输入并喂给两个 writer:`sp.updateTodoSection(items)`(flush 流式卡片的置顶区)与 `cp.setTodos(items)`(随下一次 payload PATCH 重建——tool result 必然触发)。共享 helper 放在 src/progress.ts 中 `TodoItem` 旁边:`isTodoToolName` 规范化下划线与大小写,`todo_write`/`TodoWrite`/`todowrite` 都匹配;`parseTodoItems` 对非 todo 形状的输入返回 `undefined`(engine 保留上一份清单),对空列表返回 `[]`(engine 清空该区)。src/feishu/progress.ts 的 `formatTodoWriteInput` 改为通过 `parseTodoItems` 解析,因此 V2 卡片的逐条渲染对两种工具名都显示带状态图标的清单。

queued 轮的修复在 engine 的 in-loop queued arm 有两半。一是镜像 post-permission restart 重建 `sp`/`cp` 并重绑 active preview、开新占位卡:结果处理的每个终态分支都已终结旧卡,而降态 preview 会静默丢弃跟进轮的工具进度、只把最终回复 PATCH 到旧卡上。二是不再对 `recvP` 重复 re-arm:循环在每次收到事件后的迭代顶部只挂一个 receive,再挂第二个就把前一个 waiter 孤儿化——由于 `EventChannel.push` 按 FIFO 唤醒 waiter,孤儿会偷走接管轮第一个被推送的事件。switch 之前挂起的那个 receive 才是该保留的。

## Alternatives considered

**由 dsh adapter 把持久化的 `todo/write` 会话事件投影成新的 engine Event 类型。** 否决:它读取的是权威会话状态而非调用参数,但需要扩展 engine 的 Event union 并波及 stubs 与测试。engine 已有按工具名特判的先例(同一 `tool_use` 分支里 `Write` 的 plan 文件跟踪),按名检测是既有的扩展点。

**在 adapter 里解析并推送现成 items。** 否决:adapter 只做 wire 协议投影;它所喂给的表现层关注点属于 progress/渲染层。

**在 queued arm 里解除现有 `sp` 的降态而非重建。** 否决:终态卡会恢复接收 PATCH,让已完成(绿色)的卡为跟进轮复活;每个 queued 轮一张新卡,与消息在轮间到达时的渲染方式一致。

**在 queued arm 里加大 drain + re-arm 力度。** 否决:在每事件 arm 之后再 arm 都会注册两个 waiter;删掉多余的 receive 是唯一只有一个 waiter 的状态。

## Consequences

dsh agent 的 `todo_write` 调用现在会在执行中卡片(streaming 文本路径)与 V2 payload 卡片的 `📋 Task List` 区渲染置顶待办,每次调用整体替换,空列表清空;畸形输入保留上一份清单而非静默清空。queued 跟进轮打开自己的进度卡:工具条目、待办区与工具计数只描述当轮,该轮的第一个事件不再被丢弃;已完成轮的卡保持原样。区标题保持现状——V2 硬编码 `📋 Task List`,streaming 路径是无标题代码块;本地化不在本次范围。

## Testing

`tests/engine/engine-events.spec.ts` 的 `todo_write progress section`:用可捕获 preview 的 stub platform 驱动 `todo_write` tool_use 事件走 `processInteractiveEvents`;断言卡片最后一次更新包含状态图标行,且空列表调用会清空。queued 跟进测试通过 `queueMessageForBusySession` 入队消息,驱动 turn 1(bash)到完成,再从 session 的 send 钩子异步推送 turn 2 的事件(queued arm 在 send 前 drain,真实 adapter 异步推送)——断言出现第二张 preview 卡、卡上有待办行与最终回复、且 turn 1 的条目不泄漏。`tests/progress-compact.spec.ts` 覆盖 `isTodoToolName`/`parseTodoItems`(匹配集合、空列表与 undefined 的区分);`tests/feishu/progress.spec.ts` 覆盖两种工具名的逐条清单与其他工具的代码块回退。包测试 1865 全绿,typecheck 干净。
