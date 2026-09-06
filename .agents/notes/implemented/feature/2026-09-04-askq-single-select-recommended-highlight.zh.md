# Agent Note：单选问题卡的推荐选项按钮高亮

Status: implemented

[English](2026-09-04-askq-single-select-recommended-highlight.md) | 中文

## Problem

`recommended` 选项标记随每次 ask 到达飞书桥——`ask_user_question` 的 schema 明确教模型设置它——但只有多选 checker 表单消费它（经 `checked: true` 预勾选）。单选卡（带数字按钮的列表行）上该标记完全没有呈现，模型在最常见的 ask 形态上表达的推荐不可见。

## Decision

单选列表行在 `opt.recommended === true` 时把按钮渲染为 `btnType: 'primary'`，否则 `'default'`。其余一律不变：label、description 与基于索引的 `askq:{q}:{n}` 回答编码不动，结算快照不标推荐——与多选快照一致，它同样不回显预勾选状态、只显示用户选中的选项。

## Alternatives considered

**label 前缀 emoji。** 否决：显示文本会与进入回答的 label 分叉，结算快照需要同样的装饰才能保持对称，还可能与模型自己写的 `(Recommended)` 后缀叠加成双重标记。

**description 前缀「推荐」。** 否决：把 UI 文案拼接进模型写的句子里。

## Consequences

`AskUserQuestionOption.recommended` 的契约措辞（user-questions 的 types JSDoc 与两份 README）现在同时点名两种呈现：多选 UI 预勾选，单选 UI 高亮。多个 recommended 选项如实渲染出多个 primary 按钮——schema 允许它，不加防御。飞书 listItem 的 `primary` 样式跨端可用，`session-card.ts` 已有使用。

## Testing

`tests/engine/engine-m3-askq.spec.ts` 在多选预勾选用例旁新增 `single-select renders the recommended option button as primary`（25 通过）；`tests/feishu/card-action.spec.ts` 保持绿色（57）。
