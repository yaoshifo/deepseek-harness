# Agent Note: TS 原生 /skills 与 /mcp 能力查询命令

Status: implemented

[English](2026-08-28-feishu-bridge-skills-mcp-commands.md) | 中文

## Problem

用户在聊天里没有任何方式查看当前进程加载了什么。skill 目录只以模型侧的 `<available_skills>` 发布存在，MCP 服务器只能通过其 `mcp__*` 工具名间接观察——唯一的查询途径是问 bot 本身，这要烧掉一个模型回合，而 bare-persona/render 会话（deny 了 `skill` 工具）根本无法回答。`/status` 两样都不展示。

## Decision

`src/engine/skills-mcp-commands.ts` 通过 `Engine.registerCommand` seam 注册两条只读命令（help 分组 `tools`、≥2 字符前缀匹配），接收一个窄接口 `SkillsMcpCommandDeps`，由 `buildProjectAssembly` 注入数据闭包：`listSkills`（`ctx.get('skills')` 为 undefined 时缺省——命令回复「不可用」而非抛错）、`toolNames`（进程全局 `ctx.tools.schemas()` 名单，与 mcpHealth 运行时上下文同一读法）、可选 `healthServers`（`mcpHealth` 配置）、可选 `allowlist`（项目级 `mcpServers`）。

`/skills` 按聊天工作目录渲染 skill 注册表的 invocation-neutral `list({ cwd })`（与 provider 相同的发现基础），描述截 80 rune，模型不可调用的条目标注为仅命令面。`/mcp` 按首个 `__` 切分 `mcp__<server>__*` 名字分组，健康监视中但无在线工具的服务器标注降级，白名单外的在线服务器标注隐藏；每个服务器最多列 8 个工具名，超出显示 `+N`。

命名：Go cc-connect 从未有 `/skills` 命令（2026-08-21 审计已勘误为文档笔误），因此两条命令与 `/reload` 一样是 TS 原生新增而非移植；2026-08-21 的命令筛选裁定不受影响。

## Alternatives considered

**Engine setter 注入**（`setCronScheduler` 模式）：否决——命令不持有 engine 状态，只读装配期闭包；注册时传 deps 与 chatroom seam 一致。

**会话内视图**（live agent 自己的目录视图，含其运行时注册）：作为已记录的天花板推迟——`/skills` 以进程级发现按聊天工作目录作答，取 agent 的 `ScopeKey` 会让引擎耦合 adapter 内部，换来的保真度有限。

## Consequences

`/help` 的工具分组自动列出两条命令（从注册表生成）。i18n 按 reload key 的追加风格新增 13 个 en+zh 键。两个视图的边界都写进了各自 usage 文案：`/skills` 是发现视图而非 live agent 的 scoped 目录；`/mcp` 是进程全局工具注册表，项目级遮蔽只标注、不在此强制。

## Testing

`tests/engine/skills-mcp-commands.spec.ts`（10 例）：表合并 + tools 分组 + resolver 优先级；/skills 的不可用/空/有料路径（仅命令面标注、80 rune 截断、cwd 透传）；/mcp 的分组/遮蔽/降级/空路径（8 工具截断、不可解析名字不建组）；≥2 字符前缀与单字符落空；卡片与纯文本平台分叉；dispose 后 resolver 还原。
