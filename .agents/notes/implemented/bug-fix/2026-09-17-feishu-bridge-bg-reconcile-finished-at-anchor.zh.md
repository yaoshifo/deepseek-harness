# Agent Note: 把「通知在途」探针锚定在 job 的 finishedAt

Status: implemented

[English](2026-09-17-feishu-bridge-bg-reconcile-finished-at-anchor.md) | 中文

## 问题

当天早些时候落地的对账探针（[泄漏对账 note](2026-09-17-feishu-bridge-bg-count-leak-reconcile.zh.md)）把一切 `reported === false` 的已结算 job 都当成还欠完成通知。但 `reported` 只在模型亲自领取 job 时翻转——`job_output` wait/read、kill、teardown 取消（标志归 jobs-local 所有）；tool-jobs 的通知投递从不翻转它。于是「通知已投递、被唤醒回合消化、但模型从未再读该 job」的 job 永远停在 `reported === false`：

- reader 的 idle 对账每个 tick 都看到 `inflight > 0`，永远对不了账，退到 30 分钟宽限善后——对账机制为之而生的那种未回报形态，恰恰是它清不掉的；
- 结算前对账让 `💡 N` 行永久留在定稿卡上（定稿卡不再接受后续渲染）。

## 决策

把探针锚定在时间上：`settledUnreportedBackgroundJobs(since)` 只数 `finishedAt > since` 的已结算未回报 job。锚点之前结算的 job，其通知要么已投递、要么被抑制、要么随 owner 一起被丢弃；锚点之后结算的才可能仍在投递途中，保留全部既有宽限保护。不带 `finishedAt` 的快照永远不算欠通知——注册表无法为它证明有通知在途；其存活阶段仍由 `pendingBackgroundJobs()` 覆盖。

两个调用点各传自己的等待起点：

- **reader idle 对账 → `state.bgWaitStartedAt`。** 计数出现后的首个 tick 锚点还是 0，该 tick 所有已结算 job 都计数（保守：几秒前刚结算的 job 可能正在投递途中，急清会吞掉它的通知）；该 tick 设下锚点，下一个 tick 清掉僵尸——约两个 idle tick，而不是三十分钟。
- **结算前对账 → `state.timing.turnStart`，即结算回合的起点**（既有 per-turn 锚，`processInteractiveEvents` 入口处赋值）。回合开始之前结算的 job 不可能欠这张卡的通知——其通知要么唤醒过更早的回合、要么被抑制、要么随 owner 死亡；回合中途结算的才仍欠。`state.timing` 有意横跨排队续轮（完成页脚时钟如此），因此回合与其排队后继之间结算的 job 仍计数：它们的通知还在 drain 队列里。不选 `bgWaitStartedAt`，因为该字段是 reader 视角的，常见流程里一直是 0——结算处锚 0 会把注册表里所有已结算 job 都计上，令修复在这一调用点失效。

## 考虑过的替代方案

- **投递时翻转 `reported`（tool-jobs）。** 跨包语义变更；投递有数种形态（followup 唤醒、next-step inbox 拼接、随被回收 owner 丢弃），而该标志的含义——模型亲自拿到终态——会变模糊。计数归 bridge 所有；用时间锚定让注册表的标志保持诚实。否。
- **在注册表内按时效过期未回报 job。** 注册表无法知道一份通知还值得等多久；该策略是 bridge 的宽限，而且快照里已有 bridge 需要的时间戳。否。

## 后果

- 「已投递未领取」的 job 在等待锚点越过其 `finishedAt` 后不再计数：reader 约两个 idle tick 内对账清掉泄漏计数。结算锚点（`state.timing.turnStart`）之下，回合中途结算的 job 仍算作欠通知——它的通知可能正在投递途中——因此该计数会活过这次渲染；但两种情形下定稿卡都不出提示行，因为提示只认注册表的活 job（见[泄漏对账 note](2026-09-17-feishu-bridge-bg-count-leak-reconcile.zh.md)）。
- 任一锚点之后结算的 job 保留完整宽限并继续计数（2026-09-16 oc_3c16b 语义不变）；卡上的提示行以注册表的活 job 切面为准，而非该计数。
- 漂移警报：探针除 owner/status/reported 外新增锚定 `JobSnapshot.finishedAt`；jobs 包改动任一字段形状都会让 adapter-projection 的过滤用例大声失败。
- stub 会话的探针从恒返回常数改为过滤 job 列表（含 `finishedAt`），并记录收到的锚点，让用例能钉死各调用点用的等待起点。

## 测试

- `tests/agent-dsh/adapter-projection.spec.ts`：owner/status/reported 过滤不变，新增锚定计数——锚点当时或之前结算的僵尸、无 `finishedAt` 的快照不再计数。
- `tests/engine/engine-unsolicited.spec.ts`：锚点前僵尸在第二个 idle tick 对账清零（首个 tick 只设锚点）；等待期间结算的 job 保留计数、保持 reader 武装，且探针锚定在 `bgWaitStartedAt`。
- `tests/engine/engine-events.spec.ts`：结算前对账清掉回合前僵尸不进渲染，回合中途结算的 job 保留计数但不渲染提示行，探针锚定在 `state.timing.turnStart`。
