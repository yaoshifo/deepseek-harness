# Agent Note: 移除 feishu-bridge 洞察卡

Status: implemented

[English](2026-09-16-remove-insight-card.md) | 中文

## Problem

洞察卡（移植自 cc-connect 的 #33 Predict Next + turn_summary）在每个完成的回合后触发：一行回合总结加一行预测的下一句用户消息，以带发送/屏蔽按钮的紫色卡片投递，背后是每回合两条轻量旁路查询。用户裁定这张卡没用了（2026-09-16）：它带来回合后的噪音和每回合两条旁路查询的成本，而其建议已无人读。`/btw`——同模块移植的手动旁路提问命令——是另一个能力，保留。

## Decision

bridge 交付物中不再有洞察卡。随之移除：

- 回合后触发、两条生成 fork、增量发卡、`act:/nopred` 屏蔽卡片动作，以及 engine 的配置字段与 setter。
- `predictNext` / `turnSummary` 项目配置键及其装配。schemastery 会保留已验证对象中的未知键，残留键会以「配了但无效」的旋钮载入；`buildProjectAssembly` 改为在装配时抛错——与 2026-09-14 删 `feishu.progressStyle` 时引入的守卫同类。
- 五条 i18n 词条：`predict_insight_title`、`predict_send`、`predict_block`、`nopred_title`、`nopred_body`。
- 仅剩的生产消费方是预测 resume 模式的两个面：`forkSessionWithProvider` 能力成员（`ForkQuerierWithProvider` 接口降为三成员）与 `engine/provider.ts` 的 `getProviderModel`（整文件删除）。

`engine/predict.ts` 收缩为仅 `/btw` 并更名为 `engine/btw.ts`（`registerPredictCommands` → `registerBtwCommands`）。保留：`/btw` 走 `forkQuery`、群名生成与 monitor 分诊走 `lightweightQuery`、chatroom 快问走 `pollQuery`——均仍按[一次性旁路查询决策](../architecture/2026-08-26-oneshot-origin-bare-side-queries.zh.md)以 origin `oneshot` 裸跑。[按群路由回退](../feature/2026-09-03-feishu-bridge-per-chat-provider-routes.zh.md)与[飞行 turn fork 种子](../feature/2026-08-30-feishu-bridge-flying-turn-fork-seed.zh.md)失去这两个消费方，机制保留。

## Alternatives considered

**保留代码、默认关闭。** 维持一条无消费方的死路径——两种 fork 模式、一个卡片动作、五条 i18n 词条；裁定退役的是能力本身，不是它的默认值。

**只删一半（总结或预测）。** 裁定针对整张卡；两半共享触发、卡片与配置块。

**静默剥离配置键。** 残留的 `predictNext` 块会以「配了但无效」载入——恰是 progressStyle 守卫拒绝的那类错误配置。

**连 `/btw` 一起删。** 超出裁定范围；它是有人用的手动命令，与被删功能只共享模块文件。

## Consequences

群里不再出现回合后卡片，每回合两条旁路查询连同其 token 成本消失。仍带任一被删键的配置在装配时抛错并给出删除指引（Mac live profile 两者皆无——已核实）。`forkSessionWithProvider` 离开共享能力接口；chatroom 测试桩删去其 reject 成员，未来需要按命名路由的带种子 fork 时再加回方法。约二十条只测被删行为的测试随之删除；`/btw` 保留其五条。`docs/config-catalog` 与 tool-cordis API catalog 的过期条目留待下次上游同步再生成（fork 政策接受的漂移）；`MIGRATION.md` 保留移植史。

两条装配测试钉住残留守卫：残留的 `predictNext` 或 `turnSummary` 键穿过 schemastery 验证存活，`buildProjectAssembly` 拒绝之。
