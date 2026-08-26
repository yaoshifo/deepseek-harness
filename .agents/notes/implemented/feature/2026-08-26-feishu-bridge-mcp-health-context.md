# Agent Note: feishu-bridge MCP degradation surfaces as prompt runtime-context

Status: implemented

English | [中文](2026-08-26-feishu-bridge-mcp-health-context.zh.md)

## Problem

The feishu-bridge daemon reaches several intranet MCP servers through the agentichub gateway (devx-mcp, zeus-devx-database) whose auth tokens expire daily. When a token dies, `dsh-mcp-client` with `failOnStartupError: false` either silently registers no tools at boot or unregisters them after its reconnect attempts are exhausted (connection.ts "tools unregistered") — no error reaches the agent; the only symptom is that the `mcp__<server>__*` tools vanish from the catalog. The agent keeps answering and only discovers the outage by calling a missing tool (or never). The daemon's human operator sees nothing either, because the fix (renewing the token) is a local command the agent could run if it only knew.

## Decision

An opt-in `mcpHealth` config block on the feishu-bridge plugin registers a `feishu-bridge:mcp-health` runtime context (order 130) via `ctx.systemPrompt.context()` when its `servers` list is non-empty. The context text is evaluated at every prompt assembly: for each configured `serverName`, it checks whether any tool in the no-scope registry view (`ctx.tools.schemas()`) has the `mcp__<serverName>__` prefix; each server still missing after `startupGraceSecs` (default 180, guarding the boot connection race) contributes one line — the server name, that its tools are not registered (token expired / connection failed / reconnects exhausted), and the optional `fixHint`. Healthy or within grace returns `''` (empty context text contributes nothing), so steady-state token cost is zero.

Degradation is inferred from tool-registry presence, not connection state: this needs no new event, listener, or state, and the per-assembly evaluation makes recovery automatic (a reconnected server's re-registered tools make the line disappear on the next assembly). The registration is a Cordis effect on the plugin context, so HMR/plugin disposal unregisters the context.

`ctx.tools.schemas()` with no scope enumerates the global tool layer; the daemon's mcp-client rows mount at profile root, so their registrations land there (`ScopedLayers.effect` with an unscoped ctx). This is pinned empirically by `tests/mcp-health-mcp-client.spec.ts`, which boots a real `mcp-client` instance against the real stdio fixture MCP server and asserts the healthy/degraded texts, and by `tests/mcp-health.spec.ts`, which registers the watched tool from a separate plugin fiber (the cross-instance shape) and covers default-off, grace, recovery (unregister → re-register), HMR disposal, and registry-throw containment (read as healthy; the health context must never break assembly).

## Alternatives considered

- **Listen to `tools/change` and keep a cached health map.** Rejected: the cache adds state, an event dependency, and an invalidation edge (the emit carries no payload and fires for scoped restrictions too), while per-assembly evaluation is already the system-prompt contract and self-heals. The per-assembly `schemas()` cost matches what assembly itself pays for its tool projection a moment later.
- **A real health check (ping each server on a timer).** Rejected: the token-expiry failure mode already manifests exactly as missing tools; a timer adds connections, credentials, and a second source of truth that can disagree with what the model actually sees.
- **Surfacing degradation as a chat message / card.** Rejected for this need: the degradation is agent-relevant state (which capabilities are gone, what to run to fix it), not a user notification; runtime-context reaches every new session and render with zero wiring, and the agent can escalate to the user when it matters.
- **Core-side MCP health service.** Rejected: no second consumer today; feishu-bridge owns the deployment knowledge (which servers matter, what the fixHint command is). The module (`src/core/mcp-health.ts`) is the extraction point if one appears.

## Consequences

- New sessions (including subtask children and one-shot forks that keep runtime context) learn a degraded server before their first tool call, with the renewal command inline — the operator no longer needs to notice the outage.
- The detection cannot distinguish cause, reports no precise onset time, and assumes mcp-client rows mount at profile root (an agent-scoped mcp-client instance would read as permanently degraded); documented in the package README's Known Limitations.
- A per-project `mcpServers` visibility mask does not interact with the check: the health text reads registration truth (global view), not per-session visibility, so an intentionally masked-away server is not reported degraded.
