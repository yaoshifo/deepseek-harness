# dsh-feishu-bridge-chatroom

English | [中文](README.zh.md)

The chatroom plugin of the Feishu bridge: multi-role chatroom orchestration — role groups, the moderator, the `/chatroom` command family, the `feishu_bridge_chatroom` tool, and the bundled chatroom-moderator skill — as its own dsh package mounted beside `@deepseek-ai/dsh-feishu-bridge` (dependency direction: this package imports the bridge's export face; the bridge never imports this package). The engine seam halves ride the bridge service's `feishuBridge/*` events; the per-engine configuration and command registration apply in the plugin's startup sweep once the bridge reports readiness.

## Model Experience

### What the model sees

- The `feishu_bridge_chatroom` tool (family tag `feishu_bridge_chatroom`): the moderator orchestrates a chatroom through its actions (`start` / `ask` / `gather` / `pick-roles` / `pick-topic` / `ask-human` / `end` / `list` / `note`); role personas reference it through their whole-prompt replacement.
- Chatroom personas: role, direct-role, moderator, and research-assistant sessions run with complete system-prompt replacements assembled from the persona directory's flattened CLAUDE.md plus the participation/research contracts (precomputed by the session-start-options listener; the adapter registers them as `complete: true` sections).
- Moderator primings and wake messages (gather fan-in summaries, end-barrier closings, restart-recovery notes), plus the research-assistant preambles carried on the subtask start options.
- The bundled `feishu-bridge-chatroom-moderator` skill, mounted as an isolated skill provider.

#### Token effect

The tool description and schema reach every dsh agent in projects where the tool registers (the tool is process-wide, routed by caller). Persona prompts replace each chatroom session's system prompt entirely instead of appending; moderator wakes and relay cards are user-visible messages, not model-facing.

#### KV Cache effect

Chatroom sessions use whole-prompt persona replacement, so each role/moderator session has its own stable prefix; the tool schema extends the model request for bridge-owned agents, adding to (not invalidating) their reusable prefix.

## Known Limitations and Deferred Work

- **Pre-readiness window**: messages a platform delivers between the bridge's engine start and this plugin's `whenReady()` sweep are handled with default-valued chatroom configuration (no roles dir override, ledger off) — a window the in-bridge wiring did not have. It is structural to the sibling-plugin mount order; recovery and all later turns see the swept configuration.
- **Unloading the plugin loses in-memory chatroom state**: armed barrier instances, in-flight flags, and gather-round stamps are process-local; disposing the plugin fiber drops them. The durable `featureState.chatroom` section survives — the per-session accessors write it in place, so a codec-less save persists it verbatim — and restart barrier recovery rides the persisted snapshots, not the instances.
- **Picker state is in-memory**: a daemon restart drops the armed pickers; the next click on an orphaned pick card swaps it in place for a grey expired card prompting a fresh `/chatroom` (Go left the orphan buttons silent or fake-confirming).
- **Deployment migration is manual**: production profiles carry chatroom sections under the `feishu-bridge` row in their self-evolved `cordis.patch.yml`; the bridge now fails loud on such residue, and the sections must move to this plugin's own config (`defaults` + per-project `projects`, keyed by bridge project name). The migration snippet and profile-template updates land with the C3 deployment batch.
- **Coverage of the REAL-composition surface**: the apply/HMR specs mount the plugin on real Cordis services (event bus, tool registry, skill registry, bridge service) but not through the Loader with a `cordis.yml`; a boot-through-the-Loader composition test and the production `/reload` smoke checklist land with C3.
