# Agent Note: feishu-bridge reload completion notice carries an MCP tool-surface reminder

Status: implemented

English | [中文](2026-09-02-reload-mcp-surface-reminder.zh.md)

## Problem

On 2026-08-26 the live daemon silently gained 95 MCP tools overnight: devx-mcp (71) + zeus-devx-database (16) + zai-vision (8) mounted through three profile rows, pushing requests to 130 tools / ~100k chars (~25k tokens) of tool schema across 115 sessions before the servers were unmounted by hand about two days later (2026-09-02 session-log scan of the `~/.dsh/feishu-bridge-sessions` store; `request/header` carries the exact per-request tool array). An earlier server, mcp-ssh-manager (37 tools), had been rejected the same way — a hand-written profile comment: "37 个工具 schema 每轮都进请求，上下文成本不值". The gap was visibility, not permission: nothing tells the operator, at the moment they change the MCP configuration, that the surface just got heavy. `/reload` is that moment — the operator just edited the profile, the daemon just restarted on it, and the operator is in the chat holding the completion notice.

## Decision

Warn, never block (user ruling 2026-09-02): the operator who installs an MCP server owns its size; loading behavior is untouched and no new Config exists. `completePendingReload` (`packages/acp/feishu-bridge/src/engine/reload-commands.ts`) now takes the process-global tool view and, after the completion notice is delivered, sends one more message through the same platform and reply context when the mcp-client tool total exceeds 20 (strictly): the total plus the per-server breakdown, heaviest first, plus one advisory sentence (the schemas ride along on every model request; disable unused servers in the profile). New i18n key `reload_mcp_surface_reminder` (en/zh, reload family).

Counting lives in `core/mcp-health.ts` as the pure `mcpToolCounts()` over public tool names, reusing `splitMcpToolName` — reload-commands becomes the second in-package consumer of the mcp-health naming domain; the [mcp-health note](2026-08-26-feishu-bridge-mcp-health-context.md) rejected a core-side service while naming the module as the extraction point, and this stays inside that package. Failure containment mirrors the completion notice itself: a reminder send or registry read failure warns to console and never affects notice delivery or marker cleanup.

The threshold is a product constant, not a Config field: 5 tools resident today; 13 carried for days without complaint; 95 and 37 both rejected by hand — 20 sits between tolerated and rejected and matches the pre-registered deferred-surface trigger line (MCP tools > 20 → revisit).

## Alternatives considered

- **A hard per-server tool budget (`maxTools`) in dsh-mcp-client, fail-loud at mount.** Designed in full, rejected by the user: a gate that blocks loading takes away the operator's control over their own installation and adds fail-loud semantics (fiber rejection, `failOnStartupError` interplay, reconnect resync) for a cost that prompt caching already absorbs.
- **A per-server warn log in mcp-client at sync time.** Deferred: it doubles the touch surface across two packages, while the reload moment is when the operator acts and the daily error digest already carries persistent logs.
- **Folding the reminder into the completion-notice text.** Rejected: the existing message stays untouched, and the reminder fires only over the line, so ordinary reloads still send exactly one message.
- **A schema-byte threshold.** Deferred: an honest byte bound needs a stable per-definition wire render (`ToolRuntime.schemaOf` is private); the tool count matches both observed incidents (37, 71) and the user's framing.

## Consequences

- The reminder counts only the process-global view (profile-root mcp-client rows); agent-scoped `.mcp.json` mounts through mcp-workspace are not counted — the same limitation the mcp-health detection documents, and the live deployment's servers are all profile-level.
- The count is a point-in-time snapshot at completion-notice delivery: a server still inside its `startupTimeoutMs` window may be undercounted.
- A plain daemon start without a pending marker sends nothing — no operator present, nothing changed; the reminder rides only the marker-gated completion notice.
- `tests/reload-completion.spec.ts` pins the over-line reminder (total + heaviest-first breakdown), the exact boundary (20 silent, 21 reminds), send-failure isolation, and the no-marker path; `mcpToolCounts` is pinned in `tests/mcp-health.spec.ts`.
- If the surface routinely exceeds the line, the recorded next step is a codex-style deferred tool surface (`tool_search`), not raising the threshold; the decision ledger lives in the lsp adoption research and the codex audit.
