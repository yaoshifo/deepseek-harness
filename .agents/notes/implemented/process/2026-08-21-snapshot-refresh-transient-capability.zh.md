# Agent Note：提交前先审查快照 refresh 的产物

Status: implemented

[English](2026-08-21-snapshot-refresh-transient-capability.md) | 中文

## Problem

一次全量 `DSH_SNAPSHOT=refresh` 的 acp-agent 快照套件运行，把 `examples/acp-agent/tests/snapshots/code-mode-read-image/stdout.expected.jsonl` 重写为 `promptCapabilities.image: false`，而其前后所有 replay 运行——包括之后两次完整 refresh 尝试——产出的都是 `image: true`。这个一次性的 `false` 是瞬时现象而非行为变更，但刷新出的 fixture 通过了校验，差点作为伪造的 capability 回归被提交。

`supportsAcpImagePrompts`（[`packages/acp/acp/src/content.ts`](../../../../packages/acp/acp/src/content.ts)）在每次瞬时未命中时都报告 `false`：ACP `initialize` 握手执行时 `attachments` 或 `llm` 服务尚未进入 store，或 `resolveModelInfo` 抛进它的 `catch`。在全量套件负载下，该探测有一次输掉了这个竞态。refresh 写回（[`packages/test-support/acp-snapshot/src/suite.ts`](../../../../packages/test-support/acp-snapshot/src/suite.ts)）先写入当前输出、再与自己刚写的内容比较，因此瞬时值能通过 refresh 校验并落进 fixture；损坏只在下一次 replay 运行时暴露。

## Decision

把 refresh 产物当作未受信内容，diff 审查之后才可提交：任何 `pnpm run test:snapshot:refresh` 之后，先审查 fixture diff 再提交；initialize 期取值的变化——`promptCapabilities`、protocol version、agent info——在普通 replay 运行确认之前一律视为可疑。机械性抖动（比较器会归一化的裸 UUID）丢弃或保留皆可。上游仓库关闭了 issue，本 note 即该隐患的持久记录；若日后 capability 探测改为 fail loud 或 refresh 流程加入语义 diff 守卫，可重新评估。

## Alternatives considered

**修复 capability 探测里的竞态。** 让 `supportsAcpImagePrompts` 在服务瞬时不可用时重试或 fail loud 能消除根因，但该失败在四次全量运行中只出现过一次、隔离运行从未复现，盲改无法用失败测试证明，还可能改变上游拥有的握手语义。

**给 refresh 模式加语义 diff 守卫。** 拒绝重写 `promptCapabilities` 变化的 fixture 本可拦截此次事故，但这是为一个只观察到一次的隐患，在共享的 test-support 代码里固化字段清单；人工 diff 审查覆盖同样的面，且 fork 不必携带投机性的上游分歧。

## Consequences

代价是每次 refresh 运行后多一步人工审查，且在 diff 审查与提交之间落下的瞬时值仍会漏网。换来的是在 fixture 抖动属于预期、错误值最难被察觉的场合——合并后的同步——获得保护，避免把伪造的行为变更静默提交。此次事故也验证了这里用的归因模式：在把合并后的测试失败判定为回归之前，先在合并前的 worktree 上复跑失败的套件。
