# Agent Note: /dir picker card and act:/nav: card-action prefixes

Status: implemented

English | [中文](2026-08-20-feishu-bridge-dir-card.zh.md)

## Problem

The feishu-bridge `/dir` command was a plain-text surface while its Go original (`engine_cmd_workspace.go`) renders an interactive picker card: paged history rows with `act:/dir select N` buttons, `act:/dir reset`/`act:/dir prev` actions, and `nav:/dir N` page-turn buttons. Two routing gaps blocked any port. First, `handleCardAction` peeled every action with `slice('act:'.length)`, so it could not distinguish an `act:` value (run a side effect, then re-render) from a `nav:` value (re-render only) — Go's `handleCardNav` splits at the first colon and runs `executeCardAction` only for the `act` prefix. Second, the Feishu platform dispatched only `act:`-prefixed values as card actions, dropping `nav:` silently — a pre-existing dead button: the M4 cron card's back button carries `nav:/help` and has never done anything.

## Decision

`src/engine/dir-card.ts` ports `renderDirCard`/`renderDirCardSafe` as pure renderers (rune-safe 56→53+ellipsis path truncation, page size 5, primary button on the current dir, prev button only with ≥2 history entries, page-hint note only when paging). `cmdDir` sends the card on card-capable platforms — both for the no-args listing and after a successful `dirApply`, which returns the `dir_session_reset` notice — keeping the plain-text path as the fallback. `handleCardAction` now splits the action at the first colon, accepts only `act`/`nav` prefixes, and handles `/dir`: `act` maps `select N`/`reset`/`prev` onto `dirApply` (reusing `commandContext`, exported for this) and re-renders page 1 with the notice; `nav` parses the page number with no side effect. Both paths PATCH the pressed card through `asCardRefresher`, falling back to a new card. `supportsCards` moved from a private helper in `cron-commands.ts` to `core/types.ts` beside `asCardSender`, avoiding a `commands.ts ↔ cron-commands.ts` import cycle.

Two deliberate cuts. The `/dir` card omits Go's `cardBackButton()`: its `nav:/help` target has no handler, so shipping it would add a second dead button; the code comment names the help-card milestone as its return path. The `/cron` branch now executes its side effect only under the `act` prefix — observably identical today (no `nav:/cron` buttons exist) but it makes the prefix semantics uniform: side effects never run on `nav:`.

## Alternatives considered

**Route `nav:` by stripping `act:` from any action.** Rejected: `slice('act:'.length)` on `nav:/dir 2` happens to yield `/dir 2`, but a `nav:` value whose command also exists as `act:` would silently run side effects on a page turn, and `nav:/help` would mis-slice into `/help` only by luck of prefix length.

**Port `renderHelpGroupCard` in the same change.** Rejected: Go's help card is a navigation hub of dozens of `nav:` cards (`engine_cmd_misc.go`), each a separate render domain; bundling it would balloon the diff and its own review surface. The inert `nav:/help` button is documented in the README's Known Limitations instead.

**Keep `supportsCards` in `cron-commands.ts` and import it from `commands.ts`.** Rejected: `cron-commands.ts` already imports `isAdmin` from `commands.ts`, so the reverse import closes an import cycle; the predicate belongs beside the `asCardSender` capability check it wraps.

## Consequences

`/dir` and `/sp -d` bare-name resolution now work in the live profile once `dirScanPaths` is configured there (a config-only gap; the code was complete since M7-d). Clicking the cron card's back button now logs "no handler" instead of vanishing — noise, but a truthful signal that the help-card domain is missing. Every future card family that follows Go's `handleCardNav` switch reuses the prefix split; a new `nav:` command needs only a re-render branch, never a side-effect guard. Old `/dir` cards orphaned across a daemon restart simply re-render on the next `/dir` (page state is carried in the button values, not server-side).

## Testing

`tests/engine/dir-card.spec.ts` pins the card structure (header color, row values/types, current-dir primary, pagination clamps, empty-history note with the reset button kept, rune-boundary truncation, override precedence, error fallback). `tests/engine/commands.spec.ts` covers the `cmdDir` card path and its plain-text fallback; `tests/engine/engine-card-action.spec.ts` covers the prefix split, the `select`/`reset`/`prev`→`dirApply` mapping, invalid-index re-render without notice, `nav:` page turns without side effects, the PATCH fallback, and unknown `nav:` consumption; `tests/feishu/card-action.spec.ts` covers the platform `nav:` dispatch. Real-device clicks (the README's known callback-testing limitation) are covered by the smoke run.
