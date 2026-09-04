# Agent Note: research assistants start from a warmed environment, not zero

Status: implemented

English | [中文](2026-09-04-chatroom-research-warmup.zh.md)

## Problem

Every `/chatroom --research` startup re-provisioned the shared uv venv with a hardcoded four-package list and nothing else, so assistants re-earned machine knowledge each run. Three concrete failure modes, all observed: (1) `uvHooks.pipInstall` installed unpinned `pandas` while akshare's metadata only requires `pandas>=2.0.0` — PyPI's latest is pandas 3.0.5, which breaks akshare, so the next workspace rebuild (the `小米` workspace was deleted whole at archival, venv included) would have silently broken day one; (2) `uv venv` ships no pip, yet the assistant preamble taught `-m pip install` — on a fresh venv that command fails until the model self-recovers via ensurepip (the production venv's pip 26.0.1 was assistant-installed); (3) proven machine experience — eastmoney endpoints blocked on this host so sina-source akshare calls are the working path, FRED keyless CSV, HKEXnews/EDGAR/DI endpoints, pdfplumber for announcement PDFs — lived only inside per-workspace `DATA_LEDGER.md` files, which archival deletes together with the workspace.

## Decision

Three seams, all config-driven (deployment-varying choices stay out of plugin source):

- `researchVenvPackages` (chatroom config): the base-package list installed into the shared venv. The code default pins `pandas<3` — akshare's missing upper bound is ecosystem fact, not machine preference. `ensureResearchPythonEnv` now creates the venv with `uv venv --seed` (pip present day one) and reconciles an existing venv against the configured list: packages missing from the in-venv marker (`.dsh-base-packages.txt`, inside the venv so deleting the venv deletes the marker) are delta-installed, assistant-installed extras untouched. A later config extension warm-upgrades a live venv at the next research startup.
- `researchPlaybook` (chatroom config): a stable playbook path outside the archivable research workspace. `decorateSessionStartOptions` carries it on `SessionStartOptions.playbook` for research-assistant sessions (the venv precedent); the research-assistant preamble gains a read-first/append-only bullet — same tail-append discipline as the ledger — plus uv-first install guidance (`uv pip install --python <venv> …`) and the scholar-skill route for academic sources. The hardcoded four-package phrase is gone from the preamble.
- The research-role persona's shared-env sentence now names `uv pip install` to match.

## Alternatives considered

- **Hardcoding the machine recipes into the preamble text.** Rejected: host-specific facts (blocked endpoints) do not belong in fork plugin source, and every change would need a deploy; the playbook is a file the user edits.
- **Seeding the playbook into each research workspace.** Rejected: the `小米` precedent — archival deletes the whole workspace, venv, ledger, and seed together. The playbook lives at a stable path and survives.
- **Pre-fetching common datasets at startup.** Rejected: the ledger's freshness discipline requires same-day fetches to count as reusable; topic-driven steward prefetch already covers demand. The playbook's endpoint recipes make those fetches fast and correct instead.

## Testing

`engine-chatroom-venv.spec.ts`: exec-seam observation of the real createVenv/pipInstall argument lists (`--seed`, configured packages, marker written), delta reconciliation (marker missing items installs exactly the delta, absorbs it, up-to-date venv installs nothing), plus the pre-existing idempotence/failure suites unchanged. `adapter-persona.spec.ts`: playbook bullet present/absent by configuration, uv-first phrasing, hardcoded package list gone, scholar mention. `engine-chatroom-venv.spec.ts` `buildSessionStartOptions`: playbook decorates research-assistant sessions only. `chatroom-config.spec.ts`: both fields' defaults, override, and `~` expansion. `chatroom-persona.spec.ts`: the uv wording in the research role contract.

## Consequences

The venv reconciliation runs at every `/chatroom --research` startup inside the existing `researchVenvChain` serialization — concurrent rooms wait behind a possible one-time delta install (bounded by the 300s install timeout) instead of failing. A missing/unreadable playbook file is non-fatal: the decoration omits the bullet and the session proceeds (the config points at a user-maintained file that may legitimately appear later). The preamble's playbook bullet adds one line of stable-prefix text per assistant session; the playbook body itself is read on demand, not injected. Both new fields default off/unchanged, so unswept configurations behave exactly as before.
