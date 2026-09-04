# Agent Note: per-run scratch dirs for parallel research chatrooms

Status: implemented

English | [中文](2026-09-04-chatroom-parallel-run-dirs.zh.md)

## Problem

Parallel chatrooms under one enabled bot are architecturally supported: chatroom state keys by hub, ledger dirs key by `hashID(hubKey)-run`, and the shared research venv creation already serializes across concurrent chatrooms. The interference surface left is the research workspace root: every research assistant and the data steward take the workspace root as cwd, and the assistant preamble's first discipline told them to write "all scripts and data to the current directory". Concurrent rooms then overwrite each other's generic root-level names (`logs_*.txt`, ad-hoc dirs like `beijing_housing/` — the production workspace already carries this residue from single runs), and even one room accumulates scratch no one can attribute to a chatroom.

## Decision

Engine bookkeeping isolates run-scoped scratch; shared assets stay shared by design. At research provisioning, each role assistant gets `<researchWorkspace>/runs/<ledger-tag>/assistant-<role>/` and the steward gets `.../steward/`, where ledger-tag is `hashID(hubKey)-chatroomLedgerRun` — the same tag as the ledger dir, so one scratch dir per chatroom instance with a matching audit trail. The dir is pre-created (mkdir failure warns; the stamp alone suffices — the assistant mkdir -p's on first use), stamped onto the child's chatroom featureState (`researchRunDir`), carried through `SessionStartOptions.subtask.researchRunDir` by the chatroom plugin's session-start-options listener, and named in the assistant preamble's first discipline. An empty stamp (no workspace, or a pre-stamp session recovered from disk) keeps the previous cwd wording.

Untouched sharing: the venv, `data/core/`, `data/<role>/`, and the append-only `DATA_LEDGER.md` stay at the workspace root — parallel rooms dedup fetches through the ledger exactly as before.

## Alternatives considered

**cwd = the run dir.** Rejected: the ledger and data disciplines are relative paths from the workspace root (`DATA_LEDGER.md`, `data/core/`), and the steward's prefetch assumes one shared area; moving cwd breaks ledger discovery for a one-line scratch win.

**Engine-level per-domain fetch queue / single dispatcher.** Already deferred in the package README; the parallel cost a dir scheme cannot fix is topic overlap (per-domain fetch pressure amplifying anti-crawl blocks). The usage rule stands: stagger overlapping research rooms; disjoint topics and plain rooms parallelize safely.

## Consequences

Two concurrent research chatrooms never overwrite each other's scratch, and each chatroom's scratch is auditable beside its ledger. Run dirs persist like ledgers (no auto cleanup). Remaining parallel edges are documented in the package README: `data/<role>/` name collisions across same-role rooms, tail-append races on the single `DATA_LEDGER.md`, and same-role cross-run memory lost-update (the dsh-memory index upsert is last-write-wins — a dsh-memory-generic concurrency fact, deferred to that package).

## Testing

`chatroom-state.spec.ts` covers the `researchRunDir` codec roundtrip (projection and survive-reset carry). `engine-chatroom-steward.spec.ts` asserts per-assistant and steward stamps, on-disk creation, and the `''` fallback without a workspace. `chatroom-subtask-seam.spec.ts` asserts the `subtask.researchRunDir` decoration and its absence. `adapter-persona.spec.ts` pins the model-visible preamble text both ways (run dir named, cwd fallback). Full chatroom + bridge suites: 180 files, 3175 passed.
