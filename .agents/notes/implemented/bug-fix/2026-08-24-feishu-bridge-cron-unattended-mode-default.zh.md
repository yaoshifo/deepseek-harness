# Agent Note: cron prompt 运行以 default 模式启动，绝不继承项目级 plan 默认

Status: implemented

[English](2026-08-24-feishu-bridge-cron-unattended-mode-default.md) | 中文

## 问题

prompt 型 cron 任务把提示词作为合成用户消息注入，携带 `modeOverride: job.mode`（`Engine.executeCronJob`）。任务未设置 `mode` 时该覆盖为空，adapter 便用项目的 `agent.mode` 解析会话模式——而生产配置里每个项目都是 `agent.mode: plan`。cron 运行没有人类来批准 ExitPlanMode 卡片：风控驴项目 07:03 盘前检查（任务 `fbe6d268`，`session_mode: new_per_run`）在 07:04 走到一次 `exit_plan_mode` 调用后日志零事件，直到调度器的 30 分钟执行超时把运行杀掉；20:30 夜盘前检查同样失败。该任务在 2026-08-21 上午（plan 默认铺开之前）还能正常完成，自当晚间起持续超时。subtask 子会话（[effectiveMode bypass](2026-08-20-feishu-bridge-effective-mode-bypass.zh.md)）与 chatroom 链路（[chatroom 主持人永不进入 plan 模式](../feature/2026-08-23-feishu-bridge-chatroom-moderator-no-plan-mode.zh.md)）已各自处理无人值守缝；cron 合成消息是最后一条原样继承项目模式的消息路径。

## 决策

`executeCronJob` 构造合成消息时使用 `modeOverride: job.mode !== '' ? job.mode : 'default'`：任务未设 `mode` 则以 `default` 启动——沿用项目权限 preset，plan 型项目默认不再为无人值守运行武装 plan 模式。显式任务 `mode` 原样透传，包括显式的 `plan`（操作者的明确选择）。该一次性覆盖在交互态启动 agent 会话处被消费，因此 `new_per_run` 运行必定收到；这与 pick 阶段先例（chatroom-pick 合成消息上的 `modeOverride: 'default'`）一致，而不是新增 env 标志。

## 备选方案

**给 `sessionBypassesPermissions` 加 cron 标志（完整 Go effectiveMode bypass）。** 否决：bypass 改写的是 plan 之外的审批语义；cron 回复落在有人值守的群里，审批卡仍有意义，而任务级 `mode` 字段就是给想要 bypass 的任务留的显式逃生门。与主持人偏差同理，仅限 plan 模式。

**在 adapter 里用 cron 会话 env 标志降级 plan。** 否决：需要新增会话属性并接入 `buildSessionEnv` 才能表达消息构造点已经知道的事实；合成消息覆盖才是这条路径的既有缝（pick 唤醒）。

**只修存储的任务数据（往 `jobs.json` 里编辑 `mode`）。** 否决：daemon 在内存持有任务并在每次运行后回写存储，手编不能留存；且 plan 默认项目下未来每个 prompt 任务都会重新踩中卡死。

## 后果

plan 默认项目下的 prompt cron 任务能跑完而不是死在执行超时上，以项目常规权限 preset 执行——与已批准计划的实施同一权限面。显式 `job.mode: plan` 仍会卡在批准卡上；那是操作者声明过的选择。`reuse` 任务若目标交互会话已活跃则保持该会话的模式（覆盖在会话启动时生效）：在场人类可以批准那张计划卡。调度器超时现在量的是真实工作而不是卡死时长。

## 测试

`tests/engine/cron-execute.spec.ts`（`ExecuteCronJob_UnattendedModeDefault`）：无 `mode` 的 `new_per_run` prompt 任务以 `setSessionMode('default')` 启动 agent 会话；显式 `bypassPermissions` 原样透传。真机验证：风控驴 20:30 / 07:03 任务完整跑完并发出结论，`last_error` 为空。
