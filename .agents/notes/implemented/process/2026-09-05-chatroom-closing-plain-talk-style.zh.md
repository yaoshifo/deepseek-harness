# Agent Note：chatroom 收尾产物从费曼类比改为白话直讲

Status: implemented

[English](2026-09-05-chatroom-closing-plain-talk-style.md) | 中文

## Problem

两份主持人 priming（普通与 research）此前都要求收尾 HTML brief 与收尾文字总结以生活类比开场（「这件事就像……」）——费曼式框架。读者实测反馈表明，类比增加的映射负担大于它卸掉的：读者要先理解类比场景，再把类比元素映射回讨论本身，内容才开始落地。收尾产物的目的是快速交出完整图景；类比层把第一屏花在了绕道上。

## Decision

`chatroom-priming.ts` 中的收尾 HTML brief 与文字总结改为白话直讲：直接讲事情本身（讨论解决了什么问题、主要判断、各方倾向哪里、诚实分歧在哪），把术语就地展开成大白话，用讨论里真实的具体事实和数字做支撑。层 2 的「最小例子（日常场景）」改为「最小实例——用讨论里真实的具体事实、数字或场景落地」，实例只能长在材料本身上。表述全部正向——不加「不要用类比」式否定禁令——因为正向的实例来源规则已让类比无处生根。类比周边的结构资产保留：分层展开/折叠、2-3 个门槛点、⚠ 反直觉标注、分歧清单、折叠原始细节的保真底线。学术版 brief 不动。

风格定义为何内联而不引用用户级 `~/.dsh/AGENTS.md` 的回复偏好：主持人与角色会话是 bare-persona 会话，其 setup 替换整个系统提示并调用 `agentInstructions.suppress()`（Go `--bare` 对齐；见 [session-start-options](2026-08-24-feishu-bridge-session-start-options.md) 与 [render-fork-suppresses-instructions](2026-08-26-render-fork-suppresses-instructions.md)），全局规则到不了主持人。brief 同时是 HTML 渲染子任务的任务书；内联让风格在真正起作用的路径上保持权威。

## Alternatives considered

**按引用复用用户级白话直讲规则。** 否决：bare-persona 抑制意味着主持人根本看不到它（规划期间已对照 adapter 抑制路径核实）。

**保留类比作为可选开场并加「不要过度」。** 否决：否定式提示会把注意力引回被禁概念，且类比一旦使用仍要花掉第一屏。

## Consequences

收尾总结与 summary.html 直接以判断本身开场；读者不再经过类比层转译。两份 priming 与 gather spec 现在断言 `白话直讲版` / `直接讲事情本身` / `最小实例` 并禁 `费曼` / `生活类比`。cc-connect（这些文本的 Go 来源）已停止维护、未同步，两棵树在此决策上有意分叉。
