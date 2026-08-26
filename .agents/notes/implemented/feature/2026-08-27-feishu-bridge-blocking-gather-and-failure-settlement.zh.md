# Agent Note: 阻塞式 gather 与带失败语义的子任务结算

Status: implemented

[English](2026-08-27-feishu-bridge-blocking-gather-and-failure-settlement.md) | 中文

## Problem

B4 之后，`feishu_bridge_subtask` 的 spawn 非阻塞且没有飞书群：父回合在派发后立即定稿，从派发到第一个子任务回报之间，除了静态计数（2026-08-26 note 的过渡补丁）外没有任何卡片表明工作仍在进行。原生 `subagent` 时代没有这个缺口——它的同步调用把父回合保持打开，子任务的工具调用实时流入活跃进度卡——其 run-settlement 还把每种失败形态映射成结构化的工具结果。桥路径则存在反向缺口：`subagent/end` 监听器完全丢弃 `stopReason`（max-tokens 的子任务把截断文本当成完成来汇报）、无任何助手输出的失败被 `no result to report` 抛错吞掉、`reportSubtaskTimeout` 没有生产调用点——失联的群路径子任务让父级永远等待。

## Decision

维持单一委派入口，为其补上同步契约。`gather` 改为阻塞：`gatherSubtasksBlocking` 布防同一个 barrier，在 Session 上注册 waiter，收齐时以汇总 resolve——汇总作为 gather 工具调用自己的结果回到仍打开的父回合；调用在飞期间子任务活动流入活跃进度卡（`fromSubagent` 事件），飞行中的工具调用使 idle timer 保持解除，中止信号（用户停止、teardown）注销 waiter 并让 barrier 保持布防、回落逐条唤醒。waiter 在位时跳过逐子结算卡——汇总即投递。结算文本组合终局原因：非 completed 的 stop reason 加失败语义前缀（error / max-tokens / refusal / aborted，外加 provider 诊断与「未留下收尾输出」注记），无输出的完成以通知结算而非抛错吞掉，`SubagentRunEndInfo` 从 one-shot 结果透传 `diagnostic`。群路径子任务获得对等通知：错误回合的自动汇报带失败标记与本回合自己的部分流式文本（绝不误报上一回合的陈旧回复），回合中进程退出以中断前缀投递部分输出，stall 击杀 / 硬回合上限 / agent 已死的发送失败 / 通道关闭路径投递合成超时通知（用户接管过子任务时抑制）。

## Alternatives considered

- **重新启用原生 `subagent` 工具（one-shot）。** 不作为默认：它以零引擎代码恢复阻塞体验，但重新打开第二个委派面，重叠部分要靠模型仲裁（worktree 与跨项目路由只在桥工具里），且其子任务没有 worktree 隔离——派给它的改仓库并行任务会在父工作区里相撞。保留为文档化的兜底：live profile 里把 `tool-subagent` 的 disable 换成 `backgroundMode: 'one-shot'` 覆盖。
- **父回合定稿后 PATCH 的每子任务实时面板卡。** 仍然搁置（见 [2026-08-26](2026-08-26-feishu-bridge-pending-subtasks-card-visibility.zh.md)）：需要 post-`completeAndDetach` PATCH 通道，而阻塞式 gather 用普通活跃卡就恢复了同样的可观测性，零新生命周期机器。
- **把原生子任务计入 `backgroundTasksPending` 以保活 unsolicited reader。** 拒绝（与 2026-08-26 note 相同）：该计数器「每任务一次唤醒」的递减与 gather 的 N 合 1 汇总会漂移。

## Consequences

- 典型派发流（spawn N → gather → 综合）在一个模型请求内完成：结果作为工具结果到达，无唤醒往返，失败信息包含在内。
- 等待中的父回合被占用至 gather 超时（默认 20 分钟，远低于 60 分钟硬回合上限）；逃生口是不调 gather——保持逐条唤醒的增量模式。
- 阻塞等待是内存态：等待中途重启丢失 waiter，后续汇报回落逐条唤醒。
- 失败词汇由 `subtask_settlement_*` i18n 键持有；`buildProjectAssembly` 引擎自动检测语言，引擎级测试钉 en 文案，一个 REAL 用例钉组合链路。

由 `tests/engine/engine-subtask.spec.ts`（阻塞 gather 三态、结算词汇、群路径失败前缀、超时通知守卫）、`tests/tools/subtask-tool.spec.ts`（路由）与 `tests/engine/native-subtask-assembly.spec.ts` 的两个 REAL 组合用例（无唤醒轮的回合内 resolve；max-tokens 失败语义端到端）钉住。
