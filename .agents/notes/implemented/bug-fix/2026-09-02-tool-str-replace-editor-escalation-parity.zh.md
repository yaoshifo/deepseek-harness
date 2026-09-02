# Agent Note: str_replace_editor joins the sandbox escalation contract

Status: implemented

[English](2026-09-02-tool-str-replace-editor-escalation-parity.md) | 中文

## Problem

跨家族沙箱契约（[沙箱笔记](../feature/2026-07-06-sandbox.zh.md)）要求每个受限消费方通告成对的 `sandbox_permissions` + `justification` 字段供一次「严格变宽、经批准」的重试，并把拒绝映射为共享标记加同回合升级提示。bash 工具与 `dsh-tool-fs` 的 `write`/`edit` 工具遵守它；`str_replace_editor`——feishu-bridge profile 组合为其编辑面的 Claude Code 风格编辑器——解析按调用策略却不通告升级字段、不附加提示，受限编辑因此是终局拒绝：模型要绕道 bash 才能碰围栏拒绝的路径。

## Decision

`packages/fs/tool-str-replace-editor/src/index.ts` 的 `MutationPolicy` 现在携带与 tool-fs 控制器相同的升级面：`escalationModes` 通告（恰在 `ctx.fs.sandboxMode` 有定义时为 `ESCALATION_TARGETS`）、受限后端下展开进工具 `parameters` 的两个 schema 字段（否则缺失，校验器在 `execute` 前拒绝）、先校验参数配对再经 `approveEscalation`（`ctx.approval`，工具名 `str_replace_editor`）路由严格变宽重试的 `resolvePolicy(args, exec)`，以及给拒绝标记追加 `escalationHintMarker('operation')` 的 `mapError`。三个变更命令（`create`、`str_replace`、`insert`）经它解析策略；`view` 保持只读。词汇与失败关闭序列全部来自 `@deepseek-ai/dsh-sandbox`——编辑器只持有自己的胶水，与 bash、tool-fs 各自持有的形状相同。

## Alternatives considered

**从 `dsh-tool-fs` 导入 `FsSandboxController`。** 否决：那是兄弟工具包未导出的内部件；为共享一个控制器耦合两个工具包，是比每个家族自己拥有约 60 行胶水（bash 亦然）更大的拓扑改动。

**把控制器上移进 `dsh-sandbox`。** 暂时否决：控制器绑定了 cordis `Context`、`dsh-tools` 的执行上下文与 `dsh-fs` 的 `FsError`；`dsh-sandbox` 刻意只做词汇层。若出现第四个 fs 家族工具，再议共享归属。

## Consequences

受限的 `str_replace_editor` 变更现在与被拒的 `write`/`edit` 读感一致：共享标记、重试提示、批准后把更宽模式只盖在这一次变更上的授权。feishu-bridge profile 的编辑器在 `workspace-write` 会话获得恢复路径；`danger-full-access` 的 plan 审批升格（[预设笔记](../feature/2026-09-02-feishu-bridge-plan-approval-permission-preset.zh.md)）之后围栏已撤、字段闲置。从 registry 组合编辑器的部署在下次依赖刷新时获得本修复——feishu-bridge live profile 用 pnpm store 解析本包，不是 `link:`。

## Testing

`packages/fs/tool-str-replace-editor/tests/tools.spec.ts`（`sandbox escalation` describe）：两类后端的通告门控、标记加提示的拒绝文本、批准升级把所授模式盖进变更、拒绝升级失败关闭且不变更、审批服务缺失失败关闭、参数配对拒绝。
