# Agent Note: 放弃后台任务计数前先问任务注册表

Status: implemented

[English](2026-09-16-feishu-bridge-bg-grace-live-job.md) | 中文

## 问题

活体证据（2026-09-16，oc_3c16b03b）：最后一个回合于 11:20:25 启动 `run_in_background` 构建、11:21:12 结束，卡片正确显示 💡 1。构建跑了 39 分钟（机器高负载），而 unsolicited reader 的后台宽限期是 30 分钟——11:53:14 它判定任务永远不会完成，把计数清零。这一个假设引出两个缺陷：

1. 清零路径从不触碰卡片提示，已终态的卡片从此定格在 💡 1（回合早已结束，之后再无任何 PATCH 能清它）。
2. 清零同时解除了 idle reaper 唯一的保护（`backgroundTasksPending > 0` → 跳过）。live 配置 `interactiveIdleTimeoutMins: 30` 下，reaper 于 11:54:00 dispose 了 agent——比构建完成早六分钟。tool-jobs 把完成通知投递给一个已销毁的 owner，按「claim 前销毁即随 owner 丢弃」静默丢弃，通知永久丢失，定格的卡片成了它唯一的残迹。

grace 测试自己的注释写明了这个假设："Grace exhausted: the task will never complete"。墙上时钟分不出慢任务和挂死任务；只有注册表知道。

## 决策

用注册表探针取代时钟猜测，落在两个放弃点上：

- `AgentSession.pendingBackgroundJobs(): number`（bridge 核心接口）。dsh adapter 经 `ctx.get('jobs')` 实现——`JobRegistry.list(caller)` 过滤 `ownerSession` 为本会话且状态为 `running`/`stopping` 的快照。registry 或 context 缺席返回 0（单测构造、无 jobs 组合）。
- grace 耗尽先问：有活 job 则 reader 保持 armed、计数与提示不动（完成通知保持可投递）；只有「计数还在但注册表已无活 job」才放弃——且该路径现在也清卡片提示（`setBackgroundHint('')`，守卫写法对齐 `consumeBackgroundNotices`），终态卡不再渲染过期的 💡 N 行。
- idle reaper 的跳过条件在计数旁加上 `pendingBackgroundJobs() > 0`，计数被 grace 清零的慢任务不会再失去 owner。

## 考虑过的替代方案

- **调大 grace 配置。** 治标；更慢的机器总会超过任何上限。否。
- **耗尽不清计数，另加二级硬上限。** 两级时钟、中间夹着一份与真实脱钩的计数；一次注册表查询取代两者。否。
- **在 dsh 核心（tool-jobs）修。** 「已销毁 owner 的通知随之丢弃」是注册表白纸黑字的生命周期语义，不是那边的 bug；bridge 侧不销毁仍有活工作的 owner 即可。否。

## 后果

- 慢任务现在能熬过宽限期：完成唤醒引擎回合，卡片走 🔄 头，计数结算归零，提示清除。
- 真挂死的任务（进程僵住、永不结算）现在会让 interactive state 和 agent 句柄保活到用户回归或杀掉任务——此前 30 分钟 reaper 强制回收并丢失通知。这是正确性换内存：每个挂死任务一个句柄，无硬上限（除非造成实际伤害再做）。
- 漂移警报：探针锚定 `JobRegistry.list` 的 caller 圈定与 `JobSnapshot.ownerSession`/`status`。jobs 包若改动两者，adapter-projection 的过滤用例会大声失败。
- 测试：`engine-unsolicited.spec.ts`（grace 耗尽清提示；活 job 保持 reader 与计数）、`engine-events.spec.ts` idle reaper（计数与活 job 双保护）、`adapter-projection.spec.ts`（owner/status 过滤、registry 缺席 → 0）。
