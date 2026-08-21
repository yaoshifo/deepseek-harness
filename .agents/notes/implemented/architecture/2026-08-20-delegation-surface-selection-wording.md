# Agent Note: Delegation-surface selection wording (headless subagent vs attended subtask)

Status: implemented

English | [中文](2026-08-20-delegation-surface-selection-wording.zh.md)

## Problem

Two delegation surfaces are live in one feishu-bridge session: the native `subagent`/`subagent_fork` tools (headless, continuable, child seeded from the parent) and the ported `feishu_bridge_subtask` tool (attended Feishu group chats, per-spawn `dir`, git worktree isolation). Their capabilities overlap on spawn/report/send/fork semantics but split on two axes the model could not see:

- The native tools have no per-spawn working-directory option — the child session hardcodes the parent's cwd (`childSessionMeta` in `dsh-subagent`), so its workspace-write sandbox boundary and its AGENTS.md/CLAUDE.md instruction chain both stay in the parent's project. A model that delegates cross-project work to a headless subagent gets a child running in the wrong directory, unable to write outside the parent workspace.
- Neither tool's description stated the split, so tool selection between the two surfaces was guesswork driven by name similarity.

## Decision

Each tool's `description` states its own delegation fact; neither description references the other tool by name (the native `toolName` is load-time config, and other deployments mount no dir-capable alternative at all). This follows the [tool-guidance ownership rule](2026-07-05-prompt-variables-and-tool-guidance-ownership.md): per-tool semantics and selection guidance live in tool descriptions, not prompt sections or personas.

- `dsh-tool-subagent`'s spawn and fork wordings both state: the child shares this session's working directory and its instruction files, and a delegation cannot redirect it to another directory. The sentence describes the capability (no per-spawn directory), not the cwd value, so it stays true for out-of-process providers whose deployment config pins a different fixed directory.
- `feishu_bridge_subtask`'s description and `dir` parameter state that work in a different directory is delegated through this tool: the child runs there and loads that project's instruction files.

The practical selection contract the wording encodes: same-directory background work uses the headless subagent; cross-directory work, same-repo parallel writes (auto worktree), and any work the user should watch or join use the subtask tool.

## Alternatives considered

- **Hide the native subagent tools from bridge sessions** (scoped `tools.restrict()` or disabling the `tool-subagent` rows) — removes the ambiguity but also removes headless same-directory delegation, which the split design keeps on purpose; bridge subgroups are heavyweight attended sessions and poor fits for quiet background research.
- **Extend the subagent seam with a per-spawn `cwd` field on `SubagentStartRequest`** — makes the native tool cross-directory too, but changes the capability contract for every provider, needs capability gating plus wire surface for out-of-process backends, and buys nothing the attended tool does not already cover. Deferred until a headless cross-directory need actually appears; the upgrade path is to then align `feishu_bridge_subtask`'s `dir` resolution onto the same field.
- **A prompt section explaining the two surfaces** — duplicates facts each tool can state locally and drifts from the descriptions under later edits; rejected by the one-owner rule.
- **Unify both surfaces on the `ctx.subagents` seam with an attended provider** — the continuation manager and the bridge engine would each own part of one child's lifecycle (turn ordering vs Feishu group routing), violating the one-lifecycle-controller rule.

## Consequences

Cross-package wording changes are pinned by existing keyless snapshots: the acp-agent `system-prompt.expected.md`/`tool-schemas.expected.json` fixtures carry the new sentences, `docs/tool-catalog.md` is regenerated, and `subtask-tool.spec.ts` asserts the bridge description and `dir` parameter carry the cross-directory contract. The cost is that every future rewording of either description re-touches those fixtures. What the split buys: zero architecture change for the full current feature set, and a model that can select the right surface from each tool's own contract. Known gap kept open on purpose: quiet (headless) cross-directory delegation does not exist; it requires the deferred seam extension above.
