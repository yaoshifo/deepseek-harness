# Agent Note: chatroom 中途参与——插话提示、轮间同步、插话处理

Status: implemented

[English](2026-09-02-feishu-bridge-chatroom-midrun-participation.md) | 中文

## Problem

research 模式（`--research`，auto）曾是参与死区。dev 服务器一场会话（2026-08-30/31，hub `oc_2edeb9831b39b7d855bb93b67a873358`，北京房价，5 角色 × 3 轮，22:24–03:08）全程只有一次用户交互——角色卡确认——之后 4.5 小时零人类消息；03:07 发出的收尾 `ask_user_question` 无人应答，房间从未收尾。三个缺口，没有一个是引擎能力问题：

- 插话不可发现：hub 普通消息一直能作为正常用户回合唤醒主持人，但没有任何卡片、命令或提示词说明这一点。
- research priming 没有插话处理条款——普通模式的「人类发言时，把它融入讨论」在 research 侧没有对应物，用户中途发言时主持人没有处理指引。
- auto 模式轮间静默是设计使然：priming 把迭代判断完全交给主持人；manual 模式每轮问用户，auto 模式什么都不问。

## Decision

三处文本级新增；不改引擎、工具 schema、事件。

- **插话提示上用户真正会看的两张卡**（新 i18n 键 `chatroom_interject_hint`，en/zh）：hub 就绪汇总卡（账本行旁，`afterChatroomStarted`）与 research 进度卡 live 状态的正文（`buildResearchProgressCard`，仅 live——终态保持各自文案）。
- **auto 模式轮间同步**（research priming，auto 分支）：每轮综合写入账本后，用一条普通回复向用户同步——图景一句话加下一轮深挖什么；不用卡片、不等回复、不暂停。manual 模式已有每轮询问卡，故不加同步条款。
- **插话处理**（research priming，两模式共享）：用户中途发言并入编排——追问经 `ask` 转给相关角色，新信息与方向调整并入下一轮 gather 任务；不无视，也不中断在途轮次。

## Alternatives considered

**收尾卡超时兜底（本轮最初的 P1a）**：把 research-manual 的 10 分钟整卡自动默认（`armResearchManualAskTimeout`）也武装到 auto 模式 hub，给四选项菜单设默认。所有者评审后否决：所有者点卡作答、也知道自由文本会变成卡片答案，误路由论据撤回；且两个默认选项都不清理任何东西——桥完全没有解散群 API（全仓无 `im/v1/chats` DELETE 调用），`end` 之后同样十个角色/助手群原地保留、只是灰掉。剩余价值（daemon 重启杀死挂起 ask、过期卡提示误导）撑不起改动；两个事实改记入 README 限制条目。

**轮内 steer 或 pause**：gather 在途时主持人的回合已结束（工具结果里写明），轮内无人能对 steer 动作；且武装中的 gather 里串行 `ask` 有交错坑——busy 角色的回复不 relay（gate 已消费）、idle 角色的回复被吞作该角色的 gather 回复。轮次边界是唯一安全的参与点。

## Consequences

- auto 模式仍是「静默或点卡」收尾：收尾卡无限等待、重启即死、角色/助手群累积——均已写入 README 新的 Known Limitations 条目。
- 轮间同步为 auto 模式每轮增加一条主持人消息；提示行挂在本来就有的卡上，消息量变化有界。
- chatroom 面的 keyless 录制会话快照仍被阻塞（语料库零 chatroom 用例；自 2026-08-31 scan3 轮沿袭）。行为由四条新 spec 钉住：进度卡提示（仅 live）、就绪卡提示（含账本行）、auto 独有的同步条款、两模式的插话条款。
- 计划与 README 中在案的跟进项：桥的解散群能力（群累积的根因）、闲置房间回收、`askq_stale_question` 文案对重启死卡的误导、ask-during-gather 交错、缺失的重复 gather 守卫、60 分钟默认 research 超时（dev 那场在反爬限流下轮轮命中）。
