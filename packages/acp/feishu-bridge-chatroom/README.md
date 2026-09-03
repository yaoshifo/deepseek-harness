---
description: "The chatroom layer of the Feishu bridge: multi-role chatroom orchestration — role groups, the moderator, the /chatroom command family, and the feishu_bridge_chatroom tool — for teams running parallel agent roles inside one Feishu group."
kind: "package-bundle"
---

# dsh-feishu-bridge-chatroom

English | [中文](README.zh.md)

## Summary

Orchestrate multi-agent chatrooms inside one Feishu group: start role groups or a moderator through the `feishu_bridge_chatroom` tool or the `/chatroom` commands, fan one question out to every role and gather the answers into a single summary, and let the moderator drive a round-table discussion across independent role sessions. Roles run as dsh agents with whole-prompt personas assembled from the persona directory plus the configured user-profile file (`userProfile`: one background text injected into every chatroom persona — roles, moderator, and direct-role 1:1 alike); research mode first runs a bounded clarify stage that collects user background and constraints into the ledger (at most two ask cards, skippable when the injected profile suffices), then collects a pure-judgment data-needs list from every role, pre-fetches the common datasets once through a hub-parented data steward into the shared research workspace, and then keeps one assistant per role for angle-specific digging under a fetch-ledger convention. A project opts out with `enabled: false`, which removes the commands, masks the tool out of that project's model requests, and hides the bundled moderator skill.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The chatroom plugin of the Feishu bridge: multi-role chatroom orchestration — role groups, the moderator, the `/chatroom` command family, the `feishu_bridge_chatroom` tool, and the bundled chatroom-moderator skill — as its own dsh package mounted beside `@deepseek-ai/dsh-feishu-bridge` (dependency direction: this package imports the bridge's export face; the bridge never imports this package). The engine seam halves ride the bridge service's `feishuBridge/*` events; the per-engine configuration and command registration apply in the plugin's startup sweep once the bridge reports readiness. A project configured `enabled: false` (in this plugin's `defaults` or its `projects` entry) gets no `/chatroom` commands, its agents' `feishu_bridge_chatroom` calls fail loud, and the tool definition is masked out of its sessions' model requests through the bridge service's per-engine deny registry.

<a id="model-experience"></a>
## Model Experience

### What the model sees

- The `feishu_bridge_chatroom` tool (family tag `feishu_bridge_chatroom`): the moderator orchestrates a chatroom through its actions (`start` / `ask` / `gather` / `pick-roles` / `pick-topic` / `ask-human` / `end` / `list` / `note`); role personas reference it through their whole-prompt replacement.
- Chatroom personas: role, direct-role, moderator, and research-assistant sessions run with complete system-prompt replacements assembled from the persona directory's flattened CLAUDE.md plus the participation/research contracts (precomputed by the session-start-options listener; the adapter registers them as `complete: true` sections). A configured `userProfile` file appends a user-background section to every role/moderator/direct-role persona; research assistants and the data steward get no injection (roles carry relevant background into their assistant task text).
- Moderator primings and wake messages (gather fan-in summaries, end-barrier closings, restart-recovery notes), plus the research-assistant preambles carried on the subtask start options — the same preamble serves each role's assistant and the hub's pre-spawned data steward, carrying the fetch-ledger, per-role data-directory, and per-domain pacing disciplines.
- The research-mode flow staged by the moderator priming: a bounded clarify stage first gathers each role's user-background questions and merges them into one ask card whose answers land in the ledger synthesis as 「用户背景与约束」 (at most two rounds; a clear topic plus a sufficient injected profile may skip the stage), then a plain (non-research) gather collects each role's data-needs list, the steward fetches the merged common datasets into the workspace's `data/core/` and registers every fetch in `DATA_LEDGER.md`, and the round-1 broadcast points each role at that ledger so its assistant only pulls what is missing; later rounds reuse the ledger, and adjudication targets are assigned by named allocation with at most one disputant plus one neutral puller.
- The bundled `feishu-bridge-chatroom-moderator` skill, mounted as an isolated skill provider.

#### Token effect

The tool description and schema reach every dsh agent in enabled projects (the tool is process-wide, routed by caller); a project configured `enabled: false` masks the definition out of its sessions' requests (the adapter restricts the service-denied name at session create), and the bundled moderator skill's catalog entry leaves them too (the provider mounts cwd-scoped to the enabled projects' workdirs). Persona prompts replace each chatroom session's system prompt entirely instead of appending; moderator wakes and relay cards are user-visible messages, not model-facing. Research mode trades one cheap plain-gather needs round and a single steward prefetch for the duplicate per-assistant fetch rounds they replace; the priming and the research-assistant preamble grow by the ledger and pacing discipline text. The `userProfile` text is duplicated into every role and moderator persona (N+1 copies per chatroom), so deployments keep the file concise.

#### KV Cache effect

Chatroom sessions use whole-prompt persona replacement, so each role/moderator session has its own stable prefix; the tool schema extends the model request for bridge-owned agents, adding to (not invalidating) their reusable prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Pre-readiness window**: messages a platform delivers between the bridge's engine start and this plugin's `whenReady()` sweep are handled with default-valued chatroom configuration (no roles dir override, ledger off) — a window the in-bridge wiring did not have. It is structural to the sibling-plugin mount order; recovery and all later turns see the swept configuration.
- **The tool mask has a startup window**: sessions created between the bridge's readiness and this plugin's sweep (which registers the per-engine deny mask and mounts the cwd-scoped skill provider) still see the `feishu_bridge_chatroom` definition and the moderator skill entry; their tool calls fail loud at the tool's execute gate instead. Sessions created after the sweep see neither.
- **The bundled skill scopes by cwd, not by project identity**: the moderator skill's catalog entry — whose description names `/chatroom` — is itself a behavior entry point (a model that sees it can load and follow it), so the provider mounts with `cwdPrefixes` set to the enabled engines' base workdirs and a disabled project's sessions see no entry. Ceiling: the cwd is a proxy — a session that switches its working directory under an enabled project's workdir sees the entry again (the tool stays masked), two projects sharing one workdir cannot be told apart, and a cwd-less host-plane lookup sees no scoped root at all.
- **Unloading the plugin loses in-memory chatroom state**: armed barrier instances, in-flight flags, and gather-round stamps are process-local; disposing the plugin fiber drops them. The durable `featureState.chatroom` section survives — the per-session accessors write it in place, so a codec-less save persists it verbatim — and restart barrier recovery rides the persisted snapshots, not the instances.
- **Picker state is in-memory**: a daemon restart drops the armed pickers; the next click on an orphaned pick card swaps it in place for a grey expired card prompting a fresh `/chatroom` (Go left the orphan buttons silent or fake-confirming).
- **Deployment migration is manual**: production profiles carry chatroom sections under the `feishu-bridge` row in their self-evolved `cordis.patch.yml`; the bridge now fails loud on such residue, and the sections must move to this plugin's own config (`defaults` + per-project `projects`, keyed by bridge project name). The migration snippet and profile-template updates land with the C3 deployment batch.
- **Coverage of the REAL-composition surface**: the apply/HMR specs mount the plugin on real Cordis services (event bus, tool registry, skill registry, bridge service) but not through the Loader with a `cordis.yml`; a boot-through-the-Loader composition test and the production `/reload` smoke checklist land with C3.
- **User participation is discoverable but not enforced; endings and groups leak by design**: plain messages in the hub always reached the moderator mid-run — the ready card and the live research progress card now say so, the auto-mode priming directs a one-line per-round progress sync, and mid-run user messages fold into the next round or go out via `ask`. Still deferred: the wrap-up `ask_user_question` has no timeout fallback in auto mode (it waits indefinitely, and a daemon restart kills the parked ask — the stale-card hint then tells the user to answer a question that no longer exists), and `end`/`/chatroom stop` stop every chatroom-descendant session — roles, role assistants and their recursive children, the steward and its fetchers — but never delete their Feishu groups (the bridge has no dissolve API), so those groups accumulate until removed by hand.
- **Research data deduplication is prompt-level convention**: the fetch ledger, per-role data directories, per-domain pacing, and claim partition live in priming and preamble text — compliance is soft and measurable only by re-mining a research chatroom's session logs against the recorded baseline (see the 2026-09-02 Agent Note); the engine-level fallbacks (a single dispatcher seam, a per-domain fetch queue) stay deferred.
- **The research clarify card shares the wrap-up card's exposure**: in auto mode the clarify `ask_user_question` has no timeout fallback and waits for the user (the same exposure the plain chatroom's 3-round clarify loop has); in manual mode the research-manual 10-minute whole-ask auto-default answers it with the default options. An unreadable configured `userProfile` fails loud at `/chatroom` startup and the tool's `start` action, but a mid-run deletion of the file degrades to a warned skip in the persona assembly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
