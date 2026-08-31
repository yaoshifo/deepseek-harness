# Agent Note: workspace MCP 发现——.mcp.json 会话的目录级隔离

Status: implemented

[English](2026-08-31-workspace-mcp-discovery.md) | 中文

## Problem

Claude Code 会话从项目根目录的 `.mcp.json` 发现 MCP 服务器，工具跟随会话所在目录。harness 此前只有进程级全局 `mcp-client` 行：所有会话看到全部已配置服务器，按项目隐藏只能靠 bridge 的 `mcpServers` 白名单遮罩（[per-project MCP visibility Agent Note](2026-08-25-feishu-bridge-per-project-mcp-visibility.zh.md)）。dida 工作区、riskai 检出这类已带 Claude Code `.mcp.json` 的目录，无法在不建全局行的前提下与 harness 会话共享。

## Decision

### 挂进 agent 自有 scope，不做常驻共享挂载

每个会话在自己的创建窗口 setup 内经 `agentCtx.plugin(mcp-client, config)` 挂载其目录的服务器。`bindScopeParent` 是单亲绑定且无公开 re-link（`packages/core/scope/src/index.ts`），preset 已持有每个 agent 的父绑定，跨 agent 常驻挂载需要层模型不提供的第二条 scope 链。代价——每会话一条连接、stdio 服务器每会话一个子进程——记为 Known Limitation，而不是预建连接池。

### 会话头持有 cwd

setup 从 `agentCtx.agent.session.header.cwd` 解析 cwd（`agent-loop` 在 setup 前安装在 `Agent.ctx` 上的关联）。fresh/fork/resume 三条路径因此按会话自身记录的 cwd 挂载，调用方无需传递；resume 的会话保持与其日志写入时一致的工具集。

### 信任是显式目录清单

`Config.roots` 是显式绝对目录路径数组；默认 `[]` 即特性关闭。cwd 在所有 root 之外则不挂载并记 error 日志。收窄清单的原因：会话文件沙箱允许写 cwd 子树，而 MCP 子进程由 daemon 经 MCP SDK 直接 spawn、不经过 dsh 沙箱 policy——roots 内可写的 `.mcp.json` 对该目录后续每个会话都是可执行代码。roots 隔离的是其他目录，保护不了 root 内工作的 agent。每次挂载记录文件的 mtime 与内容摘要，审计线索可指认文件版本。

### 目录挂载位于项目白名单遮罩之外

bridge 把挂载组合在 `withProjectToolMask` 外层而非内层：遮罩在目录工具注册前从全局工具视图计算 deny 列表，目录挂载的服务器因此不受项目 `mcpServers` 白名单约束。两条可见性轴保持独立，子任务路径（转发的 deny 列表从全局视图计算）天然一致，任何项目无需为自己的目录加白名单。

### 解析器遵循 Claude Code 文档行为

有 `url` 无 `type` 是配置错误（跳过并记录）；`type: "sse"` 是本客户端缺失的独立传输（跳过，不误映射为 streamable-http）；`streamable-http` 是 `http` 的别名；`${VAR}` 与 `${VAR:-default}` 展开，缺失且无默认时保留字面文本并告警；未知字段忽略；单文件内重复 server 名导致整个文件失败（由原始文本扫描器检测，因为 `JSON.parse` 会静默保留最后一个重复项）。stdio 相对 command 经 daemon PATH 解析——Claude Code 用户写的 `npx` 形态条目依赖这一点，与 ACP 路径的绝对 command 规则不同。

### 有界启动

会话创建不能为每个目录服务器继承无上限的连接等待：`mcp-client` 增加 `startupTimeoutMs`（未设置即原行为），workspace Config 以 10 s 默认值暴露，挂死的端点最多将该目录的会话创建延迟到该上限，工具在发现完成后注册。`startupTimeoutMs` 字段按 fork 原则是上游 seam-feature 候选。

## Alternatives considered

- **跨 agent 的常驻共享挂载，同 root 会话共用** — 否决：`bindScopeParent` 单亲且无公开 re-link，preset 持有每个 agent 的绑定，共享挂载需要层模型不提供的第二条 scope 链；按会话挂载的代价是连接数而非架构。
- **让目录挂载服从项目 `mcpServers` 白名单** — 否决：把两条独立可见性轴耦合起来，逼迫每个 root 目录改白名单，且与子任务路径（转发 deny 列表从全局视图计算）不一致。
- **把 `type: "sse"` 条目映射成 streamable-http** — 否决：SSE 是独立传输；该映射会让每个 SSE-only 端点静默错配，而不是报告跳过。
- **对重复 server 名保留 `JSON.parse` 的 last-wins 语义** — 否决：静默落败的服务器是文件作者看不见的误配；原始文本扫描器让重复成为文件级失败。
- **对 `[A-Za-z0-9_-]{1,32}` 之外的名字做 slug+hash 规范化**（ACP 路径的规则） — 文件场景否决：`.mcp.json` 就地可改，可读的跳过消息优于稳定的生成名。
- **沿用全局行的无上限启动等待** — 否决：全局行最多拖慢一次 daemon 启动，目录行会拖慢该目录每一次会话创建。

## Consequences

- 工具可见性由会话头 cwd 加磁盘文件决定，与 skills 同类的外部资产论证：不新增 session 事件，agent-loop 与两端的 SDK 面不动。
- 已知发散，严格度与全局 `mcp-client` 行同类：`.mcp.json` 改动后回放旧会话不再复现原工具集。composition 测试钉住工具名集合与一次真实工具调用；keyless 录制会话快照仍需 API key 才能录制。
- 同名全局行在会话内被遮蔽且无告警：mcp-client 的名字保留按 scope 分键，本服务看不到全局名单。
