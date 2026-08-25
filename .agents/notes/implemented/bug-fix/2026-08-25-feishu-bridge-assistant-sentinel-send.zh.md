# Agent Note: research 角色用 "assistant" 哨兵指代预配助手，不再转写 key

Status: implemented

[English](2026-08-25-feishu-bridge-assistant-sentinel-send.md) | 中文

## Problem

事故 2026-08-25（chat oc_ac5db，聊天室「人生重大决策的防错机制」）：marks 角色无法使用其预配研究助手群，同聊天室其他四个角色均正常。会话日志取证：系统提示中的助手完整 session key 无误，但模型把它转写进 `feishu_bridge_subtask` send 参数时丢了 5 个字符（其思考轨迹显示先错抄两次、然后沿用了错抄版本）。引擎侧两个缺陷把这次转写失误放大成一场误导性故障：

- `sendToSubtask` 用 `getOrCreateActive` 校验 child——**创建性**查找。错 key 查不到，现场造出一个无 parent 的影子会话（注册表 s228，创建时间与失败调用仅差 6 毫秒），影子的空 parent 链随后被误报为「目标群不是当前会话派发的子任务」——这个报错把用户和排查都带偏了方向，还留下一条永久的注册表污染。
- research moderator priming 仍让角色用 `$CC_RESEARCH_ASSISTANT_CHILD`——dsh 后端不存在的 Go 时代 env 注入。模型找不到「注入的环境变量」，转而从对话记忆重构 key——恰是转写出错的路径。

## Decision

- **哨兵寻址。** `sendToSubtask` 把 `child: "assistant"` 在服务端解析为调用者会话的 `researchAssistantKey`；research 角色契约与 moderator priming 改为指示哨兵，不再内联 40+ 字符的十六进制 key。模型不再转写 key，也就无从抄错。persona 的内联 key 注入链（`researchAssistantChild` 经 `ChatroomOptions` → adapter → persona 构建）作为死代码删除；会话注册表的 `researchAssistantKey` 仍是解析源。
- **非创建性 child 查找。** group 路径校验改用 `findActive`；未知 child key 大声失败：「no subtask session <key> — the key may be mistyped; copy it verbatim, or use "assistant"」，不再造影子会话、不再误报归属。
- **清除陈旧说辞。** priming 中的 `$CC_RESEARCH_ASSISTANT_CHILD` 提及删除；spawn 兜底路径的答复里仍会拿到真实 key，后续追问原样复制。

## Alternatives considered

**key 格式校验（feishu key 形状正则）。** 弃用：格式合法但内容错误的 key 依然过不了归属校验，而哨兵是从根上消灭这个失败类，不是检测它。

**保留内联 key 并加「仔细复制」指示。** 弃用：指示修不了转写；另外四个角色抄对是运气不是纪律。

## Consequences

抄错的 child key 现在产生一条清晰报错、零副作用。research 角色对预配助手完全不需要 key。spawn 兜底路径（预配失败→角色自建子任务）保持原样复制 key 的语义。部署清理（一次性、手动）：从开发虾项目的 sessions.json 删除影子会话 s228 及其假 `feishu:oc_a39d75653b9c335f4c4cad3f47a` activeSession 条目——注意与真 key 差 5 个字符。

## Testing

`engine-subtask.spec.ts`：未知 key 的 send 以 mistyped-key 报错拒绝且不新建会话（数量断言）；哨兵解析 `researchAssistantKey` 并投递；未预配的调用者被引导先 spawn。`chatroom-persona.spec.ts` 钉住 research 契约中的 `child: "assistant"`。`engine-chatroom-gather.spec.ts` 钉住哨兵措辞与 env 提及的缺失。engine + adapter + assembly 全量套件（1480 测试）与仓库 typecheck 通过。
