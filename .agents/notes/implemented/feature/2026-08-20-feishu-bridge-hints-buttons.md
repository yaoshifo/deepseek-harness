# Agent Note: feishu-bridge hints quick-prompt buttons

Status: implemented

English | [中文](2026-08-20-feishu-bridge-hints-buttons.zh.md)

## Problem

Go cc-connect rendered three global config groups — `hints`, `hints_with_param`, `hints_common` — as quick-prompt buttons: compact buttons folded into the completion footer's collapsible panel, one button-plus-input row per param hint, and always-visible common buttons at the card bottom, all re-ordered by persisted click frequency, plus a `/hint` card. The M4-E wiring audit classed the whole hints surface as C-group "engine mechanism not ported" and `buildStatusFooterElements` shipped without it — so the user's migrated config produced no buttons anywhere.

## Decision

`src/engine/hint-usage.ts` ports Go `HintUsage` (write-through JSON at `<dataRoot>/hint_usage.json`, stable frequency-descending sort). One deliberate divergence: Go's load/save round-trips only `hints` and `hints_with_param`, silently dropping `hints_common` counts; the TS store persists all three categories. `src/engine/hints-panel.ts` ports `hintButtonName`/`ParseHintButtonName` (base64url of the hint text in the form button name — Feishu form_submit callbacks omit action.value — with a 95-char cap falling back to FNV-1a plus a process-lifetime reverse map, same as Go's `sync.Map`: after a daemon restart, hashed long-hint buttons on old cards are undecodable in both implementations) and the three element builders. Two Node/Go differences needed explicit handling: `Buffer.from(x, 'base64url')` silently skips invalid characters where Go's decoder errors, so `parseHintButtonName` re-encodes and rejects non-canonical names; and Feishu card schema 2.0 rejects a form without a submit descendant (error 300123), the very reason the footer's form wrapper had been removed — the wrapper now returns only when hints are configured, since the folded form_submit hint buttons satisfy the schema. Go's early return on a fully empty footer state is kept: hints ride footers that already carry content (workdir, usage, duration) and never render alone.

`status-footer.ts` merges the panel elements into the collapsed set before wrapping in `status_footer_form`; common buttons append as `hints_common_form`. `feishu/platform.ts` decodes `hint__` names in the empty-value branch, reports clicks through `setHintClickHandler` (engine `start()` wires it to the shared `HintUsage.increment`), and the `cmd:` branch appends the `_arg`-located form input (first non-empty string as fallback) plus echoes the final command text. `/hint` renders the standalone card or a numbered text list. Config lives at the plugin top level (`hints` / `hints_with_param` / `hints_common`, mirroring Go's global toml keys) and `apply()` shares one `HintUsage` across engines.

## Alternatives considered

**Per-project hint config.** Rejected: Go wires the three lists globally in `wire.go` for every engine, and the shared click-count store only makes sense process-wide.

**Persist the hashed-name map to survive restarts.** Rejected: keeping Go's in-memory semantics is one less store file; the loss window is buttons on cards older than the last restart, and only for hints whose encoded name exceeds 95 chars.

## Consequences

Completion footers, `/new` cards, and `/hint` carry the buttons; clicks reorder all three groups by frequency across projects and survive restarts. Buttons on completion cards dispatch as ordinary user messages in the same chat, so a hint is indistinguishable from typing the command by hand (including plan-mode approval flow).

## Testing

`tests/engine/hint-usage.spec.ts` (counts, stable ordering, three-category persistence, corrupt store), `tests/engine/hints-panel.spec.ts` (name encode/decode incl. hashed over-cap path and invalid-name rejection, element structure, frequency ordering), `tests/engine/status-footer.spec.ts` (form-wrapped panel merge, common form, empty-state early return), `tests/feishu/card-action.spec.ts` (name dispatch, `_arg` extraction and fallback, echo, click reporting), `tests/engine/commands.spec.ts` (`/hint` card, text fallback, empty notice), `tests/assembly-config.spec.ts` (config wiring, shared usage instance). Real-device smoke on 开发虾: `/hint` card and a live completion footer both render all three groups; button clicks are user-checked.
