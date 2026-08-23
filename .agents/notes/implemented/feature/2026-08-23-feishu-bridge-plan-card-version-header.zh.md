# Agent Note: 计划卡 header 显示版本标识

Status: implemented

[English](2026-08-23-feishu-bridge-plan-card-version-header.md) | 中文

## Problem

计划卡 header title 此前由计划文件 basename 派生（[剥掉 cwd-slug](../../archived/bug-fix/2026-08-22-feishu-bridge-plan-card-title-strips-cwd-slug.md)），语义上重复了卡片正文首行 `# 标题`——同一张卡把同一主题显示两遍，派生过程还叠加了截断与字符替换造成的漂移。该 title 同时是硬编码中文（`计划·`），绕过了 bridge 的五语言 i18n；而预留的 i18n 键 `plan_content_header` / `plan_content_header_revision` 带着按 markdown 设计的值，完全没有消费方。

## Decision

header 只承载版本标识，计划自身的标题留在卡片正文。`Engine.planCardTitle(revision)`（`engine/engine.ts`）在首次呈现时返回本地化裸标题（`Plan` / `计划`），第二次起返回 `(v%d)` 变体，`sendPlanContent` 与 `sendInlinePlanContent` 的卡片标题统一经它生成。两个 i18n 键在五种语言下改为纯文本卡片标题（卡片 header 不渲染 markdown）；`sendInlinePlanContent` 删除了仅为旧标题推导存在的 `filePath` 参数；`planCardName`（`engine/plan-file.ts`）随之删除。[计划文件持久化](2026-08-21-feishu-bridge-plan-file-persistence.zh.md)的落盘命名不变：`-YYYYMMDD-HHMMSS` 修订后缀只在磁盘上，聊天内共存的计划卡靠 `(vN)` 区分。

## Alternatives considered

**保留 basename 派生（剥 cwd-slug 后）的标题。** 落选：header 在语义上仍与正文首行标题重复，用户裁定这一重复不值得换「扫一眼知主题」。取代上方已归档的剥离决策。

**显示完整落盘 basename。** 落选：新增的信息只有 cwd-slug 前缀，在已绑定唯一项目 workdir 的聊天里是零信息噪音；标题字眼仍与正文重复。

## Consequences

代价：仅凭 header 无法定位背后的计划文件——导出按钮可取回内容，修订版靠版本号而非磁盘时间戳区分。收益：卡片上不再重复出现主题；header 随会话语言本地化；两个预留 i18n 键有了第一个消费方。

## Testing

`tests/engine/plan-file.spec.ts`：经 stub 卡片平台断言两条发送路径在 revision 1 与 2 的卡片标题，钉住本地化裸标题（en）与 `计划 (v2)` 变体（zh）；`planCardName` 的用例随函数删除。
