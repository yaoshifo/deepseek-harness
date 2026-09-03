# Agent Note: /chatroom 引导式启动流（开始方式卡与模式卡）

Status: implemented

[English](2026-09-03-chatroom-guided-start-flow.md) | 中文

## Problem

`/chatroom` 的参数形态膨胀到九种（两个子命令、五个 flag、两个位置槽），且有用的那些完全不可见：`--continue`、`--research`、`--mode` 只能靠打字输入，不读源码或用法文本的用户无从发现研究模式与前情延续，而用法文本本身还落后于实现（列了四种形态，实际存在五个 flag 与两个子命令）。#43 角色选择卡与 #59 话题推荐卡早已确立了引导模式——用户没说的都变成卡片——但被引导的只有话题和角色。

## Decision

在选择卡家族中新增两张卡；flag 保留为高级覆盖，**用户未显式给出的每个决策都有对应的卡**（显式给出的 flag 跳过其卡）。

- **开始方式卡**（`/chatroom-start-pick`，`ChatroomStartPickState`）：裸敲 `/chatroom` 且 `moderatorDir/ledgers` 下有历史聊天室时，列出最近五场（议题、阵容、开始日期）加一行 新讨论——直接动作按钮，各一次点选，不唤醒主持人。无历史 → 直接进现有 #59 话题推荐卡（原行为）。点 继续 时先复核账本 header（已删除 → 灰色失效卡），然后：空前情阵容 → #43 角色选择卡（与显式路径一致——前情被丢弃，记入 README 局限）；研究标志已 stash（显式 `--research`）→ 立即启动；否则带前情与其阵容武装模式卡。
- **模式卡**（`/chatroom-mode-pick`，`ChatroomModePickState`）：普通讨论 / 研究·自动 / 研究·手动 三行回显议题、阵容与前情注记；每个按钮直接启动——普通模式 stash 清洗，研究模式 stash 各自标志并先过共享 uv venv 门禁（失败 → 红色需 uv 卡，不 spawn）。多角色启动在即且 `chatroomResearch === false` 的每个入口都武装它：角色选择卡 confirm、显式 `/chatroom <角色> <议题>` 路径、引导式继续。单角色 confirm 保持 1:1 直聊路径（没有主持人就没有研究），显式 stash 的 `--research` 立即启动。
- **裸 `--continue` 放宽**：不带话题的 `/chatroom --continue` 现在解析最新前情并沿用其记录话题（此前是 usage 错误）——延续天然有主题；无账本仍以需要账本消息 fail loud。
- 用法文本重写（中英）：以三种引导形态开头，flag 降级为高级行——顺带修复 `--research`/`--mode`/`--max-rounds`/`list`/`stop` 从未出现在用法里的既有滞后。

只动引擎接缝：两条 `registerCardAction` 路径、两张与既有选择卡并列的 picker 映射，不改工具 schema、会话事件、持久化或主持人 priming。`--max-rounds` 刻意保留为 flag 加配置默认值（自动模式行的 blurb 写明上限）——数字选项塞不进三行卡片。

## Alternatives considered

**彻底删除 flag**：脚本与肌肉记忆失去快捷路径；保留它们没有成本——卡片只问用户没说的。

**只引导裸调用**（显式 `/chatroom a,b topic` 保持立即启动）：研究模式对会打显式命令的用户恰好仍不可发现；模式卡一次点选兼作回显议题与阵容的最终确认。

**把继续行并进 #59 话题卡**：话题卡由 LLM 供数（`pick-topic` 到达时覆写 `recs`），预置的历史行会被主持人迟到的提交冲掉；单独的即时卡让 LLM 契约原封不动。

**单选 + 确认两段式**：这里的每个选择都可恢复（每张卡有取消，启动后有 `/chatroom stop`），直接动作行把点选减半——这正是本次改动的目的。

## Consequences

- 有历史时裸敲 `/chatroom` 的引导链最多四张卡（开始 → 话题 → 角色 → 模式），各一次点选，且随调用越来越显式而自然缩短。
- 研究模式 venv 预置在引导路径上从命令时移到模式卡点选时（过渡卡 正在准备研究环境，然后启动或红色错误）；显式 `--research` 路径保持命令时门禁。
- 引导式继续原样沿用前情阵容；要调整就显式点名角色——与空前情阵容丢弃一起记入包 README 的 Known Limitations。
- 行为由新的 `engine-chatroom-guided.spec.ts` 钉住（18 个用例：卡片武装、全部启动动作、venv 失败、取消、孤儿卡、无历史回退、空阵容回退、`--research` 跳过、裸 `--continue`）与更新的存量用例——后者经共享的 `confirmChatroomModePlain` 点选助手完成普通启动。chatroom 面的 keyless 录制会话快照仍无人认领（语料零 chatroom 用例，自 2026-08-31 scan3 轮结转）。

## Related

- [Picker 状态在内存](../../../../packages/acp/feishu-bridge-chatroom/README.zh.md)——新卡共享孤儿卡灰换行为与重启暴露。
- [chatroom research 去重](2026-09-02-chatroom-research-data-dedup.zh.md) 与 [research 数据可靠性](2026-08-27-feishu-bridge-research-data-reliability.zh.md) 拥有模式卡所选入的研究流。
- [跨聊天室共享](../architecture/2026-09-03-feishu-bridge-chatroom-cross-sharing.zh.md) 拥有开始方式卡所列举、继续路径所解析的账本/inherit 机制。
