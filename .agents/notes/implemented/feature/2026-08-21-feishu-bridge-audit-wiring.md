# Agent Note: migration-completeness audit and the low-hanging wiring batch

Status: implemented

English | [中文](2026-08-21-feishu-bridge-audit-wiring.zh.md)

## Problem

The user asked for a code-level verification that the cc-connect → dsh-feishu-bridge migration was actually complete, rather than trusting FEATURE-PARITY's "51 ✅ / 10 ✂️". A three-way audit (command inventory, config/wiring keys, non-command capability surfaces) against the read-only Go repo found four classes of gaps beyond the already-tracked M8 leftovers: two false ✅ rows (#20 restrict_to_workdir claimed a D3 setup-hook restrict() that does not exist anywhere in TS; #35a's reaction chain is ported at the platform level but the engine never calls `startTyping`), one B-class wiring loss with security relevance (`allow_from` implemented in `platform.ts` but unreachable from config), eight more implemented-but-unconfigurable platform option keys, an inbound `RateLimiter` ported in M0 and never wired (no flood protection; only `queue.maxDepth` bounds depth), and no wall-clock cap on a trickle-forever turn (the idle stall detector only fires when events stop arriving).

## Decision

**Wiring batch (all landed):**

- `feishu.allowFrom/groupOnly/shareSessionInChannel/threadIsolation/replyToTrigger/respondToAtEveryoneAndHere/enableFeishuCard/progressStyle/activeTagName` enter the Config schema and the assembly forward. `replyToTrigger` maps to the inverted platform flag (`noReplyToTrigger: true` only on explicit false, Go default true); `enableFeishuCard` → `useInteractiveCard`; `activeTagName` → `activeTagOverride`. Unset keys stay undefined so platform defaults apply.
- Inbound rate limiting: `config.rateLimit` (Go defaults 20 messages / 60 s armed unconditionally at assembly, matching wire.go; `maxMessages: 0` disables) → `engine.setRateLimitCfg` → `checkRateLimit` keyed by sessionKey (Go's legacy path; the `[users]` role path is a documented cut) → gated in `handleMessage` after content merge and before permission/chatroom routing, Go engine.go:2470's position. Replies the previously dead `rate_limited` i18n key.
- Absolute turn cap: `display.absoluteTurnTimeoutSecs` (unset = 2× idle, 0 disables) → `absoluteTurnMax` → hard cap 3× enforced **on event arrival** in `processInteractiveEvents`, killing with the previously dead `watchdog_reset` message. Arrival-time enforcement is the deliberate TS shape: the event loop has no watchdog goroutine to poll, and the trickle-forever case is exactly the one where events keep arriving; the quiet case is already owned by the stall-retry path (TS's designed primary, where Go's watchdog is only a backstop). Research sessions lift the cap via a faithful `isResearchSession` predicate (assistant flag or research-hub role).
- Three alias gaps: `dir` += chdir/workdir, `hint` += ht, `compress` += compact (the last was fully unreachable — TS prefix matching needs ≥2 chars and "compact" is not a prefix of "compress").

**Deliberately not wired:** `resolve_mentions` (belongs to the unported mention-resolution capability) and `stream_preview.partial` (Go used it only to drive claudecode's `--include-partial-messages`; the dsh adapter event stream has no such distinction — exposing it would be a dead knob, violating the no-dead-tunables rule).

**User ruling (2026-08-21):** the 19 previously unadjudicated missing commands are an intentional curation — they stay unported by design (`/tts` additionally waits on the voice-capability ruling). Recorded in README Known Limitations and MIGRATION.md 补充 16; the builtinCommands count is corrected 52 → 53 and `/skills` is struck as a doc typo (Go has no such command).

**Doc corrections:** FEATURE-PARITY #20 becomes 📋 (M8 ruling), #35a's note now states the reaction chain's true state, OPERATIONS.md's stale language/mode TODOs become real mappings, and the README reply_footer limitation is updated to the true state (wired in M7-b; only the balance segment waits on adapter growth).

## Alternatives considered

**Port Go's watchdog goroutine wholesale (quarter-period poll + decideWatchdog verdicts).** Rejected: the TS event loop's structure makes a poll loop a second source of truth for turn state; the hard-cap-on-arrival check plus the existing stall-retry path covers both Go verdicts that matter (soft-cap-quiet collapses into the stall path, hard-cap is the only genuinely missing verdict).

**Expose `stream_preview.partial` anyway for config parity.** Rejected: a config key with no consumer is exactly the misconfiguration-fails-loud violation the repo forbids.

## Consequences

Production gains flood protection and a trickle-forever bound with zero profile changes (Go defaults apply). The audit's P2 list — voice-message transcription (inbound audio is dropped today; the old production config had `[speech]` enabled), failure classification + redaction, `[hooks]`, comment-session driving, `[references]`, two embedded skills (feishu-search / lark-guide), lark_skills sync, sessions_tui / feishu setup wizard, heartbeat / skill_presets, the #35a reaction chain, and restrict_to_workdir (#20) — was ruled entirely unported by the user the same day; each cut is recorded in README Known Limitations, FEATURE-PARITY (#20 → ✂️), and MIGRATION.md 补充 16. The audit also confirmed the Go foreign-session-event leak fix (9323dd8d) is structurally resolved in TS by the adapter's session-id + lineage routing.

## Testing

`tests/assembly-config.spec.ts`: platform-option forward (values, defaults, inverted replyToTrigger), rate-limit wiring with the 20/60 default and the 0-off switch, absolute-cap wiring with the 2× fallback. `tests/engine/engine-events.spec.ts`: third-message rate-limit drop (busy-session queue shape), unlimited default, absoluteTurnMax defaults, isResearchSession predicate, hard-cap kill of a 150 ms trickle under a 400 ms idle, and the research exemption surviving past the cap. Alias coverage rides the existing matchPrefix and compress-resolver tests.
