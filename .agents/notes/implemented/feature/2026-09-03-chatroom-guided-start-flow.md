# Agent Note: /chatroom guided start flow (start and mode pick cards)

Status: implemented

English | [中文](2026-09-03-chatroom-guided-start-flow.zh.md)

## Problem

`/chatroom` grew nine parameter forms (two subcommands, five flags, two positional slots), and the useful ones were invisible: `--continue`, `--research`, and `--mode` existed only as typed flags, so a user who did not read the source or the usage text had no way to discover research mode or continuation, and the usage text itself lagged behind the implementation (it listed four forms while five flags and two subcommands existed). The #43 role picker and #59 topic picker had already established the guided pattern — everything the user does not state becomes a card — but only topic and roles were guided.

## Decision

Extend the picker family with two cards; flags stay as advanced overrides, and **every decision the user did not state explicitly gets its card** (a stated flag skips its card).

- **Start card** (`/chatroom-start-pick`, `ChatroomStartPickState`): a bare `/chatroom` with recorded chatrooms under `moderatorDir/ledgers` lists the five newest (topic, cast, started date) plus a 新讨论 row — direct-action buttons, one tap each, no moderator wake. No recorded chatrooms → the existing #59 topic picker directly (previous behavior). A tapped 继续 re-validates the ledger header (deleted → grey gone card), then: empty-cast prior → #43 role picker (explicit-path parity — the prior is dropped, recorded in the README limitations); research already stashed (explicit `--research`) → start now; otherwise arm the mode card with the prior and its cast.
- **Mode card** (`/chatroom-mode-pick`, `ChatroomModePickState`): plain roundtable / research auto / research manual rows echo the topic, cast, and prior note; each button starts directly — plain stashes a scrub, research modes stash their flags and gate on the shared uv venv first (failure → red needs-uv card, nothing spawns). It arms wherever a multi-role start is imminent and `chatroomResearch === false`: the role-picker confirm, the explicit `/chatroom <roles> <topic>` path, and the guided continue. Single-role confirms keep the direct 1:1 path (research is impossible without the moderator), and an explicitly-stashed `--research` starts immediately.
- **Bare `--continue` relaxation**: `/chatroom --continue` with no topic now resolves the newest prior and takes its recorded topic (previously a usage error) — a continuation has a subject by definition; without a ledger it still fails loud with the needs-ledger message.
- Usage text rewritten (zh/en): leads with the three guided forms, demotes the flags to an advanced line — fixing the pre-existing staleness where `--research`/`--mode`/`--max-rounds`/`list`/`stop` never appeared.

Engine seams only: two `registerCardAction` paths, two picker maps beside the existing ones, no tool-schema, session-event, persistence, or moderator-priming changes. `--max-rounds` deliberately stays a flag plus the configured default (the auto-mode row's blurb names the cap) — number options do not fit a three-row card.

## Alternatives considered

**Remove the flags entirely**: scripts and muscle memory lose the shortcuts; keeping them costs nothing — cards ask only what the user did not state.

**Guide only bare invocations** (explicit `/chatroom a,b topic` keeps starting immediately): leaves research undiscoverable exactly for users who type explicit commands; one tap on the mode card doubles as a final confirmation echoing topic and cast.

**Merge the continue rows into the #59 topic card**: the topic card is LLM-fed (`pick-topic` overwrites `recs` on arrival), so pre-seeded history rows would be clobbered by the moderator's late submission; a separate instant card keeps the LLM contract untouched.

**Radio + confirm buttons (two taps)**: every choice here is recoverable (cancel on each card, `/chatroom stop` after start), so direct-action rows halve the taps — the point of the change.

## Consequences

- The guided chain for a bare `/chatroom` with history is up to four cards (start → topic → roles → mode), each one tap and each skippable by stating the information inline; the chain shortens naturally as invocations get more explicit.
- Research venv provisioning moved from command time to mode-card tap time for the guided path (transitional 正在准备研究环境 card, then start or red error); the explicit `--research` path keeps the command-time gate.
- The guided continue reuses the prior cast verbatim; adjusting it means naming roles explicitly — recorded in the package README's Known Limitations alongside the empty-cast drop.
- Behavior is pinned by the new `engine-chatroom-guided.spec.ts` (18 cases: card arming, all start actions, venv failure, cancels, orphaned cards, no-history fallback, empty-cast fallback, `--research` skips, bare `--continue`) and the updated legacy specs, which complete the plain start through the shared `confirmChatroomModePlain` tap helper. Keyless recorded-session snapshots stay unclaimed for the chatroom surface (the corpus has zero chatroom cases, carried from the 2026-08-31 scan3 round).

## Related

- [Picker state is in-memory](../../../../packages/acp/feishu-bridge-chatroom/README.md) — the new cards share the orphaned-card grey-swap behavior and the restart exposure.
- [chatroom research dedup](2026-09-02-chatroom-research-data-dedup.md) and [research data reliability](2026-08-27-feishu-bridge-research-data-reliability.md) own the research flow the mode card selects into.
- [Cross-chatroom sharing](../architecture/2026-09-03-feishu-bridge-chatroom-cross-sharing.md) owns the ledger/inherit machinery the start card lists and the continue path resolves.
