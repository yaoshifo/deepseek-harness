# Agent Note：chatroom 提问身份路由——回复按身份路由，不再靠门推断

Status: implemented

[English](2026-09-06-chatroom-ask-identity-routing.md) | 中文

## Problem

转发机制靠推断回答「这个回复属于哪次提问」：一个一次性门（`chatroomAsked`，提问时武装、首个回合结束消费）加一个 gather 序号戳做过期检测。三起事故同根：2026-09-02 oc_e51a，被延迟的研究结论回合把已武装的 gather 搁浅到研究超时；stale 守卫本身——只有已武装 gather 的序号错配可检测，串行追问（askSeq 0）不可见；2026-09-06 oc_97be4a1c（与唤醒链冻结同一场运行）：第 3 轮 gather 超时后主持人在 09:55 串行追问 marks，marks 仍在跑的轮次回合 09:56 结束时消费了重臂的门，串行提问自己的作答回合撞上已消费门的早退、整条被丢——内容幸存只因 marks 同时把名单写进了文件。另有两缺口：串行提问没有任何 deadline（冻结事故在普通聊天室的对应物——角色静默挂死则房间永久停滞）；重启后未决串行提问对恢复不可见，而 `endChatroom` 只能靠不持久化的旗标猜在飞状态。

## Decision

- **每次 ask 铸身份**，来自 hub 共享 `chatroomGatherSeq` 计数器——gather 轮与串行提问共用一个 id 空间。id 随回合消息元数据下发，回合开始时盖到会话上（复用既有盖章钩子）。
- **串行提问登记持久条目**（`pendingSerialAsks`，按角色名索引：`{ id, question, armedAt, lastWakeAt, wakeCount }`），经 codec 持久化，键随条目走。
- **回合结束按身份路由**：戳命中已武装 gather → 扇入（已武装 end barrier 先于一切接住带戳回合）；戳命中该角色未决串行条目 → 转发+唤醒主持人+条目完成；戳不在任何未决集 → 超时/被取代回合——按自由发言转发（卡+落账），不消费门、不清在飞位（新 ask 拥有它）。
- **一次性门保留为 answered 闩。** 无元数据唤醒（助手汇报开启延迟结论回合）继承已持久化的身份；把这类回合的戳重置为 0 会搁浅延迟研究轮——既有「zero metadata keeps the round」测试钉住这一点。门不再是关联机制，只是完成位。
- **取代规则**：新 gather 轮退役全部串行条目（其回合自由转发而非被吸收为轮答案）；同角色重复串行提问替换其条目；gather 期间的 steer 归属武装中的轮次——盖轮 seq、其回复计为轮回复（不新铸身份）；对空闲角色的 steer 直接铸造并直接盖戳，因为 steer 永不开新回合。
- **监督网新增第二类关系**——未决串行条目——沿用三层纪律（证据门含 `researchAwaitingAssistant` 门控的助手等待、角色有机活动钟 `roleActivityAt`、每窗口一条熔断通知）。普通聊天室第一次有了 deadline；`assistantStallSec` 现在管辖全部受监督关系。
- **重启恢复退役恢复出的条目**，每条一次有界唤醒（「重问或推进」），与 barrier 恢复对称——永不等一个回合已死的回复。恢复时退役也让 `endChatroom` 不会透过描述死工作的条目去排水死回合。
- **研究进度卡成为屏障状态的唯一投影**：60s 心跳 PATCH 活动卡（等待中角色+已进行分钟数）；活动更新经 2s 合并窗合并；终态绕过合并窗立即落地；`startedAt` 随屏障快照持久化。
- **RECORD.md 超 64KB 按行边界轮转**进 `RECORD-<n>.md` 归档（归档先写——崩溃窗口宁可重复进下一号归档也不丢数据），账本读指令把角色指向尾部+归档。

## Alternatives considered

- **每角色 epoch 计数**（第一版设计）：仍是叠在门上的版本推断补丁；设计评审中因 steer 与串行重问各需专门豁免而放弃。
- **退役门做纯注册表路由**：无元数据唤醒回合没有可路由的身份；延迟研究流要求继承持久身份。门留作闩，注册表管关联。
- **armed timer 做串行 deadline**：重启脆弱，违背监督网的电平触发设计（「没有会随重启丢失的 armed timer」）。
- **gather 超时停掉缺失角色的回合**：毁掉深度研究工作；晚到回复的自由转发保住它。
- **提示词级「别追问忙碌角色」**：劝导性；散文承诺恰是冻结事故的失败点。

## Consequences

- 测试钉住整张路由表（非提问静默、扇入、串行完成、自由转发）、2026-09-06 复现端到端（两份回复都送达）、gather 期间 steer 的轮归因、gather 取代串行、条目完成后的后续静默、条目持久化与重启退役有界唤醒、监督网全部证据门与熔断、心跳/合并/终态直通的卡片行为。
- 相对 Go 对等性披露的行为变化：steer 回复现在经轮身份计为轮回复（旧注释的经门重臂吸收被替换）；gather 取代未决串行提问时晚到回复按自由发言转发而非吸收为轮答案；被取代回合不再清 `chatroomInFlight`。
- 已知行为：同角色首回合开跑前连续两次 queue 型串行提问——第一份回复按自由发言转发（内容不丢，形态不同）。
- `endChatroom` 排水检测与 gather 超时状态文本仍读在飞状态；取代规则保证该状态由最新 ask 拥有。
- 部署：bridge 重建 + `/reload`；journal 验证行是 `chatroom: supervisor woke stalled moderator about serial ask`、`chatroom: retired restored serial ask after restart`，以及活动研究卡的心跳 PATCH 节奏。
