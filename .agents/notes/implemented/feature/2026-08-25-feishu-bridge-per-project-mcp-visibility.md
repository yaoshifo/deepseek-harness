# Agent Note: Per-project MCP tool visibility is a session deny mask, not per-project mounting

Status: implemented

English | [中文](2026-08-25-feishu-bridge-per-project-mcp-visibility.zh.md)

## Problem

A feishu-bridge daemon serves every configured project in one process, and dsh composes MCP servers per profile: an `mcp-client` plugin row mounts one server's tools into the process-global tool registry at boot, and every session of every project sees them. An MCP server that belongs to one project therefore taxes every other project's every model request — each registered tool's name, description, and JSON schema ride every request — and widens the model's tool-choice surface. The ACP `session/new` parameter that could carry per-session servers rejects non-empty values, and dsh has no per-project composition layer, so no configuration path expressed "this server belongs to that project".

## Decision

`config.projects[].mcpServers` is a per-project MCP server-name allowlist (absent = unrestricted, no behavior change). When present, the project's adapter denies the `mcp__*` tools of every non-allowed server by visibility mask — MCP connections stay process-global; only what sessions see changes. Three creation funnels carry the mask, all inside `DshAgentAdapter`:

- **Session setup hook** (`withMcpMask` wrapping `buildSessionSetup` and the one-shot prompt setup): after the wrapped setup composes its sections, enumerate the agent scope's schema view and call `tools.restrict({ deny })`. The deny list is computed inside the hook, from the same unrestricted view `restrict` validates names against — setup time precedes any restriction, so the view still holds every global tool. This covers plain sessions, resumes, forks, chatroom personas (their `skill` deny intersects), and one-shot queries.
- **Continuable subtask children**: children do not inherit the parent's restrictions (agent-scope design), so `startContinuableChild` recomputes the deny list from the global tool view and forwards it as the request's `toolFilter` — the in-process fork/spawn providers both declare the `toolFilter` capability, apply it in the child's creation window, and persist it in the child's descriptor, so resumed children keep the mask.

Tool-to-server attribution is a prefix match on the mcp-client naming contract (`mcp__<serverName>__<rawName>`, identity suffix tolerated); `mcpDenyList` is exported for unit tests and pinned by `tests/agent-dsh/adapter-mcp-mask.spec.ts`, with the assembly wiring pinned in `tests/assembly-config.spec.ts`.

## Alternatives considered

- **True per-project MCP mounting (per-project plugin instances or connections).** Rejected for this need: composition is per-profile at boot, tool registration is process-global, and "project" is a feishu-bridge concept dsh core does not have — the change would touch plugin lifecycle, schema catalog, and snapshot surfaces to buy the same token saving the mask already delivers. Connection isolation (credentials, network) remains the reason to revisit; the mask is explicitly not an authority boundary.
- **`allow` masks instead of `deny`.** Rejected: allow masks exclude every later-arriving name, so first-party tools added by HMR or a plugin update — and runtime dynamic tool registrations — would silently vanish from masked sessions. Deny masks admit later unnamed globals, which keeps future first-party tools visible and confines the staleness to the revival edge below.
- **A generic cwd-keyed visibility plugin serving web/ACP sessions too.** Rejected: no current consumer outside feishu-bridge, and a cwd-keyed rule list would duplicate the project identity this plugin already owns (`buildProjectAssembly` threads `ProjectConfig.mcpServers` into the adapter's config). The `withMcpMask` shape is the extraction point if a generic need appears.
- **Fail loud on an allowlist entry with no live tools.** Rejected: a typo and an outage are indistinguishable at session time, and failing loud would let one project's dead server break that project's every session.

## Consequences

- Every masked project's model request drops the non-allowed servers' tool schemas (a recurring per-step saving), with Code Mode SDK bindings filtered by the same restriction; unconfigured projects and deployments without `mcpServers` are untouched.
- **Revival leak**: a server that reconnects after a session started re-adds its tools unnamed in that session's deny set — deny masks admit later unnamed globals — and the tools stay visible until the next session start or resume recomputes the mask. Self-healing, documented in the package README's Known Limitations; pattern-based restriction in core `tools` is the upgrade path.
- The mask is visibility composition, not a permission boundary (the dsh tools scope-security non-goal): a model cannot see the masked tools, but the design does not defend against a caller bypassing the view.
