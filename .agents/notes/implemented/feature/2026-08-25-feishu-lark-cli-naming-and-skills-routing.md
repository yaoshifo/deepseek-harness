# Agent Note: the lark tool is named `lark-cli` and routes Feishu domain tasks through the official embedded skills API

Status: implemented

English | [中文](2026-08-25-feishu-lark-cli-naming-and-skills-routing.zh.md)

## Problem

The bridge's lark pass-through tool shipped as `feishu_bridge_lark`: a verbatim `lark-cli` subprocess wrapper with per-project credential routing, but with no guidance for the 18 Feishu business domains lark-cli covers. Two gaps compounded. First, naming: official lark-cli skill text, official docs, and CLI output all say `lark-cli docs +fetch`, so the tool name forced a mental translation on every reference the model reads. Second, guidance: the Claude Code-era lark skill had no dsh counterpart, so agents called the tool bare, guessing flags — while lark-cli ships 28 embedded, agent-tested skills (`skills list` / `skills read <skill>[/<file>]`, version-locked into the binary via go:embed) that nobody routed to.

## Decision

The tool registers as `lark-cli` (`src/tools/lark.ts`) — named verbatim after the official CLI so every command reference in lark-cli's embedded skills maps literally to a tool call. This is a deliberate exception to the snake_case convention of native dsh tool names (`web_search`, `feishu_bridge_send`): the registry imposes no name format, MCP tool names already carry hyphens, and the model-facing mapping win outweighs the convention.

The tool description now embeds the official progressive-disclosure workflow: before any Feishu domain task (docs, sheets, Base, calendar, mail, wiki, IM, tasks, approval, OKR, ...), first discover the domain with `["skills","list"]`, then read its guide with `["skills","read","<skill>"]`, and on demand `["skills","read","<skill>/references/<file>.md"]` — reading only the reference the current step needs, never the whole set upfront (lark-cli's own SKILL.md files demand exactly this). The description rides the tool schema into every model request, so no skill file, catalog entry, or prompt section is added; the embedded content stays version-synced with the installed lark-cli binary at zero maintenance cost.

## Alternatives considered

**Switch to the official Feishu MCP (larksuite/lark-openapi-mcp).** Rejected: it is a Beta whose README documents hard gaps — no file upload/download, no direct cloud-document body editing (import and read only) — while lark-cli updates weekly and covers 200+ commands; its tool definitions bloat the context (the official FAQ tells users to cap tools at ~10 with `-t`); and it needs a second OAuth flow (`lark-mcp login --oauth`) that duplicates the bridge's existing per-project credential routing.

**Mount lark-cli's skills as static dsh skill files (GitHub checkout or `npx skills add`).** Rejected: a copied snapshot drifts from the binary the moment lark-cli updates, the skill bodies assume bash invocation and would need rewriting for tool pass-through, and 28 catalog descriptions bloat every session's skill list (an official lark-cli issue reports exactly that complaint). The embedded `skills list`/`skills read` API is the intended on-demand channel for custom agents.

**A thin bootstrap skill in the bridge's bundled skills directory.** Rejected as a separate file: the tool description is always model-visible, costs no catalog entry, and carries the same routing instructions — the bootstrap skill would duplicate it.

## Consequences

Every `lark-cli docs +fetch` mention in official skill text now maps to a tool call by name. Cost: the per-tool "grant all" permission memory is keyed by `(agent, tool)`, so users re-approve the renamed tool once; historical session logs replay unchanged (they record the name that was actually used). The rename is a documented convention exception — if dsh ever gains a tool-name format check, `lark-cli` needs an explicit allowance.

The child runs in the session's work dir (`Engine.sessionWorkDir`, the same base the send tool uses for relative attachment paths), so skill guides' `@./xxx` local-file arguments resolve against the agent's working directory. lark-cli's per-run skills notifier stays suppressed (`LARKSUITE_CLI_NO_SKILLS_NOTIFIER`) because the description now owns the routing hint.

## Testing

`tests/tools/lark-tool.spec.ts` asserts registration and clean disposal under the new name (HMR safety). Full feishu-bridge suite: 2379 passing.
