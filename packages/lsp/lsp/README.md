---
description: "The LSP capability seam (ctx.lsp): provider selection by file extension, four normalized code-navigation operations, and structured errors, for users and maintainers composing or extending code navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp

English | [中文](README.zh.md)

## Summary

`dsh-lsp` provides the harness's language-server code navigation: an agent can go to a symbol's definition, find its references, jump to its implementations, or read hover documentation, and the code-navigation service (`ctx.lsp`) routes each query to the language-server provider that owns the file's extension. Providers register by branded id and file extension, so a provider swap never changes how navigation is requested or what the model sees. The service exposes exactly four read-only operations and no generic JSON-RPC escape hatch, and it contributes no prompt or tool schema itself — the model-facing `lsp` tool lives in `dsh-tool-lsp`. Compose it with a provider such as `dsh-lsp-stdio` and the tool to give agents precise navigation; this package does nothing on its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount a language-server provider and the `lsp` tool to give agents semantics-based code navigation that text search cannot reliably provide — distinguishing same-named functions, following import aliases, connecting an interface to its implementations, or reading inferred types. This package is the service those packages register against; it defines no UI, tool, or provider of its own.

### When to choose it

Choose this service when a deployment wants model-visible code navigation backed by language servers. It covers read-only navigation — definitions, references, implementations, and hover — and deliberately omits mutations (rename, code actions, formatting), symbol lists, and diagnostics. The service is provider-neutral: local stdio servers, remote servers, and sandbox-native providers register the same way, so replacing the backend does not change what the model sees or how it asks.

### Composing a navigation stack

The seam needs a provider and a consumer to do anything. A minimal composition mounts the service, a stdio provider, and the tool:

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-lsp'
- name: '@deepseek-ai/dsh-lsp-stdio'
- name: '@deepseek-ai/dsh-tool-lsp'
```

Server commands, extension mappings, and the filesystem/subprocess pairing are configured in the provider and tool packages; see [dsh-lsp-stdio](../lsp-stdio/README.md) and [dsh-tool-lsp](../tool-lsp/README.md).

### The four operations

Each query asks one of four semantic questions at a cursor position in a source file; results are normalized locations or hover content, never raw protocol payloads.

| Operation | What the agent gets |
|---|---|
| `goToDefinition` | The declaration site(s) of the symbol at the cursor |
| `findReferences` | Every reference, always including the declaration |
| `goToImplementation` | The concrete implementation site(s) |
| `hover` | Normalized documentation for the symbol, or none |

The seam exposes exactly four semantic position operations — `goToDefinition`, `findReferences`, `goToImplementation`, `hover` — plus the name-based `symbol` fan-out, and no generic JSON-RPC escape hatch, so no protocol payload or unreviewed command/mutation reaches a provider through `ctx.lsp`.

`findReferences` always includes declarations, so impact analysis never misses the defining site. Positions are zero-based UTF-16 on the wire; the model-facing tool accepts one-based cursor coordinates and converts them.

### Failures and recovery

A query fails with the structured error `LSP_UNAVAILABLE` when no registered provider handles the file's extension — add a provider for that extension or query a supported file. Invalid or conflicting provider registrations fail with `LSP_INVALID_PROVIDER` or `LSP_CONFLICT` before any route is published, and a query against a disposed provider fails with `LSP_DISPOSED`. Consumers catch `LspError` and route on its stable `code`; through the tool, these surface as error results the model can read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the seam and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Capability seam, Service Definition role.** The package owns `ctx.lsp` and the provider registry; providers register capabilities, not tools, and `dsh-tool-lsp` is the only owner of the model-facing surface.
- **Atomic registration.** `registerProvider()` validates and conflict-checks everything before mutating: an invalid or conflicting registration publishes nothing, and its disposer releases the id and every extension reservation together.
- **Order-independent selection.** `query()` routes by the file's final extension, normalized to lowercase leading-dot form; registration and HMR order never change routing. The language id only synchronizes the transient document and never participates in selection.
- **Closed vocabulary.** The four-operation union is closed — adding an operation is a compile-enforced change across the seam, providers, and the tool. There is no JSON-RPC escape hatch, and every request field is required, so there is no `resolve()` step.
- **Provider-owned workspace coordinate.** Location results carry the provider's canonical workspace URI, so consumers relativize file URIs in the execution world's namespace instead of applying host-platform path rules.

### Source map

| File | Role |
|---|---|
Service methods:

| `registerProvider(provider)` | Register a backend, atomically reserving its branded `id` and every normalized file extension. Any invalid input or conflict publishes nothing and throws `LspError` (`LSP_INVALID_PROVIDER` / `LSP_CONFLICT`). Returns a disposer releasing all reservations. Disposed with the calling fiber. |
| `query(request, signal?)` | Select the provider by the file's final extension, derive the `languageId` from that provider's mapping, and run one query. No match throws `LspError` `LSP_UNAVAILABLE`. |
| `symbol(request, signal?)` | Run one name-based symbol lookup. A seeded request (`seedFilePath`) routes to the one provider covering the seed's extension — the seed declares the symbol's language — and returns an empty merged result with `uncoveredSeedExtension` when no provider covers it. A seedless request fans out to every provider in registration order, folds `workspaceSymbolProvider`-less providers away, and retains other failures alongside the successful groups; every provider failing throws. No provider registered throws `LSP_UNAVAILABLE`. |

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Lsp` service, `registerProvider`/`query`, `finalExtension`, `LspError` codes |
| [`src/types.ts`](src/types.ts) | Seam vocabulary: request, result, provider, and service contracts |
| [`src/brand.ts`](src/brand.ts) | `LspProviderId` branded-id type and factory |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; routes are private atomic state) |

