# Agent Note: 每个空闲节拍对账泄漏的后台任务计数

Status: implemented

[English](2026-09-17-feishu-bridge-bg-count-leak-reconcile.md) | 中文

## 问题

活体证据（2026-09-17，oc_f85284）：会话 turn 30 于 14:37:59 完成，但群里 15:09 才出现该回合定稿卡的**第二份副本**，标题「执行完成 · 15:09:08 · 8」——在[重复卡 note](2026-09-17-feishu-bridge-duplicate-completion-card.zh.md) 认定它只是被重发的同一张卡之前，一直被读成迟到 31 分钟的完成通知。同群 13:58 已发生过一次（3 pending）。链条：

1. turn 30 里一次 `bash run_in_background` 调用把 `backgroundTasksPending` 加到 1。
2. agent 在**同一回合内**用 `job_output(wait: true)` 领取了任务；tool-jobs 把这类 job 标记 `reported` 并抑制其完成通知——wait 已经把终态交给模型（tool-jobs 自己的测试钉死了这一点："suppresses the notice when a wait returned the terminal state"）。
3. bridge 的计数只在通知到达时递减（引擎唤醒回合结算，或 `bg_task_notice` 拼接事件）。通知被抑制后两条路都不触发：计数泄漏。
4. 泄漏计数把已定稿卡压满 30 分钟后台宽限。宽限到点，放弃路径的善后——49f177d17c 的注册表探针正确判定无活 job——清零计数并清卡片提示。这次清理谁也没清到：定稿路径早已把这张卡摘了句柄，于是这次提示清理**新开了一张卡**，把整份定稿内容又发了一遍（见[重复卡 note](2026-09-17-feishu-bridge-duplicate-completion-card.zh.md)）；在标题时钟冻结修复之前，那张副本盖的是渲染时刻（15:09:08）而非定稿时刻，「迟到通知」的假象就此完成。全程没有发生位移自愈重发：重发会删掉被替换的卡，而 oc_f85284 的原卡至今还在群里。

2026-09-16 的修复按设计工作——它的探针能区分慢任务与死计数——但它只管宽限**到点时**发生什么；对一个从来没有活 job 可等的计数无能为力。

## 决策

两个独立修复：

- **凡消费计数之处都对账注册表**（`engine.ts`）：`backgroundTasksPending > 0` 时，任何时钟或渲染决策前先问注册表——unsolicited reader 的 idle 分支一处，回合结算路径在终态渲染前再问一处，于是注册表无法佐证的计数根本到不了定稿卡（`engine: settled card background count reconciled away`；见[重复卡 note](2026-09-17-feishu-bridge-duplicate-completion-card.zh.md)）。三态：活 job（`pendingBackgroundJobs()`，running/stopping）继续等（49f177d17c 语义，不变）；已结算未回报的 job（`settledUnreportedBackgroundJobs(since)`，同一注册表切面上的探针：终态 + `reported === false` + 结算晚于调用方的等待锚点）仍欠一份通知——现有宽限计时继续为它们等（投递不翻转 `reported`，所以是否仍欠由锚点而非单靠标志判定；该精化归 [finishedAt 锚定 note](2026-09-17-feishu-bridge-bg-reconcile-finished-at-anchor.zh.md) 所有）；活 == 0 且在途 == 0 意味着被计数的 job 全部已结算**且**已被同回合领取——泄漏，就地清掉，日志行独立措辞（"reconciled away" 与 "grace exhausted" 区分）。结算路径写提示时渲染的是注册表的活 job 数，而不是这个计数本身：`💡 N 个后台任务` 指的是仍在跑的 job，没有活 job 就不出这一行（`engine: settled card background hint cleared`）。被在途通知续命的计数只是给 reader 宽限计时用的记账；定稿卡不再接受任何后渲染——注册表无法佐证的提示会永久冻在卡上（2026-09-18 oc_5677：定稿卡上挂着 💡 6 个后台任务，而注册表里没有任何在跑的 job）。
- **冻结终态标题时钟**（`streaming.ts`）：首次终态渲染（completed/truncated/failed 加已结算的挂起提问态）把标题时间戳定格在定稿时刻；后续渲染——存活卡上的 PATCH、位移自愈重发、挂起卡的结果渲染——复用定格值。非终态时钟照常前进。

为什么不改 tool-jobs：wait/read 交付终态后抑制通知是有意设计（不能对模型讲两遍）；计数归 bridge 所有，就该由 bridge 对账。

## 考虑过的替代方案

- **在 job_output 工具结果上递减。** 引擎看到的是投影后的结果文本而非结构化 job 状态；从文本解析 "[status: completed]" 很脆，也无法把 job id 映射回被计数的调用。否。
- **调小宽限。** 治标；任何更小的上限照样延迟卡片，还可能吞掉真正在途的通知。否。
- **改 tool-jobs 的抑制语义。** 为一个正确的设计做跨包行为变更；注册表探针已经能看到 bridge 需要的一切。否。

## 后果

- 「后台启动 + 同回合领取」模式定稿的卡上根本不再有后台提示：结算前对账在终态渲染之前丢掉泄漏计数，提示只渲染注册表的活 job，reader 的 idle 对账则继续清掉它再也无法佐证的计数，让 reader 在一个 idle tick（约 60 秒）内解除武装，而不是拖满 30 分钟宽限。中途结算的 job 仍会保留计数（其 `finishedAt` 晚于结算锚点），但已不可能再作为「在跑任务」渲染到定稿卡上。
- 终态卡在任何一次渲染里都显示真实定稿时刻；加上重复卡守卫后它根本不会再在群里出现一次，迟到的卡无法再冒充刚发生的完成。
- 慢任务与在途通知保留全部现有保护（2026-09-16 oc_3c16b 语义不变）。
- 代价：计数挂起期间每个 idle tick 一次注册表 `list`（内存过滤）。
- 漂移警报：两个探针锚定 `JobSnapshot.ownerSession`/`status`/`reported`/`finishedAt`；jobs 包改动任一字段形状都会让 adapter-projection 的过滤用例大声失败。
- 旧的「盲等宽限」测试重定向到在途通知语义（无 job 的 stub 默认值在对账语义下读作泄漏）；对账场景有独立测试，锚定探针的用例归 [finishedAt 锚定 note](2026-09-17-feishu-bridge-bg-reconcile-finished-at-anchor.zh.md) 所有。

## 测试

- `tests/engine/engine-unsolicited.spec.ts`：泄漏计数在首个 idle tick 对账清零；重定向后的在途通知宽限边界；活 job 宽限测试不变。
- `tests/engine/engine-events.spec.ts`：结算前对账——泄漏计数不渲染到定稿卡上，仍活着的 job 保留计数与提示。提示以注册表的活 job 切面为准：在途通知保留计数但不出提示行；活 job 的行显示活 job 数而非挂起计数；计数已不再跟踪的活 job 依旧有它的一行。
- `tests/agent-dsh/adapter-projection.spec.ts`：`settledUnreportedBackgroundJobs` 的 owner/status/reported 过滤；注册表缺席 → 0。
- `tests/streaming.spec.ts`：终态标题时间戳冻结——completed 卡后渲染保持定稿时刻、已结算挂起卡不再接受任何后渲染并保持结果时钟、非终态渲染时钟照常前进。
