# Agent Note: 后台子任务活体面板

Status: implemented

[English](2026-08-27-feishu-bridge-background-subtask-panel.md) | 中文

## 问题

父回合在 native 子任务仍在跑时结束（无 gather 的逃生路径——派发、交接、结束回合、逐汇报唤醒）后，群聊陷入静默：子任务事件只有在 bridge 会话存活时才投影进父通道，而回合的 `completeAndDetach` 会把它移除，此后 `resolveSubagentAncestor` 把每个子任务事件都丢弃。用户只能盯着一个冻结的「N 个子任务运行中」footer，无从判断子任务是否还活着（2026-08-27 oc_a7ab0de6：两个实施子任务在终态卡旁静默跑了八分多钟）。2026-08-26 的可见性 note 早已把 per-child panel 列为 deferred，阻碍是 settled 进度卡的 post-detach PATCH 通道。

## 决策

独立面板卡——持有自己的 message handle、完全不经过进度卡机器——直接绕开该阻碍：

- **生命周期**：父回合带着未汇报 native 子任务结算时贴卡（turn-end 重算点的 `ensureSubtaskPanel`），按定时器（`features.subtaskLivePanelIntervalMs`，默认 15s）与每次 reported 翻转就地 PATCH，集合清空时终态为 done 卡（PATCH 失败的死卡——被撤回或群被删——静默收尾，绝不空转）。`/done` drain 以 drained 卡关闭；engine `stop()` 清理全部定时器。gather 回合永不贴面板——其 live 卡已在流式子任务活动，且 gather 挂住的回合不会中途结算。
- **行内容**：每个待汇报子任务——label、工具调用计数、上次活跃的绝对时刻与相对时长（「上次活跃 HH:MM:SS（刚刚/N 分钟前）」）、超过 `features.subtaskLivePanelStallMs`（默认 120s）静默后的 ⚠️ 停滞标记、首个事件到来前的「尚未产生事件」。「⏹ 停止全部」按钮（`act:/subtask-panel stop`）经 `interruptNativeChild` 逐个中断；中断翻转 reported 后下一次刷新即终态。header 与行措辞后来重构为工具过程卡的执行中拼装，该决策见[header 重构 note](2026-08-28-feishu-bridge-subtask-panel-header-refresh.zh.md)。
- **数据源**：adapter 的子任务 activity 记录器——`session/event` 对每个带 `parentSession` 头的会话记录 `childId → {lastEventAt, toolCalls}`，在 ancestor 投影之前且与之无关，因此记录不受父回合 detach 影响。经 `SubagentActivitySource` 结构探测暴露给引擎；面板终态时清掉已结算子任务的条目，Map 不随 daemon 生命周期增长。

## 已考虑的替代方案

- **把 per-child 行 PATCH 进 settled 进度卡的 footer。** 否决：footer 只有一行，2026-08-26 note 有意让 settled header 保持终态，且它需要的正是当年导致推迟的 post-detach 进度 PATCH 通道。
- **让投影在 detach 后存活、从投影流行渲染。** 否决：detach 会话的通道没有消费者，维持它是新的生命周期机器；而且「事件流」粒度不对——面板要的是计数不是流。
- **轮询子任务会话日志。** 否决：记录器已经在零 I/O 下看到每个 durable 事件；轮询每个 tick 重读 zstd 日志只得到同样的数字。

## 后果

- 模式 B（父挂起、子任务后台跑）从此有连续活性信号；停滞子任务在一个 stall 窗口内可与正常工作者区分。
- 面板是内存态：daemon 重启或 HMR 重建即丢（重启恢复通知会结算记录；残留面板卡只是停止更新——重启路径由机器唤醒 steer 的 note 覆盖）。
- 父被汇报唤醒时渲染新回合自己的卡，面板继续 PATCH 剩余子任务——就地 PATCH 永不与 tail guard 冲突（后者只管进度卡的 reissue）。
- 由 `tests/engine/subtask-panel.spec.ts`（渲染布局、贴卡/刷新/终态、配置关闭、drain、stop-all）与 `tests/agent-dsh/adapter-subagent.spec.ts` 的记录器用例（detach 免疫记录、非子会话忽略）钉住。是 [2026-08-26](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.zh.md) deferred 项的落地；gather 模式的对应物见 [2026-08-27](2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.zh.md)。
