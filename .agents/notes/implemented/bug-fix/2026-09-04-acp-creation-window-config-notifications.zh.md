# Agent Note: Silent ACP session-creation window for config-option notifications

Status: implemented

[English](2026-09-04-acp-creation-window-config-notifications.md) | 中文

## Problem

每个 ACP `session/new` 都可能在响应之后立刻发出一条 `config_option_update` 的 `session/update` 通知，重复响应自身携带的 `configOptions`。该发射是异步副作用而非设计步骤：组装会话时挂载 agent 作用域的 provider 插件，其适配器注册触发 `llm/adapters-updated`，桥接层的 `topologyChanged()` 随后在链外解析选项并把通知排进会话的输出队列。通知能否在会话关闭前抵达客户端因此是一场竞态。`cancel` 快照场景——提示词、就绪文件、立即取消——大约每四跑输一次：通知要么晚于客户端停止读取，要么被 `topologyChanged` 的 closing 守卫丢弃，expected stdout 丢失第二行。快照套件唯一的场景级 flake 即源于此产品级非确定性。

## Decision

会话创建窗口保持静默：`AcpSession` 构造时拓扑通知未武装（unarmed），`topologyChanged()` 在未武装或 closing 时直接返回。创建处理器——`session/new` 与 `session/resume` 同样处理——只在响应的选项发现完成后、返回之前武装通知。响应即初始配置状态（ACP 契约本就把 `configOptions` 放在响应上）；`config_option_update` 只发布其后发生的拓扑变化。落在窗口内的拓扑变化不会丢失：响应所 await 的发现已反映其产生的状态。

## Alternatives considered

**在响应前确定性地发射创建期通知。** 保留现有线上字节，但需要与窗口内的偶发发射去重（两者都会发）并对 RPC 响应写入做顺序保证——为一封无客户端消费的回声造机器。败给静默。

**让快照 harness 等到通知到达再取消。** 钉住了场景，却把产品竞态留给每个真实的快速客户端。作为 flake 掩盖否决。

**在快照套件中把该通知行归一化掉。** 违反 fixture 优先于 normalizer 的规则，并使产品行为变化脱离评审视野。

## Consequences

外部 ACP 客户端不再在会话创建时收到 `config_option_update` 回声；初始状态读自创建响应，ACP 协议本就如此提供。仓库内无客户端消费该通知（唯一发射点就是桥接层自身；subagent-acp、SDK、API BFF 都没有监听）。会话中段的拓扑变化——创建响应之后的适配器注册、替换或释放——仍与从前完全一样发布完整选项，由既有 bridge spec 钉住。`cancel` 场景此后字节级稳定：连续十次回放全绿，无 key 快照套件全量回放绿。

## Testing

回归测试是确定性的而非概率性的：一个 bridge spec 在创建窗口内注入一次适配器注册（通过 `listModels` spy 在发现中途注册 provider）、窗口后再注入一次，然后断言只到达一条 `config_option_update`——来自窗口后的注册、宣告窗口后的 provider。修复前该断言看到两条通知；修复后一条。全部 54 个 bridge spec 与刷新后的十个 ACP 场景 expected（各删去冗余行）回放全绿。

## Related

- [LLM model catalog and ACP selection](../../archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.md) —— 其目录与选择机制的每会话挂载触发了本 Note 在创建窗口内静默的拓扑事件。
