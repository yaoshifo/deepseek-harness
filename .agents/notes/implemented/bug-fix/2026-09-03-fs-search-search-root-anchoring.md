# Agent Note: glob/grep patterns anchor at the search root

Status: implemented

English | [中文](2026-09-03-fs-search-search-root-anchoring.zh.md)

## Problem

A 2026-09-03 feishu-bridge session hit three consecutive `glob` calls that each returned `No files found` for files verified to exist: `path=/Users/hm/.claude/skills` + `pattern=html/**`, `path=…/packages/acp/feishu-bridge` + `pattern=skills/*/SKILL.md`, and `path=…/packages/acp/feishu-bridge-chatroom` + `pattern=src/**/*.ts`. The mechanism (verified against the packaged rg, R1–R8): the tool passed the pattern verbatim to `rg --files --glob=<pattern>` and the search root as a trailing `-- <path>` argv element, with the spawn cwd pinned at the session cwd. ripgrep matches `--glob` candidates in the form the path argument dictates — an absolute `path` yields absolute-path candidates, a relative one yields cwd-relative candidates — so a relative pattern (the Claude Code Glob/Grep convention every model carries) matched nothing under either form. Two aggravators: `~`-prefixed patterns and paths ride the argv verbatim (no shell layer expands them), and an absolute pattern is unreliable in globset (its leading `/` handling makes it miss), so a model that hand-expands `~` still gets silence. The only reliable pre-fix usage was "no `path` + pattern carrying the full cwd prefix" — using `path` at all guaranteed an empty result, contradicting the parameter's purpose. Inherited from upstream (`e0f20088d8` introduced the pinned cwd; `18700f428d` froze the argv shape); upstream master at `49a606bc5b` (0.1.2-alpha.5, verified 2026-09-03) still carries all three defects, and the fork had touched only grep description text since the merge base.

## Decision

- rg now runs with its cwd AT the search root: `runRipgrep` takes a `spawnCwd` (default the session cwd), and `buildGlobCommand` no longer puts `path` in argv. Patterns (and grep's `include`) therefore match relative to the search root — the `path` argument, default the session workspace — matching Claude Code semantics the models already assume.
- `resolveSearchRoot` (search-core) anchors the root: `~` alone and `~/`-prefixed paths expand against the home directory, relative paths join the session cwd, absolute paths pass through.
- `resolveGlobPattern` (glob) anchors the pattern the same way: a `~/`-prefixed pattern expands first; an absolute pattern inside the root strips to its root-relative form; the root itself collapses to `**`; an absolute pattern outside the root is a plain argument error pointing at the `path` argument — a silent miss would read as "no such files".
- grep handles a file `path` by running from its parent with the basename behind `--` (an absent path takes the same shape so rg names it in the failure); a directory `path` runs rg at the root like glob.
- Both tools re-anchor rg's search-root-relative output at the session cwd before returning: workspace-relative inside it, absolute outside — every returned path stays follow-up-readable by `read`.
- The VCS exclusion for a search root that sits inside a VCS directory moved from the argv `!**/.git/**` glob (whose candidates lost their `.git/` prefix once rg's cwd moved to the root) to an upfront path-segment check that returns an empty result; `RipgrepRun.workdir` lost its last consumer and was removed.

## Alternatives considered

- **Document the old semantics instead of changing them.** The old semantics were not one semantics: candidates were absolute or cwd-relative depending on the `path` form, so no prose could state them coherently, and the model intuition (pattern relative to `path`) would keep tripping.
- **Rewrite the pattern internally to `<path-prefix>/pattern`.** Dies on the absolute form: an absolute `--glob` never matches in globset, so the absolute-`path` half of the bug stays.
- **Keep the root in argv and make rg match absolute candidates.** rg has no option to change the `--glob` matching basis; the cwd is the only lever.

## Consequences

- Tests: integration.spec.ts pins the three incident shapes (absolute/relative `path` + separator-bearing pattern, outside-workspace root with absolute follow-up-readable output, absolute-pattern strip/reject/equal-root) and grep's separator-bearing include plus absolute file target; tools.spec.ts pins the resolution pure functions, the spawn-cwd-at-root argv contract, and the re-anchored output.
- Snapshots: the four parameter descriptions changed model-visible text, so 37 snapshot files (tool-schemas.expected.json and system-prompt.expected.md) were mechanically replaced and docs/tool-catalog.md regenerated. The 16 SDK replay snapshots load the tool from the main tree's built lib through the worktree's linked node_modules, so they verify in a clean build (CI) rather than in this sandbox; the session-sandbox-root and PTY-flavored snapshot failures pre-exist on the untouched main tree under this session's sandbox.
- The pre-fix reliable shape (pattern with the full cwd prefix plus a `path`) now returns empty — a deliberate breaking change under the pre-release stance; the descriptions state the new anchor.
- Deployment: host build + `/reload`; the next session that passes `path` with a relative pattern is the live verification signal.
- If upstream later fixes the same defect, the next absorption meets this change across the four source files, the snapshot expectations, and the README/tool-catalog pairs. The decider is this package's test suite — run `node_modules/.bin/vitest run packages/fs/tool-fs-search/tests/` after the merge: green means the upstream fix covers the pinned incident shapes (adopt the upstream text and keep our tests), red means it is weaker (keep this implementation and absorb the rest). tool-catalog converges by regeneration; snapshot expectations follow the winning implementation via the same mechanical description replacement. The general merge-tree rehearsal and conflict-attribution flow lives in `dsh-sync-upstream`.
