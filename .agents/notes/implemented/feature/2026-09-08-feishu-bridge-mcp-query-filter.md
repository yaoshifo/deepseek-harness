# Agent Note: /mcp query filter

Status: implemented

English | [中文](2026-09-08-feishu-bridge-mcp-query-filter.zh.md)

## Problem

After `/skills` gained a fuzzy query (same day), `/mcp` remained a flat listing. With several servers and each server's tool line capped at eight names, answering "which server owns `read_file`" meant scanning every capped line by eye. Pagination, by contrast, was a non-problem: the live profile mounts five servers and per-server tool lines are already capped, so the card is bounded at roughly a dozen lines.

## Decision

`/mcp [query]` filters **every section** — live groups, degraded health-watched servers, and workspace mounts — to servers matching the query. For live groups a match is any whitespace-separated token appearing (case-insensitively) in the server name **or any of its tool names**, the same token-AND semantics `/skills` uses; degraded and workspace entries match on the name alone (they have no tool names to match). A filtered view echoes the query with matched/total counts (`mcp_query_line`), and a zero-match query gets its own reply (`mcp_no_match`) distinct from an empty registry (`mcp_empty`). Degraded detection keeps comparing against the unfiltered groups — a watched server whose tools exist but were filtered out is filtered, not degraded. No pagination, no snapshot: the tool registry read is synchronous and the command has no card actions.

## Alternatives considered

**Mirror /skills wholesale (paging + snapshot).** Rejected: five servers render ~a dozen bounded lines; paging would split one glance into pages. The sync data source also makes the snapshot machinery unnecessary.

**Filter live groups only, leave degraded/workspace sections unfiltered.** Rejected: a query that shows a "hidden" workspace section the user did not ask for defeats the point of zooming in.

## Consequences

`/mcp zzz` now replies no-match instead of falling through to the agent as an unknown command (a bare word after /mcp was previously ignored as an argument). The i18n surface is two new keys (`mcp_no_match`, `mcp_query_line`) plus rewritten `mcp`/`mcp_usage`; usage text names the tool-lookup example. If the server count ever grows past a screen, revisit paging — the render stays single-card by design today.

## Testing

`tests/engine/skills-mcp-commands.spec.ts`: server-name filtering (case-insensitive), tool-name matches pulling in the owning server, token-AND across name and tool names, degraded/workspace sections filtering by name, the 🔍 scope echo, and the no-match/empty split.
