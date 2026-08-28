# Agent Note: feishu-bridge 撤回联动取消暂存附件

Status: implemented

[English](2026-08-28-feishu-bridge-recall-staged-attachments.md) | 中文

## 问题

飞书撤回消息（`im.message.recalled_v1`）此前只到达 `cancelQueuedByMessageID`：取消排队的**文本**消息（其附件随队列条目一起取消）并汇报 inflight。纯附件消息不进队列——`stageAttachments`（#8）把文件落盘到 `.feishu-bridge/pending/<hash>/`，按消息 id 记入 `InteractiveState.pendingAttachments`。因此撤回一个上传的文件后暂存原样保留：文件留在磁盘上，下一条文本 prompt 仍会把已撤回文件的路径拼进模型可见的 bullet 列表。移植时 recall.ts 头注释声称「附件随排队消息一起走」，这只对文本+附件消息成立——Go 的 staged-attachment 撤回分支是真实缺口，并非不适用。

## 决策

`cancelStagedAttachmentsByMessageID`（src/engine/recall.ts）是纯附件的撤回分支，在 `Engine.start` 里与队列取消并列接进同一个 `setRecallHandler` 回调。命中时：删除该消息 id 的 `pendingAttachments` 条目、删除对应缓存文件（`rm --force`，fire-and-forget + 警告，形状同 `discardStagedAttachments`）、当不再剩任何暂存条目时移除 pending 目录并清空 `state.pendingDir`，并回复 `attachments_cancelled_by_recall`——列出被撤回的文件名与剩余的图片/文件计数。两个分支天然不相交——纯附件消息走暂存、文本消息走队列——所以回调无条件依次执行两者，顺序无关。

仍被存活暂存条目引用的路径不删除——删除侧在这个破坏性边界上保持防御。曾使路径别名成为可能的同名冲突（不同消息上传同名文件在共享 pending 目录里互相覆盖字节）已由 src/engine/attachments.ts 的 `uniquePathIn` 修复：`saveImagesToDir`/`saveFilesToDir` 在名字被占用时于扩展名前加 `(n)` 后缀，每个暂存上传保留自己的字节。

`attachments_staged` 通知尾句改为「发送 /new 可取消，或直接撤回该消息」，让该能力可被发现。

## 备选与否决

**把该分支折叠进 `cancelQueuedByMessageID`。** 否决：`RecallResult`（'cancelled'/'inflight'/'not_found'）驱动排队消息的回复文案（`cancel_queued_by_recall` 说的是「排队消息」）；暂存命中需要不同的回复和不同的返回契约（布尔）。兄弟函数让两者都保持诚实。

**附件已被消费后回复「已开始处理」。** 否决：`drainStagedAttachmentPaths` 之后消息 id 已离开状态，区分「已消费」与「从未在此暂存」需要为一桩无法挽回的事维护墓碑集合——prompt 已经发出。静默与未知 id 的 `not_found` 语义一致。

## 后果

被撤回的上传不再到达模型：暂存条目与缓存文件一同消失，用户能看到剩余的暂存。若后续文本已开跑（附件已 drain），撤回是静默 no-op——与 inflight 排队消息同样的固有限制。撤回**文本**消息不影响仍在暂存的附件；它们继续等下一条文本。整条 `im.message.recalled_v1` 通路（两个分支）的真机验证本就挂在 MIGRATION.md 的日常验证清单上——`lark-cli im messages delete --as user`（高危命令，需用户确认）可撤回用户自己的消息，冒烟无需真人在客户端操作。

## 测试

`tests/engine/recall.spec.ts`：选择性撤回后其他消息 id 的条目与文件保留；撤回最后一条暂存时移除 pending 目录并清空 `state.pendingDir`；共享路径在被其他条目引用时保留；未命中 id 零改动。接线测试经 `Engine.start` 覆盖同一撤回回调后的两个分支：stage → 撤回删文件并回复 `attachments_cancelled_by_recall`，随后撤回排队消息仍回复 `cancel_queued_by_recall`。`tests/engine/attachment-staging.spec.ts` 钉住去重：目录中已存在的名字加 `(n)` 后缀（两个 save 助手都覆盖），不同消息上传的同名文件暂存到各自路径且字节互不覆盖。
