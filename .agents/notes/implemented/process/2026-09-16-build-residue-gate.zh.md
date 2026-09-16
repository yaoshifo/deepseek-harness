# Agent Note: 孤儿 tsc 产物的构建残留门

Status: implemented

[English](2026-09-16-build-residue-gate.md) | 中文

## Problem

`tsc -b` 只增不删：删掉源文件后，它的 `lib/types/<file>.{js,d.ts,.js.map,.d.ts.map}` 产物会无限期留在原地。tsdown bundle 只拉取新入口链引用的文件，所以陈旧产物不会毒化 daemon bundle——中毒路径是任何 lib 消费面（门、直接导入、工具链）从已删模块读符号，外加只有 `pnpm run clean`（全量重建）才能清掉的磁盘残留。该门首次运行就在主树 219 个包里抓到 1124 个累积的孤儿产物，含已从工作区删除的整包 lib 树。

## Decision

`scripts/verify-build-residue.ts` 扫描每个包的 tsc 产物目录（`lib/types`，rootDir `src`——工作区内统一），标记源文件已不存在的产物；覆盖仓库根包、`packages/<group>/<pkg>` 与 `vendor/<pkg>` 两种布局，以及 `src` 整树消失的删包场景。`--prune` 删除被标记的产物。既无 `packages/` 也无 `vendor/` 的根目录直接报错而非空转通过；完全未构建的树（无任何 `lib/types`）以零计数通过。

## Alternatives considered

**扩展 `pnpm run clean`。** clean 清空全部产物并强制全量重建；残留场景需要的是定向的文件级清理，不是更大的锤子。

**连 tsdown 根级产物一起标记。** `lib/*.js` bundle 与分块每次构建整体再生成，且无逐文件源映射；只有 tsc 的逐文件产物会孤儿化。

## Consequences

源删除后的构建须跑该门（`tsx scripts/verify-build-residue.ts`，`--prune` 删除）。整包剪空后留下的空目录仍归 `clean.ts` 管。该门只读工作区树，不碰 `node_modules`。
