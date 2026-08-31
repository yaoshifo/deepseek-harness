# Agent Note: dsh-memory 子代理工具门

Status: implemented

[English](2026-08-31-dsh-memory-subagent-tool-gate.md) | 中文

## Problem

包 README 声称三个模型可见面均只作用于顶层 POSIX-cwd 会话（"subagents get none"），但该门只存在于系统提示 section 渲染器（`origin === 'subagent'`）与索引注入监听器（任意 origin 值）中。五个工具注册在 `ctx.tools` 上且没有任何 origin 检查，而 subagent 子上下文默认继承父级工具，除非组合配置了 `toolFilter`（[child-agent.ts](../../../../packages/subagent/subagent/src/child-agent.ts)），因此带 POSIX cwd 的 subagent 可以执行 `memory_*` 调用。它将在没有记忆策略 section 的情况下运行——没有索引纪律、没有"什么不该存"的规则——且其 worktree cwd 会让写入落进一个没有任何会话会读的临时 worktree-slug 目录。单元测试断言了 subagent 拿不到 section，却从未覆盖工具面。

## Decision

`resolveCall`——每个工具 `execute` 都经过的唯一入口——在解析 scope 之前拒绝 subagent-origin 的 agent，抛出 `memory tools are unavailable for subagent sessions`。它与 section 的门完全镜像，一处覆盖两个 scope，且不动 agentless 调用的既有错误。强制落在做决策的操作上，与本包其他执行期门（无 cwd、非 POSIX cwd、全局 scope 关闭）一致。oneshot 旁路会话保留工具访问：它们能拿到策略 section，其工具可用性与它们可见的指引一致——排除它们的只有注入。两项机械加固随行：invariant companion 的转义检查现在拒绝结尾框架闭合标签之前的任何字面闭合标签（此前正文中段未转义标签加正常结尾可以通过），`listMemory` 对目录读取与逐文件 stat 之间被删除的文件跳过而非抛出裸 ENOENT。

## Alternatives considered

**经 agent 作用域工具注册做 schema 级隐藏。** ToolRuntime 支持按 agent 的 schema 可见性，但本包其他会话门都是执行期响亮报错；一处一个强制机制胜过两处，且 schema 隐藏的工具对直接 `ctx.tools.execute` 的调用方仍需要拒绝路径。

**把 oneshot origin 一并门掉。** 注入排除所有 origin 值，但 oneshot 旁路会话仍拿到策略 section（其 cwd 就是项目 cwd），拒绝其工具等于拒绝其自身指引描述的能力。维持不变。

**把记忆目录注册为沙箱可写根，让通用工具服务 subagent。** 此前已被 [memory index maintenance](2026-08-17-memory-index-maintenance.md) 否决——非本地文件系统 provider 下通用工具会写错机器——本门不改变该结论。

## Consequences

单元测试经真实工具执行器在两个 scope 上钉住拒绝行为，README 稳定失败清单（双语）携带新错误。无快照变更：顶层会话毫无差异，拒绝是错误路径，该范围决策记录于此。确实需要记忆访问的 subagent 由其父会话中转调用；尚未观察到此类需求。
