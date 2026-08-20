# dsh-feishu-bridge

English | [中文](README.zh.md)

cc-connect's orchestration capability (engine + Feishu platform) migrated into dsh as a single plugin: one long-lived dsh process assembles, per configured project, an Engine plus a Feishu WS platform (official node-sdk long connection, D5); agent sessions are created natively through `ctx.agents`, with no bridge protocol left. The migration plan, milestones, and decision records live in [docs/MIGRATION.md](docs/MIGRATION.md); the 61-item feature comparison in [docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md); deployment and configuration mapping in [docs/OPERATIONS.md](docs/OPERATIONS.md).

Plugin structure:

| Directory | Contents |
|---|---|
| `src/engine/` | faithful port of Go `core/`: the event state machine, sessions, commands, cron, relay, chatroom, monitor, i18n, attachment staging |
| `src/feishu/` | port of Go `platform/feishu/`: WS, API client, cards, progress cards, chat management, tags, avatars, media, quoted-message fetching |
| `src/agent-dsh/` | Agent interface → `ctx.agents` adapter (D1/D3: setup hooks, provider routing, approval/question/plan wiring) |
| `src/tools/` | the `feishu_bridge_subtask / cron / relay / chatroom / lark` tool families (D4: caller-agent routing, no env needed) |
| `skills/` | revised skills (`feishu-bridge-` prefix), loaded through the profile's `customSkillDirs` |

Model-visible surface: inbound messages (with reply-chain prefixes and staged-attachment path notes) enter the prompt; outbound goes through the card system (progress cards, completion cards, approval cards); CC_FEISHU_* workspace routing is injected as a system-prompt section through the D3 setup hook.

## Model Experience

### Request context and condition

#### What the model sees

This plugin never constructs LLM requests itself — every model input goes through the dsh agent layer (fully replayable from the session log), and all model-visible text the plugin contributes is conditionally injected and preserved verbatim from the Go original: the inbound prompt carries the user text, the reply-chain prefix (`[Quoted message from X]:` single-message form or `--- Reply chain (n messages) ---` numbered chain), staged-attachment path bullets, and `(Images saved locally, please read them: <paths>)` / `(Files saved locally, ...)` notes; projects with feishuWorkspace configured get a "default Feishu workspace" system-prompt section injected with the session through the setup hook (CC_FEISHU_* values + creation precedence; a chatroom bare persona replaces the system prompt wholesale and omits this section); the `feishu_bridge_subtask / cron / relay / chatroom / lark` tool families register into the dsh tool catalog, and lark tool results are the lark-cli subprocess stdout/stderr verbatim.

#### Token effect

Conditional injection: with no attachments, no reply chain, and no workspace configured, the direct token cost is zero; reply chains cap at 5 messages; attachment notes carry paths only, never bytes.

#### KV Cache effect

Reply prefixes and attachment notes are appended inside each user message (append-only conversation prefix, cache-friendly); the workspace system-prompt section is a fixed per-session prefix segment, prefix-stable within a session; lark tool results enter the context once as tool messages and never rewrite history.

## Known Limitations and Deferred Work

- **The lark tool supports only the Feishu domain (open.feishu.cn)**: the plugin's platform side never ported Go `larkCreds.Brand` (the lark.com dual domain); introducing a brand dimension into `src/tools/lark.ts` and the platform client is the path when lark.com is needed.
- **Quoted-message sender names are not resolved**: the platform never resolves contact names through the directory API (a deliberate cut since M1); senders render as `User`/`Bot` in reply chains; add a `resolveUserName` cache on the platform when real names are needed.
- **`reply_footer` (#11) is not wired**: the Codex-style status footer depends on model/effort capability getters and ctx%/usage computation (#1 usage domain), assigned to the M7 usage milestone; the `features.replyFooter` key is currently declared but not forwarded, default off.
- **Card button callbacks cannot be tested automatically**: `card.action.trigger` can only be verified by real-device clicks (the Feishu platform has no callback-simulation API); button paths are covered by pure-function table tests plus real-device smoke runs.
- **Multi-workspace is not migrated**: the channel→workspace binding (Go workspace_binding.go) and the per-workspace agent pool are not wired; single workspace + `/dir` per-chat override carries production needs, classified C in the group-E audit.
- **/fork can only seed from a live parent session**: Go copies completed turns from the persisted log, while the TS side degrades to a brand-new session when the parent is not in memory (the commented ceiling on adapter startSession).
- **Chatroom picker state is in-memory**: after a daemon restart, old pick cards become orphans (faithful to Go); remaining M7 domains (plan-render/usage/predict-next) advance per the MIGRATION.md queue.
- **`nav:/help` buttons are inert**: the cron card's back button targets Go's help-card system (`renderHelpGroupCard` + the `nav:` help navigation), which is not ported; the click reaches the engine and logs "no handler" instead of silently vanishing. Porting the help-card family is the fix; the `/dir` picker card ships without a back button for the same reason.
- **`/list`, `/status`, and `/switch` remain plain-text surfaces**: Go renders `renderListCardSafe`/`renderStatusCard` cards with `act:/list switch|delete N` actions; the TS commands keep their text output until that render domain is ported.
