# Agent Note: chatroom 屏障结算移到失败发生点，不再等超时

Status: implemented

[English](2026-08-31-feishu-bridge-chatroom-barrier-failure-settlement.md) | 中文

## Problem

chatroom 的屏障机制在正常路径上是正确的，但失败分支留下的状态只能靠超时收场，且两个守卫是单向的。gather 广播对某个角色失败时，该角色留在 `expected` 里，屏障空等完整 gather 超时（普通 20 分钟、research 60 分钟），进度卡冻结、主持人毫无反馈。spawn 半途失败会把已建的角色群变孤儿：hub 还没有 `chatroomModerator` 标记，`resolveChatroomHubKey` 连 hub 自己都解析不出来，`/chatroom stop` 只能答"不在聊天室"。ask 卡片发送失败时 `chatroomInFlight` 仍然武装着，`endChatroom` 的 Phase A 据此为一个永不到来的回复安装 drain 屏障，烧掉整个 drain 超时。end 屏障的 relay 卡是 fire-and-forget，收尾唤醒可能压到角色的末轮 relay 卡之上，违反 gather 路径已明确执行的「relay 卡先于占位卡落位」契约。`askHuman` 在 gather 进行中会拒绝，但 `gatherRoles` 在人类提问挂起时不拒绝——交错时同一角色被注入第二个在途 ask，其 turn-end 消费掉一次性 relay 门，角色对人类答复的后续回复在 `:1004` 的静默 return 处整体丢失。`end`/`force` 工具动作把调用者的 session key 直接当 hub key，角色 persona 能从自己的群里终结聊天室（杀死自己的子树、遗弃自己的研究助手、让真 hub 的 gather 空等超时）。在存活角色群之上重复开室会叠代角色群、persona 标记混叠；gather summary 全文内联每条回复且无上限，任意大的唤醒文本直进主持人上下文。

## Decision

结算现在发生在失败发生的地方，超时重新只是兜底。`gatherRoles` 在 `pendingHumanQuestionRole` 非空时拒绝，镜像 `askHuman` 的 gather 守卫；`routePendingHumanReply` 在 gather 武装时落回 hub 的正常 agent 路径——用户确实答复了，所以清掉过期的 ask 标志而不是留着它把后续无关消息路由进死 ask（与既有 stale-flag 落回先例对称）。gather 广播失败调 `forgetFailed` 把该角色移出 `expected`；`expected` 清空即立即完成屏障——选移除而非按空回复 accumulate，因为角色从未收到问题，NO_REPLY（主动弃权）语义不符。`startChatroom` 在 spawn 循环之前设 `chatroomModerator`，半途失败后 hub 从任何入口都可停止。`askRoleInternal` 发送抛出时清 in-flight 标志，`end` 不再为死回复武装 drain 屏障。end 屏障先 await relay 卡再唤醒，与 gather 路径一致。`end`/`force` 先用 `resolveChatroomHubKey` 解析调用者归属的 hub，非 moderator hub 的调用者拒绝（`chatroom_end_moderator_only`）——角色 persona 无法再冒充 hub。存活角色群存在时拒绝再开室（`chatroom_already_running`）。gather summary 每条回复截断 200 rune，与 end 屏障共用 `clipRunes`。

## Alternatives considered

**把广播失败按空回复 accumulate。** 否决：角色从未见到问题；NO_REPLY 语义属于主动选择沉默的角色。

**在 catch 块里回收半途已建的角色群。** 否决：逐角色 cleanup 加状态复位比 spawn 前设 moderator 标记的 diff 大得多，且标记让所有入口都能停室，不只失败路径。

**research 轮用更大的独立截断（600 rune）。** 否决：research 标志要穿过屏障构造器与持久化快照；完整回复本来就活在账本和 relay 卡上。

## Consequences

交错守卫现在对称（挂起人类提问阻止 gather；gather 进行中人类回复走 hub 转述）；`end` 仅 moderator 可调，包括收尾后的二次 end——原先的伪成功现在报错；唤醒摘要是模型可见的截断文本。已知上限：gather 进行中到达的主持人答复在 gather 结束后才被转述，而不是中途注入——这是"一个角色永不同时挂两个在途 ask"的代价。

## Testing

`tests/engine/engine-chatroom-gather.spec.ts`：人类提问挂起时 gather 被拒；挂起回复的落回路径；单角色广播失败后其余回复照常唤醒、全失败立即完成；超长回复截断 200 rune。`tests/engine/engine-chatroom-end.spec.ts`：收尾唤醒只在末轮 relay 卡之后落位；存活角色群存在时二次开室被拒。`tests/engine/engine-chatroom.spec.ts`：spawn 半途失败后 hub 可停止、孤儿群可回收；ask 发送失败清 in-flight 标志使 `end` 立即结算。`tests/tools/chatroom-tool.spec.ts`：角色会话不能调 `end`/`force`；moderator 路径照常。
