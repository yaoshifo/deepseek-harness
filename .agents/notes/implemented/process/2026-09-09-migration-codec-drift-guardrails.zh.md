# Agent Note: Migration codec snapshot drift guardrails

Status: implemented

[English](2026-09-09-migration-codec-drift-guardrails.md) | 中文

## Problem

已发布的迁移 codec（`session-format-v0-to-v1`、`session-format-v1-to-v2`）按手写的 schema 快照校验历史会话日志。快照在其所属代退役之后才编写，却必须覆盖旧写入器在仍是当前代期间添加的每一个字段扩展。仓库里没有任何真源记录这个窗口：写入器的事件类型此后持续演进，而 CI fixture 与快照出自同一批作者之手，fixture 与 schema 共享同一个盲区。

2026-09-09 这类漂移以用户可见故障的形式暴露：一次 `/fk` fork 静默丢失了父会话上下文，因为父会话的 v0 日志在迁移中途被拒。对生产 sessions root 实测，v0 时代写入器落盘过的五类字段扩展从未被快照吸收——`todo/write` item 的 `activeForm`、header 的 `origin: 'oneshot'`、`permission/preset` 的 `origin` 成员、`approval/decided` 的 `allowed-always` outcome、`subagent/descriptor` version 2——导致 2856 个历史代日志中 1726 个不可读（fork seed 丢失、resume 失败）。feishu-bridge 的 fork 兜底还把拒绝吞成误导性的「no seedable turns」warn（已在 adapter 侧单独修复）。

## Decision

历史 v0 会话作为已记录的接受损失废弃（用户 2026-09-09 拍板）：五处快照缺口不修，包括 078313831b 在 v0-to-v1 侧留下、比其 v1-to-v2 姊妹处更窄的 header 白名单。改为落地三道防线：

1. **生产扫描** —— `.agents/skills/feishu-session-log-triage/scripts/scan-migration-drift.mjs` 用当前构建的迁移解码跑 sessions root 下全部历史代日志，按拒绝原因聚类输出报告并 fail-loud。它是唯一以落盘数据本身为真源的检查。catalog 从本仓库构建产物解析，因此跑的永远是本 checkout 会部署的 codec 链。
2. **锁定拒绝** —— 五类漂移形态作为「拒绝」用例钉进 `session-format-v0-to-v1`（`tests/validation.spec.ts`、`tests/codec.spec.ts`），并标注拍板。快照的部分修复无法悄然落地；修复快照意味着把这些用例一并翻转为接受。
3. **快照编写规则** —— 任何未来代（v3+）的 codec schema 在落地前，必须先对上一代日志做全量生产扫描，据其验证或生成。凭记忆或当前源码编写快照正是漂移的成因。

凡是可能改动 session-format 包的 daemon reload 之后、以及编写任何新代快照之前，都要跑一次扫描。

## Related

相邻迁移机制本身——版本命名的 successor generation、绝不改写已提交代——由 [released session format migrations](../architecture/2026-08-31-released-session-format-migrations.zh.md) 拥有。本 note 补上该机制留下的编写侧约束：退役后编写的快照必须以退役写入器的落盘数据为依据，而非当前源码。

## Alternatives considered

**修复五处快照缺口。** 能救回 1726 个会话，但价值集中在 1330 个一次性提问会话；用户裁定其余工作会话不值得修。只有当拒绝清单上的某个会话重新被需要时再重启——锁定用例已点名全部要修的形态。

**从历史 git 快照生成 schema。** 写入器任意时刻的格式理论上可从 git 历史推导，但提取脆弱（合并顺序、回移植），且生成器本身会变成第二份手写 schema。生产扫描直接测量同一属性。

**为已提交数据漂移建 CI fixture gate。** CI 触不到生产数据，静态 fixture 复制的是同一作者盲区；它只能钉住已知回归，而这已由锁定拒绝用例承担。

**把扫描挂进 `reload.sh`。** 能自动覆盖，但拉长部署路径并把 owner-local 诊断耦合进部署脚本。扫描保持为上述两个触发点上的手动步骤。

## Consequences

未来的 v3 快照有了独立的、以数据为依据的验证器；当前的接受损失被钉住并点名，而非隐式存在。代价：v0 历史会话永久不可读；扫描要求先构建 checkout（`pnpm run build`）；两道防线都依赖流程被执行——reload 清单和任何 v3 工作必须携带扫描这一步。
