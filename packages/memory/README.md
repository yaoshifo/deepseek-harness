---
description: "The memory package group: Claude Code-compatible persistent memory — the shared per-project memory directory, a cross-project global scope, and the memory tools — for dsh sessions."
kind: "package-group"
---

# memory/ — Claude Code memory compatibility

English | [中文](README.zh.md)

## Summary

The `memory/` group gives dsh sessions persistent memory in externally owned layouts: the `memory/` package shares Claude Code's per-project memory directory so both harnesses recall the same facts, adds a cross-project global scope every dsh session on the machine shares, and exposes the memory tools plus session-start index injection. Storage introduces nothing of its own — formats, slug encoding, and index discipline stay locked to Claude Code's observed behavior.

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Plugins that share externally owned memory layouts with dsh sessions.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Claude Code `~/.claude/projects/<slug>/memory/` sharing: strategy section, session-start index injection, memory tools | — |

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
