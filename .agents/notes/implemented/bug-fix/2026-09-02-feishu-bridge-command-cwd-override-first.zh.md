# Agent Note: 命令 cwd 优先解析每群目录 override

Status: implemented

[English](2026-09-02-feishu-bridge-command-cwd-override-first.md) | 中文

## Problem

`/shell` 等聊天命令无视群会话的 `/dir` override。`commandWorkDir()` 的解析顺序是引擎槽位 → 每群 override → `process.cwd()`；项目配置写入的槽位永远非空，override 永远轮不到——四个 cwd 解析器里唯一的反序（`sessionWorkDir` 与 `effectiveWorkDirForPending` 都是 override 优先）。2026-09-02 现场观测（books 群）：`/shell git pull` 拉的是项目 workdir（mem0）而不是该群的 override（deepseek-harness）。

## Decision

每群 override 优先，对齐会话解析器；`/shell`、`/skills`、`/mcp`、`/status` 随群目录走。`planWorkDir()` 刻意保持槽位优先：它给计划文件命名，应跟踪项目而非群会话。用户可见效果：`/status` 显示的目录与 `/skills`、`/mcp` 的 workspace 列表随各群 override 变化。测试：`tests/engine/shell-commands.spec.ts`——"prefers the chat dir override over the agent work dir (/dir display and /shell cwd agree)"，叠加保留的 "runs in the command working directory (agent work dir)" 锚。
