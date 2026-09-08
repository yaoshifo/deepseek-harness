# Agent Note: /skills fuzzy search, paging, and the /skill alias

Status: implemented

English | [中文](2026-09-08-feishu-bridge-skills-search-pagination.zh.md)

## Problem

`/skills` rendered the whole catalog as one flat card — production mounts ~60 skills, so the card scrolled for screens and finding one skill meant reading the list. There was no way to narrow by keyword, and `/skill` resolved only by accident (a ≥2-char prefix of `skills`), not as a guaranteed alias.

## Decision

`/skills [query] [page]` (alias `/skill`, explicit in the match function so it no longer depends on the prefix rule). The query is fuzzy: every whitespace-separated token must be a case-insensitive substring of the entry's name **or** description — a single token behaves exactly like the name-containment example that motivated the feature, while description hits keep Chinese-description skills findable. The engine deny-mask filters first, the query second; an empty catalog and a zero-match query get distinct replies (`skills_empty` vs `skills_no_match`).

Listings longer than `SKILLS_PAGE_SIZE` (15, hardcoded like `dirCardPageSize`/`listPageSize`) render one page per card: a paged title (`skills_title_paged`), the 🔍 query line with matched/total, prev/next `nav:/skills <n>` buttons, and a page-hint note whose text also names the `/skills <query> <page>` form — the plain-text fallback keeps the note but not live buttons, so text platforms page by re-typing the command. A trailing standalone positive integer in the command args is the page number, so `/skills lark 2` jumps to page 2 of the filtered set; a skill literally named as a bare number is unreachable through this form.

Page turns re-render a **snapshot captured when the command ran**. The registered-card-action seam (`registerCardAction`) is synchronous, while `ctx.skills.list()` is an async FS-reading service call, so the handler cannot re-fetch: `cmdSkills` stores the deny- and query-filtered listing in a per-registration `Map` keyed by `stripUserID(msg.sessionKey)`, and the `/skills` card action renders the requested page from it. The channel-level key is the same slot the `/dir` card actions use, so the listing author and a pressing group member land on the same entry. A missing snapshot (every pre-reload card, or post-dispose) renders the `skills_stale` notice instead of paging silently. `renderSkillsCard` is the single renderer; the command path sends it via `replyWithCard` and the action path returns it for the engine's in-place PATCH.

## Alternatives considered

**Widen `CardActionHandler` to allow `Promise` and re-fetch on every page turn.** Rejected: a central engine seam change for freshness nobody asked for, repeated `listSkills` FS scans per button press, and pages that could shift mid-navigation. The snapshot keeps turns cheap and page-consistent.

**Page as the first argument, reusing `pageArg`'s first-token read.** Rejected: `/list` has no query so its first token is free; `/skills`' primary argument is the query. The trailing-number form keeps `/skills lark` unambiguous at the cost of the bare-number-name edge case.

**Name-only matching.** Rejected: many production skills carry their meaning in a Chinese description while the name is English; description matching is what makes the search usable. Single-token behavior is identical either way.

**Work dir in the button value as the snapshot key.** Rejected: the channel key matches the `/dir` card-action precedent, needs no value plumbing, and correctly shares one slot across users of the same chat.

## Consequences

Pages show the catalog as of the chat's last `/skills` run — a reloaded or changed catalog needs a re-run, the same freshness semantics `/list` paging has; stale post-reload buttons explain themselves via the notice card. The chat's latest run replaces the snapshot, so concurrent searches in one chat page the newest query's results (self-consistent within a chat, which shares one work dir). The i18n surface is five new keys (`skills_no_match`, `skills_title_paged`, `skills_query_line`, `skills_page_hint`, `skills_stale`) plus rewritten `skills`/`skills_usage`; `CardPrev`/`CardNext` are reused. `/mcp` is untouched.

## Testing

`tests/engine/skills-mcp-commands.spec.ts` (21 cases): name-substring filtering (case-insensitive), description hits, multi-token AND, the no-match/empty-catalog split, the explicit alias resolution, the trailing page argument (plain, with query, out-of-range clamp), the paged card structure (paged title, button values, note, single-page without either), the in-place PATCH via `nav:/skills 2` (cross-user key mapping included), query scope across page turns, the stale notice, and disposal removing the card action with the snapshots.
