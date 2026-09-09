# Agent Note: Directory groups for unaccounted sidebar sessions

Status: implemented

English | [中文](2026-09-09-ui-workspace-cwd-groups.zh.md)

## Problem

The workspace browser groups Sessions only through the manual Workspace account (`sessionIds` in the Host workspace store); every unaccounted Session — anything created outside the Web UI, such as all sessions of the feishu-bridge daemon mounted through persistence read-only roots — trailed in one undifferentiated Ungrouped bucket. Mounting the bridge store made that bucket swallow ~1500 sessions at once.

## Decision

`ui-workspace`'s derivation splits unaccounted Sessions by their distinct `cwd`: one directory group per path, keyed `cwd:<path>` (collision-free against Workspace UUIDs and the empty Ungrouped key), labeled with the directory basename. Directory groups order themselves by their newest member and sort members by recency; they take no manual order and persist none. Sessions without a cwd still trail in the Ungrouped bucket with its existing browser-local order semantics. `owningGroupKey` gained a `cwd` parameter so the current-selection group resolution (auto-expansion, contains-current highlight) routes to the directory group; real Workspace membership always wins over the cwd route. Dragging inside a directory group is a no-op, which the existing drag commit path already provides by finding no account for the key.

## Alternatives considered

**Host-side auto-accounting: add cwd-matching Sessions to `WorkspaceView.sessionIds` automatically.** Rejected: it turns the manual navigation account into a hybrid with unclear ordering, archiving, and move semantics, and the Web process discovers foreign sessions only through cold listing, not creation events.

**A one-time script writing bridge Sessions into the workspace store.** Rejected: the running Web process owns that store in memory and rewrites it through its single write chain, so external edits lose; and the account would need re-running for every new bridge session while accumulating throwaway worktree directories.

## Consequences

Real Workspace groups, their manual order, and the Ungrouped bucket's stored order are unchanged. Browser-persisted expansion keys extend naturally to `cwd:` keys. Sessions of a deleted Workspace now regroup by cwd instead of pooling in Ungrouped.

## Testing

`tree.client.spec.ts`: stray Sessions split into per-cwd groups (label, inter-group newest-member order, intra-group recency), cwd-less Sessions stay in Ungrouped, accounted Sessions never leak into directory groups. `workspace-browser.client.spec.tsx`: an unaccounted current Session with a cwd auto-expands its directory group, whose header renders no workspace menu. Full package suite passes (152 tests).
