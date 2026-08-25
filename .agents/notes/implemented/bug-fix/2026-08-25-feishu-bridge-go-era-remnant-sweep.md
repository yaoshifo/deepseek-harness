# Agent Note: Go-era remnant sweep — model-visible texts, the plan-file chain, and phantom-minting lookups

Status: implemented

English | [中文](2026-08-25-feishu-bridge-go-era-remnant-sweep.zh.md)

## Problem

Following the oc_ac5db assistant-key incident, three parallel audits (model-visible text, option plumbing, creating lookups) swept the bridge for Go/cc-connect-era remnants whose referenced mechanisms do not exist in the dsh backend. Verified findings, all real:

- The chatroom closing flow's first instruction (`dir: /tmp/chatroom-summary-<timestamp>`) named a directory nothing creates — `resolveDirPath` requires existence, so the spawn failed on the spot every time.
- The research-assistant preamble ran scripts with `$VIRTUAL_ENV/bin/python`; the Go `buildSessionEnv` injection was never ported (the venv start option was carried but never consumed), so the variable expanded empty.
- ~13 texts named the native tool `AskUserQuestion` with a `MultiSelect` parameter; dsh's tool is `ask_user_question`/`multi_select`, and the schema silently ignored the wrong parameter name, degrading the moderator's multi-select clarification cards to single-select.
- The plan-file tracking chain was dead through three breaks since the port: the engine matched `'Write'` while the adapter projects dsh's `'write'`; `toolInputRaw` was never projected; and the promotion condition required `toolName` and `done` on tool_result events that carry neither (`done` is only true on the turn-end result event). The plan-review "fresher file wins" refinement and the plan-export .md artifact silently degraded to the submitted copy.
- Every chatroom/hub state read and the subtask settlement router used creating lookups: a dangling hub or parent key silently minted a parentless registry record whose empty flags then misreported (ghost hub → research contract silently dropped, gathers degrade to serial relays; ghost parent → settlement delivered as a context-free agent turn in a dead record). Test harnesses were silently riding the mint.
- Smaller residues: the closing flow still declared the file-delivery tool "not yet shipped" while the same persona teaches it; `ExitPlanMode` instead of `exit_plan_mode`; the settlement wake hint named the retired `cc-connect subtask send` CLI.

## Decision

Three commits on `fix/go-era-remnants` (worktree `.claude/worktrees/go-remnants`):

1. **Texts reference what exists.** The closing spawn runs with `dir: ${ledgerDir}` (where the brief already writes); the assistant preamble inlines the concrete `<venv>/bin/python` from the venv start option (adapter now consumes it; the dead `venv.pathBin` field is deleted; a system-python fallback line covers unprovisioned runs); `ask_user_question`/`multi_select` everywhere; the stale delivery declaration, `ExitPlanMode`, and the CLI hint are corrected.
2. **Plan-file chain rewired.** The adapter projects `toolInputRaw` (parsed JSON object arguments); the engine tracks the pending plan write under dsh's `write` and promotes it by tool-call id match on the result event (success and denial both promote, preserving revise-the-same-file). The ported stubs now feed the realistic event shape instead of the impossible Go-era one that masked the break.
3. **Lookups stop minting.** `chatroomHubOf` (findActive + warn) backs all 17 hub-state reads — entry points fail loud, timer/relay paths treat a missing hub as no state, finalize still tears roles down; `deliverParentReply` delivers the card but never wakes and never mints on a dangling parent; `buildSessionStartOptions` reads the hub non-creatingly; `reportSubtask` fails loud on unknown keys, symmetric with `sendToSubtask`.

## Alternatives considered

**Auto-mkdir in resolveDirPath for the closing spawn.** Rejected: the fail-fast on nonexistent `--dir` is intentional (typos must not silently create directories); the prompt was wrong, not the engine.

**Real env injection for VIRTUAL_ENV.** Rejected: dsh agents have no per-session env mechanism; inlining the concrete path into the preamble achieves the contract without a new mechanism.

**Convert the record-enumeration lookups (findRoleKeyByName/collectSubtree consumers) too.** Deferred: those suffer the active-record-vs-stored-flags structural mismatch (below), which findActive does not cure.

## Consequences

Deferred with explicit triggers, for a separate change: the structural mismatch where chatroom state lives on per-Session records but resolves through the per-key active mapping — a `/new` in the hub or role chat swaps the active record and silently orphans moderator/research/barrier flags (gather never completes, personas reset). Fix requires id-based resolution of stored records. Also deferred: dead i18n keys from unported `/allow`/`/yolo` commands, the half-wired `toolResultMeta` projection, and dead Event type fields (`arrivedAt`, `requestID`, `sessionID`/`error` dead reads, `gitBranch`, `UserQuestionOption.preview`).

## Testing

Per-commit focused suites all green: texts (persona/gather/venv/adapter, 109), plan-file chain (plan-file/subagent-card/projection, 30, plus new projection cases), lookups (engine 1348 + agent-dsh + assembly; new dangling-key tests for gather, buildSessionStartOptions, and ghost-parent settlement with session-count assertions). The combined full run shows a pre-existing load-dependent flake (`skips the rollback when --worktree is requested`, 5 s timeout) that reproduces identically on the base commit — not from this change. Bridge typecheck passes.
