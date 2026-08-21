# Agent Note: 暂存区内容密钥闸门

Status: implemented

[English](2026-08-21-staged-content-secret-gate.md) | 中文

## Problem

防密钥泄漏此前只有指令层约束——全局 agent 指令的暂存纪律（"禁止 `git add -A`"、"不提交 `.env`/`credentials.json`/`*.pem`"）与本仓库的 "Never commit credentials"——lefthook pre-commit 任务和所有 CI workflow 均无密钥扫描，`.gitignore` 只覆盖 `.env`。粘贴进源码文件的密钥、或以未被忽略的文件名提交的密钥会一路畅通地推到远端；`.cc-connect/` 整个目录未被忽略且处于 untracked 状态。

## Decision

pre-commit 任务 `secrets (staged)` 以 `scripts/verify-no-secrets.ts --cached {staged_files}` 读取精确的 Git index 字节（复用共享的 `readGitIndexBlob`），因此已暂存、随后又从工作区编辑掉的密钥同样会被拦下。`scripts/no-secrets.ts` 的模式列表刻意只收高置信度信号：私钥块头、AWS access key id、GitHub 经典与细粒度 PAT、32+ 字符的 `sk-` API key、Slack token。上游 vendored 源码（`vendor/**`）不在扫描范围；携带 `no-secrets: allow` 标记的行被跳过（闸门自己的 spec fixture 借它存放真实格式的样本）；index 中不存在的文件与无法按 UTF-8 解码的二进制文件被跳过。`.gitignore` 另外忽略 `*.pem`、`credentials.json` 与 `.cc-connect/`。退出码沿用 `verify-translation-pairing` 的约定：违规为 1，用法错误为 2。

## Alternatives considered

**gitleaks。** 标准扫描器，但它是本机未安装的 Go 二进制依赖；其余 lefthook 任务全部是从检出目录直接运行的 hermetic tsx 脚本。它仍是熵值检测与全历史审计的既定升级路径，两者都非正则模式所能替代。

**扫工作区字节而非 index 字节。** 更便宜，但"暂存后又从工作区改掉"的密钥会漏过——提交携带的是 index 字节，闸门必须读它。

**飞书 `cli_a` app-id 模式。** 对仓库的校准发现 `packages/acp/feishu-bridge/docs/MIGRATION.md` 中已有已提交的 app id；app id 本身不是凭据，该模式会阻断正常的文档提交。

**CI 侧扫描。** push 侧闸门拦不住本地提交，且增加 workflow 面；留作未来工作，未随本地闸门一起交付。

## Consequences

常见凭据家族在提交产生之前就被机械拦截，与 agent 是否遵守指令无关。代价是正则天花板：无前缀或低熵密钥（飞书 app secret、AWS secret access key、自造 token）检测不到，且 `no-secrets: allow` 标记是刻意信任提交者的逃生口。测试中真实格式的密钥样本必须携带 allow 标记，或低于长度阈值。每个暂存文件花费两个 Git 子进程，把任务成本约束在一次提交实际暂存的少量文件上——全树扫描明确不在闸门的成本模型内。
