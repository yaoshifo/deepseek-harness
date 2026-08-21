# Agent Note: Staged-content secret gate

Status: implemented

English | [中文](2026-08-21-staged-content-secret-gate.zh.md)

## Problem

Instruction-level rules — the global agent instructions' staging discipline ("never `git add -A`", "never commit `.env`/`credentials.json`/`*.pem`") and this repository's "never commit credentials" — were the only guard against leaked credentials. The lefthook pre-commit jobs and every CI workflow contained no secret scanning, and `.gitignore` covered only `.env`. A key pasted into a source file, or committed under an unignored name, reached the push unblocked; `.cc-connect/` was entirely unignored and untracked.

## Decision

The pre-commit job `secrets (staged)` runs `scripts/verify-no-secrets.ts --cached {staged_files}` over exact Git index bytes (via the shared `readGitIndexBlob`), so a secret edited out of the working tree but still staged is still caught. The pattern list in `scripts/no-secrets.ts` is deliberately high-confidence only: private-key block headers, AWS access key ids, GitHub classic and fine-grained PATs, `sk-` API keys of 32+ characters, and Slack tokens. Vendored upstream sources (`vendor/**`) are out of scope; a line carrying the `no-secrets: allow` marker is skipped (the gate's own spec fixtures use it for their realistic samples); files absent from the index or not decodable as UTF-8 (binary) are skipped. `.gitignore` additionally ignores `*.pem`, `credentials.json`, and `.cc-connect/`. Exit codes mirror `verify-translation-pairing`: 1 for a violation, 2 for a usage error.

## Alternatives considered

**gitleaks.** The standard scanner, but a Go-binary dependency this machine does not carry; every other lefthook job is a hermetic tsx script run straight from the checkout. It remains the named upgrade path for entropy-based detection and full-history audits, which regex patterns cannot replace.

**Scan working-tree bytes instead of index bytes.** Cheaper, but a secret staged and then edited out of the working tree would slip through — the commit carries the index bytes, so those are what the gate must read.

**A Feishu `cli_a` app-id pattern.** Calibration against the repository found already-committed app ids in `packages/acp/feishu-bridge/docs/MIGRATION.md`; an app id alone is not a credential, and the pattern would have blocked routine documentation commits.

**CI-side scanning.** A push-side gate could not block the local commit and adds workflow surface; kept as future work rather than shipped alongside the local gate.

## Consequences

The common credential families are blocked mechanically before the commit exists, independent of whether the agent obeyed its instructions. The cost is the regex ceiling: unprefixed or low-entropy secrets (Feishu app secrets, AWS secret access keys, self-generated tokens) are not detected, and the `no-secrets: allow` marker is an intentional escape hatch that trusts the committer. Realistic key samples in tests must carry the allow marker or stay below the length thresholds. Each staged file costs two Git subprocesses, which bounds the job to the handful of files a commit actually stages — a full-tree scan is explicitly out of the gate's cost model.
