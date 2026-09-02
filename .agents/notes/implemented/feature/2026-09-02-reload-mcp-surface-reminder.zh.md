# Agent Note: feishu-bridge reload 完成通知附带 MCP 工具面提醒

Status: implemented

[English](2026-09-02-reload-mcp-surface-reminder.md) | 中文

## Problem

2026-08-26，live daemon 一夜之间静默多出 95 个 MCP 工具：devx-mcp（71）+ zeus-devx-database（16）+ zai-vision（8）经三条 profile 条目挂载，把请求推到 130 个工具 / ~100k 字符（≈25k tokens）的工具 schema，波及 115 个会话，约两天后才被手工卸载（2026-09-02 对 `~/.dsh/feishu-bridge-sessions` 存储的会话日志扫描；`request/header` 携带每请求的精确工具数组）。更早的 mcp-ssh-manager（37 个工具）也是同样下场——profile 里一句手写注释："37 个工具 schema 每轮都进请求，上下文成本不值"。缺口在可见性而非权限：没有任何机制在运维改 MCP 配置的那一刻告诉他工具面刚变重了。`/reload` 正是那一刻——运维刚改完 profile、daemon 刚按新配置重启、运维还在聊天里看着完成通知。

## Decision

只提醒、绝不拦截（2026-09-02 用户拍板）：安装 MCP server 的运维对其体量负责；加载行为零变化、不新增任何 Config。`completePendingReload`（`packages/acp/feishu-bridge/src/engine/reload-commands.ts`）现在接收进程全局工具视图，完成通知送达后，当 mcp-client 工具总数超过 20（严格大于）时，经同一平台与回复上下文再发一条消息：总数 + 每 server 分布（最重在前）+ 一句建议（这些 schema 每轮模型请求都会携带；未使用的 server 可在 profile 中禁用）。新 i18n 词条 `reload_mcp_surface_reminder`（en/zh，随 reload 族）。

计数落在 `core/mcp-health.ts` 的纯函数 `mcpToolCounts()`（作用于公开工具名，复用 `splitMcpToolName`）——reload-commands 成为 mcp-health 命名域的第二个包内消费者；[mcp-health note](2026-08-26-feishu-bridge-mcp-health-context.zh.md) 曾在拒绝 core 侧服务时点名该模块为抽取点，本次仍留在包内。失败隔离与完成通知同构：提醒发送或注册表读取失败只 warn 到 console，绝不影响通知送达与标记清理。

阈值是产品常量而非 Config 字段：现役 5 个；13 个曾连续多天无异议；95 与 37 均被手工否决——20 落在「容忍」与「否决」之间，且与预登记的延迟工具面触发线（MCP 工具 > 20 → 再议）一致。

## Alternatives considered

- **在 dsh-mcp-client 里做每 server 硬预算（`maxTools`），挂载时 fail-loud。** 已完整设计后被用户否决：会拦加载的门夺走了运维对自己安装物的控制权，还为 prompt caching 本已吸收的成本引入 fail-loud 语义（fiber 拒绝、`failOnStartupError` 交互、重连重同步）。
- **mcp-client 同步时按 server 打 warn 日志。** 暂缓：跨两个包翻倍改动面，而 reload 时刻才是运维行动的时刻，持续性日志已有每日错误日报兜底。
- **把提醒折进完成通知正文。** 否决：既有消息保持原样，且提醒只在超线时发送，普通 reload 仍然只发一条消息。
- **按 schema 字节数设阈值。** 暂缓：诚实的字节口径需要稳定的按定义 wire 渲染（`ToolRuntime.schemaOf` 是 private）；工具数同时命中两次已观察事故（37、71），也符合用户的框架。

## Consequences

- 提醒只统计进程全局视图（profile 根挂载的 mcp-client 行）；mcp-workspace 按 agent 作用域挂载的 `.mcp.json` 不计入——与 mcp-health 检测文档化的同一限制，且 live 部署的 server 全部是 profile 级。
- 计数是完成通知送达时刻的快照：仍在 `startupTimeoutMs` 窗口内的 server 可能被漏计。
- 无 pending marker 的普通冷启动什么都不发——没有运维在场、也没有变更发生；提醒只随 marker 门控的完成通知走。
- `tests/reload-completion.spec.ts` 钉死超线提醒（总数 + 最重在前的分布）、精确边界（20 静默、21 提醒）、发送失败隔离、无 marker 路径；`mcpToolCounts` 由 `tests/mcp-health.spec.ts` 钉死。
- 若工具面常态化超线，既定的下一步是 codex 式延迟工具面（`tool_search`）而非调高阈值；决策台账在 lsp 采用率调研与 codex 审计中。
