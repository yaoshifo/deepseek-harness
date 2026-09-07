# Agent Note: Vite-native tsconfig paths for test resolution

Status: implemented

[English](2026-08-27-vite-native-tsconfig-paths.md) | 中文

## 问题

每次跑 vitest 都会打印 Vite 的迁移警告：`vite-tsconfig-paths` 插件重复了 Vite 8 原生提供的 `resolve.tsconfigPaths` 能力。仓库为此一直付出双份成本——根目录一个 devDependency、每个 vitest 配置挂一次插件、每个 vitest *project* 再挂一次——只为一件事保活：工作区包的裸导入经共享的 `tsconfig.base.json` paths 映射解析到 `src`，绝不经由包 `exports` 落到构建后的 `lib/`——那里的陈旧产物会加载第二份模块单例（[测试解析](../../../../docs/testing.zh.md)）。

## 决策

**已逆转。** 2026-08-27 切到原生解析的分两步退回：2026-08-29 吸收上游 1079 个提交期间 `vitest.config.ts` 先退回 `vite-tsconfig-paths` 插件，2026-09-06 其余四条车道（`vitest.snapshot.config.ts`、`vitest.e2e.config.ts`、`vitest.web.config.ts`、`vitest.web-stress.config.ts`）跟进收尾，偏离就此终结。

放弃原生解析的原因：它按 importer 就近发现 tsconfig 链（向上查找加 `extends`），而非一个指向式全量门面。上游新增的 face-split 包持有不带 `paths` 的 solution 式根 `tsconfig.json`，这条就近发现路径让这些包的 `src` 文件经 package `exports` 落到构建后的 `lib/`，加载出第二份模块单例——`api/session-controller` 中 33 个 `instanceof` 测试失败。插件的 `projects: ['./tsconfig.base.json']` 门面在每条车道恢复源码平面约定：base 文件没有 `include`，其 paths 映射作用于每个测试文件，且 paths 压过包的 `exports`。

每个 vitest 配置挂载 `tsconfigPaths({ projects: ['./tsconfig.base.json'] })`；`vitest.config.ts` 经其 `pathsPlugin()` 工厂对每个 vitest project 重复挂载。现行决策由 [fork 二次开发原则](2026-08-29-fork-secondary-development-principles.zh.md)持有，其「不 fork 工具链」规则正是本次偏离的产物。

## 验证

- 2026-08-29 主 lane 退回后全量单测通过；`api/session-controller` 的 33 个假 `instanceof` 失败清除。
- 2026-09-06 车道收尾经插件门面跑通了全量 keyless snapshot 回放车道，以及其余三条车道（e2e、web、web-stress）各自的 scoped 套件。

## 已考虑的替代方案

- **留用插件直到被强制下线。** 当时拒绝：在惯性之下保留第二套解析实现及其失效模式，同时让警告刷屏本地与 CI 的每一次测试。face-split 单例失败逆转了这一判断。
- **给三个 solution 式聚合 tsconfig 加 `extends`** 让最近层链条显式到达 base。拒绝：非必要——就近查找在那里本就可达，而改动聚合 tsc 入口会把爆炸半径扩大到运行时解析之外。
- **由 `tsconfig.base.json` 生成 Vite `alias` 表。** 拒绝：又造一条有自己的漂移风险的映射管线——移除插件要删掉的正类东西。

## 后果

- `vite-tsconfig-paths` 是根 devDependency，`THIRD_PARTY_NOTICES.md` 保有对应条目。
- 新增含测试的车道目录不需要自己的 tsconfig 链：插件门面把每条车道直接指向 `tsconfig.base.json`。
- 改名 `tsconfig.base.json` 或移动其 `paths` 映射时，需在同一变更里同步更新每个 vitest 配置与[开发布局表](../../../../docs/development.zh.md)。
