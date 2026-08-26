# Agent Note: feishu-bridge 的 MCP 降级以 prompt runtime-context 呈现

Status: implemented

[English](2026-08-26-feishu-bridge-mcp-health-context.md) | 中文

## Problem

feishu-bridge daemon 经 agentichub 网关接入多个内网 MCP server（devx-mcp、zeus-devx-database），其鉴权 token 每日过期。token 失效后，`dsh-mcp-client` 因 `failOnStartupError: false` 要么启动时静默不注册工具，要么重连耗尽后注销工具（connection.ts 的 "tools unregistered"）——错误不会到达 agent，唯一症状是 `mcp__<server>__*` 工具从目录中消失。agent 照常应答，只有调用缺失工具时（或永远）才发现故障。守护进程的人类运维者同样看不到任何信号，而修复手段（续期 token）恰恰是 agent 知道后就能自己执行的本地命令。

## Decision

feishu-bridge 插件新增 opt-in 的 `mcpHealth` 配置块：`servers` 列表非空时，经 `ctx.systemPrompt.context()` 注册 `feishu-bridge:mcp-health` runtime context（order 130）。context text 在每次 prompt 组装时求值：对每个配置的 `serverName`，检查无 scope 的注册表视图（`ctx.tools.schemas()`）中是否存在 `mcp__<serverName>__` 前缀的工具；超过 `startupGraceSecs`（默认 180，防启动连接竞态误报）仍缺失的 server 各贡献一行——server 名、其工具未注册（token 过期 / 连接失败 / 重连耗尽）、可选的 `fixHint`。全部健康或宽限期内返回 `''`（空 context text 零贡献），稳态 token 开销为零。

降级由「工具注册表存在性」推断而非连接状态：不需要新事件、监听器或状态，且逐次组装求值让恢复自动发生（server 重连并重注册工具后，下一行组装即消失该行）。注册本身是插件 context 上的 Cordis effect，HMR / 插件卸载自动注销 context。

`ctx.tools.schemas()` 无参调用枚举全局工具层；daemon 的 mcp-client 各行挂载在 profile 根层，注册因此落在全局层（`ScopedLayers.effect` 收到无 scope 的 ctx）。这一语义由 `tests/mcp-health-mcp-client.spec.ts` 经验性钉住——它用真 `mcp-client` 实例连接真实的 stdio fixture MCP server 并断言健康/降级文本；`tests/mcp-health.spec.ts` 则从独立插件 fiber 注册被监视工具（跨实例形态），覆盖缺省关闭、宽限期、恢复（注销→重注册）、HMR 卸载与注册表抛错的兜底（按健康处理，健康 context 绝不能弄崩组装）。

## Alternatives considered

- **监听 `tools/change` 维护缓存的健康映射。** 否决：缓存引入状态、事件依赖与失效边界（该 emit 无 payload 且 scoped restriction 也会触发），而逐次组装求值本就是 system-prompt 的既有契约且自愈；每次组装的 `schemas()` 开销与组装自身随后的工具投影同量级。
- **真实健康检查（定时 ping 各 server）。** 否决：token 过期的故障形态已经精确表现为工具缺失；定时器增加连接、凭证与第二个可能与模型所见不一致的事实源。
- **以聊天消息 / 卡片呈现降级。** 否决：降级是 agent 相关状态（哪些能力没了、跑什么命令能修），不是用户通知；runtime-context 零接线地到达每个新会话与渲染，需要时 agent 自会向用户上报。
- **在 core 侧做 MCP 健康服务。** 否决：今天没有第二消费者；哪些 server 重要、fixHint 命令是什么，这些部署知识归 feishu-bridge 所有。模块（`src/core/mcp-health.ts`）是将来出现通用需求时的抽取点。

## Consequences

- 新会话（含保留 runtime context 的 subtask 子会话与 one-shot fork）在第一次工具调用前即知某 server 已降级，且续期命令就在上下文里——运维者不再需要先于 agent 发现故障。
- 检测无法区分降因、不报告精确起始时刻，且假设 mcp-client 各行挂载在 profile 根层（agent-scoped 的 mcp-client 实例会被判为永久降级）；已写入包 README 的 Known Limitations。
- 项目的 `mcpServers` 可见性掩码与该检测不互相影响：健康文本读注册真值（全局视图）而非 per-session 可见性，被有意掩蔽的 server 不会被报为降级。
