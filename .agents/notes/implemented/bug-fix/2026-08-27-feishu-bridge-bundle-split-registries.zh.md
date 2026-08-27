# Agent Note: feishu-bridge 双 bundle 模块分裂——进程级注册表改挂 globalThis

Status: implemented

[English](2026-08-27-feishu-bridge-bundle-split-registries.md) | 中文

## Problem

C2 chatroom 抽包上生产后，topic-pick 卡片把 i18n key 原样渲染（`chatroom_topic_pick_title` 等裸 key）。同一根因还静默破坏了另外两处注册表：featureState codec 注册（armed barrier 快照持久化与 `/new` 携带语义停止生效）与工具家族颜色声明。

## Decision

根因在打包布局而非注册机制：包的 tsdown 配置刻意产出三个自包含运行时 bundle（插件入口 `lib/index.js`、`lib/invariant.js`、兄弟插件面 `./exports` 的 `lib/exports.js`——不发布共享 chunk）。于是 `src/i18n/index.ts`、`src/engine/feature-state.ts`、`src/streaming.ts` 里的模块级可变注册表在每个 bundle 里各有一份拷贝：兄弟插件（chatroom 包）经 `./exports` 拷贝注册，引擎读自己 bundle 的拷贝——两个注册表永不相遇。

修复把注册表**状态**挂到 `globalThis` 符号槽（`__DSH_FEISHU_I18N_SUBTABLES__`、`__DSH_FEISHU_CODECS__`、`__DSH_FEISHU_TOOL_FAMILIES__`；先例：client/connection 的 `__DSH_TRANSPORT__`），任一 bundle 副本读写同一槽。模块函数 API 不变，chatroom 包零改动。

## Alternatives considered

- 经 `FeishuBridgeService` 方法路由注册（cordis 实例天然跨 bundle）：同样正确，但要重写 exports 面、包 apply 与一批测试，且 `./exports` 面上的模块级注册函数对后续消费者仍是陷阱。全局槽让两个副本以最小 diff 达成一致。
- tsdown 共享 chunk：与包刻意自包含 bundle 的设计相悖，还要扩宽发布 files 清单。

## Consequences

- 源码面与产物面行为一致：源码面测试（tsconfig `paths` 单实例）不再观察到与生产（双 bundle）不同的世界。
- 回归防护：`packages/acp/feishu-bridge/tests/built-bundle-registries.spec.ts` 消费构建产物（净树上自跳过；CI 在 build 后跑到）——经 exports bundle 的注册必须落到全局槽，且两个 bundle 文件必须引用同一槽名。
- 流程规则：**跨包单例状态一律不放模块级**——任何多入口自包含打包的包都会复制模块；注册类能力要么走 cordis 服务实例，要么显式挂 globalThis 槽。源码面 REAL-composition 测试不能替代产物面组合测试。
