# Agent Note: Deployment-class bridge config lives in the bundle patch

Status: implemented

[English](2026-09-01-feishu-bridge-deployment-class-config-in-bundle-patch.md) | 中文

## Problem

[plan-mode 迁移](2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.zh.md)退役第一个每机 profile shim 之后，两台 live profile 仍带着约 15 行行为性条目——两机逐字一致，每一行都是手抄漂移面：goal 全家 / workflow / ralph / 第二编辑器的禁用（2026-08-20，cc-connect 血统）、`tool-ask-user` 与 `dsh-memory` 的插入、`system-prompt` 的身份抑制、`agent-instructions` 的 CLAUDE.md 候选。这些行将来的任何改动都要逐机重抄；plan-mode shim 已经实证过失效方式（dev profile 漏掉了 2026-09-01 的改写）。

两机对照是判别器：Mac 与 dev 上一致的行是部署类 bridge 行为，不一致的行是每机策略——sandbox 与 permission preset 今天就不同（Mac `workspace-write`、dev `danger-full-access`），证明它们属于 profile。

## Decision

六组条目从 profile patch 迁入 `packages/acp/feishu-bridge/cordis.patch.yml`：

- goal 全家（域、轮次驱动、`/goal` 命令、工具——只禁工具行会让 /goal 建的 goal 无工具可关）、workflow、ralph 的禁用：低频编排，其 schema 每轮都花请求上下文。
- `tool-str-replace-editor` 禁用：会话编辑器是 `dsh-tool-fs` 的 edit；dsh-base 仍挂载该行，而[单一编辑器决策](../simplification/2026-08-10-default-presets-single-editor.zh.md)正是通用 preset 不挂它的同一理由。
- `tool-ask-user` 插入：追问卡 / user-questions 机制没有 dsh-base 行，凡 bridge 组合皆需要。
- `dsh-memory` 插入及索引上限（每会话 25600、全局 8192）：会话记忆面是 bridge 产品体验的一部分。
- `system-prompt` 的 `includeHarnessIdentity: false`（bridge 会话自带身份/人格注入）；`persona: ''` 因 patch config 是按 key 整体替换而照抄 base 值。
- `agent-instructions` 的 CLAUDE.md / CLAUDE.local.md 候选（Claude Code 兼容约定）；`maxBytes` 照抄 base 值。

插入的行必须出现在 resolver manifest 的 dependencies 里，因此 `@deepseek-ai/dsh-tool-ask-user` 与 `@deepseek-ai/dsh-memory` 加入 bridge 包依赖。`tests/bundle-patch.spec.ts` 经真实 `applyEntryPatches` 组合钉住全部六组（行存在或禁用、config 值精确）。

刻意留在 profile 的：`sandbox-policy` 与 `permission`（两机今天就不同——运维策略而非产品行为）、`llm-pi-ai` 路由、`session-persistence-jsonl` 路径、`feishu-bridge` 行（bot 凭证、引擎调优）、MCP 与 lsp 插入（token、URL、绝对二进制路径）、`tool-web` 禁用（与每机 MCP 存在性和 key 可用性耦合）、`skill-filesystem` 的 `customSkillDirs`（机器路径）。

## Alternatives considered

- **继续手抄这些行。** 即迁移要移除的漂移类别；dev 漏掉 plan-mode 改写是已记录的实例。
- **把 sandbox/permission preset 也迁走。** 方向错误——两机刻意跑不同值；bundle 级默认值会与 profile 覆盖打架，而不是取代手抄。
- **引入 profile 继承或模板机制来共享行。** bundle 层就是那个机制：后包按 id 覆盖前包的行、link 挂载的包在 pull + `/reload` 时更新、组合 spec 把守共享副本。
- **把 `tool-web` 禁用也放进 bundle。** 禁用理由是机器状态（无直连 provider key；MCP 对提供联网路径）；没有那对 MCP 的 bridge 部署会彻底失去联网能力。

## Consequences

- 新的 bridge 部署默认获得精简工具 roster 与完整的追问/记忆机制；profile 收缩为真·每机配置（凭证、路径、模型路由、运维策略）。
- rollout 沿用 plan-mode 的顺序约束：先 pull link 包、再删 profile 行，否则 daemon 回退到 dsh-base 默认值直到下次 reload。
- 添加两个依赖的 `pnpm install` 把 `content-type` 从 2.0.0 去重到库中已有的 2.1.0（`body-parser`/`type-is`）——良性规范化，记录在此免得 lockfile diff 需要二次解读。
