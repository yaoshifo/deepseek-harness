# Agent Note: Closing-card asks convert to non-blocking followups suggestion cards

Status: implemented

[English](2026-09-02-feishu-bridge-closing-card-followups-conversion.md) | 中文

## Problem

agent 约定提示词要求：turn 的「发现的问题 / 可优化点」一节非空时，收尾要发一张 `ask_user_question` 多选卡。`ask_user_question` 是阻塞式工具，turn 因此 park 在 ask 上——park 几乎成了每个 turn 的默认终态。被 park 的 turn 会压制 ✅ 完成通知（其唯一触发点是 turn 的 result 事件）、一直占着会话锁（该聊天上 cron 复用模式的任务直接报 "session busy"）、把下一条自由文本吞成 ask 的答案、被所有收割器豁免且全仓无任何超时兜底、daemon 重启后卡片整体作废。这些 park 语义对真正的中途提问是正确的；错的是收尾卡滥用了它。

## Decision

引擎的 `askUser` 委托对识别为收尾卡的 ask 就地转换而非 park。识别在引擎侧、按签名进行——模型行为零改动、零迁移：单题 questions 且 header 为保留字「后续处理」，或单题多选且含「暂不处理」选项。两个键都是提示词既已规定的特征，存量收尾卡在首次部署即被转换；header 常量放在 `engine/ask.ts`、提示词模板 import 同一常量，匹配器与提示词不可能漂移。

- `isFollowupsAsk`（engine/ask.ts）持有匹配器；`Engine.askUser` 的转换分支把问题登记到 `InteractiveState.pendingFollowups`，把 ask 前的回复段钉进实时播报段（`StreamPreview.pinAnalysisText` 把该段冻结为前缀——`appendAnalysisText` 按文本块整体替换该段，ask 之后的尾段文本本会把收尾总结顶出卡片；ask 后的块折叠进前缀，完成卡因此承载完整回复；`captureReplyForExport` 仍为导出按钮登记该段，segmentStart 不动、turn-end 导出仍登记完整 joined 回复，二次 pin 追加而非丢弃首个前缀），并返回合成的延迟 Decision——custom 文本告知模型选择会作为新消息到达、且不要向用户复述该说明（建议卡本身已说明流程）。工具结果本身就是第二道防线：即使会话带着过时提示词，也会正确收尾而非干等。
- `sendFollowupsCard` 在 `handleResultEvent` 里紧跟 `sendTurnCompletionCard` 发出蓝色建议卡（checkOptions 表单、`fw_multi:0` action、recommended 选项预勾选、卡内附言输入框）；errored turn 丢弃登记，排队接管把登记结转到最终 turn 的完成卡。
- 飞书平台的卡片回调 intake 新增 `fw_multi:` 分支：合成自包含的「[后续处理]」选择消息（勾选与未勾选项带标签、附附言；发送时 meta 缓存丢失时退化为仅序号），并以 `isFollowupAction` 旗标派发。`routeAskResponse` 永不认领该旗标——即使该会话上另有 ask 正在 park，选择也开新 turn；提交后的卡按发送时缓存的 meta 冻结为已提交快照，且各命名空间只消费各自的 meta。
- 提示词段改写为新语义（登记后正常结束回合；选择即授权；不点即不处理），不再要求「暂不处理」选项。

## Alternatives considered

**提示词驱动的工具切换——新增非阻塞的 `feishu_bridge_followups` 工具，由提示词指示模型调用。** 作为机制被否：它依赖模型遵从，一次漏做、一个带着旧提示词的存量会话、一次提示词漂移都会退回旧的 park 行为。签名转换则锚定模型既有的稳定行为；提示词改写只是对齐说明，不是承重墙。

**把选项渲染在 ✅ 完成卡上。** 产品决策否掉：完成卡是纯状态面，混入决策 UI 的交互设计不好。

**砍掉收尾卡、改纯文本回复。** 产品决策否掉：结构化多选的选择面保留。

**给未答的收尾 ask 加超时自动结算。** 否掉：✅ 仍然迟到（被产品否掉的两卡时序只是延后出现），且 park 窗口——吞消息、cron busy——在超时前依旧存在。

## Consequences

收尾卡 turn 现在正常结束：✅ 通知按时到达、会话锁即释放（cron 复用任务可跑）、自由文本开新 turn、idle reaper 正常回收会话、重启后点旧卡选择仍以新 turn 到达——严格优于重启即作废的 parked ask。ask 前的收尾总结由卡片自身承载：钉住的前缀让它在实时播报段活过整个 turn（无字数阈值、不依赖 plan render；降级预览下 pin 惰性、由降级消息路径投递文本），turn-end 的 speculative 摘要渲染看到空槽位、回退到完整 joined 回复，摘要因此覆盖整个 turn（2026-09-03 oc_f924a2：被钉住取代的过渡性 speculative 渲染只是一屏摘要、还落在后续处理卡之后——用户仍得点「查看完整回复」才能读到总结）。代价：两条推送背靠背（✅ 卡之后是建议卡）——「完成→选择」的自然顺序被接受，若实际吵再考虑配置开关；匹配器是显示文本契约，三特征全偏离的收尾卡回落到 park（fail-open 到旧行为，可用 askq park 频率监控）。真正的中途 `ask_user_question` 提问照旧 park。由 `tests/engine/followups.spec.ts`（匹配器、转换、ask 前钉住、活 turn 折叠、发射、路由）、`tests/streaming.spec.ts`（pin、fold、合并显示、setAnalysisTextIfEmpty 守卫、截断兜底、降级惰性）、`tests/feishu/card-action.spec.ts`（fw_multi intake 与冻结）、`tests/agent-dsh/adapter-persona.spec.ts`（提示词逐字钉）钉住。
