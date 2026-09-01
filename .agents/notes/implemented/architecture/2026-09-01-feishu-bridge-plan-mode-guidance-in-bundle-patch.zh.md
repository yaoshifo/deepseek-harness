# Agent Note: Bridge bundle patch owns the plan-mode guidance section

Status: implemented

[English](2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.md) | 中文

## Problem

plan-mode 段的委派句必须点名模型实际可调用的委派工具。bridge 组合里通用 `subagent`/`subagent_fork` 工具是禁用的（单一委派入口：它们的子进程对引擎不可见），因此 dsh-base 的工具中立文案——"background subagent delegations"——点名的是这里用不了的工具。

自 2026-08-21 起，部署层把适配文案作为每机 profile `cordis.patch.yml` 覆盖承载：整段手工维护的本地副本，其注释自述「上游 dsh-base release 带上此文本后删除」。由此产生两个失效模式。其一，registry 钉版的 dsh-base 发版滞后于仓库文本，每次引导演进都要把整段重新抄进每台机器的 profile——2026-09-01 [并行探索改写](../feature/2026-08-31-parallel-exploration-default-guidance.zh.md) 进入仓库时 dev profile 被漏掉（Mac 08-31 重抄，dev 仍在用 2026-08-21 文案），半数部署悄然缺失默认并行引导。其二，等来的上游文本本来就是工具中立的，「到货即删」会把点名禁用工具的句子原样放回来。

## Decision

- bridge 适配版 plan-mode 段落在 bridge 包自己的 bundle patch（`packages/acp/feishu-bridge/cordis.patch.yml`）里，作为对 dsh-base 挂载的 `plan-mode` 行的 id 定向 config 覆盖。profile 的 bundle 顺序（dsh-base → feishu-bridge → chatroom）使后包覆盖替换前行的 config，link 挂载的包在 `/reload` 时取源码更新——引导演进经 pull+reload 通道到达 bridge 部署，无需逐机编辑。
- 除委派句外每段与 dsh-base 的 section 逐字一致；唯一差异是一句委派句（"start them together as background subagent delegations in one assistant message, each with a focused, self-contained prompt" → "dispatch them together as `feishu_bridge_subtask` spawns in one assistant message, each with a focused, self-contained brief"）。
- 每机 profile 覆盖退役：2026-08-21 shim 的终点条件被取代——覆盖是永久的（工具中立的上游句子不适配本组合），不是待发版的临时补丁。
- `tests/bundle-patch.spec.ts` 经真实 `applyEntryPatches` 组合钉住两个事实：base+bridge 补丁组合产出适配版 section（无 plan-mode 补丁告警）；section 与 dsh-base 版保持锁步、差异恰为那一句委派句——base 任何改写都会让 spec 变红，逼出重新适配。

## Alternatives considered

- **保留每机 profile 覆盖并手工同步。** 即本变更移除的漂移类别；dev profile 已实证其真实发生。
- **等 dsh-base 发版后删除覆盖**（2026-08-21 的终点条件）。发版带的是点名禁用工具的工具中立句；适配文案无论如何得存在于某处，且 registry 钉版的 dsh-base 每机升级仍走 profile install。
- **把 dsh-base link 进 live profile。** 仓库文本自动流动，但仍是工具中立文案，且为一句话把整个 base 组合切到本地源码。
- **plan-mode 插件加扩展点，bridge 追加委派段而非整段覆盖。** 彻底消除双副本残留；为单一消费者改插件 API，暂缓为可能的上游提案。

## Consequences

- 忘掉某台机器的副本不再可能；profile patch 层仍可作紧急覆盖使用（它在所有 bundle 层之后应用）。
- 残余漂移风险移入仓库内部：dsh-base 段与 bridge 适配是两份副本，base 改写时须重新适配 bridge 句——锁步 spec 把这种漂移变成红灯门禁，而非静默部署缺口。
- 语义扩大：所有挂载 bridge bundle 的组合（repo spec、registry 安装、未来部署）都得到适配版 section。`feishu_bridge_subtask` 由 bridge 插件自身注册，凡 bundle 挂载处文案皆有效。
- Rollout 顺序约束：profile 必须等 link 包带上覆盖后才能删 shim；先删会回退到 dsh-base 的工具中立 section，直到下次 reload。
