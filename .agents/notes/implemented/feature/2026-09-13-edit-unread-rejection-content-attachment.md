# Agent Note: edit unread rejection attaches the current file window

Status: implemented

English | [中文](2026-09-13-edit-unread-rejection-content-attachment.zh.md)

## Problem

The `fs-observation-policy` gate requires a session-local `read` before `edit` (blind-edit prevention plus the CAS version guard). grep results do not record an observation, so the highest-frequency model path is grep → direct edit → `FS_NOT_OBSERVED` rejection; the model then spends a full round on `read` before retrying. On the bridge that round is tens of seconds of wall time per occurrence, and the model-side instruction ("Read the file first") was already present in both the tool description and the system prompt — the friction is model compliance, not discoverability.

## Decision

Keep the policy gate byte-identical; change only what `edit` returns on the unread rejection (`packages/fs/tool-fs/src/edit.ts`, `enrichNotObserved`):

- On `FS_NOT_OBSERVED` the tool performs one recovery read (same stat + size-routing + `buildWindow`/`formatReadOutput` path as the `read` tool, same caps) and appends the numbered window to the error text: `cannot modify "<path>": file has not been read — current content (up to <limit> lines) follows; retry the edit directly`. The model retries in the next turn without an intervening `read`.
- The recovery read emits `fs/observed` (present, version), so the retried edit guards on that version through the unchanged CAS path.
- A target the recovery read confirms absent fails with `cannot edit "<path>": not found` instead — one round tells the model the file is gone, and the recorded absence updates the write guard.
- Any recovery-read failure (binary target, decode error, cancellation) falls back to the plain pre-change diagnostic byte-for-byte: worst case equals the old behavior.
- `write`'s create path is untouched (guarded creation has no such friction), but its unread-overwrite rejection was later enriched the same way — see the follow-up note on the rejection-enrichment extension. `remediateFsError` stays a pure function; the enrichment lives in `src/unread-attachment.ts` (shared by both tools) because it is IO.

## Alternatives considered

**Auto-read plus auto-execute on unread edit.** Rejected: it rewards skipping `read`, blind `old_string` guesses fail more often, and the model-verified-before-edit guarantee disappears. The rejection-plus-content form keeps the refusal signal while cutting the healing path from three rounds to two.

**Recording observations from grep.** Rejected: grep shows matching lines, not the file's full shape; counting it as read would bypass the looked-at-the-whole-file intent for a marginal round saving.

**Inheriting observations across fork/subagent sessions.** Deferred: the observation state is a per-session WeakMap keyed by the session object; cross-session inheritance needs version-staleness semantics worked out at the fork seam and is not the main trigger (grep-then-edit is).

## Consequences

- Unread-edit healing drops from three tool rounds (reject → read → edit) to two (reject+content → edit); the content injected is exactly what `read` would have injected.
- Each file is enriched at most once — the recovery read records the observation, so a second unread rejection cannot occur; a wrong `old_string` after enrichment fails on the literal-match path, which attaches nothing.
- The enriched rejection is a single text segment on an `isError` result; session-log, SDK projection, and generic error rendering are unchanged in shape. The `fs-policy-reject` session snapshot was re-recorded through the refresh channel: its recorded second direct edit now succeeds (the fixture shows reject-with-content → retry success → DONE) and `workspace.expected` moves blue → green.
- Error cards grow by the attached window (bounded by the read caps); the plain form remains for recovery-read failures (and, before the follow-up, for `write`).

## Testing

`packages/fs/tool-fs/tests/integration.spec.ts`: unread edit attaches content with the retry guidance and leaves the file untouched; the direct retry succeeds without an intervening read; a missing target passes `FS_NOT_FOUND` through; a 2500-line file attaches only the first window with the continuation footer; a binary target falls back to the plain diagnostic byte-for-byte; an external change after the enriched rejection still fails the retry with `FS_STALE_VERSION`. Package suite 371 tests green; `tsc -p packages/fs/tool-fs` and oxlint clean; `test:snapshot` replay of `fs-policy-reject` green (four unrelated snapshot failures pre-exist on `dev` without this change).
