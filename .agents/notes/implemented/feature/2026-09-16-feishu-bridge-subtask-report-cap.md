# Agent Note: subtask report cap — head+tail delivery with a spill file

Status: implemented

English | [中文](2026-09-16-feishu-bridge-subtask-report-cap.zh.md)

## Problem

The parent agent's context had no defense against oversized subtask reports: `deliverParentReply` injected the report body verbatim into the wake, banked it verbatim into the gather barrier, and rendered it verbatim on the human-facing card — no size cap anywhere on the injection path. A pathological report (logs, file listings pasted back) rode along until the core-layer auto-compaction (0.8 × window) eventually summarized it away; several large reports landing inside one step could push the request past the window before the pre-step pressure check caught up (overflow recovery handles that, but a failed retry ends the turn). The same investigation confirmed the child's execution never reaches the parent — tool calls, file reads, and reasoning stay in the child transcript; the report body is the one surface worth bounding. (Context-flow facts: the 2026-09-16 three-probe investigation, recorded in the project memory `dsh-subagent-context-flow-and-compaction`.)

## Decision

Cap the delivered report at `subtask.reportMaxChars` (default 8192 code points; floor 1024 enforced at load — a smaller cap would crowd every report out with the notice line alone):

- **One capping site**: the first statement of `deliverParentReply`, before the card send, the dedup hash, the gather banking, and the wake assembly. The three downstream consumers read the same rebound `content` parameter, so card, banking, and wake carry the identical capped text — no "human sees full text, model sees the cut" skew.
- **Pure budget arithmetic** in `src/engine/subtask-report-cap.ts` (`planSubtaskReportCap`): code-point counting (`Array.from`, matching the rune semantics used elsewhere in the bridge), head 2/3 / tail 1/3 of the budget left after the notice and separators — the delivered text never exceeds the cap — with an ellipsis line marking the cut between head and tail.
- **Full text spills** to `<sessions dir>/subtask-reports/report-<sha256(childKey) first 12 hex>-<ISO ts>.md` (atomic write; the chatroom-research directory-derivation precedent). `storePath === ''` (tests, no persistence) means "cannot save": the notice degrades to a not-saved wording pointing back at the child session — `feishu_bridge_subtask action: send` recovers the text, and the original always lives in the child's session log — never a fake path.
- **Never throw**: a rejection from the delivery path rolls the caller's rollback of the child's `reported` flag into a redelivery loop; every failure is a warn + degrade.
- **The dedup hash stays on the raw text** (2026-09-13 subtask-report-dedup): a capped report must still collapse against a prior verbatim direct send — hashing the capped body would re-deliver the same text to the parent.
- **Saved-notice feedback**: the saved variant's notice embeds the omitted count, which feeds back into the head/tail budget; one fixed-point `while` iteration converges it (the notice length only varies by digit count).
- **The child preamble carries the same number** (`subtaskAgentSystemPrompt(reportMaxChars)`, adapter setter wired next to the engine setter from one config read): children are told the cap instead of discovering it — keep reports within N code points, write longer content to a file and reference the path.

## Alternatives considered

- **Reuse the spill-policy / `ctx.spillStore` service** (the tool-result cap's mechanism): rejected — it binds the cap to the daemon's composition (a deployment without the spill-local backend would silently keep full text), adds three workspace dependencies, and the session-reference source vocabulary fits captured conversations better than child reports. A self-contained directory keeps the behavior deterministic on every deployment that has session storage.
- **Cap only the wake, keep the card full-text**: rejected — "human sees full, model sees the cut" is a cognitive skew, and a several-tens-of-thousands-character card is its own rendering burden; the card carries the path, so a human can still open the file.
- **A total cap on the gather summary (N × per-report cap)**: deliberately not done — each banked report is already bounded, the extreme-count case stays far under the core-layer 0.8×window compaction line, and a summary-level cap would truncate several moderately long reports into preview soup. The single choke point if it is ever needed: `resolveOrWakeGather`'s summary.
- **A 50 KB byte cap aligned with spill-policy's `maxInlineBytes`**: rejected — code points match the bridge's rune semantics (labels, prompts) and price CJK text fairly; a byte cap would triple-count Chinese reports.

## Consequences

- The parent's context spend on reports is bounded at N × cap; a normal research report (hundreds to a few thousand code points) is untouched — no file, no notice.
- The model pays one extra read when it needs the full text; the human opens the file from the card.
- Reports land as files under the project's sessions dir (`subtask-reports/`); no cleanup this round (small volume, value product — a 30-day cleanup can follow existing conventions if it accumulates).
- The child preamble grew one line (a few dozen tokens per child request); the persona pin assertions carry it (`tests/agent-dsh/adapter-persona.spec.ts`).
- `docs/config-catalog.md` (generated) is not regenerated under the fork policy; this note records the drift.
- Known uncovered, deliberately: the runtime bypass of a child `send_message`-ing its parent directly and grandchild reports to children (neither recipient is the parent agent), the `cardDetail` appendix on the human card (display-side only), and the gather async-wake summary total (N × cap). Out-of-scope finding from the delivery-site work, flagged not fixed: `deliverParentReply`'s `cardDetail` concatenation is unbounded — human-card display only.
