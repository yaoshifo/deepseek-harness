# Agent Note: Workspace MCP discovery — directory-level isolation for .mcp.json sessions

Status: implemented

English | [中文](2026-08-31-workspace-mcp-discovery.zh.md)

## Problem

Claude Code sessions discover MCP servers from the project root's `.mcp.json`, so tools follow the directory a session works in. The harness had only process-global `mcp-client` rows: every session sees every configured server, and per-project hiding requires the bridge's `mcpServers` allowlist masking ([per-project MCP visibility Agent Note](2026-08-25-feishu-bridge-per-project-mcp-visibility.md)). Directories like a dida workspace or a riskai checkout that already carry a Claude Code `.mcp.json` had no way to share it with harness sessions without global rows.

## Decision

### Mount into the agent's own scope, not a standing shared mount

Each session mounts its directory's servers through `agentCtx.plugin(mcp-client, config)` inside its creation-window setup. `bindScopeParent` is single-parent with no public re-link (`packages/core/scope/src/index.ts`), and presets already hold every agent's parent binding, so a cross-agent standing mount would need a second scope chain the layer model does not offer. The cost — one connection and one stdio child process per session — is recorded as a Known Limitation instead of pre-building a connection pool.

### The session header owns the cwd

The setup resolves the cwd from `agentCtx.agent.session.header.cwd` (the association `agent-loop` installs on `Agent.ctx` before setup). Fresh, fork, and resume paths therefore mount by the session's own recorded cwd with no caller threading, and a resumed session keeps the tool set its log was written against.

### Trust is an explicit directory list

`Config.roots` is an explicit list of absolute directory paths; default `[]` means the feature is off. A cwd outside every root mounts nothing and logs an error. The narrow-list rule exists because the session file sandbox permits writes under the session cwd, and MCP child processes are spawned by the daemon through the MCP SDK without the dsh sandbox policy — a writable `.mcp.json` inside a root is executable code for every later session in that directory. Roots isolate other directories; they cannot protect a root from agents working inside it. Each mount logs the file's mtime and content digest so the audit trail names the file revision.

### Directory mounts sit outside the project allowlist mask

The bridge composes the mount around `withProjectToolMask`, not inside it: the mask computes its deny list from the global tool view before directory tools register, so directory-mounted servers are exempt from the per-project `mcpServers` allowlist. The two visibility axes stay independent, the subagent path (whose forwarded deny list is computed from the global view) agrees by construction, and no project needs an allowlist entry for its own directory.

### Parser follows Claude Code's documented behavior

`url` without `type` is a configuration error (skip and log), `type: "sse"` is a distinct transport this client lacks (skip, not mis-map to streamable-http), `streamable-http` is an alias for `http`, `${VAR}` and `${VAR:-default}` expand with unset-without-default kept literally plus a warning, unknown fields are ignored, and a repeated server name inside one file fails the whole file (detected by a raw-text scanner, because `JSON.parse` silently keeps the last duplicate). Relative stdio commands resolve through the daemon PATH — required for the `npx`-shaped entries Claude Code users write, unlike the ACP path's absolute-command rule.

### Bounded startup

Session creation must not inherit an unbounded connect wait per directory server: `mcp-client` gained `startupTimeoutMs` (unset = the previous behavior) and the workspace Config exposes it with a 10 s default, so a hung endpoint delays that directory's session creation by at most the bound and tools register when discovery later completes. The `startupTimeoutMs` field is an upstream seam-feature candidate under the fork principles.

## Alternatives considered

- **A cross-agent standing mount shared by every session in a root** — rejected: `bindScopeParent` is single-parent with no public re-link and presets own each agent's binding, so a shared mount needs a second scope chain the layer model does not offer; per-session mounting costs connections instead of architecture.
- **Subjecting directory mounts to the per-project `mcpServers` allowlist** — rejected: it couples two independent visibility axes, forces allowlist edits in every root directory, and disagrees with the subagent path whose forwarded deny list is computed from the global view.
- **Mapping `type: "sse"` entries to streamable-http** — rejected: SSE is a distinct transport; the mapping would silently misconfigure every SSE-only endpoint instead of reporting the skip.
- **Keeping `JSON.parse` last-wins semantics for repeated server names** — rejected: a silent loser server is a misconfiguration the file author cannot see; the raw-text scanner makes the duplicate a file-level failure.
- **Slug-plus-hash normalization for names outside `[A-Za-z0-9_-]{1,32}`** (the ACP path's rule) — rejected for files: a `.mcp.json` is editable on the spot, so a readable skip message beats a stable generated name.
- **Leaving the startup wait unbounded like global rows** — rejected: a global row can hang daemon startup once, but a directory row would hang that directory's every session creation.

## Consequences

- Tool visibility is decided by the session header cwd plus the on-disk file, the same class of external asset as skills: no new session events, and agent-loop and both SDK surfaces are untouched.
- Known divergence, same strictness class as global `mcp-client` rows: replaying an old session after its `.mcp.json` changed no longer reproduces the original tool set. The composition test pins the tool-name set and one real tool call; a keyless recorded-session snapshot still needs an API key to record.
- Same-named global rows are shadowed inside a session without a warning: mcp-client's name reservations are per scope, so the service cannot observe global names.
