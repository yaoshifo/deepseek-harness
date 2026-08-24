# Agent Note: continuable seam 满足桥侧无人值守子任务的迁移前置

Status: implemented

[English](2026-08-24-subagent-continuable-bridge-seam.md) | 中文

## Problem

feishu-bridge 去包袱路线图要在批次 B4 把无人值守子任务（无飞书群、无用户围观）迁到原生 continuable 子会话上。两个原生缺口挡住了这次迁移。

其一，`startContinuable` 静默忽略 `SubagentStartRequest.cwd`。模型侧消费方（`tool-subagent`）已经把 `cwd` 透传进 continuable 请求，one-shot 路径也早已校验、能力门控并持久化该字段（见 [cwd-override note](../architecture/2026-08-23-subagent-cwd-override.zh.md)），但 continuable 路径既无校验也无门控，还在 `childSessionMeta` 之前把值丢掉——跨目录的子任务会落在父会话的 cwd 里跑。

其二，`notifySettlement` 无条件唤醒或 steer 父 agent。桥的引擎自己驱动父回合（`agentSession.send` → `Agent.followup`，事件环只在引擎回合内排空），原生唤醒会开启一个引擎从未调度的自发父回合——一次引擎无法渲染、部署也没要过的模型请求。

## Decision

**cwd 对齐。** `startContinuable` 现在与 one-shot `start` 跑同一套 start 期闸门，且都在任何身份预留或 persistence 工作之前：能力断言（新增 `ContinuationHost.assertStartCapabilities` 钩子，由 runtime 的 `assertCapabilities` 对共享的 `SubagentCapabilityOptions` 子集实现）与绝对路径校验（同一错误码与措辞）。解析后的 cwd 流入 `childSessionMeta` 的第四参并写进子会话的持久 header，冷恢复即可读回。选择全量门控而非仅 cwd 门控是为了与 one-shot 路径对称：既有 continuable 测试的 start spec 不请求任何能力，全量门控不破坏任何用例，一个 seam 只留一份门控契约。

**结算投递外置。** `SubagentRuntime` 增加 loader 级配置 `settlementNotice: 'inbox'（默认）| 'external'`。`'external'` 下 `notifySettlement` 在任何唤醒、steer、注入或收件箱写入之前直接返回；结算仍可经 `subagent/end` 事件与子会话自身的 Session 观察。默认行为不变，因此 `tool-subagent` 的模型面承诺——无条件收到 runtime 通知——在所有部署上继续成立，唯一例外是显式声明自己拥有通知通道的部署。桥正是这样的部署：它经引擎的回合机器投递自有的 `[子任务完成]` 合成消息。

## Alternatives considered

- **仅对 continuable 路径门控 `cwdOverride`。** 更窄，但会让一个 seam 上出现两份门控契约。为对称与 fail-loud 而弃用；预留的回退方案（若既有用例因设计而破再收窄门控）从未触发。
- **保留结算唤醒、让桥事后压制。** 唤醒是 manager 处置事务里一次直接的 `Agent.followup`/`steer`，外部无法取消，模型请求无论如何都已花掉。弃用。
- **新增一个供桥拦截、借以取消投递的 seam 事件。** `subagent/end` 在所有权释放之后才发且不携带父标识；要在投递前拦截就得再发明一个事件，信息量与 config 字段相同。config 字段是更小的 seam。
- **把 `tool-subagent` 的 schema 承诺改成条件式。** 模型面文本会从「你会被告知」退化成「通常会被告知」。弃用：`'external'` 是部署对「由我方投递结算」的断言，不是条件式投递——父任务仍会得知结果，只是经由部署自己的通道。

## Consequences

- one-shot 与 continuable 启动执行同一套能力词表。`SubagentCapabilityOptions`（五个可选的能力承载字段）是共享的门控输入，随 host 钩子一同导出。
- 带 `static Config`（schemastery）的 `SubagentRuntimeConfig` 是 subagent 包第一个 loader 级配置；直接 `ctx.plugin(SubagentRuntime, …)` 的调用方自行解析默认值。
- 桥的 B4 桥侧半场消费这两者：以 `settlementNotice: 'external'` 挂载 `SubagentRuntime`，并把 worktree 路径作为 `cwd` 传入。
- [结算投递 note](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md) 已就地修正：其无条件性不变量适用于 `'inbox'`（默认）；`'external'` 是部署自有投递。
- 不加 snapshot：两个特性的默认行为都不变（cwd 按请求选择加入，`settlementNotice` 默认 `'inbox'`），与 cwd-override 兄弟提交的先例一致。