### Registration and selection lifecycle

Registration and disposal run through `ctx.effect()`, so provider routes live and die with the registering fiber. `finalExtension()` splits on both path separators and returns `''` for names without an extension or leading-dot dotfiles, which no route matches. `LspError` extends `HarnessError` with stable codes (`LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`, `LSP_UNSUPPORTED_OPERATION`, `LSP_MALFORMED_RESPONSE`) that callers route on instead of parsing `message`.

</details>

`LspQueryRequest` (`operation`, `filePath`, `position`, `workspaceRoot`) — every field required, so no field needs implementation defaulting and there is no `resolve()` step. Positions and ranges are zero-based UTF-16, matching the protocol; the tool owns the one-based cursor convention. `findReferences` always includes declarations — providers enforce this internally, so callers get no flag. `LspQueryResult` is a CLOSED discriminated union: `{ kind: 'locations'; locations; resolvedWorkspaceUri }` for navigation, `{ kind: 'hover'; hover }` for hover (content or `null`) — consumers `switch` to exhaustiveness so a new arm breaks compilation until handled. `resolvedWorkspaceUri` is the provider's canonical workspace `file:` URI; callers relativize location URIs against it instead of applying host-platform path rules to the possibly symlinked request root.

`LspSymbolRequest` (`query`, `workspaceRoot`, optional `seedFilePath`) names the seam's symbol lookup: no file, no position, and server-side matching semantics. A seeded lookup routes by the seed's extension exactly like `query()`; a seedless lookup fans out. Each provider answers an `LspSymbolResult` (`symbols` in its server's relevance order, plus its own `resolvedWorkspaceUri`); an unresolved `WorkspaceSymbol` keeps its entry with `location: null`. `seedFilePath` names a project file to open transiently for servers (tsserver) whose symbol index requires a loaded project. `LspSymbolsMerged` carries the groups plus `failures` (providers that failed while another answered) or `uncoveredSeedExtension` (no provider covers the seed's language; nothing was queried). See `src/types.ts` for the full contracts and `src/index.ts` for the `LspError` codes, including `LSP_DISPOSED` and `LSP_MALFORMED_RESPONSE`.

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared navigation model to the provider, the tool, and the decision evidence.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — operations, coordinates, requests and results, and `LspError` codes.
- [LSP capability seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md) — design rationale, alternatives, and deliberately deferred API.
- [dsh-lsp-stdio](../lsp-stdio/README.md) — the stdio provider that registers against this seam.
- [dsh-tool-lsp](../tool-lsp/README.md) — the model-facing tool over this seam.
- [lsp group map](../README.md) — the three-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-lsp`, which owns the model-facing `lsp` schema, prompt guidance, and rendered results while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-lsp` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the seam's current scope. They are package constraints, not a task backlog.

- **Exclusive extension ownership within one runtime** — two providers cannot both claim `.ts`, even with different language ids; overlaps fail registration. A deployment-configured selector above registrations is the intended extension, which can relax exclusive reservation without adding provider choice to model input ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md)).
- **Four position operations plus name-based symbols** — call hierarchy and `documentSymbol` are deferred (they need different schemas); diagnostics need separate freshness/accumulation rules; mutations (rename, code actions, formatting) require separate tools with preview, permission, and write-policy integration.
- **Fork extension of the upstream seam** — upstream closes the seam at four operations; `symbol()` is a fork-local addition pending an upstream equivalent (semantic merge if upstream ships one).
- **No observation API** — availability is observed only by running `query()` and routing the thrown `LspError` codes; there is no provider-change event or capability-status query.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
