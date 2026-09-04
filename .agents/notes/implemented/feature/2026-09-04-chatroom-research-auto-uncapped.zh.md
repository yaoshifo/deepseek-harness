# Agent Note: Research auto mode runs uncapped; the round-cap machinery is removed

Status: implemented

[English](2026-09-04-chatroom-research-auto-uncapped.md) | 中文

## Problem

研究自动模式给自己的迭代设了硬上限：主持人 priming 承诺「最多 N 轮，达到上限强制收尾」，`gatherRoles` 在超出上限的那一轮直接拒绝（默认 3；`--max-rounds` 按次覆盖；`maxResearchRounds` 配置项，clamp 到 [1, 20]）。这个上限早于每轮 60 分钟的 research gather 超时和结束条件 priming 而存在；两者就位后，它唯一还会触发的场景是在各方仍有实质性分歧或未验证假设时强制收尾——掐断了这个模式本来要跑的研究——并且让一整套机制（配置字段与 clamp、CLI flag、含 codec/reset-carry/桥 v2 抬升与 v1 映射的持久化会话字段、i18n 文案、卡片行）一直活着，而其覆盖路径从未被任何部署配置过。

## Decision

研究自动模式按主持人判断图景是否完整来迭代；引擎侧不限制研究轮数。整套上限机制一次性移除：`maxResearchRounds` 配置字段及其 clamp、`--max-rounds` flag 解析与范围报错、持久化的 `chatroomResearchRound`/`chatroomResearchMaxRounds` 会话字段（state 访问器、codec encode 与 reset-carry、桥的 version-2 平铺字段抬升、version-1 snake_case 映射）、`gatherRoles` 的上限检查，以及 priming/i18n/模式卡的全部相关文案。自动模式结束条件改为「无轮数上限，按需迭代」并加上每轮要有明确深挖靶点的纪律；收尾流程引言删去「达上限被 engine 拦截」一枚举项；模式卡写明轮次自动推进、无上限。`chatroomResearchRound` 的唯一消费者就是上限比较，因此计数器随之移除，不留下只写不读的状态。

## Alternatives considered

**保留 `--max-rounds`/`maxResearchRounds` 作为无上限默认之上的可选上限。** 否决：没有任何现役消费者设置过它（生产 profile 从未配置该字段），可选路径将成为无主表面；pre-release 立场宁可删净基础也不背兼容垫片。

**提高默认上限而非移除。** 否决：任何有限数字都只是把强制收尾挪到另一个位置；本模式已经信任主持人的结束条件判断（实质性分歧/未验证假设 vs 图景完整）作为终止器，普通圆桌同样无上限运行。

## Consequences

终止依赖主持人的判断与用户（`/chatroom stop`、收尾 `ask_user_question`）；引擎侧不再有轮数兜底。每轮仍受 research gather 超时（默认 60 分钟）约束，`/chatroom stop` 仍能中断整棵子树。习惯性敲 `--max-rounds` 的行为与其他未知 flag 一致——被跳过，其数字值并入议题文本——usage 文案不再宣传它。旧 `sessions.json` 里携带被删字段的条目在下一次保存时丢弃它们（pre-release 无兼容承诺）。澄清阶段的追问上限（最多 2/3 轮）是另一条独立限制，未动。验证：包内 spec 断言自动模式 research gather 连续推进 6+ 轮、并逐字钉住「无轮数上限」priming 文案；chatroom 包加桥 session 共 386 例测试全绿，仓库 typecheck 干净。
