# Claude Code Memory Compatibility

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into sharing this machine's Claude Code memory, without changing the shipped default Web composition:

```sh
dsh web --patch examples/claude-memory/cordis.yml
```

dsh and Claude Code then read and write the same per-project memory directory, `~/.claude/projects/<slug>/memory/`, where `<slug>` is the session working directory with every `/` and `.` replaced by `-`. Memories written by Claude Code are recalled by dsh, and memories written by dsh appear in Claude Code's next session. No storage of its own is introduced.

Three model-visible surfaces carry the mechanism. The system prompt gains the verbatim Claude Code memory strategy section (one file holds one fact, frontmatter `name`/`description`/`metadata.type`, the four memory types, `[[name]]` links, MEMORY.md as a one-line-per-memory index). The first admitted step of each top-level session folds the project's `MEMORY.md` (first 200 lines or 25,600 bytes, whichever comes first) into durable context inside a plugin-owned `<system-reminder>` frame that declares recalled memories background context, not user instructions. Five tools — `memory_list`, `memory_read`, `memory_write`, `memory_delete`, `memory_index` — operate only inside that directory, going through the host filesystem directly rather than the swappable `ctx.fs` provider, so the shared directory stays machine-local in every deployment shape. `memory_index` upserts or removes one pointer line at a time; generic file tools cannot write this directory — the file sandbox denies them — which the memory strategy section states explicitly.

The injection happens once per session: resume and compaction do not re-inject, and the model reads the current index with `memory_read` when it needs fresher state. Subagent sessions get neither the section nor the injection. `memory_write` backfills `node_type: memory` and `originSessionId` provenance into any frontmatter `metadata:` block, mirroring what the Claude Code harness adds; writes to `MEMORY.md` that exceed the line or byte budget still succeed but carry a warning to move detail into topic files and rewrite the index. File names are validated as single path segments — path traversal is rejected at the store boundary; frontmatter quality stays model-governed, exactly as in Claude Code.

Concurrent sessions (dsh or Claude Code) writing the same memory file resolve last-write-wins, the same as two concurrent Claude Code sessions. Point `claudeHome` at a different root to keep a machine's real Claude Code home untouched while experimenting.
