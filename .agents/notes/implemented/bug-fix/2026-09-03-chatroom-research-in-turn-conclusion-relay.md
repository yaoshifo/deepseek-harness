# Agent Note: Research relay must not defer an in-turn conclusion

Status: implemented

English | [中文](2026-09-03-chatroom-research-in-turn-conclusion-relay.zh.md)

## Problem

A research role that consumed its assistant's results inside the same turn had that turn's reply silently dropped. `maybeAutoRelayRole` deferred on `researchDispatched` alone, conflating "dispatched an assistant this round" with "the conclusion is still owed". Observed live in the 2026-09-02 oc_e51a research chatroom (Xiaomi stock, 9h38m total, `researchTimeoutSec: 7200`): both roles sent their round task to the assistant and then blocked on the subtask gather inside the same turn; the gather resolved in-turn (assistant turn ends 00:07 / 02:09 / 02:12 / 03:53), the role concluded, and the turn end (00:17 / 02:11 / 02:14 / 03:59) deferred anyway. Four of six research turns lost their conclusions this way; each loss stranded the armed gather until the 7200s research timeout, and the moderator recovered through direct asks. `buildGatherTimeoutWake` read the same flag, so the timeout report claimed "assistant dispatched, not returned" when the assistant had returned and the role had concluded. The defer logic predates the research-dedup batch (2026-09-02); the dedup design's role-assistant flow surfaced it.

## Decision

Defer only while the dispatched assistant verifiably still owes its report: the defer branch additionally requires `assistantReportPending` — the pre-provisioned assistant's turn is in flight (`interactiveStates[key].activeTurns > 0`) or its current dispatch cycle has not reported (`!getSubtaskReported()`; a parent follow-up re-arms the one-shot report). Once the assistant has reported and is idle, the ending turn IS the conclusion and relays into the armed gather. Unresolvable assistants (no `researchAssistantKey`, session gone) read as pending, preserving the conservative defer for fallback-spawned assistants. `researchDispatched` semantics and `buildGatherTimeoutWake` stay unchanged: a role that deferred had a verifiably pending assistant at defer time.

## Alternatives considered

- **Clear `researchDispatched` when the blocking gather resolves in-turn.** The gather resolves on any child turn end, including an intermediate status report (an assistant that dispatched its own fetchers ends its turn with "waiting for children" — the oc_e51a marks round-1 shape); a gather resolution alone cannot distinguish a final contribution, so it would re-open a premature-relay path.
- **Keep the unconditional defer and rely on the assistant's report to wake a conclusion turn.** That path works only when the role ends its turn before the assistant reports; in-turn consumption produces no later wake, which is the observed failure.

## Consequences

- Tests in `engine-chatroom.spec.ts` pin three shapes: the in-turn conclusion relays into the armed gather; the relay still defers while the assistant's turn is in flight; it still defers when the dispatch cycle has not reported (silent or re-armed assistant).
- A narrow race remains: a role turn ending between the assistant's turn end and the async report delivery (`replyToParent` is fire-and-forget through a platform card send) relays a possibly pre-report reply. It is unreachable for gather-mediated turns (the blocking tool call holds the turn open until the results land) and was not observed; accepted over stranding every in-turn conclusion.
- Re-measure on the next research chatroom: "deferring relay" log lines appear only while the assistant is verifiably in flight, and research gathers complete without timeouts. Related notes: `2026-09-02-chatroom-research-data-dedup` (the role-assistant flow this relay serves), `2026-09-02-mid-epoch-report-redelivery` (the report delivery machinery).
- Deployment: chatroom package rebuild + `/reload` on both machines.
