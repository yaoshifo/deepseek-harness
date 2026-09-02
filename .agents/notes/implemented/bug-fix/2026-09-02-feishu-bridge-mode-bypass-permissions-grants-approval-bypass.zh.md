# Agent Note: A resolved bypassPermissions mode grants approval bypass in the bridge

Status: implemented

[English](2026-09-02-feishu-bridge-mode-bypass-permissions-grants-approval-bypass.md) | 中文

## Problem

bridge 的 mode 词表承诺六个值（`default`、`bypassPermissions`、`acceptEdits`、`plan`、`auto`、`dontAsk`——cron store 校验、cron 工具 schema 通告），但 `startSession` 对 mode 字符串只消费一件事：`planMode.set(agent, mode === 'plan')`。配置了 `mode: 'bypassPermissions'` 的 cron job 因此只关掉了 plan 模式——其工具审批询问照样路由到卡片，无人值守运行在那里以 `unavailable` 失败关闭。[cron 无人值守 mode 笔记](2026-08-24-feishu-bridge-cron-unattended-mode-default.zh.md)明确把 per-job `mode` 字段称作「想要 bypass 的任务特意留下的更强逃生门」；实现从未兑现这个承诺。真正翻转会话 `bypassPermissions` 标志的只有无人值守子任务基座（以及经 permission-policy waterfall 加入的 chatroom persona）。

## Decision

`startSession` 现在先算 mode（一次性 override > `/spawn` 钉定 > 项目默认，再过 `feishuBridge/mode-policy` waterfall），再从解析后的值推导会话的 `bypassPermissions`：`unattended || mode === 'bypassPermissions'`（`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts`）。任何落到 `bypassPermissions` 的来源——cron job mode、spawn 钉定、项目 `agent.mode` 默认——现在都与无人值守基座一样自动放行工具权限。从 waterfall 之后的 mode 推导保证监听链保持权威：未来某个监听器改写 mode，bypass 随之改变。其余 mode 值（`acceptEdits`、`auto`、`dontAsk`）仍是仅标签，不变。

## Alternatives considered

**只给 cron 加 bypass 旗标。** 否决：缺口在 mode 词表的共有语义，不在 cron 路径；cron 专用旗标会留下「spawn 钉定或项目默认写着 bypassPermissions、含义却只是关 plan」的口径分裂。

**改为有声失败：cron store 拒绝 `bypassPermissions`。** 否决：该值是已文档化的词表（cron 工具 schema 与 2026-08-24 笔记都承诺了它）；把它做实更小、且符合 Go effectiveMode 的原语义。

## Consequences

显式配置为 `bypassPermissions` 的 cron job（或任何会话）不再弹审批卡——包括沙箱升级询问，一律自动 `allowed-once` 放行。这是逃生门做下的明示交换；想要卡片的运维保持 `default`。状态栏的 YOLO 标签从此对应真实行为。`tests/agent-dsh/adapter.spec.ts` 钉住 override 与默认两条路径（不接 ask delegate：无 bypass 时 answerer 以 `unavailable` 失败关闭）。

## Testing

`packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts`（`effectiveMode bypass wiring`）：`setSessionMode('bypassPermissions')` 一次性覆盖与 `setDefaultMode('bypassPermissions')` 项目默认各自把一条 `approval/request` 自动放行为 `allowed-once`，且未组合 ask delegate。
