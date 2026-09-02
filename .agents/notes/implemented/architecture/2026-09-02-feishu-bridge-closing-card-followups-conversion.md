# Agent Note: Closing-card asks convert to non-blocking followups suggestion cards

Status: implemented

English | [中文](2026-09-02-feishu-bridge-closing-card-followups-conversion.zh.md)

## Problem

The agent-conventions prompt mandates a closing `ask_user_question` multi-select card whenever a turn's「发现的问题 / 可优化点」section is non-empty. `ask_user_question` is a blocking tool, so the turn parks on the ask — and parking became the default end state of nearly every turn. The parked turn suppresses the ✅ completion notification (its only trigger is the turn's result event), holds the session lock (cron reuse-mode jobs on that chat fail with "session busy"), swallows the next free-text message as the ask's answer, is exempt from every reaper with no timeout anywhere, and turns stale on a daemon restart. Those park semantics are correct for genuine mid-turn questions; the closing card is what misused them.

## Decision

The engine's `askUser` delegate converts a recognized closing-card ask instead of parking it. Recognition is engine-side and signature-based — no model behavior change, no migration: a single questions ask whose header is the reserved「后续处理」, or a single multi-select question offering a「暂不处理」option. Both keys are traits the prompt already mandated, so live closing cards convert on the first deploy; the header constant lives in `engine/ask.ts` and the prompt template imports it, so the matcher and the prompt cannot drift.

- `isFollowupsAsk` (engine/ask.ts) owns the matcher; the conversion branch in `Engine.askUser` registers the question on `InteractiveState.pendingFollowups`, delivers the pre-ask reply segment (the same captureReplyForExport + length-threshold + auto-render-guard speculative render the parked path runs at deliverCards — the trailing post-ask text replaces the 实时播报 section, so without this render the closing summary survives only behind the export button; segment flush and completeAndDetach stay out deliberately so the turn keeps streaming and the turn-end export still registers the full joined reply), and returns a synthetic deferred decision whose custom text tells the model the selection arrives as a new message — the tool result itself is the second line of defense, so even a stale-prompt session ends its turn instead of waiting.
- `sendFollowupsCard` emits the blue suggestion card (checkOptions form, `fw_multi:0` action, recommended options pre-checked, in-form note input) right after `sendTurnCompletionCard` in `handleResultEvent`; an errored turn drops the registration, and a queued takeover carries it to the final turn's completion.
- The Feishu platform's card-action intake gains the `fw_multi:` branch: it composes a self-contained「[后续处理]」selection message (checked and skipped options with labels, plus the note; indices-only fallback when the send-time meta cache is gone) and dispatches it flagged `isFollowupAction`. `routeAskResponse` never claims that flag, so the selection starts a fresh turn even while another ask is parked; the submitted card freezes into its settled marks from the send-time cached meta, and each namespace consumes only its own meta entries.
- The prompt section is rewritten to describe the new semantics (register, then end the turn; selection = authorization; not clicking declines) and no longer mandates a「暂不处理」option.

## Alternatives considered

**Prompt-driven tool switch — a new non-blocking `feishu_bridge_followups` tool the prompt instructs the model to call.** Rejected as the mechanism: it relies on model compliance, so a missed instruction, a stale session prompt, or prompt drift falls back to the old parking behavior. The signature conversion instead keys on behavior the model already exhibits; the prompt rewrite is alignment, not load-bearing.

**Rendering the options on the ✅ completion card itself.** Rejected by product decision: the completion card is a pure status surface, and mixing decision UI into it reads as bad interaction design.

**Dropping the closing card for plain-text replies.** Rejected by product decision: the structured multi-select selection surface stays.

**A timeout that auto-settles unanswered closing asks.** Rejected: the ✅ would still arrive late (the two-card sequence the product rejected, time-shifted), and the park window — swallowed messages, busy cron — survives until the timeout fires.

## Consequences

Closing-card turns now end normally: the ✅ notification fires on time, the session lock releases (cron reuse jobs run), free text starts new turns, the idle reaper recovers the session, and a post-restart card click still delivers its selection as a fresh turn — strictly better than the parked ask, which restart voided entirely. The pre-ask closing summary keeps its parked-path visibility: the speculative render delivers it before the turn ends (below the length threshold, with plan render disabled, or when the render pipeline fails it stays behind the export button — each the parked path's own behavior). The costs: two pushes arrive back-to-back (✅ card, then the suggestion card) — accepted for the natural done→choose ordering, with a config knob as the escape hatch if chats get noisy — and the matcher is a display-text contract, so a closing card that deviates from all three signature traits falls back to parking (fail-open to the previous behavior, monitorable via the askq park rate). Genuine mid-turn `ask_user_question` asks park exactly as before. Pinned by `tests/engine/followups.spec.ts` (matcher, conversion, pre-ask render, emission, routing), `tests/feishu/card-action.spec.ts` (fw_multi intake and freeze), and the verbatim prompt pin in `tests/agent-dsh/adapter-persona.spec.ts`.
