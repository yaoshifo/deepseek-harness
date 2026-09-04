# Agent Note：/done 会中断仍在运行的聊天室

Status: implemented

[English](2026-09-04-done-interrupts-live-chatroom.md) | 中文

## Problem

主持人还没 `end` 的聊天室 hub 里发 `/done`，会在拆掉会话的同时把房间的 feature 状态留在原地：`cmdDone`（`dsh-feishu-bridge` `src/engine/commands.ts`）停 agent 会话、处理 worktree，但没有任何路径调用 `finalizeChatroomEnd`——唯一会摘掉 hub 的 `chatroomModerator` 标志与角色 `chatroomHubKey` 绑定的地方。残留后果：hub 的下一条消息顶着主持人 persona 在已拆空的房间上开局（`chatroom-policy.ts` `decorateSessionStartOptions`），武装中的 gather 保持武装、其 timer 稍后把幻影主持人唤醒去问死掉的角色，台账永远写不上结束行。这正是 `interruptChatroom`（`/chatroom stop`）要解决的弃室死锁类问题，只是又多了一条用户命令能到达。发现自 2026-09-04 一次生产问答（oc_39a120a7900266692ebd685d84cce027）——该房间事先已正常收尾，接缝是潜伏的、未被踩中。

## Decision

bridge 在 `cmdDone` 入口（`--reply` 处理与 Done reaction 之后、子树拆解之前）分发新的 `feishuBridge/pre-done` 瀑布事件，payload 为 `{ engine, sessionKey, handled: string[] }`。在子树下持有状态的 feature 插件在此清理；listener 塞进 `handled` 的 descendant key 会被 bridge 自己的后代循环跳过（root chat 永远归 bridge 清理，递归摘要只统计 bridge 亲自清理的数量）。事件走既有的 `feishuBridge/*` declaration-merged `Events` 接口，依赖方向不变：chatroom 插件引用 bridge 的导出面，反向永不发生。

chatroom 一侧是一条 policy listener：被 `/done` 的会话带 `chatroomModerator`（start 时置位、仅 `finalizeChatroomEnd` 清除、持久化——为 true 即未收尾，同时覆盖武装中的 gather、end barrier 与挂起的 human question）时，调用 `interruptChatroom` 并把返回的 `cleanedKeys` 推进 `handled`。`finalizeChatroomEnd` 的返回值从计数改为清理过的 session key 列表（调用方取 `.length`），使分类遍历成为「/done 必须跳过什么」的唯一事实来源——bridge 循环因此不会对角色群重跑 `cleanupOneChat`（无双重 worktree 处理、无重复脏摘要）。interrupt 失败（无 spawn 能力平台）被捕获、告警、不标记 handled：普通拆解照常进行，退化为旧行为而不是 fire-and-forget 命令路径里的未处理 rejection。已收尾的 hub（标志已落）原样落穿——普通 `/done` 语义分毫不差。

角色/助手群里发 `/done` 维持现有语义（房间级逃生口仍是 `/chatroom stop`，任意成员群可用），direct-role 1:1 会话不是 hub——两者按设计不在范围内。

## Alternatives considered

- **在 `cmdDone` 里检测活跃聊天室。** 否决：`chatroomModerator` 活在 chatroom 插件不透明的 `featureState` 段里；bridge 去读会破坏包接缝（`session.ts` 刻意让该段对 bridge 不透明）。
- **跳过 chatroom 插件的清理、全交给 `/done` 的循环。** 否决：barrier 需要 `interruptChatroom` 的消费语义（停 timer、不唤醒），且没有跳过清单时 bridge 会与 `finalizeChatroomEnd` 的 fire-and-forget 调用并发地对角色群重跑 `cleanupOneChat`——双重 worktree 处理与重复脏摘要。
- **在 hub 下一条消息时惰性清理（turn 开始时检测标志）。** 否决：启发式（得从角色会话猜存活）、武装中的 gather timer 会活到触发为止、台账保持未收尾。

## Testing

`dsh-feishu-bridge` `tests/engine/done-prehook.spec.ts`：分发 payload 契约、handled 跳过（被认领的子群不再有 done 标记与头像涂色，其余与 root 照常清理）、无监听者回归（bare fallback——所有后代照常清理、摘要不变）。`dsh-feishu-bridge-chatroom` `tests/engine/engine-chatroom-done.spec.ts`：在武装着两个角色的 hub 上经 `dispatchCommand`（挂真实 policy listener，`chatroomPolicyFace`）发 `/done`——moderator 标志落下、gather 被消费、无唤醒、中断卡发出、台账写入已中断行、每个角色的清理恰好跑一次（跳过可观察地阻止了第二遍）——以及已收尾 hub 的落穿。Loader 层组合覆盖仍由既有 `loader-composition.spec.ts` 启动承担（两插件齐挂）。无快照更新：没有模型可见面变化；用户可见差异（中断卡取代「沉默加残留」）由 spec 覆盖。

## Consequences

代价：活跃聊天室 hub 上的 `/done` 不再是纯 bridge 操作——其用户可见结果取决于 chatroom 插件是否挂载（本 profile 恒挂载，但裸 bridge 组合会得到旧的残留行为），且 `finalizeChatroomEnd` 返回类型从计数改为清理 key 列表，触达所有调用方。买到的东西：`/done`、`end`、`/chatroom stop` 三条路径收敛到同一个拆解面，任何用户命令都无法再把房间留成「死子树上的 persona 标志加武装 barrier」；台账必然到达终态行；而 `feishuBridge/pre-done` 接缝是通用的 feature 拆解钩子——下一个在子树下持有状态的 sibling 插件（monitor、relay）可以用同一方式认领自己的清理，无需再改 bridge。
