---
description: "面向用户与维护者的 subagent 委派 seam，用于选择提供方后端、组装委派工具或排查子 agent 运行问题。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent

[English](README.md) | 中文

## 概述

`dsh-subagent` 是子 agent 委派背后的服务：agent（智能体）把任务交给具名子 agent，收集完成的结果，并且——对可继续子 agent 而言——跨轮次持续发送后续工作。多个提供方在同一约定下共存，因此单个组合可以并排提供进程内子 agent、进程外 ACP 或 SDK 子 agent，以及真实 Codex 或 Claude Code 子 agent。子 agent 有两种形态：一次性运行以单个结果结算，可继续子 agent 的持久会话则接受后续消息并可被中断。同一服务还回答发现类问题——存在哪些子级、它们的模式、活动状态与血缘——而不加载或恢复它们。把它与至少一个提供方后端和一个委派工具一起挂载；后端与面向模型的工具位于兄弟包中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是每个委派组合都共享的约定。你通过把服务与一个或多个提供方后端以及面向模型的委派工具一起挂载来启用它；此后 agent 即可委派工作，服务会把每个请求路由到具名提供方。

### 启用委派

把服务与一个提供方和委派工具一起挂载。提供方以你配置的名称注册（进程内 spawn 后端默认为 `spawn`）；工具行指名该提供方，让模型看到一个静态工具。一个最小的一次性配置：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
```

调用该工具的 agent 会把子 agent 的最终答案作为工具结果收到。只挂载服务本身不会改变任何行为：在组合出提供方和工具之前，什么都不能委派。

### 一次性与可继续子级

一次性子 agent 只运行一次，并以单个结果结算，可附带可选的结构化输出与失败时的安全诊断。启动请求可以通过 `agentOptions` 覆盖子 Agent 的提供方、模型、推理等级与输出 token 上限；每个请求的选项都要求提供方声明对应能力。可继续子 agent 保留持久会话并按顺序接受后续消息：调用方收到稳定的子 agent id、发送后续消息，并可中断当前轮次而不销毁子 agent。工具行的 `backgroundMode` 选择形态（默认 `one-shot`，或在支持的提供方上使用 `continuable`）。

### 后续消息、中断与发现

可继续子 agent 把后续消息作为下一个轮次回答，父级随时可以中断运行中的轮次或列举自己的子级。发现覆盖两种形态：服务列举直接子级与完整后代树——模式、活动状态与血缘——直接读取在线会话状态与可选持久化，不加载任何子 agent。

### 失败与恢复

需要所选提供方不具备的能力的请求会在启动时响亮失败，而不会被静默忽略。失败的子 agent 运行会返回停止原因，提供方后端还会附加安全诊断；被取消的请求以 `aborted` 结算。子 agent 相互隔离：崩溃或行为异常的子 agent 无法破坏父级会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务的构建方式以及可观察行为从何而来；完整约定见[使用本包](#use-this-package)。

### 设计理念

- **一个服务，多个提供方。** 服务是具名提供方注册表；每个后端以唯一名称注册，请求按名称选择一个。
- **两种子级形态。** 一次性运行在发布时转移所有权；可继续子级保留持久 Session，且同一时刻至多一个进程内 Activation。
- **兑现即发布。** 提供方的 `start()` 只有在真实子 agent 存在后才兑现，因此调用方要么拥有一段在线运行，要么一无所有。
- **同进程值可信。** 请求、描述符与结果按不可变约定借用；序列化与不可信输入校验属于进程与协议边界。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务入口：提供方注册表、启动与继续 API、生命周期事件 |
| [`src/continuation.ts`](src/continuation.ts) | 可继续子级：身份预留、Activation 驻留、后续消息、中断、结算 |
| [`src/types.ts`](src/types.ts) | 公开的请求、结果与提供方约定 |
| [`src/descriptor.ts`](src/descriptor.ts) | 版本化的 `subagent/descriptor` 会话事件词汇 |
| [`src/child-agent.ts`](src/child-agent.ts) | 子级组装、委派策略、深度辅助函数 |
| [`src/list-children.ts`](src/list-children.ts) | 基于在线会话存储与可选持久化的发现 |
| [`src/control.ts`](src/control.ts) | 浏览器控制面组装：目录活性采样、浏览器时区校验、失败分码 |
| [`src/control-types.ts`](src/control-types.ts) | client-safe 的目录行、控制面请求、回执与失败 |

### 一次性流程

请求先对照提供方声明的能力进行校验，随后对持久化描述符做快照，再由提供方构建子 agent。两个进程内提供方都声明 `agentOptions`：创建子级时把请求字段叠加到父级最新已记录请求的提供方、模型与推理等级之上；父级还没有请求时回退到创建选项，并保留配置的 token 上限。更改路由而不显式指定推理等级时，会清除继承的路由自有等级，使所选模型解析自己的默认值。DSH SDK 也声明该能力并公开不可变的 `agentRouteDefaults`，使其实例持有的提供方／模型默认值在确切路由预检前成为基线；`start()` 仍负责直接调用方与输出上限。ACP、Codex 与 Claude Code 会拒绝 agent 路由覆盖，而不是静默忽略。成功时运行被发布、所有权转移给调用方；失败时提供方回滚每个尚未发布的资源。结果携带子 agent 的最终输出、可选的结构化值、停止原因与可选的安全诊断。

### 可继续流程

管理器预留子 agent 身份、解析持久化描述符、创建（或冷恢复）子 agent、把它安装进 Activation 并提交提示词。后续消息经子 agent 自己的 inbox 成为 FIFO 轮次；没有 Activation 时从持久化会话冷恢复。当驻留 Activation 结算时，管理器会在父级自身的轮次流中告知该子级的直接父级。

- `agentOptions`：把请求的子 agent 创建选项（provider／model／推理等级／token 上限）合并到父级已记录路由之上。
- `outputSchema`：强制执行结构化最终结果；
- `depthLimit`：强制执行 `maxDepth`；
- `toolFilter`：应用请求的子 agent 工具限制；
- `persona`：应用每个子 agent 独立的 persona；
- `cwdOverride`：按请求接受一个绝对 `cwd`，为子 agent 会话覆盖父级的工作目录。纯会话元数据：git worktree 隔离或其他目录准备工作仍归调用方所有，叠加在该覆盖之上。

### 所有权与不变式

- **发布即边界**——发布前提供方拥有设置并须在失败时回滚；发布后调用方拥有运行并须 dispose（资源释放）它。
- **注册受 effect 作用域约束**——移除提供方会阻止新启动，但绝不撤销已接受的运行。
- **继续执行权限基于确切身份**——后续消息要求确切在线直接父级；上报要求确切在线子级。
- **描述符仅进日志**——它是会话事件，不进入模型历史，并跨压缩（compaction）保留；可继续描述符会显式记录解析后的子级提供方、模型与推理等级，用于冷恢复。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享 seam 逐步进入后端、面向模型的工具与设计决策。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [Subagent 能力 seam](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)——委派能力家族的设计记录。
- [可续跑后台 subagent](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)——接受后续轮次的持久子级。
- [进程内 spawn 后端](../subagent-spawn-in-process/README.zh.md)——最容易组合的提供方。
- [进程外 ACP 后端](../subagent-acp/README.zh.md)——经 Agent Client Protocol 拥有自有运行时的子级。
- [合并后的 subagent 控制服务](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)——后续消息、中断与列举面。

## 委派深度

该 seam 拥有 Service Provider 和 Consumer 共享的深度词汇：`AgentOptions.subagentDepth` 声明、`assertSubagentMaxDepth` 和 `delegationDepthOf(agent)`。持久化的 `SessionHeader.delegationDepth` 具有权威性且单调：运行时选项可以增大委派深度，但绝不能将其降到这个下界以下，因此恢复后的子 agent 不会被重新计为顶层。

`inheritsParentContext` 只用于描述，不能强制执行。它仅说明子 agent 是否能看到父级已完成的对话历史（`fork` 可以；`spawn` 和各进程外一次性提供方不可以），不表示是否继承工具、服务或权限。

<a id="delegated-policy"></a>

## 委派策略

两条进程内委派路径都会通过共享的子 agent 辅助函数，在委派边界固定子 agent 的权限范围。`captureDelegatedPolicyOverrides(parent)` 会为父会话的显式沙箱覆盖项（`sandboxPolicy.overrideOf()`）创建快照，并在审批能力已组合时将子 agent 的审批策略固定为 `'never'`，无论父级自身采用何种策略。这样，被委派的子 agent 只能在继承的沙箱范围内行动，每次审批请求（例如 `sandbox_permissions` 升权）都会被确定性拒绝，而不会等待无人处理的提示（这两个服务都是可选的 `ctx.get` 消费方）。`appendDelegatedPolicyOverrides()` 则在未发布的设置阶段、在任何 fork 种子之后，把每个值作为一条 `source: 'delegation'` 的 `sandbox/mode` 或 `approval/policy` 事件写入子 agent 自己的日志。因此，新捕获的策略会覆盖种子中的陈旧状态，而子 agent 的生效策略始终可以仅凭其日志重建。沙箱的部署默认值绝不复制：未切换的父级不会记录 `sandbox/mode`，其子 agent 会动态跟随部署默认值。可继续启动会在第一次 await 前捕获策略，并且只为全新物化写入这些委派事件；冷恢复只会重放已持久化的委派事件，不会重新捕获父级策略，因此创建之后的父级切换绝不会追溯性地改变持久化子 agent。每个进程内子 agent 还会收到一条作用域内的运行时上下文声明（`subagent:delegation`），告知其权限范围已固定，需要更宽访问的任务应以上报限制收尾，而不是重试。参见[一次性](../../../.agents/notes/implemented/feature/2026-07-25-subagent-policy-inheritance.zh.md)与[可继续](../../../.agents/notes/implemented/feature/2026-08-10-continuable-subagent-policy-inheritance.zh.md)两篇委派策略 Agent Note。

## 一次性所有权与生命周期

`provider.start(request): Promise<SubagentRun>` 是所有权转移边界；委派工具也会在其由 Task 支撑的一次性后台路径中使用它。兑现前，提供方拥有设置过程，并且在任何失败路径上都必须取消、回滚并使尚未发布的资源完全停稳。兑现后，run 的所有权转移给调用方；调用方必须在每条路径上调用 `dispose()`。剩余提示词和轮次工作属于 `SubagentRun.result`。

`SubagentRun.result` 兑现为 `{ output, structured?, diagnostic?, stopReason }`。子 agent 级失败会以非 `completed` 原因兑现；只有 seam 无法表示的基础设施故障才可以拒绝。提供方可以为非完成结果附加安全的 `diagnostic`：它会先排除工具输入、文件内容、环境值、凭证与原始协议载荷，并把完整文本限制在 4096 个 UTF-8 字节以内。共享结果类型不定义提供方类别或生命周期阶段：进程外提供方可以从锁定版本产品提供的结构化事实与已观测的进程结果派生固定展示文本，而消费方只负责原样呈现，不解析该文本。该字段不是 assistant 输出；消费方会将它分开呈现，它也不会进入 `subagent/end.lastAssistantMessage`。`dispose()` 是幂等的，会取消剩余工作，并等待结果结算以及子 agent 资源完全停稳。result 的拒绝只通过 `result` 本身报告；只有独立的资源释放失败，才会使 `dispose()` 被拒绝。`output` 与 `subagent/end` 事件的 `lastAssistantMessage` 使用导出的 `AssistantOutputFold`／`finalAssistantOutput` 辅助函数选取子 agent 最后一条非空 assistant 消息；若没有这类消息，则选取其累积的 assistant 文本。子 agent 两种输出均未产生时，`output` 为 `[]`，该事件字段缺省（终态结果约定归 [`SubagentResult`](../../../docs/subsystems/subagent.zh.md#the-terminal-result-subagentresult) 所有）。

本地运行会在 `start()` 兑现前发布普通的子 agent／会话，把该共享会话 id 作为 `SubagentRun.id` 返回，以 `SubagentRun.localAgent` 公开准确的子 agent，把 `request.parent.session.id` 记录到子 agent 的 `parentSession` header，并在其初始轮次内追加已解析的描述符。远程提供方则生成 parent 作用域的生命周期 id，并返回 `localAgent: undefined`；由于没有本地 child 会话，其一次性运行不会进入基于追踪的枚举结果。

## 可继续子 agent 与 Activation

每个可继续子 agent 都有一个持久化 Session，并且同一时刻至多有一个进程内 **Activation**。Activation 表示重建后的子 agent 的一次驻留时段，不是请求、结果、取消或 Task 的边界。Agent inbox 是唯一的轮次队列，因此驻留归继续执行管理器，所有轮次排序与执行归 agent loop（智能体循环）。任何可继续路径都不会创建 Task 或中间的承载结果的包装层。

管理器根据 Agent 的完全停稳状态和所拥有的子级集合推导三种内部驻留状态，而不维护第二套状态机：running 表示存在正在进行的准入、尚未结束的轮次，或会唤醒 Agent 的 inbox 工作；waiting 表示 Agent 已完全停稳，但仍拥有至少一个尚未 dispose 的子级；settled 表示 Agent 已完全停稳且所有拥有的子级均已 dispose，此时管理器会 dispose `AgentHandle` 并移除 Activation。每条后续消息都使用 `Agent.followup()` 并成为一个 FIFO 轮次，且不会对当前轮次进行 steering（中途引导）。路由只取决于驻留状态：running 入队、waiting 唤醒同一 Agent，无 Activation 时则冷恢复一个新的。

管理器预留子 agent 身份、解析持久化描述符，通过私有的 activation-owner 作用域调用 `ctx.agents.create()`（冷恢复时为 `ctx.agents.resume()`），把返回的 `AgentHandle` 安装到 Activation 中，建立任何可继续父级所有权，然后提交提示词。冷恢复绝不通过提供方分发，因为持久化会话已持有初始前缀，折叠后的描述符即是全部重建输入。

### 结算投递

当一个驻留 Activation 结算时，管理器会在父级自身的轮次流中告知该子级持久化的直接父级：这个子级已经产出它将产出的全部内容。对于每个已经向调用方返回过 id 的子级，管理器都会无条件投递结算通知，不考虑该子级是否调用过 `report`。最需要说明结局的终止情形，包括达到 token 上限、模型失败、取消或拆卸，恰恰是子级根本没有机会选择的那些情形。在第一条消息被接受之前就回滚的物化保持静默，因为那位调用方已被告知该子级未建立。消息会携带该 epoch 的终止原因、它产出过的最终 assistant 内容，以及持久化来源 `{ kind: 'subagent-settled', form: 'notice', senderSessionId: <child-id> }`——与子级自撰的 `subagent-report` 是不同的来源 kind，因此 transcript（文本记录）绝不会把运行时写下的话算到子级头上。

有两条顺序规则让这条投递可靠而非侥幸，它们也正是这件事属于管理器而非外部 `subagent/end` listener 的原因。第一，发送发生在子级所有权释放**之前**，此时父级仍然计入该子级，因此在结构上不可能被判定为已结算。第二，如果父级本身也是驻留 Activation，该消息会采用与 report 相同的唤醒准入记账。这样，从同步发送消息到负责准入该消息的 microtask 运行之间的窗口，不会被误判为完全停稳——`Agent.status` 会把上下文维护折叠成 `idle`，而维护期间的唤醒发送只会预置一次延后唤醒。缺少其中任一条规则，父级都可能在通知仍留在 inbox 时被 dispose，而 `cancel()` 会清空该 inbox，于是通知被静默丢失。

空闲父级会以一个普通的后续轮次收到该通知。繁忙父级则被 steer 到其最近的 step 边界，因此同时结算的多个子级只消耗一个 step，而不是各自一个轮次；采用 steer 而非 inject 还意味着：即便驱动在状态读取与发送之间退出，该消息仍会被认领。如果父级所在的谱系已经开始排空，该通知会通过 inject 投递，且完全不会唤醒父级。对已经完全停稳的父级调用 `Agent.followup()` 会开启新轮次，而 `cancel()` 不会预先阻止之后开启的轮次；因此在拆卸期间唤醒父级，会让宿主即将 dispose 的 Agent 多执行一次模型请求，而且树的每一层各一次，因为每层自己的通知又会唤醒上一层。被 inject 的消息会送达仍在读取自身 inbox 的父级，而无论如何日志都会记录这份记账；但它不会比该父级自身的 dispose 活得更久：`AgentHandle.dispose()` 是一次 `keepInbox: false` 的 cancel，会持久地取消尚未被认领的通知。因此 resume 后的父级没有待处理通知可读：`list_agents` 只告诉它有哪些子级、各自是在线还是仅存于存储；结局本身留在子级自己的 Session 里，一次 `send_message` 会通过 resume 该子级把它取回。已离开注册表的父级不算错误：通知被丢弃，子级自身的 Session 仍是持久记录。投递绝不会阻塞或使拆卸失败——发送被拒只会记录日志，因为为了重试一条通知而保留子级，会把它的整条祖先链永久钉在 `waiting` 上。

受继续执行管理的父级 Activation 会在子 agent 能够运行之前，把每个子 agent 的会话 id 记录到 `ownedChildren` 集合中，并且只有在每个所拥有的子 agent Activation 完成 `AgentHandle` dispose 之后才会 dispose（子先于父）。拆卸会先自顶向下传播 Agent 取消，再等待缓慢的后代，而 handle 释放仍保持 child-first。顶层及其他非继续执行的 Agent 没有 Activation，处于该等待图之外。最终结算会在 dispose handle 前等待 best-effort 的 `ctx.sessions.flush(child.session)`。监听器拒绝会被记录，但不会使 Activation 失败，因为监听器参与本身不能标识持久化后端；因此恢复时的持久化状态仍可能缺失或陈旧。

## 生命周期事件

服务会为每次一次性运行以及每个已驻留的可继续 Activation 时段发出一对 `subagent/start`/`subagent/end`，因此可继续子 agent 可用与一次性运行相同的词汇观察，且不会暴露管理器是物化、唤醒还是冷恢复了它们。对于一次性启动，它会在同步的 `subagent/start` 之前附加结果观察器，因此即使子 agent 已经结算，也仍会先产生 `subagent/start`，再产生 `subagent/end`；在驻留前失败的可继续时段不会发出这对生命周期事件中的任何一个。这对事件共享由服务生成的 `runId`；`local` 标志根据提供方返回的确切 `localAgent` 是否存在取得快照（可继续子级恒为 true），因此观察器不会根据可复用的提供方名称或会话名称推断运行身份或本地性。`provider` 字段包含子 agent 初次创建时记录的提供方名称，不表示该提供方当前仍在注册：已接受的一次性 run 可在提供方移除后才结算；冷恢复时段会从描述符读取初始提供方名称，不会调用或注册该提供方。

运行事件受执行委派的父级作用域约束。每个监听器都独立隔离：同步抛出或返回的 promise 被拒绝时，只会记录日志，不会阻塞同级监听器或改变运行。

提供方新增和移除还会发出 `subagent/provider-added` 与 `subagent/provider-removed`。面向模型的工具等消费方使用这些事件，因为 Cordis 可能并发加载同级插件；配置顺序不能证明注册顺序。

可继续子级不会创建 `SubagentRun` 或 Task。继续执行管理器为每个驻留子会话直接拥有一个仅存在于当前进程的 Activation 和一个留存的 `AgentHandle`，使用 Agent inbox 作为唯一 FIFO，并从持久化描述符冷恢复。父到子投递由确切在线的直接父级身份授权。上报则由确切在线的子级身份授权；管理器根据持久化的 `parentSession` 推导接收方，`MessageSource` 记录发送方，但不授予权限。中断权限被刻意设计得比投递权限更宽：人类出示持久化直接 parent 地址，因此即使 parent Agent 离线，在线 child 仍可被停止；Activation 物化时记录的任何确切在线 ancestor 也可以停止其后代，因为停止一个轮次是幂等的，且不投递任何内容。

当 `ctx.sessionProjections` 可用时，服务会注册两个投影单元。`subagentTiming` 会在每个描述符处重置，使 fork 种子中的祖先工作不会计入 child 总量，随后累加 `turn/start` → `turn/end` 活跃时间，并为未结束的轮次保留同一切面的 `active.since` 和 `active.through` 边界；在该轮次保持未结束期间，`active.through` 会跟随最近折叠的事件，从而为 inactive 消费方提供保守的崩溃上界，又不会混入更新的会话元数据。`subagent` 以同样的 last-wins 重置纪律从 `subagent/descriptor` 事件折叠持久化身份——模式与创建标签——因此 fork 种子中的祖先描述符只在 child 自身的描述符覆盖之前有效；畸形或版本无法识别的载荷折叠为可序列化的 `null` 哨兵——与没有描述符的日志不可区分，且能完好通过每个 JSON 推送帧，让消费方以之替换掉手中的陈旧身份而非继续保留该身份——绝不抛错。

`registerContinuableSetup()` 允许可选包添加子级作用域能力，而无需让继续执行管理器知道这些能力的名称。贡献会在 Activation 发布前同步安装，在设置失败时一并回滚，并随子级作用域释放。新授权须等到下一个 Activation，移除贡献则会立即撤销每个驻留安装项。

## 收集模型

面向模型的工具默认同步收集：先等待子 agent 结果，再 dispose 运行，然后才返回。一次性后台委派会在工具中注册普通 Task，其通用状态、收集和取消工具负责后续交互，并将模型提供的 `description` 持久化为可选显示标签。可继续后台委派会调用 `ctx.subagents.startContinuable()`，只返回持久化子 agent id；子 agent 自 inbox 接受起就拥有自己的轮次，因此没有 Task、也没有结果 promise——调用方通过 `send_message` 后续操作工具发送后续工作，`interrupt()` 只停止当前轮次而不 dispose 子 agent，而持久化子 agent 会话仍是子 agent 详细输出的来源。只有 `ctx.agents` 可用时，继续执行管理器才会存在，而会话持久化按每项继续执行操作解析。与此独立，`listChildren()` 枚举在线会话存储与可选会话持久化的在线优先合并——持久化缺席时仅枚举在线 child，因为那时冷 child 本就无法恢复——并由已注册的 `subagent` 投影单元供给每个 child 的持久化模式与标签：在线 child 取注册表的水位快照；冷 child 先取可选投影缓存的持久化行，且仅当其 `seq` 门证明该值折叠自 child 自身后缀（fork 种子之后——自有描述符一经追加即不可变）才直接采用，否则经一次有界并发的持久化 inspect 再经注册表折叠，且 inspect 结果必须仍指向枚举时的生命周期（同 id 被重新发布的会话降级为 `corrupt` diagnostic）。缓存读取抛出异常时，不会据此作出分类判断，因为缓存只是派生数据；静默落到该权威重折。分类结果完全以投影折叠为准；列表操作本身不解析描述符。取得身份值即产出 child 行；已定局而折叠未产出身份的候选是 `corrupt` diagnostic，inspect 失败是瞬时的 `unavailable`（下次列表重试），运行中而暂无身份值的候选整行省略（描述符尚未追加的创建窗口）。它不查询继续执行管理器、Agent 注册信息、Activation 或提供方。每个 child 行都会根据合并结果中携带持久化 `origin: 'subagent'` 的 header 派生读取时的 `hasChildren` 提示；它不会读取后代事件日志，展开后仍以描述符支撑的 child 目录为权威依据。UI 等服务消费方可以保留两种模式，并为无标签的一次性 child 选择回退展示；面向模型的 `list_agents` 工具只投影 `continuable` 条目，通过在线 Agent 注册表细化状态，并把仅存于存储的状态映射为可恢复而非终态的 `ready`（`running`／`idle`／`ready`），并在 `descendants` scope 下遍历 `listDescendants()`。列表操作会把调用方的取消信号转发到每次持久化读取，在这些 await 前后检查取消，并将每次检测到的中止报告为 `SubagentError` 错误码 `CANCELLED`；投影注册表未挂载则以 `SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE` 响亮失败，会话存储缺失则以 `SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE` 响亮失败。完整约定见[后台 subagent 任务 Agent Note](../../../.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.zh.md)、[可继续后台 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.zh.md)、[持久化目录 Agent Note](../../../.agents/notes/implemented/feature/2026-07-22-durable-subagent-catalog-and-list-agents.zh.md)、[服务合并 Agent Note](../../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.zh.md)、[能力 seam Agent Note](../../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)和 `src/types.ts`。

可继续 Activation 会等待 best-effort 的最终会话 flush，但不会把 listener 参与视为持久性确认。一次性运行保留尽力执行的会话检查点，因此已完成的一次性 child 只有在其会话确实进入持久化存储时，才可在 dispose 后继续被发现；如果该检查点缺失，服务不会根据 Task 历史虚构目录条目。

-----

<a id="model-experience"></a>
## 模型体验

### 结算通知

#### 模型看到什么

一条用户角色的父级消息，开头是结果本身——`Background subagent <child-id> finished and will do no further work unless you send it more.`，或子级被停止、耗尽额度、拒绝任务或失败时的对应句子——随后是 `Its closing message:` 与子级的最终 assistant 内容；若子级没有产出内容，则是 `It left no closing message.`。这是本服务面向父级的唯一直接贡献；委派 schema、父级延续与发现以及子级作用域的 `report` 分别归 `dsh-tool-subagent`、`dsh-tool-subagent-control` 和 `dsh-tool-subagent-report` 所有。

#### Token 影响

父级请求中，每个已结算的 Activation 一条通知，长度取决于子级的最终消息。如果子级既上报又结算，父级请求会同时承担两者。

#### KV Cache 影响

在父级中仅追加：通知位于其可复用请求前缀之后。到达空闲父级会启动一次独立的模型请求，到达繁忙父级则不会。

### 子级委派范围声明

#### 模型看到什么

每个进程内子 agent 的运行时上下文快照都携带下方的 `subagent:delegation` 声明，位于沙箱策略与审批策略语句之后。

##### 委派范围声明

```markdown
You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the job needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.
```

#### Token 影响

每个子 agent 的运行时上下文快照中一条固定声明；父级请求中没有任何新增。

#### KV Cache 影响

子级内部前缀稳定：该声明在子 agent 生命周期内绝不变化，因此只写入第一份运行时上下文快照一次。父级侧不会直接使缓存失效；具名工具消费方共同负责请求前缀的任何变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该 seam 何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是通用委派对比或任务积压。

- **ACP 子级仍为一次性，且无法通过追踪枚举**——ACP 运行在父级会话语料中没有本地子会话，远程提供方需要 Activation 所有权约定才能支持可继续子级。
- **无 host-user 继续执行**——`followup()` 要求确切在线直接父级；只有 `interrupt()` 接受持久化的人类父级地址。
- **继续执行消息绝不 steering（中途引导）**——父到子的后续消息排入后续轮次；它们绝不会重定向子级当前轮次。
- **取消收敛期间存在唤醒缺口**——中断信号发出后、driver 进入 idle 前被接受的后续消息会保持排队，直到另一条唤醒发送到达。
- **驻留仅限进程内**——Activation inbox 与所有权图不会在两个 harness 进程之间协调；对单个持久化存储的并发访问需要持久化邮箱与跨进程租约协议。
- **不回放已接受但未记录的消息**——崩溃可能丢失从未写入子会话日志、已被接受的提示词；丢失的消息不会自动回放。
- **没有持久化的上报 mailbox**——上报需要在线直接父级，提供的是接受标识，不保证恰好一次投递。
- **生命周期事件只供观察**——影响运行的 `subagent/end` 延续或决策接口仍需等待具体消费方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **跨进程继续执行**——持久化邮箱与租约协议可让两个 harness 进程共享一个持久化存储。
- **可继续 ACP 子级**——需要持久化远程会话 id 与逐子级的继续执行能力声明。
- **host-user 投递**——未来的 host 适配器需要具体的经认证交互，该 seam 才能获得用户投递能力。

</details>
