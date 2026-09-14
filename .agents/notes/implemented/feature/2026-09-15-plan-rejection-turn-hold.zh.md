# Agent Note: plan 评审被拒绝后本回合锁定 exit_plan_mode

Status: implemented

[English](2026-09-15-plan-rejection-turn-hold.md) | 中文

## Problem

2026-09-02 的讨论轮契约被证明无法仅靠措辞维持。活体会话 `cc-20260914-155002-5d40edae1146`（飞书群 oc_7cc55d，mico 工作区，glm-5.3 思考档 max）一个下午拒绝 plan 十次；其中五次携带提问或深挖型批评的拒绝仍在同一回合内被重发。最坏的形状：一个纯澄清提问（「pg 是 mico 客户端的存储吗？还是服务端的？」）没有获得任何正文——模型在 reasoning 里草拟了回答，随后直接调用 exit_plan_mode，把答案做进了新计划的 details 层。另有两个结构性发现：段落自身的第一段（「A user's conversational agreement — including an answer confirming something you asked — … submit it through exit_plan_mode」）恰恰许可了拒绝规则所禁止的「应答追问后立即重发」，同一段落里两句话互相矛盾；且拒绝以工具报错形式落在仍然开着的回合内，退出工具的描述又刻意去策略化，决策点上没有任何东西重申契约。部署面已验证干净（daemon 2026-09-12 启动，加载的 patch 含契约句；模型在反馈自带「先不更新计划」时精确守约）——原因被隔离在引导遵从度，而非部署。

## Decision

评审被拒绝后，部署开启 `rejectionHold: true` 时（bridge bundle patch 开启；presets 与默认部署保持经典的修订-立即重发节奏），`exit_plan_mode` 在本回合剩余时间内被机械锁定。锁定在插件自己的工具执行里强制——拒绝本来就在那里 throw；同回合的后续调用现在在任何新评审提出之前抛出锁定报错。拒绝报错本身携带指令（以正文回应并结束回合；空反馈变体改为询问要改什么），同时修正了基础文本「revise the plan and present it again」与 bridge 契约相矛盾的问题。两条解除通路保证锁不会卡死：认领了用户消息的 pre-step（回合开场或回合中 steer 插话）清除它；后续回合中的调用（无用户消息的 cron 唤醒）按回合 seq 比较清除。段落里的拒绝句随之收缩到与强制语义一致——分类规则、追问应答豁免子句、句间矛盾全部删除，因为机制取代了判断：所有拒绝反馈一律是讨论输入，计划何时回来由用户的消息决定。这就是 [09-02 讨论轮 note](2026-09-02-plan-rejection-discussion-round.zh.md) 里暂缓的硬门替代方案，在它所要求的活体观察触发后挂载。

## Alternatives considered

**收紧拒绝句**（加反馈分类规则；收窄豁免子句）。否决：措辞对抗措辞，守约是概率性的，且不新增一个子句就无法止住追问应答矛盾——同一会话已证明直接指令（「end your turn without calling exit_plan_mode again」）在惯性下也会被违反。

**拒绝报错挂可配置的提示后缀。** 吸收而非选择：指令文本随锁定一起生效，陈述的是机制所强制的内容而非恳求；没有强制力的纯措辞旋钮被判定为不足。

**引擎级拒绝后截断回合。** 否决：为插件自身执行路径已能交付的收益去动 agent-loop 回合语义；放弃路径（`ASK_CANCELLED` → "stop here, and wait for their message"）是「插件级叫停已足够」的在案先例。

**评审卡意图分流**（独立的「继续讨论」/「拒绝修订」按钮让用户声明意图）。否决：把分类负担转移到每一次拒绝点按上；有了锁定，分类本身不再必要——用户开口之前一切反馈都是讨论。

## Consequences

锁定期间拒绝后的同回合重发在结构上不可能（22 分钟六轮拒绝/提交的拉锯不会再发生），回答随回合终局投递不再被掩埋，祈使句反馈多一次交换（「更新计划」）——这正是用户在会话最后一条拒绝反馈里亲手规定的节奏。锁定状态是进程本地的：服务重载丢失它，下一次拒绝重新上锁。固执的模型反复撞锁只会浪费步数，不会发出新评审卡（弹回先于 ask；bridge 面只有进度播报的工具帧可见）。段落句、lockstep spec 与两份 README 同步变更；presets 与 `packages/bundle/base` 保持上游原文。已知残余：纯生成毛刺（丢正文块、reasoning 漏成正文）属于模型层，只有缓解——弹回迫使模型产出文字，但无法保证那就是回答。
