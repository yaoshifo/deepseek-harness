# Agent Note: per-project chatroom gating through a service-registered tool mask

Status: implemented

English | [中文](2026-08-29-feishu-bridge-chatroom-per-project-gating.zh.md)

## Problem

One feishu-bridge daemon hosts every bot as a project of the single bridge plugin row, while the chatroom plugin mounts process-wide: the startup sweep registers `/chatroom` on every engine and the `feishu_bridge_chatroom` tool registers once for the whole process, routed by caller agent. A deployment that wants the chatroom on only some of its bots therefore gets it on all of them, and the cost is not just the command palette: the tool's description plus schema (roughly 600 tokens) and the bundled moderator skill's catalog entry (roughly 200 tokens) enter every model request of every bot, used or not, and a model that can see the tool can be talked into starting a chatroom on a bot that should not have one.

## Decision

A project opts out with one knob on the chatroom plugin's own config — `enabled: false` in `defaults` or in that project's `projects` entry (default true). One knob drives both halves; nothing pairs:

- **Functional face**: the sweep skips `registerChatroomCommands` for a disabled engine, and the tool's `execute` refuses calls routed to a disabled engine with a loud error (the backstop for sessions created in the startup window before the mask below was registered).
- **Model face**: the plugin registers the tool name on the bridge service's per-engine deny registry (`FeishuBridgeService.denyTools(engine, names)`, a reversible registration). Assembly wires each adapter with `setDeniedTools(() => service.deniedToolsOf(engine))`; the adapter's create-time mask — `withProjectToolMask`, the generalization of the MCP allowlist wrap — restricts those names on the agent scope at every session create and forwards them in the continuable child `toolFilter`, exactly the [per-project MCP visibility](../feature/2026-08-25-feishu-bridge-per-project-mcp-visibility.md) machinery with a service-registered source instead of a config field. The definition leaves disabled projects' model requests entirely.
- **Barrier recovery stays unconditional** for disabled engines: it drains chatrooms armed before the project was disabled (closing restored gathers, notifying the moderator), it is not a new entry point.

`denyTools` is a service method, not bridge config, because the only current consumer is a sibling package: a config field would be a second knob users must pair with `enabled` (mispairing yields a moderator that spawns without its tool), while the service seam keeps one user-facing setting and fails noisily by construction. The bridge stays generic — it owns mask storage and the adapter read, the chatroom owns the decision of what to hide.

## Alternatives considered

- **Execute-time rejection only** (an `enabled` check inside the tool). Rejected as insufficient: the definition still enters every request — the deployment pays the tokens it disabled the feature to save, and the model still sees (and can be talked into calling) the tool.
- **A bridge config field `denyTools` per project beside the chatroom's `enabled`.** Rejected: two independently-settable knobs guarding one decision; setting the bridge field without disabling chatroom hands the moderator a schema view without its own tool and the chatroom stalls mid-discussion.
- **Splitting the chatroom-off bots into a second daemon/profile without the chatroom bundle.** Rejected for this need: another process (its own LSP/MCP clients), another launchd/reload unit, and a split session store, for a granularity a config field already provides; per-process isolation remains the answer only for fault or resource isolation.
- **Mounting the chatroom per session through agent presets** (the Web composition mechanism, `packages/preset/agent-presets`). Rejected for now: the feishu-bridge adapter does not compose presets, the chatroom's process-level halves (codec, policy listeners, command sweep) double-fire per preset generation, and the `/chatroom` command is engine-level — per-session assembly is a separate project, orthogonal to per-bot gating.
- **Do nothing** (the chatroom is inert until invoked). Legitimate when every bot may use the feature; this change exists because the deployment's bots mostly never will.

## Consequences

- **The bundled moderator skill follows the same gate, scoped by cwd plus a per-engine skill mask**: the skill's catalog entry is itself a behavior entry point — the first production probe (2026-08-30, a disabled bot receiving the unknown-command text `/chatroom`) had the model load and start following the moderator skill purely from its catalog description, so "inert residual" was wrong. The provider mounts with `cwdPrefixes` set to the enabled engines' base workdirs (skill-filesystem's `scopedSkillDirs` config, added for this), and the sweep's disabled branch additionally registers the name on the bridge service's per-engine skill mask (`denySkills`, see [the skill engine-mask note](2026-09-03-feishu-bridge-chatroom-skill-engine-mask.md)) — a disabled project's sessions see no entry even when their workdir falls under an enabled project's workdir (spawn workspace overrides, the shape the 2026-09-03 oc_0ace probe exposed). Ceiling: cwd remains a proxy for the enabled side — an enabled project's session switched elsewhere loses the entry while keeping the commands and tool, and shared workdirs cannot be told apart.
- The mask has a startup window: sessions created between bridge readiness and the chatroom sweep see the tool definition and the skill entry, and are refused at execute instead.
- The startup-window and revive ceilings of the deny-mask mechanism apply unchanged (deny masks admit later unnamed globals; names absent from the live registry drop out silently — the registrant may be unloaded).
- `defaults.enabled: false` with no project override disables every bot, equivalent to the plugin row's `disabled: true`; per-project gating and presets remain composable (a preset-scoped future split of the chatroom's model face would stack on top of the execute gate).
- Production profiles flip bots off by adding `projects.<bot>: { enabled: false }` under the `feishu-bridge-chatroom` row and running `/reload`; no bridge config changes.

## Related

- [Chatroom extraction into its own package](2026-08-29-feishu-bridge-chatroom-extraction.md) — the sibling-plugin mount this gating rides; its sweep now skips command registration for disabled engines.
- [Per-project MCP tool visibility](../feature/2026-08-25-feishu-bridge-per-project-mcp-visibility.md) — the create-time mask mechanism the service registry reuses.
