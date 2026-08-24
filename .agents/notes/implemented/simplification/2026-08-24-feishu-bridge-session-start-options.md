# Agent Note: feishu-bridge de-baggage batch 6 — typed session-start options replace the CC_* env notes

Status: implemented

English | [中文](2026-08-24-feishu-bridge-session-start-options.zh.md)

## Problem

The engine→adapter channel for per-session persona and routing metadata was still the Go subprocess env-note array, long after the dsh cutover made it an in-process hand-off:

- `Engine.buildSessionEnv` wrote 17 `CC_*` KEY=VALUE strings per session start. Four of them (`CC_PROJECT`, `CC_SESSION`, `CC_SUBTASK_DEPTH`, `CC_RESEARCH_ASSISTANT_KEY`) had no reader at all — leftovers of Go's subprocess consumers.
- The adapter parsed the array back with `envHasFlag`/`envValue` line scans in three consumers (`sessionBypassesPermissions`, `buildSessionSetup`, the moderator plan downgrade) plus one smuggle: `startSession` read `CC_SESSION_KEY` out of the array as the engine session key — env var semantics hiding a typed parameter.
- Delivery rode a one-shot mutable slot (`setSessionEnv` + `this.env`): consumed by the next `startSession`, whatever that was. An empty env deliberately left the slot untouched, so a placeholder-state stall retry could inherit the previous session's persona flags — a latent cross-session leak the slot design could not express its way out of.
- `renderQuery` carried a `void sessionEnv` parameter (Go parity residue: dsh one-shots spawn in-process), threading a `[...state.sessionEnv]` copy through the whole plan-render fork chain.
- `sanitizedChildEnv` in the lark tool defensively dropped `CC_PROJECT` from child envs that the daemon never sets — dead defense once no code path produced the name.

## Decision

One typed parameter replaces the string protocol: `Agent.startSession(sessionID, options?: SessionStartOptions)`.

- **`SessionStartOptions` (core/types.ts)** groups what each adapter consumer actually reads: `sessionKey` (non-empty overrides the startSession id as the engine key; cron new-per-run keeps its two-identifier split — interactive slot key with the `#cron:` suffix vs the suffix-free session key), optional `subtask {attended, noReport, researchAssistant}`, optional `chatroom {role, directRole, moderator, ledgerDir, research, researchAssistantChild}`, optional `feishuWorkspace`, and optional `venv {virtualEnv, pathBin}`. Reader-less variables are deleted, not modeled.
- **`researchAssistant` is split by reader, not by provenance.** The research-assistant flag (a subtask-child concern read by the report-preamble branch) lives on `subtask.researchAssistant`; the pre-spawned assistant's session key (a chatroom-role concern read by the persona prompt builder) lives on `chatroom.researchAssistantChild`. In production the two never coincide: role sessions carry the key without the flag, assistant children carry the flag without the key. A single `researchAssistant {childKey}` group would have made each session carry a field its reader never consults.
- **`Engine.buildSessionStartOptions`** replaces `buildSessionEnv` (and folds `feishuWorkspaceEnv` into it); `startAgentLocked` passes the options through as a parameter, so concurrency safety is structural — there is no slot to crosstalk. The stall retry re-injects `state.sessionStartOptions`; a placeholder state (no session ever started) now passes `undefined` — a plain session — instead of inheriting whatever the slot last held.
- **`RenderQuerier.renderQuery` drops the `sessionEnv` parameter**, and the plan-render fork chain (`renderContentToHTML` / `renderPlanToHTML` / `renderReplyToHTML` / `launchPlanRender` / `renderAndDeliverReply`) loses the threaded copies. Render isolation is the fresh in-process one-shot session itself.
- **The lark child-env `CC_PROJECT` drop is deleted** along with its test fixture entry: no producer of the name exists.
- **Model-visible text is untouched.** The workspace routing section still emits its `CC_FEISHU_*` lines (the lark/feishu-search skills' prompt contract), and the chatroom priming prompt still references `$CC_RESEARCH_ASSISTANT_CHILD` — the role actually receives the key through the persona prompt text built from `chatroom.researchAssistantChild`, not through any env.

## Alternatives considered

- **Keep the env array as the wire format and only type the producer.** Rejected: the array's only reader was the adapter itself (the CLI env contract retired with the dsh cutover), so the string round-trip bought nothing and cost the smuggled `CC_SESSION_KEY` and the stale-slot failure mode.
- **A single `researchAssistant {childKey}` group on the options.** Rejected: the flag and the key have disjoint writers (assistant children vs research roles) and disjoint readers (subtask preamble vs chatroom persona); one group forces every session to carry a dead half.
- **Drop the venv fields entirely (no adapter reader).** Kept as data: the Go research path's `VIRTUAL_ENV`/PATH rewrite never reached the in-process dsh world, but the persona prompt still tells the model to use `$VIRTUAL_ENV/bin/python` — the fields preserve the one typed place that data can flow from when that gap is closed (see Consequences).

## Consequences

- `CC_SUBTASK_DEPTH`/`CC_RESEARCH_ASSISTANT_KEY` parity is gone by design (no reader); the scrub-safe `CC_SESSION` alias and its rationale (dsh stripping `*KEY*` env names) die with the array — nothing reads env anymore.
- The placeholder-stall-retry fix is a behavior change in a corner: a stall retry on a state that never started a session now starts a plain session instead of one wearing the previous session's persona. No production path exercises it (stall retry requires a live session), and the old behavior was the bug.
- `venv {virtualEnv, pathBin}` is carried, not consumed: no adapter code reads it today. The pre-existing gap it documents — the research persona prompt references `$VIRTUAL_ENV`, which the in-process dsh agent's Bash children do not inherit — predates this change and is out of B6 scope.
- Coverage: the env-injection suites (`engine-events` startAgentLocked, `engine-workspace-env`, `engine-chatroom-venv`, `engine-subtask` options builders, `cron-execute` session-key split) assert the typed surface; `adapter.spec.ts` / `chatroom-persona.spec.ts` drive personas through options; the deleted-behavior cases (nil-env-leaves-slot-untouched, render env passthrough, lark `CC_PROJECT` scrub) were removed with their behaviors.
