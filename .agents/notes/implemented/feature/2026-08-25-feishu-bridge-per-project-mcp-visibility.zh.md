# Agent Note: Per-project MCP 工具可见性是会话级 deny 掩码，而非 per-project 挂载

Status: implemented

[English](2026-08-25-feishu-bridge-per-project-mcp-visibility.md) | 中文

## Problem

一个 feishu-bridge daemon 在单进程里服务所有配置的项目，而 dsh 的 MCP server 组合是 per-profile 的：一个 `mcp-client` 插件行在 boot 时把某个 server 的工具挂进进程级全局工具注册表，每个项目的每个会话都看得到。只属于某个项目的 MCP server 因此向其他所有项目的每次模型请求收税——每个已注册工具的名称、描述与 JSON schema 都随每次请求发送——同时扩大模型的选择面。ACP `session/new` 能承载会话级 server 的参数拒绝非空值，dsh 也没有 per-project 组合层，因此没有任何配置路径能表达「这个 server 属于那个项目」。

## Decision

`config.projects[].mcpServers` 是 per-project 的 MCP server 名允许列表（缺省 = 不限制、行为不变）。配置后，该项目的 adapter 以可见性掩码拒掉所有非允许 server 的 `mcp__*` 工具——MCP 连接保持进程级全局，改变的只是会话能看到什么。三个创建漏斗承载掩码，全部在 `DshAgentAdapter` 内：

- **会话 setup 钩子**（`withMcpMask` 包装 `buildSessionSetup` 与 one-shot 提示 setup）：在被包装 setup 组装完自己的段之后，枚举 agent 作用域的 schema 视图并调 `tools.restrict({ deny })`。deny 名单在钩子内计算，取自 `restrict` 校验名字所用的同一个未受限视图——setup 时刻先于任何 restriction，视图仍持有全部全局工具。这覆盖普通会话、resume、fork、chatroom 人设（其 `skill` 拒绝与之取交集）与 one-shot 查询。
- **Continuable subtask 子会话**：子会话不继承父会话的限制（agent 作用域设计），因此 `startContinuableChild` 从全局工具视图重算 deny 名单并作为请求的 `toolFilter` 转发——in-process fork/spawn 两个 provider 都声明 `toolFilter` 能力，在子会话创建窗口应用，并持久化进子会话的 descriptor，resume 的子会话保持掩码。

工具到 server 的归属按 mcp-client 命名契约做前缀匹配（`mcp__<serverName>__<rawName>`，容忍身份哈希后缀）；`mcpDenyList` 导出供单测使用，行为由 `tests/agent-dsh/adapter-mcp-mask.spec.ts` 钉住，装配接线由 `tests/assembly-config.spec.ts` 钉住。

## Alternatives considered

- **真正的 per-project MCP 挂载（per-project 插件实例或连接）。** 就此需求拒绝：组合在 boot 时 per-profile 完成、工具注册是进程级全局、「项目」是 dsh core 没有的 feishu-bridge 概念——要买到掩码已全额交付的同一份 token 节省，得动插件生命周期、schema 目录与快照面。连接隔离（凭据、网络）是重审的理由；掩码明确不是权限边界。
- **`allow` 掩码替代 `deny`。** 拒绝：allow 掩码排除一切晚到的名字，HMR 或插件更新新增的一方工具、以及运行时动态注册的工具都会从被掩码会话中悄然消失。deny 掩码放行晚到未点名的全局工具，未来的新一方工具保持可见，过期性被限制在下面的复活边界内。
- **通用 cwd 键控可见性插件（同时服务 web/ACP 会话）。** 拒绝：feishu-bridge 之外没有当前消费者，且 cwd 键控的规则表会与本插件已拥有的项目身份重复（`buildProjectAssembly` 把 `ProjectConfig.mcpServers` 穿进 adapter 配置）。通用需求出现时，`withMcpMask` 是提取点。
- **允许列表里没有 live 工具的条目 fail loud。** 拒绝：会话时刻无法区分拼写错误与宕机，fail loud 会让一个项目的死 server 弄坏该项目所有会话。

## Consequences

- 每个被掩码项目的模型请求去掉非允许 server 的工具 schema（每步复现的节省），Code Mode SDK 绑定被同一 restriction 过滤；未配置的项目与不带 `mcpServers` 的部署不受影响。
- **复活泄漏**：server 在会话启动后重连，其工具作为该会话 deny 名单之外的晚到名字重新出现——deny 掩码放行晚到未点名的全局工具——直到下次会话创建/resume 重算掩码前一直可见。自愈，已记入包 README 的 Known Limitations；core `tools` 的 pattern 化 restriction 是升级路径。
- 掩码是可见性组合，不是权限边界（dsh tools 的 scope 安全非目标）：模型看不到被掩码的工具，但该设计不防御绕过视图的调用方。
