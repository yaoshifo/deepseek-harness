# Agent Note: memory_index maintenance tool and the sandbox fence sentence

Status: implemented

English | [中文](2026-08-17-memory-index-maintenance.zh.md)

## Problem

Two write paths into the memory directory diverged by design: the memory tools go through host `node:fs` (the machine-local sharing contract from [claude-code-memory-compat](2026-08-14-claude-code-memory-compat.md)), while generic `edit`/`write` go through the sandboxed `ctx.fs`, where `workspace-write` denies `~/.claude` because it is under no writable root. `MEMORY_PROMPT` promised verbatim Claude Code parity, but in Claude Code generic edits of the memory directory succeed while in dsh they fail with `FS_SANDBOX_DENIED`. A model keeping Claude Code habits reached for `edit` on MEMORY.md, wasted the call, and faced an escalation hint whose only wider mode is the wrong remedy for this directory. Maintaining the index separately required a full-content `memory_write` of MEMORY.md, so a one-line pointer update resent the whole index.

## Decision

`memory_index` became the fifth tool, plus two dsh-only sentences in the strategy prompt.

The tool upserts or removes one pointer line, keyed by the memory file's name. Matching tolerates both `.md` spellings (the same healing `memory_read`/`memory_delete` apply) and collapses duplicate lines into one; an upsert with no match appends after the last non-empty line, and a missing index gains its canonical `# Memory Index` header. The write is the store's atomic temp-and-rename with the same index-budget warning, `MEMORY.md` itself is rejected as an index key, and upsert `title`/`hook` must be non-empty single lines at the tool boundary. Titles and hooks stay model-authored — the tool maintains a line the model dictates and never invents recall content.

The prompt's index paragraph gained: maintain pointers with `memory_index` instead of rewriting the index, and the memory tools are the only way to write this directory because generic file tools are denied by the file sandbox. The parity principle is thereby refined, not abandoned: copy Claude Code verbatim except where dsh genuinely differs, and state the difference in the prompt instead of letting the model discover it through a denied call. `memory_write` and `memory_delete` descriptions now point at `memory_index` for the pointer step.

The index read-modify-write keeps store-wide last-write-wins semantics: a race with a concurrent full-index `memory_write` resolves exactly as two concurrent Claude Code sessions would.

## Alternatives considered

**Auto-maintain the pointer inside `memory_write`/`memory_delete`.** Rejected: those tools stay single-purpose, and automatic line rewriting can clobber a hand-curated hook; revisit only if models still systematically skip index maintenance with the prompt pointing at the tool.

**Register the memory directory as a sandbox writable root so generic `edit` works.** Rejected: under a non-local filesystem provider (e2b) generic tools would write the sandbox's `~/.claude`, silently severing machine-local sharing; it would also bypass `.md` normalization and the index-budget warning. The fence denying generic writes is correct — the gap was the prompt not saying so.

**A general `memory_edit` (arbitrary line replacement in MEMORY.md).** Rejected: string-matching edits are error-prone and widen the trust surface; the typed, name-keyed upsert matches the documented one-line-per-memory contract.

**A redirect hint inside the `FS_SANDBOX_DENIED` message.** Deferred: it needs a plugin-owned-directory registry the sandbox does not have; worth building only when more host-local plugin directories exist.

## Consequences

- `MEMORY_PROMPT` diverges further from Claude Code verbatim; anchor tests and the claude-memory snapshot pin the divergence, and prompt edits must carry the README verbatim block and snapshots in the same change.
- Index maintenance is one bounded call instead of a full rewrite; a no-op remove reports current index stats without writing.
- The acp `claude-memory` snapshot scenario now exercises `memory_read` → `memory_write` → `memory_index` end to end.
