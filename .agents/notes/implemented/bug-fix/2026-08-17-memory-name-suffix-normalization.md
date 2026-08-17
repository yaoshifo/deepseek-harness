# Agent Note: Memory file-name suffix normalization

Status: implemented

English | [中文](2026-08-17-memory-name-suffix-normalization.zh.md)

## Problem

The memory tools take the file name as a model-authored string, and `MEMORY.md` index lines embed the same name as a Markdown link target. Those are two spellings of one fact produced in one flow, and nothing reconciled them: `assertMemoryName` guarded only path escape, the tool schema described the suffix with "e.g.", and a read used the exact string or failed. A session that passed `name: "reference-foo"` to `memory_write` and later followed its own index link `reference-foo.md` received `memory not found`; an incident left four such extension-less files in the shared Claude Code memory directory, with index lines pointing past them and the next session unable to read what the previous one wrote.

## Decision

File names are trust-boundary input, so the store owns their canonical spelling; frontmatter and content stay prompt-governed, as [claude-code-memory-compat](../feature/2026-08-14-claude-code-memory-compat.md) decided — the file name is not format content.

- `writeMemory` resolves the requested name to the on-disk name: `MEMORY.md` stays exact, every other name gains a `.md` suffix when missing. The write result reports the stored `name` and the tool renders it (`Wrote 3 lines (8B) to reference-foo.md …`), so index links are written against the file that exists.
- `readMemory` and `deleteMemory` retry a miss once with the alternate suffix spelling — `.md` stripped when present, appended when absent — healing extension-less files written by sessions predating this rule or by Claude Code-side writes, which never normalize. An exact match always wins; the retry is unreachable for it.

## Alternatives considered

**Description-only tightening ("must end in .md").** Rejected as the sole measure: schema prose is advisory, and the failure is structural — one flow produces the name in two contexts with different conventions. The tightened descriptions ship alongside the normalization, not instead of it.

**Fail-loud rejection of suffix-less names.** Rejected: every model-visible convention (index links, `memory_list` entries) already names the suffixed file, so appending the suffix aligns the write with what the other surfaces show; rejecting would turn a spelling variance into a hard error and heal nothing already on disk.

**Append-only miss retry.** Rejected: the incident's direction was an index `.md` link over a bare file, which an append-only retry cannot reach; strip-and-append is symmetric and costs one extra stat per genuine miss.

**Validating index links against file names on write.** Rejected: index lines are model-authored by design and the plugin neither generates nor rewrites them; echoing the stored name plus the miss retry closes the loop without an index parser that would drift from Markdown practice.

## Consequences

Cost: a legacy bare file stays on disk until rewritten or deleted through the alternate spelling, and the suffix rule is case-sensitive — `foo.MD` resolves to `foo.MD.md`, not `foo.md`. Bought: every write produces a suffixed file name, the read and delete paths self-heal both directions, and the model sees the exact name the next session will read.
