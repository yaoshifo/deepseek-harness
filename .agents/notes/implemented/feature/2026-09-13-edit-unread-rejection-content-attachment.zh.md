# Agent Note: edit 未读拒绝附带当前文件窗口

Status: implemented

[English](2026-09-13-edit-unread-rejection-content-attachment.md) | 中文

## Problem

`fs-observation-policy` 门禁要求该会话先 `read` 才能 `edit`（防盲改加 CAS 版本守卫）。grep 结果不记录观察，因此最高频的模型路径是 grep → 直接 edit → `FS_NOT_OBSERVED` 拒绝；模型随后要花整整一轮 `read` 才能重试。在桥上每轮是几十秒的墙钟时间，而模型侧指引（"Read the file first"）早已同时存在于工具描述与系统提示——摩擦来自模型遵守率，不是可发现性。

## Decision

门禁策略逐字节不动，只改 `edit` 未读拒绝时返回的内容（`packages/fs/tool-fs/src/edit.ts` 的 `enrichNotObserved`）：

- `FS_NOT_OBSERVED` 时工具执行一次恢复读取（与 `read` 工具相同的 stat + 大小路由 + `buildWindow`/`formatReadOutput` 路径与上限），把带行号窗口附进错误文本：`cannot modify "<path>": file has not been read — current content (up to <limit> lines) follows; retry the edit directly`。模型下一轮直接重试，无需中间 `read`。
- 恢复读取发出 `fs/observed`（present, version），重试的 edit 经由未改动的 CAS 路径防护该版本。
- 恢复读取确认缺失的目标以 `cannot edit "<path>": not found` 失败——一轮即告知模型文件没了，登记的缺失同时更新 write 守卫。
- 恢复读取自身失败（二进制目标、解码错误、取消）逐字节回退到改动前的朴素诊断：最坏情况等于旧行为。
- `write` 的创建路径不动（守卫创建无此摩擦），但其未读覆盖拒绝后来以同款方式富化——见拒绝富化推广的后续 note。`remediateFsError` 保持纯函数；富化因涉及 IO 放在 `src/unread-attachment.ts`（两工具共享）。

## Alternatives considered

**未读 edit 自动读取并自动执行。** 放弃：奖励跳过 `read`、盲猜 `old_string` 失败率更高、丢失「模型验证过再改」的保证。拒绝加内容的形式保留拒绝信号，同时把自愈从三轮压到两轮。

**让 grep 记录观察。** 放弃：grep 给的是匹配行而非文件全貌；算作已读会绕过「看过全貌」的意图，换来的轮次收益有限。

**跨 fork/子代理会话继承观察。** 暂缓：观察状态是按会话对象键控的 per-session WeakMap；跨会话继承需要在 fork 缝隙处理版本陈旧语义，且不是主触发路径（主路径是 grep 后直接 edit）。

## Consequences

- 未读 edit 自愈从三轮工具往返（拒绝 → read → edit）降到两轮（拒绝+内容 → edit）；注入的内容正是 `read` 本会注入的内容。
- 每个文件最多富化一次——恢复读取登记了观察，第二次未读拒绝不会发生；富化后 `old_string` 写错走字面匹配失败路径，不附带内容。
- 富化拒绝是 `isError` 结果上的单段文本；会话日志、SDK 投影与通用错误渲染的形态不变。`fs-policy-reject` 会话快照经 refresh 通道重录：录制的第二次直接 edit 现在成功（fixture 展示 拒绝附内容 → 重试成功 → DONE），`workspace.expected` 从 blue 改为 green。
- 错误卡片因附带窗口变长（受读取上限约束）；朴素形态仍用于恢复读取失败（及推广前的 `write`）。

## Testing

`packages/fs/tool-fs/tests/integration.spec.ts`：未读 edit 附带内容与重试指引且文件不动；直接重试成功且无需中间 read；缺失目标透传 `FS_NOT_FOUND`；2500 行文件只附首窗口与续读页脚；二进制目标逐字节回退朴素诊断；富化拒绝后外部改动仍使重试以 `FS_STALE_VERSION` 失败。包套件 371 测试绿；`tsc -p packages/fs/tool-fs` 与 oxlint 干净；`fs-policy-reject` 的 `test:snapshot` 回放绿（另有四个无关快照失败在无本改动的 `dev` 基线上即存在）。
