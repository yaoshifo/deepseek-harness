# Agent Note: 子任务回报送达——卡片尽力而为，唤醒持有一次性标记

Status: implemented

[English](2026-09-07-feishu-bridge-subtask-report-delivery.md) | 中文

## Problem

原生子任务回报路径——`settleNativeChild` → `reportNativeChild` → `replyNativeToParent` / `replyToParent` → `deliverParentReply` → `deliverMachineMessage`——必须守住一条不变量：要么唤醒父会话，要么子任务保持可重投。两个缺口破坏了它。其一，`deliverParentReply` 在一条无 `.catch` 的 fire-and-forget 链上 await `sendAsCard`：那里任何 rejection（卡片构建抛错，或唤醒路径抛错，比如 busy 父会话的 `steer` 失败）都会以 unhandled rejection 浮出，并跳过 `await` 之后的一切——包括 `deliverMachineMessage`，真正的唤醒。其二，发起（`replyNativeToParent` 返回 true）在异步交付运行之前就已翻转子任务的一次性 `reported` 标记，而失败时没有任何回滚：回报读作已交付，父会话却从未被唤醒，后续 settle 与重启恢复（跳过 `reported` 子任务）都无法重投。与 2026-09-06 唤醒链冻结同族：一次记录上「已交付」的丢失唤醒。

## Decision

- **卡片尽力而为**（`deliverParentReply`）：`sendAsCard` 的 await 包进 try/catch，记日志后继续——卡片是给人看的 UI，下面的唤醒才是本质交付。
- **仅唤醒失败才回滚一次性标记**：两个发起点都捕获 `deliverParentReply` 逃逸的拒绝——`replyNativeToParent` 重置原生子的 `reported` 记录；`replyToParent` 重置群子路径的 `subtaskReported` 并持久化。丢失的唤醒因此保持可由 settle、追问或重启恢复重投。reconstruct 失败早有此回滚；交付的这一半现在对齐。
- **链内审计**：该路径上仅剩的一处裸 void 异步调用（monitor 模式的 Done 表情回应）补上记日志的 `.catch`。回报链之外未动。

## Alternatives considered

- **在 `deliverParentReply` 内部回滚。** 它做不到：标记存放在两种不同的存储（项目状态记录 vs 会话记录）里，由调用方决定，而该函数刻意只接收 key 和 label。
- **让 `sendAsCard` 自身永不 reject。** 只治表象；唤醒路径的失败仍会让 `reported` 标记搁浅。
- **为失败的唤醒建重试队列。** 恢复路径已经存在（settle 重臂、重启恢复）；它们只需要标记说实话。

## Consequences

- 测试钉住：卡片发送被拒绝时父会话仍被唤醒（`[子任务完成]` 落地）；唤醒路径失败（busy 父会话、steer 抛错）回滚 `reported`，显式重报可送达；群路径同样回滚 `subtaskReported`。
- 挂起而非 reject 的卡片发送不在本修复范围：重试机制的每尝试 deadline 最终会把它 reject 进同一个 catch。
- stall 覆盖日志（`stall check overridden: … blind pump`）现在携带 session key，排查不再需要逐会话比对尾部时间；纯观测，无行为变更。
