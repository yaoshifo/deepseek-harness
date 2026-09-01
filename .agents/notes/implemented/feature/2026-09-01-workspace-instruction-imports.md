# Agent Note: Workspace instruction `@path` imports — Claude Code parity inside the existing pipeline

Status: implemented

English | [中文](2026-09-01-workspace-instruction-imports.zh.md)

## Problem

Authors coming from Claude Code expect `@path/to/file` references inside `CLAUDE.md`/`AGENTS.md` to import other files into their instructions — READMEs, `package.json`, shared rule fragments. The harness loaded only candidate files and rendered their bytes verbatim; the package README recorded `@path` imports as an intentional gap, so repositories that split their instructions had to duplicate content or symlink every fragment.

## Decision

### Expansion happens at load, inside the existing pipeline

`src/imports.ts` expands each candidate's content right after its bounded read, at both read sites in `src/files.ts` (the baseline loader and per-scope reconciliation). Discovery, per-directory deduplication, rendering, and byte budgeting therefore operate on expanded content unchanged: no new render stage and no new session event. The digest recorded in `AgentInstructionChange` is the SHA-1 of the expanded content, keeping rendered text and logged identity exactly aligned; the durable session format is unchanged.

### Parsing follows Claude Code's documented memory-import semantics

`@` at line start or after whitespace starts a token that runs to the next whitespace or backtick; trailing sentence punctuation stays literal; inline code spans and fenced code blocks are skipped, and a code span pairs backticks within one line only. Relative paths resolve against the importing file's directory, `~/` expands against the operating-system home directory, absolute paths pass through, and recursion stops at four hops (`MAX_IMPORT_HOPS` — an external-spec constant like the symlink rules, deliberately not a config field). A reference whose file cannot be loaded — missing, unreadable, over `maxSourceBytes`, or past the depth cap — renders one `[instruction import unavailable: <path>]` line, so a broken reference is visible to the model without failing the rest of the baseline.

### Imported content is framed in place

The reference token is replaced at its site by an `Imported from: <path>` marker, the imported content, and an `End imported from: <path>` marker. The rendered body keeps passing through the existing `</system-reminder>` escaping, so imported text cannot close the plugin-owned frame.

### Refresh reaches imports through cache metadata

`InstructionVersionState` carries `imports` — the transitive absolute paths that contributed to a scope's expansion. Reconciliation adds a scope whose cached import was touched and skips the unchanged-version fast path for it, so editing only an imported file replaces the referencing scope's rendered content on the next request, while an unchanged import injects nothing. Import records live only in the in-memory per-session cache; resume picks up fresh expansion through the existing confirming read.

### Trust is provider policy, not an approval dialog

Claude Code gates external imports behind an interactive approval dialog. Headless compositions have no dialog surface: absolute and `~/` imports read whatever the mounted `ctx.fs` provider allows — host-wide for the local provider, confined for the sandbox provider — the same boundary the package already documents for symlinked candidates.

## Alternatives considered

- **Expanding during rendering** — rejected: rendering is synchronous and providerless, while imports need bounded asynchronous reads through `ctx.fs`, which lives at the load layer; expanding at load keeps the renderer pure.
- **Treating imported files as pseudo-scopes** — rejected: pseudo-scopes would add durable state and duplicate the candidate machinery; cache metadata plus touch matching delivers the same observable refresh with no format change.
- **Silently keeping the literal token when an import fails** — rejected: a silent skip hides a missing referent; the unavailable marker names the gap without failing the baseline.
- **Config knobs for depth or enabling** — rejected: Claude Code ships fixed semantics (four hops, always on); parity is an external spec, not a deployment-varying choice.
- **Interactive external-import approval** — rejected: no headless dialog surface exists, and filesystem provider policy already owns this boundary for symlinked candidates.

## Consequences

- A `CLAUDE.md` containing only `@AGENTS.md` renders framed imported content beside the real `AGENTS.md` section, because both are candidates; exact sharing keeps the symlink convention, which the existing trimmed-content deduplication collapses.
- Baseline and confirming reads issue one bounded read per imported file, so the aggregate-read `TODO(total-instruction-read-bound)` in `src/files.ts` covers imports too; per-file `maxSourceBytes` and the render budget bound the model-visible result.
- Untrusted repositories gain one more way to surface off-tree text into lower-authority instructions (absolute-path imports); the package README's trust bullet names both symlinks and imports, with provider confinement as the mitigation.

Related: [workspace context decision record](2026-06-24-workspace-context.md).
