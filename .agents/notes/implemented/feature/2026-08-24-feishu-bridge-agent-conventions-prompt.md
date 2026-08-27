# Agent Note: Plain sessions carry a fixed agent-conventions prompt section

Status: implemented

English | [中文](2026-08-24-feishu-bridge-agent-conventions-prompt.zh.md)

## Problem

The user's curiosity-reporting convention (surface out-of-scope findings, verified, in a closing 「发现的问题 / 可优化点」 section) lived in the machine-local global instruction file (`~/.claude/CLAUDE.md`, symlinked from `~/.dsh/AGENTS.md`). The follow-up interaction was text-only: to act on a subset of the findings the user had to re-type them. Two candidate homes for an ask_user_question multi-select card at closing were rejected: the shared instruction file couples runtime-specific interaction to agent-agnostic conventions, and the per-machine profile `persona` field (`cordis.patch.yml`) is forgotten on every new deployment — the workflow now ships on multiple machines (local launchd, dev server systemd).

## Decision

The convention ships with the package: `agentConventionsPrompt()` (`engine/agent-conventions.ts`) returns three blocks — the async-autonomy work mode (reversible actions proceed without asking, exploratory questions get an assessment not an edit, tool calls are invisible so narrate briefly and land the round's full deliverable in the final message, close out the round with no dangling promises; migrated verbatim from the retired global-instruction section plus the two chat-rendering rules), the curiosity-reporting contract verbatim from the retired global-instruction bullet, and a closing-card contract (non-empty findings section → one `ask_user_question` call, `multi_select: true`, one option per finding plus a 「暂不处理」 option). The findings section in the closing text carries only a short title and one line of verification evidence per finding; `path:line` and the suggested action live in the card option descriptions only, so the reply and the card do not repeat each other. Options are ordered by recommendation with the recommended ones marked `recommended: true`, and checked submissions are authorization to act immediately; unrelated free-text answers start a new task, covering the pending-question consumption of free text in `handlePendingPermission`. `buildSessionSetup` (`agent-dsh/adapter.ts`) registers the section as `feishu-bridge-agent-conventions` (order 10, after the persona slot, before tool guidance) for plain sessions only; the previous no-persona/no-workspace early return is gone. Subtask children and chatroom personas omit it — their findings surface through the parent session and their own personas. The migrated sections were removed from `~/.claude/CLAUDE.md` (which now keeps only runtime-agnostic working style); deployment-wide behavior travels with `git pull` + build, not with per-machine configuration.

The `recommended` marker rides a presentation-only seam change: `AskUserQuestionOption.recommended` (`interaction/user-questions`) → the `ask_user_question` tool schema (`interaction/tool-ask-user`) → `UserQuestionOption.recommended` (`core/types.ts`) → `CardCheckOption.checked` (`card.ts`) → the Feishu `checker` element's initial `checked` state (`feishu/card.ts`), so a recommended multi-select option arrives pre-checked and one 提交 confirms the recommended set. The answer encoding is unchanged — the form submits the checked `askq_opt_N` keys either way.

## Alternatives considered

**`system-prompt` plugin `persona` in the live profile.** Lost: machine-local config must be hand-migrated to every new deployment, the exact failure mode this change removes.

**Keep the rule in the shared global instruction file and instruct the agent to call ask_user_question.** Lost: couples a runtime-specific interaction to the runtime-agnostic instruction file the user wants kept generic.

**Engine-side parsing of the closing reply's findings section into a card.** Lost: new parsing-and-callback machinery over free-form model output where the existing ask_user_question pipeline already closes the loop.

## Consequences

Cost: every plain session pays a fixed ~1100-CJK-character system-prompt prefix, and a session whose closing card is ignored parks until the turn timeout (the next user message still flows in as the answer, handled by the free-text clause). Subtask children no longer inherit the curiosity text through the user-global instructions — a deliberate scoping; their findings aggregate through the parent session. Bought: one self-contained behavioral contract pinned in the repo, identical across every machine deploying the bridge, with zero per-machine configuration.

## Testing

`tests/agent-dsh/adapter-persona.spec.ts`: the plain-session case asserts the conventions section (name, order 10, non-complete) with the full text pinned verbatim inline, and a second case asserts conventions-before-workspace ordering when CC_FEISHU_* is configured; the subtask and chatroom paths assert absence. The `recommended` path is covered at each hop: `interaction/tool-ask-user` passes the structured flag through to the provider, `tests/engine/engine-m3-askq.spec.ts` asserts the multi-select checker pre-checks only the recommended options, and `tests/feishu/card.spec.ts` asserts the checker element carries the initial `checked` state. Package precedent: prompt sections ship with unit specs pinning registration and text (chatroom persona, subtask preambles), not keyless application transcripts.
