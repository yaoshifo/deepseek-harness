---
description: "MCP 包组：连接外部 Model Context Protocol 服务器，调用其工具并读取其资源。"
kind: "package-group"
---

# MCP — 模型上下文协议

[English](README.md) | 中文

## 概述

`mcp/` 组把 harness 连接到 Model Context Protocol（MCP）工具服务器生态。客户端包挂载外部服务器——文件系统、GitHub、数据库或记忆服务器——让模型把它的工具当作原生工具、以稳定的服务器限定名称使用，其资源可通过共享资源包读取，连接还提供服务器指令；workspace 包把会话目录下 Claude Code 兼容的 `.mcp.json` 挂载进该会话自己的 scope。只需配置 `mcp-client` 条目（或受信根目录内的一份 `.mcp.json`）；默认不启用任何服务器，因此按需逐台开启，而随附 profile 已统一挂载 `mcp-resources` 一次。只有作用域中存在已配置服务器的调用方才会看到 MCP 工具与提示词文本。本页映射该组；配置与限制由各包的 README 说明。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

客户端拥有每个已配置连接；共享资源包为这些连接提供资源工具，workspace 包则挂载目录级 `.mcp.json` 服务器。

| 包 | 提供的能力 |
|---|---|
| [`mcp-client/`](mcp-client/README.zh.md) | 连接一台 MCP 服务器，暴露其工具与指令，并提供其资源操作 |
| [`mcp-resources/`](mcp-resources/README.zh.md) | 通过显式选择服务器的共享工具发现和读取资源 |
| [`mcp-workspace/`](mcp-workspace/README.zh.md) | 把会话目录下 Claude Code 兼容的 `.mcp.json` 服务器挂载进该会话自己的 agent scope |

-----

<a id="related-documentation"></a>
## 相关文档

先用可运行的示例配置体验插件，再阅读 Agent Note 了解其背后的行为决策。

- [MCP 客户端插件 Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.zh.md)——桥接的设计：服务器限定命名、发现、执行与环境清洗。
- [资源与指令 Agent Note](../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.zh.md)——按需资源访问与作用域服务器指引。
- [workspace MCP 发现 Agent Note](../../.agents/notes/implemented/feature/2026-08-31-workspace-mcp-discovery.zh.md)——目录级隔离：scope 取舍、信任模型与 Claude Code 格式对齐。
- [第三方记忆 MCP 指南](../../docs/user/guide/mcp-memory.zh.md)——可运行的 overlay 配置行与设置说明。
- [工具子系统参考](../../docs/subsystems/tools.zh.md)——接收已注册工具的 `ToolRuntime`。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
