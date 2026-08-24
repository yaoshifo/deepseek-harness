# Agent Note: 无人值守桥侧子任务走原生 continuable seam

Status: implemented

[English](2026-08-24-feishu-bridge-native-unattended-subtasks.md) | 中文

## Problem

`feishu_bridge_subtask` 工具的 spawn 是最后一块没有原生对应的 Go 形态机制：每次派发——无论是否有人围观——都建真实飞书群、建桥侧会话，并动用引擎自建的父子注册表、深度计数、回报路由和 worktree 记账。无人值守子任务（群里永远没人看）为一无所得的群面付出全套成本，而桥还重复着原生 `SubagentRuntime` 已持久化拥有的世系/深度/恢复机制。

此前的两个堵点已由 [continuable bridge seam note](2026-08-24-subagent-continuable-bridge-seam.zh.md) 关闭：continuable 路径现在校验并持久化 `cwd`；`settlementNotice: 'external'` 压制 runtime 自己的投递。

## Decision

桥自挂 `SubagentRuntime`（`settlementNotice: 'external'`）与 in-process spawn/fork providers，profile 无需任何 subagent 条目。工具的 `spawn` 动作经新的 adapter 结构能力（`asContinuableDelegator`：`startContinuableChild` / `followupChild` / `interruptChild` / `reportChildToNativeParent`）委派；引擎只保留原生 seam 表达不了的东西：

- **父系记录**（project state 的 `native_children` 节，重启存活）：child id → 父会话 key、父 native id、标签、worktree 坐标、reported 标志。worktree 创建留在桥侧（git 约定是部署策略，见 cwd-override 决策）。
- **结算兜底**：`subagent/end` 监听把每个 epoch 的末条助手输出经群路径同款卡片 + `[子任务完成]` 唤醒机器投递——`deliverParentReply` 重构为收 (parentKey, childKey, label)，群子与 native 子共享一条投递通路。显式回报幂等跳过；追问重新武装。
- **gather barrier**：`gatherSubtasks` 把未回报的 native 子折入同一内存屏障；其回报经共享投递通路的 accumulate 入账。
- **send 排队**（`ctx.subagents.followup`）而非 Go 的 busy-reject——刻意偏离，写进工具的模型面措辞。
- **interrupt**：新工具动作，经父的活跃权威路由到原生 interrupt。
- **收尾**：`/done` 与 chatroom end 排空 native 后代（打断、干净 worktree 回收、记录清理）——worktree 处理镜像群路径的脏保留语义。

父本身是 native 的 native 子经 runtime 的 `reportFrom` 回报（每次回报一次唤醒，原生 inbox 语义）；那里不提供 gather barrier——工具如实作答而非空装。

## Alternatives considered

- **全部 spawn 迁原生。** 否决：attended 群（`/spawn`、monitor 子群、chatroom 预派助手）是原生 seam 刻意不建模的用户可见面（D1 理由）；它们保留群路径。
- **让原生 runtime 唤醒父、教引擎渲染自发回合。** 否决：引擎事件环只在自己回合内排空；吸收外来唤醒意味着第二套带重入风险的回合调度器。`external` 结算保住单一调度器。
- **native 子也保留桥侧世系。** 否决：持久化世系/深度/恢复正是原生 seam 的所有权；重复它等于重建去包袱的目标本身。
- **每条 native 记录挂桥侧 Session 而非 project state。** 否决：native 子没有桥侧会话；project state 是引擎现成的持久侧信道，重启存活且无需新文件。

## Consequences

- 无人值守工具路径不再建飞书群；skill 与工具措辞陈述新契约（send 排队、interrupt 存在、围观走 `/spawn`）。
- native 子与群子一致地略去 agent-conventions 人设节：其收尾的 ask_user_question 发现卡面向用户聊天，无人值守子任务没有这个面。
- 同时挂载 `dsh-subagent` 的 profile 会在 `subagents` 服务名上冲突——README 已记录；桥在自己的组合内拥有该服务。
- native 孙子（native 子的 native 子）可用：原生链式 spawn、`reportFrom` 回报、收尾经 native 记录传递性排空。
- REAL-composition 覆盖（`native-subtask-assembly.spec.ts`）启动真实栈（AgentLoop、jsonl persistence、SubagentRuntime external、buildProjectAssembly），只对 LLM 脚本化、平台用 stub，端到端跑 spawn → 子回合 → 结算 → 卡片 + 父唤醒；真机冒烟（活 bot 上的无人值守派发 + gather + 回报）留给用户。
