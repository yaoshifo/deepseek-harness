# Agent Note: research wrap-up reconciles report numbers; every fetch surface binds the playbook

Status: implemented

English | [中文](2026-09-07-chatroom-research-recon-and-playbook-binding.zh.md)

## Problem

The 2026-09-06/07 CSI300/CSI500 DCA research field closed with final-report numbers that no in-pipeline step verifies (found by a three-way audit — ledger inventory, independent re-fetch, session-log replay): a "500 five-口径 spread 76pp" figure unreproducible against the field's own data (~54pp max across every available 口径×window), a threshold conversion (「指数≤4047点」) off ~1.4% from its stated PE threshold by EPS dating, and one role's findings claiming 「三源核对」 for a deposit rate whose two of three named sources had no fetch action anywhere in the session log — the number was right (steward-level dual-source), the claim was not. Structural cause: the moderator contract forbids the moderator from doing research, roles cross-check only numbers contested in-round, and the wrap-up HTML renderer transports rather than verifies — prose-level derived numbers in the closing report have no owner. Two adjacent gaps surfaced by the same audit: the playbook already carried the official 统计局 CPI recipe (appended earlier the same day by a parallel field's dalio), yet this field's assistant defaulted to a single-source akshare→金十 CPI mirror because the fetch instruction roles relay never mentions the playbook — the read-first preamble bullet is advisory and sits on the assistant's side only; and the field's 腾讯 per-stock PE pitfall (-21~-24% closure gap against official EY) never flowed back into the playbook, because the wrap-up backflow checklist (moderator CLAUDE.md, books repo) has no playbook item.

## Decision

- The research-mode wrap-up gains step「0. 先数字对账」(`chatroom-priming.ts`, gated on `researchWs`): before rendering the report HTML, the moderator spawns a read-only reconciliation subtask (dir = the research workspace) that maps every key number in the ledger's SYNTHESIS/SUBPROBLEMS/RECORD to a `DATA_LEDGER.md` row, a `data/` file, or a script/result artifact; local recompute through the workspace venv is allowed, network refetch and package installs are banned; 「X 源核对」claims are checked against the ledger; the result lands as `RECON.md` in the per-run ledger dir. The moderator folds misses into the synthesis via `note` (fix what is clearly wrong, mark 「对账存疑」+ confidence otherwise); subtask failure or ~15 min of silence skips forward — the wrap-up never blocks on reconciliation. Reconciliation precedes the render so the HTML reads the corrected ledger. Default (non-research) chatrooms never gain the step: without a shared workspace there is no ledger to map against.
- Fetch instructions now bind the playbook explicitly at every surface that reaches fetchers: the round-1 research task template and the round-2 deep-dive tail (both in the research moderator priming), the steward prefetch brief, and the engine-injected research-gather prefix (`chatroom.ts`) — verified playbook recipes first (macro/valuation via the speed table to official endpoints), aggregators only without a recipe and ledger-registered. The round-1 task and the gather prefix carry the binding unconditionally: the playbook rides the research-assistant persona (`chatroom-policy.ts` decorates every assistant and steward session), not the shared workspace.
- The wrap-up backflow checklist gains a playbook-lessons step; that contract lives in the books repo's moderator `chatroom/CLAUDE.md` (persona-side companion change, committed in that repo) and is noted here so the two halves stay discoverable.

## Alternatives considered

- **Moderator-side verification.** Rejected: the contract line keeping the moderator out of research is what keeps orchestration cheap; verification is dispatched like the HTML render already is.
- **Reconciling after the user reviews the HTML.** Rejected: the HTML is the durable artifact; corrections must land before it renders.
- **Engine-enforced numeric checking.** Rejected: number provenance lives in prose; a prompt-level convention matches the fetch-ledger precedent, and compliance stays measurable by re-mining a field's session logs.
- **Hard-gating the playbook read in the assistant preamble.** The preamble already carries the read-first bullet; the observed failure was the relayed task never mentioning it, so binding the task text closes that gap without a new enforcement layer.

## Testing

`engine-chatroom-gather.spec.ts`: the reconciliation leg is asserted gated — 「数字对账」/「RECON.md」/「禁止联网重抓、禁止装包」/「对账存疑」 present with a research workspace, absent without one and in the default moderator priming; the playbook binding is asserted present in both workspace shapes of the round-1 task plus the steward brief and round-2 tail, and in the engine research-gather card body alongside the unchanged contiguous 「数据可靠性要求：让助手只用权威一手源」 phrase. Full package suite (25 files, 361 tests) green; package `tsc --noEmit` clean.

## Consequences

Each research wrap-up grows by roughly 10–20 minutes when reconciliation runs (bounded: read-only plus local recompute, skip-forward on failure or silence); every research gather role message grows by ~40 tokens. `RECON.md` lands in the per-run ledger dir beside `summary.html` — if a publishing pipeline ever sweeps ledger-dir Markdown wholesale, re-point the reconciliation output to the research workspace (recorded here as the known edge). The books-repo backflow step and this priming change ship as one mechanism pair; the playbook itself gains field-proven lessons only as future fields execute the new backflow step — the 腾讯 per-stock PE pitfall from the audited field stays unrecorded until then, by the user's explicit scope choice.
