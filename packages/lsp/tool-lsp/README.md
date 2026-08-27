# @deepseek-ai/dsh-tool-lsp

English | [中文](README.zh.md)

The model-facing **`lsp` tool** over `ctx.lsp`: one read-only tool with the name-based `workspaceSymbol` lookup plus four position operations for precise code navigation. It owns the model schema, prompt guidance, coordinate conversion, result limits and formatting, and UI presentation; it imports no provider.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `tools`, `lsp`, and `systemPrompt`.

## The tool

`lsp` accepts `operation` (`workspaceSymbol` | `goToDefinition` | `findReferences` | `goToImplementation` | `hover`). `workspaceSymbol` takes `query` (a non-empty symbol name; the model needs no coordinates) and an optional `file_path` seed document — some servers (tsserver) index symbols only while a project file is open, so any project file makes a cold query succeed. Every other operation takes `file_path`, `line`, and `character`, where `line` and `character` are positive, one-based UTF-16 cursor coordinates; the tool converts them to the seam's zero-based positions and converts rendered locations back. `findReferences` includes declarations so impact analysis does not omit the defining site. Provider, language id, workspace root, limits, timeout, initialization, and executable stay outside model input.

The tool requires the workspace root from the session `header.cwd`, with no fallback: absence fails as `LSP_WORKSPACE_REQUIRED` before querying. Its canonical result is the complete normalized Service Definition union: `{ kind: "locations", locations, resolvedWorkspaceUri }`, `{ kind: "hover", hover }`, or `{ kind: "symbols", groups }` (one group per contributing provider, each with its canonical workspace URI); Code Mode can inspect every acquired location and zero-based range directly. Native rendering projects stable, file-grouped `path:line:character` entries against the provider's canonical workspace URI rather than applying host-platform path rules to the session cwd. A `file:` URI becomes a workspace-relative path inside that URI or a URI-derived absolute path outside it; malformed and non-`file:` URIs stay verbatim. Empty locations, `null` hover, and empty symbol groups are successful no-result responses; malformed provider payloads remain structured errors.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxLocations` | `100` | Largest number of rendered locations or symbols before an omission marker. |
| `maxResultChars` | `16000` | Largest complete rendered result, including truncation metadata. |
| `timeoutMs` | `60000` | Tool-call timeout budget, enforced by `dsh-tool-call-timeout-policy`; covers the complete queued open/query/close lifecycle and is not model-configurable. |

## Model Experience

### System prompt

#### What the model sees

One system-prompt section (order 112) positions LSP as a precision aid with the following text:

##### Verbatim guidance

```markdown
Use lsp workspaceSymbol to find functions, classes, types, and other symbols by name — it needs no coordinates (a file_path helps some servers load the project) and returns path:line:character you can pass to goToDefinition/findReferences/goToImplementation/hover. Use those four position operations when textual search matches are ambiguous or before a change requires precise definitions, implementations, or references; their line and character are one-based UTF-16 coordinates at the symbol, and an off-symbol position may return no results. findReferences always includes the declaration. Fall back to grep when no language server handles the workspace.
```

#### Token effect

Fixed guidance cost on every request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schema

#### What the model sees

The model sees the generated [`lsp` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp).

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

File-grouped `path:line:character` location lines, normalized hover text, or `name (kind) in container — path:line:character` symbol lines in each provider's relevance order, capped first by `maxLocations` and then by `maxResultChars`; omission and truncation markers are included inside the complete character cap. A symbol without a resolved location loses its position suffix, not its entry. These caps affect only Native/model presentation, not the canonical value. Empty results use distinct `No results.` / `No hover information.` / `No symbols found.` lines.

#### Token effect

Capped per tool result by `maxResultChars`, with `maxLocations` additionally bounding navigation and symbol item count.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card — `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` — whose args-derived title carries the operation and one-based cursor; follow-along focuses the queried line while the title preserves the column. A `workspaceSymbol` call has no cursor, so its title carries the quoted query and no location.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

- **UTF-16 cursor coordinates** — columns are exact for the protocol but hard for a model to count around non-BMP characters; an off-symbol position may return empty results, so the prompt leads with the coordinate-free `workspaceSymbol` entry point and explains the convention for the position operations ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md)).
- **Project-loading servers need a seed** — tsserver answers a cold `workspace/symbol` with `No Project` until a document opens; the tool's optional `file_path` seeds the query, and the host re-opens the last opened document when no seed is given. A cold, seedless query on such a server surfaces the server error, and the tool description teaches the `file_path` recovery.
- **No `workspace/symbol/resolve`** — servers that return unresolved `WorkspaceSymbol` entries keep them with `location: null` (rendered without a position suffix) instead of a resolve round-trip; in practice the servers in use return resolved locations.
- **No cross-server completeness promise** — supported servers may return empty or partial results depending on indexing readiness; the tool promises no completeness across languages or servers.
- **Fork extension of the upstream operation set** — `workspaceSymbol` extends the upstream four-operation tool contract; a future upstream equivalent would need a semantic merge (see the adoption Agent Note).
