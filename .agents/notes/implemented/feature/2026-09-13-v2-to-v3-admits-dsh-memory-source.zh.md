# Agent Note: v2→v3 迁移接纳 dsh-memory 来源种类，dsh-memory 场景推进到 v3

Status: implemented

[English](2026-09-13-v2-to-v3-admits-dsh-memory-source.md) | 中文

## Problem

2026-09-06 上游引入 Session v3（`f7a6221158`/`705f84f952`）并把 122 个快照 fixture 批量推进到 v3，但 fork 私有的 `snapshots/acp/dsh-memory` 场景不在上游树里，被天然漏掉。深挖发现这不是简单的"补一个文件"：该场景的 v2 fixture 含 `source.kind: "dsh-memory"` 的 user 消息（memory 插件注入的召回提醒，且插件 invariant 强制该 kind 的包所有权），而 v2→v3 迁移的消息源审计清单（`SOURCE_KINDS`）不认识它、按设计拒绝「cannot safely transform unclassified message source」。连锁：llm-replay 插件加载时解析 fixture 抛错 → 不注册 `deepseek-official` adapter → acp `session/new` 报 `NO_ADAPTER` → 被次生的「persistence flush failed」顶替成 `Internal error`。同一根因在静态检查上表现为 corpus 的 v2≠v3 与 pinning 的 system prompt 计数 0≠1（v3 把 system prompt 提升为消息）。

## Decision

- `packages/session/session-format-v2-to-v3/src/payload.ts`：`SOURCE_KINDS` 增加 `'dsh-memory'`（fork 扩展，代码注释与双语 README 标明）。正当性：该来源的成员全是标量（`version`/`scope`/`digest`），无会话内引用，透传迁移无需解释成员——与 agent-message 中继通道同宽限；v3 原生校验（core/session）对 user 消息的 source kind 本就只要求非空字符串，生产桥一直在写该 kind。
- `snapshots/acp/dsh-memory`：经官方 refresh 通道（`DSH_SNAPSHOT=refresh`）产出 `session.v3.jsonl`（v2 输入经修复后的迁移恢复回放，18.8KB），顺带把陈旧的 `tool-schemas.expected.json` 刷到当前 schema（plan 工具描述的上游演进，与本次无关）。

## Alternatives considered

**改 dsh-memory 插件改写 source kind（如归一到 `plugin`）。** 放弃：插件的 invariant 明确要求保留包所有权 kind，且会破坏既有 v2/v3 会话日志的来源辨识；迁移器侧一行接纳远小于此。

**手写 v3 fixture。** 放弃：authored fixture 细节多、易错；refresh 通道走的就是真实迁移+回放管线，产物即验证。

**等上游接纳。** 放弃：上游没有 dsh-memory 插件，不会接纳该 kind；fork 侧扩展已按最小面积落位（一个清单成员+注释+文档），上游 sync 冲突面极小。

## Consequences

- dsh-memory 场景的三个失败（corpus、pinning、scenario replay 的 RequestError）全部转绿；`test:snapshot` 在本机仅剩 sdk bash-tool 一个环境性失败（主机缺沙箱后端，另行处理）。
- 未知 source kind 仍被迁移拒绝（`custom-source` 用例保持拒绝），清单语义未放松——只接纳了被审计为标量成员的这一个 fork 自有 kind。
- 上游 sync 注意点：`payload.ts` 的 SOURCE_KINDS 行与 README 两句 fork 扩展说明是本 fork 的唯一增量；若上游将来改动该清单，merge 时保留 `dsh-memory` 成员即可。

## Testing

`admission.spec.ts` 新用例：dsh-memory 来源的 v2 user 消息迁移成功、成员原样保留、restore 不抛（先红后绿）。包套件 520 全绿（含 `custom-source` 仍拒绝的既有语义）；session-format-catalog 26 绿；acp 快照 + corpus 21/21 绿。
