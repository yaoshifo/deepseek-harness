# Agent Note: Failure reports carry the fixed brief, not raw error text — closing the moderation cascade

Status: implemented

English | [中文](2026-09-10-subtask-failure-brief-moderation-cascade.zh.md)

## Problem

On 2026-09-09/10 the Zhipu GLM gateway tightened content moderation (code 1301: "系统检测到输入或生成内容可能包含不安全或敏感内容…"). Ten sessions on the dev server were blocked — and the bridge's own failure reporting amplified the blast radius: when a subtask or chatroom-role turn errored, the failure report pushed the provider's **raw error text** (and the turn's partial streamed output) into the parent / moderator agent's context via `deliverMachineMessage`. The provider's accusation wording ("不安全或敏感内容") inside that context then tripped the same moderation block on the parent's next request — sessions failed, reported, and failed again downstream (three sessions in the deepseek-harness bucket began their history with the propagated `⚠️ 子任务回合失败：[1301]…` text). Session-log evidence shows `turn/end` error metadata never reaches the model context; the failure-report injection points are the only channel raw error text enters another agent's context.

## Decision

Error-reasoned failure reports are a **fixed template, zero foreign text** — the only discriminator is the structural fact that the turn errored (`if (errored)`), because any detection of *which* errors are dangerous is itself a guess about provider output (keyword matching breaks on rewording; JSON-shape matching breaks on non-JSON provider errors; both were rejected in design review).

- `failureBriefForAgentContext(errorText)` (feishu-bridge `engine/subtask.ts`, exported through `./exports` for the chatroom package) renders the brief: `[failure code=1301] 子任务回合中断（<advice>）。错误原文与半截输出未随附（防下游连锁误判）…；可用 feishu_bridge_subtask（action: send）追问该子任务获取进展。请求 ID：<id>。`
- Dynamic fields are regex-extracted and whitelist-validated (`[A-Za-z0-9_.-]{1,32}` for the code; hex/timestamp shapes for the request id) — a provider stuffing prose or oversized text into those fields drops the field, never carries the payload. Zero throw paths: pure string scanning, no `JSON.parse`.
- A per-code advice table (1301 content block → "重试大概率再触发，建议调整任务或换模型路由"; 429 → wait; 401/403 → report configuration; 5xx → retry later; unknown → generic guidance) restores the parent's decision quality without re-transmitting provider wording. Extend the table when a new code's semantics are confirmed.
- Wired at the three `if (errored)` sources: the subtask auto-report (`engine.ts` processInteractiveEvents), the chatroom role failure note, and the chatroom serial failure wake (`chatroom.ts`). Gather / end-barrier / native-child paths consume these sources and inherit the brief.
- **Partial streamed output no longer rides the failure report** — it is the output the provider cut mid-generation, with no way to verify it is clean; recovery channels are the on-disk work, the child session log, and `feishu_bridge_subtask` follow-ups (the brief points at them).
- Humans keep the raw text: the child group's error card and the daemon log are untouched, and the parent-facing report card appends the raw error text after a `---` divider through the new `cardDetail` channel (`maybeAutoReportSubtask` → `replyToParent` → `deliverParentReply`, optional parameter; the injected wake always carries the brief alone).

**Convention for future paths:** any new code path that injects an errored turn's text into another agent's context must go through `failureBriefForAgentContext` — the raw text may only reach human-facing surfaces (cards, logs).

## Alternatives considered

- **Keyword / error-code detection of "moderation" errors:** rejected — rewording or a new provider breaks the classifier; the miss re-opens the cascade.
- **JSON-shape discrimination (platform vs local errors):** rejected — still a shape guess; non-JSON provider errors (plain-text SDK failures, proxy HTML) leak through, and "local" error text can embed provider content.
- **Request-layer self-healing (auto-splice the poison message and retry the parent turn):** rejected — rewrites turn semantics and session history; cannot help when the trigger is the task's own content (the ledger data in this incident).
- **Persisting the detail to a file and passing a pointer:** rejected — the parent's `read` of that file re-imports the raw text; a pointer only defers the problem.

## Consequences

- The parent / moderator receives decision-grade information (who failed, code, advice, request id, follow-up channel) with no foreign text; the human sees the full raw error on the parent card and the child group's error card.
- `code=未分类` reports (plain-text local errors such as `No API key for provider`) cost the parent one potentially wasted re-dispatch — accepted; the raw text is one `read` or card glance away for the human.
- Losing the partial is real information loss for long-running tasks whose narration mattered; if this proves a recurring pain, the upgrade path is a pre-failure progress report (child reports its on-disk state before risky final steps), not re-admitting raw text.
- Advice-table coverage is open-ended: unknown codes fall to the generic line; add confirmed codes at the table.
- The fixed brief's wording avoids known trigger terms (敏感/不安全/审核/拦截者-style phrasing); provider-side black boxes cannot be pre-verified, so the deployed effect is the acceptance test.

## Testing

`packages/acp/feishu-bridge/tests/engine/engine-subtask.spec.ts`: the brief's moderation-safety (1301 JSON → brief with code/advice/request id, no provider wording, no partial, card appendix carries the raw text), the extraction matrix (429/401/unknown/5xx advice, bracket-prefix code, oversized and non-whitelisted code payloads dropped, request-id omission), and the rewritten error-report behavior test. `packages/acp/feishu-bridge-chatroom/tests/engine/engine-chatroom-ask-routing.spec.ts` + `engine-chatroom-gather.spec.ts`: the moderator wake and the gather barrier record carry the brief, not the raw text or the partial. Full two-package suite green (3379 tests) and `tsc -b` clean on both packages.
