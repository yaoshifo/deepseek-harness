# Agent Note：聊天室闪电轮——全员参与，核心席保持常驻

Status: implemented

[English](2026-09-07-chatroom-lightning-round-poll.md) | 中文

## 问题

一场聊天室讨论只涉及主持人在选角时推荐的角色：#43 选角器把启动名额限制在 `maxRoles`（默认 5），阵容开场固定，角色目录里的其余人设（写作时 13 位思想家，随 books 结业持续增长）没有结构化的参与途径——主持人靠翻人设文件凭印象推荐，场外角色的独有盲点永远浮不出来。把 13 个全启动成常驻 agent 是显然的反面解：每场 13 个飞书群、13 个要监督的会话、每次 gather 全量扇出（gather 超时历史显示负载下单轮已跑 20-27 分钟）。

## 决策

参与拆成成本模型不同的两档：

- **闪电轮（每个人设、每场）**——`feishu_bridge_chatroom` 工具新增 `poll` 动作。引擎经 agent 后端新增的 `pollQuery` 能力（`ForkQuerierWithProvider`，adapter `oneShotQuery` 加 `toolFilter: { allow: [] }`）给每个未启动的人设发一次单回合查询：无群、无常驻会话、全部工具在引擎层掩掉（被快答的人设开不了研究——约束靠掩码执行，不靠任务书自觉），同时人设目录的 workspace 指令保持组装，CLAUDE.md 人设以与常驻角色会话完全相同的机制加载。角色 memory 连续性保留（一次性会话不携带 `oneshot` origin，memory-index 注入保持开启；每个即弃会话一次 LLM 标题调用是接受的开销——天平倾斜时再换 `oneshot` origin）。
- **核心席（≤ maxRoles 常驻 agent）**——不变；开场 poll 替代文件泛读喂给推荐：pick priming 的第一步是 `poll(round: opening)`（各一句：立场 / 盲点 / 参与意愿），pick-roles 推荐必须基于收到的表态构建。收尾补盲（`round: closing`）在总结前问场外角色——尤其自标「想深聊」的那些——最终图景还漏了什么；两版主持人 priming（普通版与 research 版）都带该指令，books 仓库的主持人 `chatroom/CLAUDE.md` 镜像了工具契约（人设侧伴随改动，在该仓库提交）。

引擎机制（`chatroom-poll.ts`、`chatroom.ts`）：

- 屏障镜像 `ChatroomGather` 的 accumulate/forget/timeout 形状，但刻意两处不同：**纯引擎内存**（跟踪的一次性查询随进程消亡，没有可持久化或恢复的东西）；超时**一次直接降级**并标注（未表态）——无重挂窗口，因为快答是分钟级不是研究轮，收尾补盲轮就是内建的第二机会。
- 派发是受 `pollMaxConcurrent`（默认 4）约束的 worker 池：13 人的库对 LLM 网关渐进扇出，尊重 2026-08-31 的教训（限流窗口挂死而不返回 429）。worker 数在派发前快照——循环条件里的活 `queue.length` 会把池子退化成单 worker（并发测试抓到，读代码没抓到）。
- settle 时由引擎——不是主持人——给每个被快答的人设写一行 RECORD.md（缺席标注（未表态））：全员出场记录是结构性保证；一张合并表态卡发进 hub 群，用户看到整个库出场而不是 13 条消息。
- #43 选角 watchdog 在 poll 在飞时顺延（每次重挂一个窗口），让开场 poll 的唤醒——不是过期的五分钟 fallback 卡——把主持人送进 pick-roles。
- 配置：`pollTimeoutSec`（默认 600）、`pollMaxConcurrent`（默认 4）、`pollProvider`（'' = 默认路由；接 `glm-flash` 这类便宜命名路由只需一行配置）。

## 备选方案

- **主持人在一个 context 里扮演全部人设。** 否决：单一 context 把立场拉平——这正是角色拆成独立 agent 的原因——且违反主持人不代言角色观点的契约。
- **全部人设常驻启动但很少点名。** 否决：空闲 agent 花 token 不多，但群与监督面照旧，澄清阶段的 gather 仍会全量扇出。
- **原生 continuable 子任务 + `settleNativeChild` 捕获。** 探索后弃用：结算路径确实带回最终输出，但 `oneShotQuery` 直接返回回合文本、不需要人设配合 report 协议、且已支持 provider 路由与工具过滤——同样的保证，更少的机械。
- **纯提示词层（主持人逐人设跑 `feishu_bridge_subtask`）。** 用户明确选择否决：屏障、超时、出场记录、并发上限归引擎所有，主持人的编排负担不随库规模增长。

## 测试

`chatroom-poll.spec.ts`（9 例）：屏障 accumulate/fail/timeout 一次降级；`pollRoles` 恰好对未启动人设在各自人设目录下发起快答、收齐后带标签汇总唤醒主持人；并发上限把第二个查询压到 worker 空出后才发；gather/poll 互斥；超时降级中止仍在途的查询（经 stub 的 abort signal 断言）并标注缺席者；选角 watchdog 在 poll 中顺延、settle 后重挂；RECORD.md 每人设一行含（未表态）、一张合并表态卡发出。工具面：enum 快照、poll 路由证明、REAL 组合 enum。配置：默认值与覆盖。`buildChatroomPickPriming` 与两版主持人 priming 断言新的 poll 驱动文本。chatroom 包全量（26 文件 375 例）与 bridge 包全量（160 文件 2890 例）绿。

## 后果

每场 `/chatroom` 增加一轮 N 个一次性表态开场（N = 库规模减核心席；当前约 13 × 几千 token），场外角色自标有兴趣时增加一轮收尾补盲——成本线性增长且比启动常驻低一个数量级。选角流程的墙钟时间增加开场 poll 的 settle（分钟级；10 分钟超时封顶）。表态质量是核心赌注——验收标准是一场次的 RECORD 里能看到场外角色的盲点被核心讨论实际吸收；若表态塌缩成 ESSENCE 口号，任务书里「具体盲点」的要求是第一个旋钮。已知缓办（记录在包 README）：收尾补盲只在主持人遵循 priming 时发生（无 `end` 时刻强制），poll 中途重启丢轮（主持人重新发起）。热加入（表态证明关键时中途 lazy-spawn 场外角色）不在本次范围；收尾补盲轮是当前的二次机会。
