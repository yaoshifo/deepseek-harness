# Agent Note: One Msg object for the feishu-bridge i18n keys

Status: implemented

English | [中文](2026-08-20-feishu-bridge-msg-key-object.zh.md)

## Problem

The M0 port generated `src/i18n/keys.ts` with one exported constant per Go message key — 632 `export const MsgXxx: MsgKey = 'xxx'` declarations mirroring Go's flat `i18n.MsgXxx` constant block. `verify-export-jsdoc` documents every export, so the shape arrived with 632 mandatory JSDoc blocks whose only honest content would be `Message key 'xxx'.` — pure noise under the prose standard's "do not comment on facts obvious from code", and noise the gate could not waive.

## Decision

`keys.ts` exports one documented `Msg` const object instead: `Msg.ToolResult` is `'tool_result'`, typed by the existing `MsgKey` union via `as const`. `ALL_MSG_KEYS` and the `MsgKey` type are unchanged; the module header records that the grouped object is the deliberate deviation from Go's flat constants. Consumers reference `Msg.Xxx` across 15 source files and 3 test files. The i18n runtime and message tables are untouched.

## Alternatives considered

**Write 632 per-constant JSDoc blocks.** Gate-compliant but the generated file would carry hundreds of zero-information comments that a regeneration pass would have to maintain verbatim.

**A string enum.** `verify-export-jsdoc` checks enum declarations as one documented symbol, so this also collapses the surface, but it replaces the `MsgKey` string-literal union with enum types, rippling into the message tables' `Record<MsgKey, …>` keys for no gain.

**De-export the constants.** They are imported by 18 modules, so un-exported consts are not importable; only an object (or namespace, whose exported members the gate still checks) restores a single documented export.

## Consequences

The package's i18n key API differs from the Go original's shape (call sites read `Msg.X` instead of `MsgX`), so future regeneration of `keys.ts` against `core/i18n/i18n.go` must emit the grouped object, not flat constants. One JSDoc block replaces 632 gate obligations, and the exported surface shrinks by 631 symbols. If per-key documentation ever becomes genuinely necessary, flat named exports would return together with their documentation duty.
