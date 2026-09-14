# Agent Note: 暴露实时播报上限、PATCH 落地后才写卡片缓存、线上操作单次序列化

Status: implemented

[English](2026-09-14-feishu-bridge-progress-card-followups.md) | 中文

## Problem

同日跟进 [进度卡修复](2026-09-14-feishu-bridge-progress-card-fixes.zh.md) 的三个遗留：

- 刷新间隔已配置化为 `streamPreview.progressFlushIntervalMs`，但实时播报上限仍是模块常量（6000 字）——同为部署可变选择（飞书 11310 防线边界）却仍不可配。
- `updateMessage` 在限流等待与 PATCH 重试之前就把 pre-button 卡写入 `lastProgressCard`，重试耗尽后缓存领先于聊天里实际显示的卡；停止卡与渲染状态重建会把外框包在从未落地的内容上。
- 每次线上操作要经历两到三次 JSON 往返：`renderPreviewCard` 序列化一次，`injectStopButton` 与 `injectReplyButtons` 各再解析并序列化（停止卡路径经内部链路还要第四次）。

## Decision

`streamPreview.maxAnalysisChars`（默认 6000，即原常量）经与刷新间隔相同的 `setStreamPreviewCfg` 缝约束实时播报段，附 schema 字段与 OPERATIONS 行。

pre-button 缓存只在 PATCH 重试完成后写入，缓存始终反映平台已接受的内容；失败的 PATCH 保留旧条目，停止/状态重建路径走既有 cache-miss 回退。

按钮注入改为原地修改卡对象（`injectStopButtonInto` / `injectReplyButtonsInto` / `injectStoppedButtonsInto` / `markCardStoppedInto`），`buildCardWithHeader` / `buildPreviewCard` 返回对象；每次线上操作恰好序列化一次，字符串版注入器作为 Go 移植公开面的薄包装保留。`lastProgressCard` 存未突变的 pre-button 卡对象；重建路径先克隆再注入，缓存本体永不带按钮。

## Alternatives considered

**播报上限维持旧常量。** 审计 F4 修复交付了间隔；到此为止会让卡片另一半真实旋钮在兄弟项可配时仍被写死，而 11310 边界正是仓规要求做成配置字段的部署可变选择。

**PATCH 失败时回滚缓存。** 成功后写入以零回滚路径达到同一保证：缓存永不领先于平台。

**删掉字符串版注入器。** 它们现在仅剩测试调用，但属于 Go 移植的公开函数面且其 spec 钉住注入行为；删除只省四个导出，代价是重写 spec 的构造路径。

## Consequences

播报上限可按部署调参而无需重构建；默认值不变。重试耗尽的 PATCH 不再用未落地内容污染停止卡重建——渲染结果与缓存只能一致。线上序列化从每次 PATCH 两到三次往返降到一次，缓存本体是对象，重建路径直接克隆而无需重新解析字符串。

## Testing

`tests/streaming.spec.ts` 覆盖配置化上限（默认契约、100 字上限截断）。`tests/feishu/cardcache.spec.ts` 钉住失败 PATCH 不推进 pre-button 缓存、停止卡重建使用已落地条目。单次序列化重构的线上逐字节等价由既有 preview/card spec 覆盖（构造切换到对象路径，断言不变）。
