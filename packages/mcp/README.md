---
description: "The MCP package group: connect external Model Context Protocol servers, call their tools, and read their resources."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group connects the harness to the Model Context Protocol (MCP) ecosystem of tool servers. The client package attaches an external server — a filesystem, GitHub, database, or memory server — so its tools are available to the model as native tools under stable server-qualified names, its resources are readable through the shared resource package, and connections also supply server instructions; the workspace package mounts a session directory's Claude Code-compatible `.mcp.json` into that session's own scope. Configure only `mcp-client` entries (or one `.mcp.json` inside a configured root); nothing ships enabled, so you opt in per server, and shipped profiles already mount `mcp-resources` once. MCP tools and prompt text appear only for callers with a configured server in scope. This page maps the group; the package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The client owns each configured connection; the shared resource package supplies resource tools across those connections, and the workspace package mounts directory-level `.mcp.json` servers.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Connect one MCP server, expose its tools and instructions, and provide its resource operations |
| [`mcp-resources/`](mcp-resources/README.md) | Discover and read resources through shared tools with explicit server selection |
| [`mcp-workspace/`](mcp-workspace/README.md) | Mount a session directory's Claude Code-compatible `.mcp.json` servers into that session's own agent scope |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [MCP client plugin Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [Resources and instructions Agent Note](../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — on-demand resource access and scoped server guidance.
- [Workspace MCP discovery Agent Note](../../.agents/notes/implemented/feature/2026-08-31-workspace-mcp-discovery.md) — directory-level isolation: the scope choice, the trust model, and the Claude Code format alignment.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
