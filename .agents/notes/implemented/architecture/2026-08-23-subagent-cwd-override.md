# Agent Note: Subagent cwd override is pure session metadata, not git orchestration

Status: implemented

English | [中文](2026-08-23-subagent-cwd-override.zh.md)

## Problem

The feishu-bridge's subtask orchestration supports cross-directory dispatch (`--dir`) and git-worktree isolation (`--worktree`) entirely through its own machinery: children are created via `ctx.agents.create` with `meta.cwd`, and `engine/worktree.ts` owns branch/worktree creation, dirty checks, and recycling. The native subagent seam had no way to express any of this — `SubagentStartRequest` carried no working-directory field, and tool-subagent's wording even promised "a delegation cannot redirect it to another directory". Every consumer that needed directory-qualified delegation therefore rebuilt a private path, and the planned migration of unattended bridge subtasks onto the native seam (de-baggage batch B4) had no native primitive to migrate onto.

The design question was whether the native seam should grow a worktree concept alongside a directory field, since the bridge's `--worktree` semantics (isolation, keep/remove lifecycle) are the visible feature.

## Decision

The native seam gains exactly one start-time option: `SubagentStartRequest.cwd`, an optional absolute path that overrides the parent's working directory in the child session header. It is gated behind a new `SubagentCapabilities.cwdOverride` flag, validated (absolute path) in `SubagentRuntime.start` and `startContinuable` before provider dispatch or identity reservation, and honored by `childSessionMeta` in the in-process driver; every out-of-process backend rejects it fail-loud through `NO_START_CAPABILITIES`. The continuable path gained the same gates when the seam grew its bridge preconditions ([the continuable bridge seam note](../feature/2026-08-24-subagent-continuable-bridge-seam.md)). `tool-subagent` exposes it as a config-gated model-facing `cwd` parameter (`allowCwdOverride`, default false — workspace isolation stays the default stance, and a forced cwd on a disabled instance is rejected at execution time like `run_in_background`).

Git worktree orchestration deliberately stays OUT of the native packages: path layout (`.claude/worktrees`), branch naming, dirty checks, and the keep/remove lifecycle are deployment conventions. A caller composes them on top of the override — create the worktree, pass its path as `cwd`. The bridge keeps `engine/worktree.ts` and consumes the override when its unattended subtasks move to the native start seam (batch B4).

## Alternatives considered

- **A native `worktree: 'auto' | 'on' | 'off'` request field** with provider-owned worktree creation and recycling. Rejected: it couples the capability packages to one git convention (layout, branch naming, retention UX) that other deployments do not share, and the bridge's keep/remove card needs caller-controlled lifecycle anyway. The cwd override expresses the composable part; git stays a caller concern.
- **No native field at all** — keep everything bridge-private, as today. Rejected: cross-directory delegation is generically useful (any consumer with a prepared directory), and B4's migration onto `startContinuable`/`start` needs a native way to place the child.
- **A free-form relative path resolved against the parent's cwd.** Rejected: silent resolution is a path-traversal footgun at a trust boundary; one absolute-path rule fails loud and keeps the child's header unambiguous.

## Consequences

- In-process spawn/fork children carry the override in their durable session header (`cwd`), so resume and listing see the real working directory; out-of-process backends (ACP, claude-code, codex, dsh-sdk) fail loud before any child starts.
- The bridge consumes the override only from batch B4 onward; until then its `--dir`/`--worktree` paths are unchanged, so the two systems coexist without a compatibility shim (pre-release stance).
- Model-visible surface: `tool-subagent`'s `cwd` parameter appears only where a deployment opts in, keeping the default delegation contract unchanged.
