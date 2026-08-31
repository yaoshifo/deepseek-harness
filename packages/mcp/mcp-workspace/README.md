---
description: "Directory-scoped MCP discovery for deployments and maintainers: sessions working inside a configured root directory mount that directory's Claude Code-compatible .mcp.json servers into their own agent scope."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-workspace

English | [中文](README.zh.md)

## Summary

`dsh-mcp-workspace` gives the harness Claude Code-equivalent directory-level MCP isolation: a session whose working directory holds a Claude Code-compatible `.mcp.json` gets those MCP servers mounted as tools visible only to that session's agent scope, under the same `mcp__<serverName>__<tool>` names mcp-client uses. Sessions in other directories see nothing from that file, without per-project allowlist configuration. Discovery trusts an explicit `roots` list of absolute directory paths — nothing mounts outside a root — and nothing ships enabled. The main costs are one connection (and for stdio servers, one child process) per session in a root directory, and a `startupTimeoutMs`-bounded wait during session creation.

## Table of Contents

- [Summary](#summary)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Use this package

The plugin is a Host service (`ctx.mcpWorkspace`). Load it from `cordis.yml` and list the directories whose sessions may mount their own `.mcp.json`:

```yaml
- id: mcp-workspace
  name: '@deepseek-ai/dsh-mcp-workspace'
  config:
    roots:
      - /home/hm/workspace/dida
      - /home/hm/workspace/riskai
    startupTimeoutMs: 10000
```

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Absolute directory paths; a session cwd equal to or under a root mounts its `.mcp.json`, any other cwd mounts nothing and logs an error |
| `startupTimeoutMs` | `10,000` | Cap each server's initial connection + tool discovery during session setup; tools register late when a server exceeds it |

Consumers compose the mount at session creation: the feishu-bridge adapter (fresh, fork, and resume paths, outside the per-project `mcpServers` mask), the API session controller's `composeAgent`, and the subagent child factory (children mount by their own cwd). `/mcp` lists a chat's directory mounts through `mountedFor(cwd)`. Consumers whose profile did not load the plugin skip the feature and warn once per process.

A `.mcp.json` in a trusted directory follows the Claude Code project format. The parser maps entries the way Claude Code documents them; misconfigured entries are skipped with a logged problem rather than failing the session:

| Entry | Mapping |
|---|---|
| no `type` or `type: "stdio"` with `command` | stdio transport; the child runs in the `.mcp.json` directory |
| `type: "http"` (alias `type: "streamable-http"`) with `url` | streamable-http transport |
| `url` without `type` | configuration error: skipped (Claude Code reports the same misconfiguration) |
| `type: "sse"` | skipped: this client has no SSE transport |
| `command` together with `url`, `type: "ws"`, unknown types | skipped |
| unknown fields (e.g. Claude Code's `alwaysLoad`) | ignored |

`${VAR}` and `${VAR:-default}` references expand in `command`, `args`, `env` values, `url`, and `headers` values against the daemon process environment; an unset variable without a default stays as the literal `${VAR}` text with a warning, exactly like Claude Code. A server name repeated inside one file fails the whole file (all servers skipped). Server names must match `[A-Za-z0-9_-]{1,32}`.

## Understand the implementation

The service is a class plugin extending Cordis `Service`, registered as `ctx.mcpWorkspace`. `wrap(setup)` composes the mount onto a creation-time `AgentSetup`: the inner setup runs first (its publication commit propagates), then every mapped server mounts into the unpublished agent's scope through `agentCtx.plugin(mcp-client, config)`, so the tools disappear with the agent and never leak into the process-global tool view. The session cwd resolves inside the setup from `agentCtx.agent.session.header.cwd`, which makes fresh, fork, and resume paths mount by the session's own recorded cwd without callers threading it through. `mountedFor(cwd)` re-reads the same file for `/mcp` display. Duplicate server names in the raw text are detected by a scanner (JSON.parse silently keeps the last duplicate), and each mount logs the file's mtime and content digest so the audit trail can answer which file revision put which servers into a session.

### Source map

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: `Config` (roots/startupTimeoutMs), `wrap`/`mount`, `mountedFor`, roots trust check, provenance logging |
| [`src/parse.ts`](src/parse.ts) | Claude Code-compatible `.mcp.json` parsing: mapping, skips, duplicate detection, `${VAR}` expansion |
| [`src/types.ts`](src/types.ts) | Types only |
| [`src/invariant.ts`](src/invariant.ts) | Package invariant companion (no runtime invariant; the tool registry owns the observable state) |

## Model Experience

### Directory-mounted MCP tools

#### What the model sees

Sessions whose cwd is inside a configured root see the `.mcp.json` servers' tools as native tools named `mcp__<serverName>__<rawName>` with the server-provided descriptions and input schemas, exactly like global mcp-client rows. Sessions in other directories, and the process-global tool view, never see them. A same-named global row is shadowed by the directory mount inside that session.

#### Token effect

Directory tool definitions enter every request of sessions in the root directory while mounted; sessions elsewhere pay nothing. Late registration after a `startupTimeoutMs` miss adds the definitions from the session's next request onward.

#### KV Cache effect

The directory tool-definition prefix is stable while the mounted set is unchanged. Edits to the `.mcp.json` affect only sessions created afterwards, so existing sessions keep a reusable prefix; a late-registering server replaces definitions and may invalidate reuse from the first changed schema token onward.

## Known Limitations and Deferred Work

- **MCP child processes bypass the dsh sandbox policy** — stdio servers named in a `.mcp.json` are spawned by the daemon through the MCP SDK, not under the session's file-sandbox policy; a `.mcp.json` writable by a sandboxed agent inside a root is executable code for every later session in that directory. `roots` must stay narrow, and interactive per-server approval (Claude Code's project-server approval) is deferred.
- **No connection sharing** — every session in a root directory opens its own connection; a stdio server means one child process per session, and parallel subtasks in the same directory multiply that. A shared pool in the mcp-client transport layer is deferred.
- **No upward traversal and no file watching** — only the session cwd's `.mcp.json` is read, and edits affect only sessions created afterwards.
- **`type: "sse"` is not supported** — entries are skipped with a logged problem; adding an SSE transport to mcp-client is deferred.
- **Relative stdio commands resolve through the daemon PATH** — unlike the ACP path, which requires absolute commands; a planted `.mcp.json` can name anything on PATH.
- **Same-named global servers are shadowed without a warning** — the scoped registration wins inside the session and the global instance keeps serving every other session; mcp-client's name reservations are per scope, so the service cannot see global names.
- **A recorded keyless session snapshot needs an API key to record** — the composition test pins the model-visible tool names and a real tool call; the session-driven snapshot remains to be recorded when a key is available.
