# Agent Note: chatroom 主持→角色回合消息的每轮人设再锚定

Status: implemented

[English](2026-09-03-feishu-bridge-chatroom-persona-turn-anchor.md) | 中文

## Problem

聊天室角色的人设在会话创建/resume 时一次性注入为完整的 system prompt 替换——一段稳定的、KV-cache 友好的前缀。2026-09-03 oc_e51a 研究场次（小米研究作战室，graham+marks，8.5 小时）暴露了长会话下的衰减：逐回合会话日志分析显示全场 0 口头反射、0 历史类比、0 身份锚点，约半数角色输出是裸研究运营腔（「台账已登记」「派手」「归队」语域），数据核验轮签名术语密度归零。语域牵引来自主持人自己的任务消息——第 1 轮之后每轮提示都是研究运营措辞，而没有任何机制重新锚定人设。人设文本本身不是瓶颈（声音资产在人设文件里，且 books 侧 embodiment @import 修复后已随前缀加载）；缺的是每轮触达、对抗语域牵引的人设表面。

## Decision

`askRoleInternal`——串行 `ask`、普通 `gather` 广播、研究 gather 三路共用的唯一拼装点——在问题（及账本指针）之后追加一行固定的人设再锚定，使其成为消息里最新的指令：从 `chatroom-persona.ts` 导出的 `chatroomRoleAnchorPrompt()`（「以你的人设作答——用你的签名框架与声口，别让研究运营腔替你说话。」）。选引擎侧锚定而非提示词侧，使三种回合类型都确定性携带锚定，不依赖主持人 LLM 的自觉，且稳定的 system prompt 前缀保持不动。

## Alternatives considered

**在主持人 priming 里教它把锚定写进问题文本**——零引擎改动。否决：执行点恰是主持人 LLM 本身，而 oc_e51a 证据表明第 1 轮后漂移进运营语域的正是主持人；锚定措辞会不一致并最终被丢掉。

**会话中途向 system prompt 重注册人设摘要**——信号位置最强。否决：人设段是会话启动时注册的 `complete: true` section，中途重注册会使稳定前缀失效（KV-cache 失效），且回合中途没有自然触发点；回合消息才是每轮真正触达角色的表面。

**引擎保持沉默，只靠人设文件**——books 侧修复（embodiment/MAP 进 @import 链、声音段加载）交付了声音资产，但一次性注入在 8 小时运营语域回合下仍会衰减成远端弱信号；每轮锚定是文件自身无法提供的对冲。

## Consequences

收益：每条主持→角色回合消息都重申人设锚定，长研究会话中人设声口保持可触达，且不动稳定前缀。代价：每条角色回合消息多一行短固定文本——加长的是消息历史而非人设前缀（README token-effect 段已注明）。活体验证信号（下次聊天室场）：声音三件套（历史类比/口头反射/身份锚点）出现，且数据核验轮不再出现签名密度归零。

## Testing

`tests/engine/engine-chatroom-gather.spec.ts`「role-turn persona anchor」：串行 ask 在注入的角色回合里带上锚定行；gather 广播在每个角色的回合上带同一锚定。包套件全绿，除既有的 steward 时序 flake（已用 stash 干净基线对照验证同样失败）。
