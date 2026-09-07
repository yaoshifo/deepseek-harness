# Agent Note：cached 配对检查拒绝缺记录的完整 staged 对

Status: implemented

[English](2026-09-07-pairing-hook-rejects-unrecorded-staged-pairs.md) | 中文

## 问题

`verify-translation-pairing` 的 `--cached` 钩子模式把 anchors 过滤成 index 里已有 `.i18n.yaml` 记录的对——设计上，「完全无记录的 staged 对」这类语料完整性归 doc-sync 管。而 fork 的 dev 分支按政策跳过 doc-sync，于是新双语对不带记录提交时永远无人拦截：缺口静默积累了五处（2026-09-07 清全量门时发现），其中一处还是当天 agent 自己写的——失败模式是普通遗漏，不是什么罕见场景。

## 决策

index 模式的过滤对已记录对保持原语义，但新增分支拒绝「双侧语言都已 staged 而记录缺失」的对（`verify-translation-pairing.ts`）：错误点名 source、说明 pairs-merge-whole、给出修法（`verify-translation-pairing --write <source>` 后把 sidecar 一起 stage）。单侧 staged 无对侧仍照旧跳过——钩子依旧不管单语编辑；只有把对合并完整的那次提交必须携带记录。lefthook 的 glob 本就覆盖 `.agents/notes/**`（此前看到的 skip 是另一条 archived-notes 任务的），钩子配置无需改动。

## 备选方案

- **扩 lefthook 配对 glob 或加 notes 任务。** 否决：glob 已含 notes；缺口在脚本 index 模式的 anchor 过滤，不在钩子接线。
- **彻底去掉过滤（钩子管完整语料完整性）。** 否决：会拒掉上游合法拥有的单语 staged 日常编辑，为一个 fork 局部痛点破坏已文档化的分工。

## 测试

`verify-translation-pairing.spec.ts` 在 fixture git 仓库上新增两个钩子模式用例：`feature/new-note` 双侧 staged 无记录退出码 1、点名 source 与 `--write` 修法；同一对带记录进 index 则通过。既有五个用例（双侧 stale hash、语料外跳过、单侧无记录跳过、三文件删除）保持绿；全量检查仍报 1358 对一致。

## 后果

新对双侧 stage 的提交现在会在 pre-commit 快速失败，直到记录随同一提交进入——在跳过 doc-sync 的 fork 上这是该时刻唯一的门。上游行为同样收窄（该分支无条件生效），与语料检查已执行的 pairs-merge-whole 规则一致；若上游吸收时偏好旧的钩子/doc-sync 分工，吸收时可将分支挪到 flag 之后。每次钩子运行的代价是每个 staged anchor 一次存在性探测。
