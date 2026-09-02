# Agent Note: str_replace_editor joins the sandbox escalation contract

Status: implemented

English | [中文](2026-09-02-tool-str-replace-editor-escalation-parity.zh.md)

## Problem

The cross-family sandbox contract ([the sandbox note](../feature/2026-07-06-sandbox.md)) says every confining consumer advertises paired `sandbox_permissions` + `justification` fields for one approved strictly-wider retry, and maps denials to the shared marker plus the same-turn escalation hint. The bash tools and the `dsh-tool-fs` `write`/`edit` tools honor it; `str_replace_editor` — the Claude-Code-style editor the feishu-bridge profile composes as its editing surface — resolved the per-call policy but advertised no escalation fields and appended no hint, so a confined edit was a terminal denial: the model had to improvise a bash detour to touch a path the fence rejected.

## Decision

`MutationPolicy` in `packages/fs/tool-str-replace-editor/src/index.ts` now carries the same escalation surface the tool-fs controller has: `escalationModes` advertisement (`ESCALATION_TARGETS` exactly when `ctx.fs.sandboxMode` is defined), the two schema fields spread into the tool's `parameters` under a confining backend (absent otherwise, so the validator rejects them before `execute`), `resolvePolicy(args, exec)` validating the pairing and routing a strictly-wider retry through `approveEscalation` (`ctx.approval`, tool name `str_replace_editor`) before anything executes, and `mapError` appending `escalationHintMarker('operation')` to the denial marker. The three mutating commands (`create`, `str_replace`, `insert`) resolve their policy through it; `view` stays read-only. The vocabulary and fail-closed sequence all come from `@deepseek-ai/dsh-sandbox` — the editor owns only its glue, the same shape bash and tool-fs own theirs.

## Alternatives considered

**Import `FsSandboxController` from `dsh-tool-fs`.** Rejected: it is an unexported sibling tool package's internal; coupling two tool packages to share a controller is a bigger topology change than the ~60 lines of glue each family already owns (bash does the same).

**Move the controller into `dsh-sandbox`.** Rejected for now: the controller binds cordis `Context`, `dsh-tools`' execution context, and `dsh-fs`'s `FsError`; `dsh-sandbox` is deliberately the vocabulary-only leaf. A shared home is worth revisiting if a fourth fs-family tool appears.

## Consequences

A confined `str_replace_editor` mutation now reads identically to a denied `write`/`edit`: the shared marker, the retry hint, and an approved grant that stamps the wider mode onto that one mutation. The feishu-bridge profile's editor gains the recovery path in `workspace-write` sessions; after a `danger-full-access` plan-approval elevation ([the preset note](../feature/2026-09-02-feishu-bridge-plan-approval-permission-preset.md)) the fence is gone and the fields sit unused. Deployments composing the editor from the registry pick the fix up on their next dependency refresh — the feishu-bridge live profile resolves this package from the pnpm store, not `link:`.

## Testing

`packages/fs/tool-str-replace-editor/tests/tools.spec.ts` (`sandbox escalation` describe): advertisement gating on both backend kinds, the marker-plus-hint denial text, an approved escalation stamping the granted mode onto the mutation, a rejected escalation failing closed without mutating, a missing approval service failing closed, and the argument-pairing rejection.
