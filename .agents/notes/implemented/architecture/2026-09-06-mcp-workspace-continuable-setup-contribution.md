# Agent Note: mcp-workspace contributes its continuable-child mount through the subagent setup seam

Status: implemented

English | [中文](2026-09-06-mcp-workspace-continuable-setup-contribution.zh.md)

## Problem

The fork-local `dsh-mcp-workspace` package was hard-referenced by two upstream packages: `dsh-subagent`'s `mountDirectoryMcp` (type-only import for the `ctx.get('mcpWorkspace')` service augmentation, plus `package.json`/tsconfig edges) and `dsh-subagent-in-process-driver` (transitive type resolution). The same directory-mount logic existed in three composition sites: the continuation manager's setup (continuable), the one-shot in-process driver's setup, and the session controller's `wrap`. Upstream absorption therefore re-grafted the fork-local dependency into `dsh-subagent` at every sync.

The fork had already added a general seam for this shape: `SubagentRuntime.registerContinuableSetup()` lets optional packages contribute child-scoped capabilities without the continuation manager knowing their names. But the seam's contribution signature was synchronous, while a directory mount must await `agentCtx.plugin(mcp-client, …)` inside the child's creation window — publication may not precede tool registration, because prompt assembly would otherwise omit the `mcp__<server>__<tool>` rows.

## Decision

The seam now accepts awaitable installs: `ContinuableSetupContribution` returns `(() => void) | Promise<(() => void) | void>`, and `apply()` awaits a pending install before the next contribution runs, still inside the child's creation window and before the batch commit. A contribution removed while its install was in flight settles, is revoked immediately, and fails its provisioning batch — the invariants the synchronous path already kept, extended to the await window. Synchronous contributions install exactly as before (no hidden microtask between them).

`McpWorkspaceService` registers its own contribution in the constructor through `ctx.inject(['subagents'], …)` with the registration bound to the inject fiber's effect, so continuable children (fresh creation and cold resume) mount by their own cwd after the child composition's tool masks, and unloading the plugin stops future mounts. The continuation manager's setup no longer calls `mountDirectoryMcp` at all.

One-shot children keep their mount: the in-process driver composes its own `AgentSetup`, which no registry covers, so `mountDirectoryMcp` stays in `dsh-subagent` for that path — but typed against a local minimal interface (`DirectoryMcpService`) instead of the fork-local package. `dsh-subagent` and `dsh-subagent-in-process-driver` carry no `dsh-mcp-workspace` dependency of any kind; the integration spec in `dsh-mcp-workspace` drives a real one-shot child through the driver against the real service, so a `mount` signature drift fails that spec instead of silently breaking the runtime lookup.

The reverse edge is now one-directional and declared: `dsh-mcp-workspace` peer- and dev-depends on `dsh-subagent` and references it in tsconfig. The previous two-way tsconfig reference pair could not coexist with this edge (project references may not form a circular graph), which is what forced the one-shot lookup to shed its type import.

The session controller's `wrap` composition (the third copy) stays out of scope pending the upstream general agent-setup seam, per the fork graft ledger.

## Alternatives considered

- **Fire the mount without awaiting it inside the contribution** — rejected: publication would precede tool registration, so the child's first prompt assembles without the `mcp__` rows. The await is a semantic requirement, not an implementation detail.
- **Keep the type-only import in `mountDirectoryMcp` and only migrate the continuable path** — rejected: `dsh-mcp-workspace` must reference `dsh-subagent` for the contribution (type resolution needs the tsconfig reference), and project references may not form a circular graph. The upstream→fork-local reference pair cannot survive the reverse edge.
- **A second registry method for one-shot contributions** — deferred with the session-controller copy: it needs its own protocol decisions (which contributions one-shot children should receive), and both belong with the upstream general agent-setup seam already recorded in the graft ledger.

## Consequences

- The one-shot lookup trades declaration-merged type safety for a locally declared interface. The integration spec is the drift guard; renaming `mount` compiles cleanly upstream of the mcp-workspace tests and fails there.
- A deployment without `mcp-workspace` no longer warns on the continuable path (only one-shot children reach the warn-once branch). The warning's audience — the deployment operator who forgot the plugin row — still gets it from the first one-shot child; a continuable-only deployment stays silent, which is the inherent cost of the upstream package not knowing the fork-local feature exists.
- Upstream absorption of `dsh-subagent` no longer re-grafts the fork-local dependency: the child-agent source carries no `dsh-mcp-workspace` reference, and the duck-typed lookup is the only fork-aware line left there.
