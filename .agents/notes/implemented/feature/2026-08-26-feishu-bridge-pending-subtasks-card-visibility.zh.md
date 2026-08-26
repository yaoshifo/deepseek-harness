# Agent Note: 定稿卡片标注仍在运行的子任务数

Status: implemented

[English](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.md) | 中文

## 问题

父 agent 用 `feishu_bridge_subtask`（native continuable 子任务）派活后，`spawn` 立即返回，父 turn 随即定稿，进度卡变绿显示 执行完成，而子任务仍在运行——在 `features.subtaskQuiet` 下连回报卡片也被抑制。从派发到首个子任务回报之间（2026-08-26 oc_b46da516 评审批次实测 6 分半钟），任何卡片上都没有「工作仍在进行」的信号。改用 native 之前的 `subagent` 工具没有这个缺口：它的同步 `Task` 调用让父 turn 一直开着，卡片保持 执行中 并流式展示子任务的工具调用。

## 决策

Header 保持终态——它报告的是父 turn 的生命周期，而那个 turn 确实结束了——但在三个面上携带未回报子任务数，该数在每个渲染点从持久化的 `native_children` 记录（`parent_key` 匹配且 `reported: false`）重算：

- 定稿卡片标题经 `ProgressStatus.pendingSubtasks`（`progressTitleAndColor`）追加 `· N 个子任务运行中`；正文经既有 `bgTaskHint` 终态渲染显示 `subtasks_running_hint` 一行。
- 派发中的 turn 立即在停止按钮行显示提示（`spawnSubtaskNative` 触发 `setBackgroundHint`）。
- ✅ 完成推送追加同一提示行（`sendTurnCompletionCard`），因为推送才是手机上一眼的「完成」信号。

`interruptNativeChild` 现在把记录置为 `reported: true`：被中断的子任务不会再回报，计数不能永远虚高。

## 备选方案

- **子任务运行期间把定稿 Header 改回 执行中。** 否决：Header 驱动 turn 生命周期的视觉语义（spinner、停止按钮、且 ✅ 推送已发出），父 turn 确实已空闲；并发的新 turn 会渲染第二张诚实的 执行中 卡，与谎报的那张无法区分。机械上它还需要 `completeAndDetach` 之后的再 PATCH 通道——为误导性信号引入新生命周期机制。
- **把计数并入 `backgroundTasksPending`。** 否决：那个计数器的递减假设一个被计任务对应一次唤醒（`handleTurnEnd` 每个后台 turn 消耗一格），而 gather 会把 N 个回报合并成一次唤醒——计数会漂移并误导 unsolicited reader 的宽限和 idle reaper。本计数纯展示。
- **每个子任务事件实时 PATCH 的面板。** 缓议：需要上面的冻结后再 PATCH 通道。每个子任务驱动的唤醒都会自然刷新计数（每次 native 回报或 gather 超时都会开启新的父 turn，其卡片重算），stale 窗口止于首个子任务回报。

## 后果

- 计数在两次唤醒之间冻结在定稿卡片上：定稿前就回报的快子任务不会出现（重算时 `reported: true`），gather 静默期结束的子任务在 gather 唤醒的卡片之前保持计数。最坏情况数字高估到下一个父 turn。
- `finish()` 和 `completeAndDetach()` 的终态 status 现在也统一走 `progressStatusLocked()`，纯文本 turn（无工具调用）同样携带 `pendingSubtasks`；这些卡片上的 `toolCallSeq` 从硬编码 0 变为预览计数器（那里就是 0——行为不变）。
- 由 `tests/feishu/card.spec.ts`（标题格式）、`tests/streaming.spec.ts`（status 字段、去重 flush）、`tests/engine/engine-subtask.spec.ts`（结算重算、归零路径、interrupt 置位）与 `tests/engine/native-subtask-assembly.spec.ts` 的 REAL-composition 用例（子任务挂起时父 turn 定稿）锚定。
