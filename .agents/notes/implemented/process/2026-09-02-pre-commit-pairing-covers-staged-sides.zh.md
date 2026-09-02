# Agent Note：pre-commit 配对检查覆盖被暂存的 Markdown 侧

Status: implemented

[English](2026-09-02-pre-commit-pairing-covers-staged-sides.md) | 中文

## Problem

lefthook 的配对作业此前只匹配 `*.i18n.yaml`，因此只暂存 `foo.md` 或 `foo.zh.md` 而不带 sidecar 的提交从不运行 `verify-translation-pairing --cached`。改了已记录配对的一侧而不重新记录，会静默累积，直到某个更晚的提交暂存了 `.i18n.yaml`——典型是合并——并为并非自己造成的漂移变红；2026-09-02 的 dev 合并正是这样撞上 feishu-bridge README 配对。

## Decision

pre-commit 与 pre-merge-commit 的配对作业现在匹配 `*.{md,i18n.yaml}`，且 `--cached` 会跳过 `.i18n.yaml` 不在索引中的 anchor：钩子只管辖已记录的配对，语料完整性（新配对、排除项）仍归 doc-sync 与 CI。已记录配对中被暂存的侧遵循既有的完整性与哈希规则，包括部分删除和三文件完整删除。`scripts/verify-translation-pairing.spec.ts` 以 fixture 索引对两个方向做了端到端覆盖。

## Alternatives considered

**在钩子里对没有记录的被暂存范围内 Markdown 强制语料完整性。** 否决：这会在提交时重复 doc-sync 的语料工作，并让已被接受的语料漂移变成无关编辑的提交阻塞。

**在 lefthook.yml 里用 shell 包装过滤不成对文件。** 否决：glob 加跳过的规则集中在脚本一处，fixture spec 才能端到端驱动它。

## Consequences

已记录配对上的漂移会在造成它的那次提交暴露，而不是留到之后的合并。任何暂存 Markdown 的提交多付一次脚本运行（约两秒），全语料的绿灯仍只有 doc-sync 与 CI 能证明。两处已知语料漂移随本次一并修复，让放宽后的钩子落在绿色基线上：[2026-08-31-parallel-exploration-default-guidance](../feature/2026-08-31-parallel-exploration-default-guidance.zh.md) 配对重新记录，2026-09-01-feishu-bridge-spawn-mode-flag 配对补上了缺失的记录。
