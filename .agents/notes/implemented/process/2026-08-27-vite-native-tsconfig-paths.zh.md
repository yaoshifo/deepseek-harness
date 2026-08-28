# Agent Note: Vite-native tsconfig paths for test resolution

Status: implemented

[English](2026-08-27-vite-native-tsconfig-paths.md) | 中文

## 问题

每次跑 vitest 都会打印 Vite 的迁移警告：`vite-tsconfig-paths` 插件重复了 Vite 8 原生提供的 `resolve.tsconfigPaths` 能力。仓库为此一直付出双份成本——根目录一个 devDependency、每个 vitest 配置挂一次插件、每个 vitest *project* 再挂一次——只为一件事保活：工作区包的裸导入经共享的 `tsconfig.base.json` paths 映射解析到 `src`，绝不经由包 `exports` 落到构建后的 `lib/`——那里的陈旧产物会加载第二份模块单例（[测试解析](../../../../docs/testing.zh.md)）。

## 决策

五个 vitest 配置全部启用 `resolve: { tsconfigPaths: true }`；插件 import、npm 依赖及其在第三方清单里的条目一并移除。解析约定本身不变。插件与原生选项之间有两个语义差异是承重事实：

- **发现按 importer 就近进行，而非指向式全量门面。** 插件把所有文件都经一个显式列出的配置解析；Vite 原生支持从每个导入文件向上查找并跟随 `extends`。本仓库每条车道的目录都能以这种方式到达 `tsconfig.base.json`：各 package、`apps/*`、根级 `scripts/`，以及最近层 `tsconfig.json` 自身不带任何 compilerOptions 的三个 solution 式聚合（`packages/api/gateway`、`packages/api/remotes`、`packages/client/connection`）。
- **paths 压过包的 `exports`**，尽管工作区包发布的 `exports` 条目指向 `lib/`，源码平面规则依然成立。

`vitest.snapshot.config.ts` 里一条已删除的旧注释曾拒绝原生选项，理由是「根 tsconfig 是没有 paths 的 solution 文件」；它写于 Vite 尚无该选项的年代，已不能描述现行机制。

Vitest 的 project 配置不继承顶层 `resolve`：`vitest.config.ts` 中每个具名 project 原地重复 `resolve: { tsconfigPaths: true }`，取代旧的按 project 挂插件写法。缺了这一步，setup 文件的 transform 在模块抓取阶段就会解析不到工作区包名。

## 验证

- 对每个疑似发现断点的车道，用只带原生选项的临时配置跑过金丝雀套件：solution 式聚合（`gateway.host.spec.ts`、`node-half.host.spec.ts`）、根级脚本车道，以及普通包车道。
- 向构建后的 `lib/index.js` 注入哨兵导出后，对裸名与其 `/invariant` 子路径做命名空间导入，哨兵均不可见，证明解析走 src 侧而非 exports 回退；事后删除了哨兵产物。
- 迁移后全量单测通过（1034 个 spec 文件）。

## 已考虑的替代方案

- **留用插件直到被强制下线。** 拒绝：在惯性之下保留第二套解析实现及其失效模式，同时让警告刷屏本地与 CI 的每一次测试。
- **给三个 solution 式聚合 tsconfig 加 `extends`** 让最近层链条显式到达 base。拒绝：非必要——就近查找在那里本就可达，而改动聚合 tsc 入口会把爆炸半径扩大到运行时解析之外。
- **由 `tsconfig.base.json` 生成 Vite `alias` 表。** 拒绝：又造一条有自己的漂移风险的映射管线——移除插件要删掉的正类东西。

## 后果

- 第三方依赖面少一个包；`THIRD_PARTY_NOTICES.md` 相应重新生成。
- 新增含测试的车道目录需要能到达 `tsconfig.base.json` 的 tsconfig 链；tsx 对 scripts 与 examples 本就有此要求，违规会在 transform 阶段大声失败。
- 改名 `tsconfig.base.json` 或移动其 `paths` 映射时，需在同一变更里同步更新五个 vitest 配置与[开发布局表](../../../../docs/development.zh.md)。
