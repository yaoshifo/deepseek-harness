# Agent Note: Followups card registrations survive daemon restarts

Status: implemented

[English](2026-09-09-feishu-bridge-followups-meta-persistence.md) | 中文

## Problem

收尾追问卡的选项全文只存在平台的内存 `askqMetaCache` 里——发卡时写入、提交时消费。两者之间任何一次 daemon 重启都会清掉这层映射，提交随之降级为只报序号的 `followups_stale` 提示——agent 只能从自己的上下文重建选项、多烧一轮确认（2026-09-09 oc_8451188a：卡 09-08 18:43 发出，18.4 小时窗口内五次重启，13:09 的提交落在缓存已空的一代 daemon 上；journal 签名 `followups card callback without cached meta`）。线路载荷带不了全文：form_submit 回调丢弃 `action.value`，只返回勾选的 checker 序号。

## Decision

followups 注册持久化到按项目的 sidecar（`<dataDir>/sessions/<project>_followups_meta.json`，`feishu/followups-meta.ts` 的 `FollowupsMetaStore`），平台 init 时播种进 `askqMetaCache`。只存 `followups: true` 条目：重启后引擎的 ask 状态不存活、没有任何 askq 卡的消费者，followups 提交是唯一的重启后消费者。store 镜像缓存的单槽语义——followups 卡的发送写自己的条目、其他问句卡接管同一 session key 即删除、提交即消费——重启因此无法复活被新卡顶掉或已被提交作答的条目。变更在内部尾队列上串行后再做原子 rename：背靠背的两张卡一次 set 一次 delete，若两个 `atomicWriteFile` rename 各自独立竞速，可能把被顶掉的条目留在盘上（键覆盖测试抓住的正是这个落盘乱序）。写入时的七天留存清扫把文件规模限制在 spawned 群的增速之内。

## Alternatives considered

**把全部 askq meta 一起持久化，而非只存 followups。** 否决：ask 卡在重启后没有消费者——引擎的 ask 状态纯内存、随进程消失——多存的条目换不来任何东西。

**stale 回调时从飞书侧卡片找回全文。** 否决：为罕见路径加一次消息拉取加卡片 JSON 解析，而发送路径在写入时刻就已握有 store 需要的全部信息。

**改经引擎的 `pendingFollowups` 持久化，不走平台。** 否决：那份登记管的是卡片发射，全文的消费者却是平台的回调路径；耦合两者只增加一次跨层查找，没有收益。

## Consequences

重启前发出的卡，其提交现在派发完整可读的选择消息并冻结卡片，与缓存常温的情形无异。代价：每个项目一个小 JSON sidecar，由留存清扫限界——超过一周的旧卡仍降级为 stale 提示；发送路径的 fire-and-forget 写在崩溃瞬间的丢失也只剩同样的降级，不会比修复前更糟。stale 路径本身保留，覆盖键被顶、窗口外旧卡、写丢失三种情形。由 `tests/feishu/card-action.spec.ts`（重启后带全标签的派发与冻结、已消费注册不复活、askq 顶键删条目）与 `tests/feishu/followups-meta.spec.ts`（留存清扫、同键替换）钉住。延伸自[收尾卡选择消息](../architecture/2026-09-07-feishu-bridge-followups-selection-message.zh.md)与[收尾卡转换](../architecture/2026-09-02-feishu-bridge-closing-card-followups-conversion.zh.md)。
