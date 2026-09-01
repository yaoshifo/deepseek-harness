# Agent Note: feishu-bridge 多问题 ask 卡 checker 组件重名被飞书拒收

Status: implemented

[English](2026-09-01-feishu-bridge-multi-question-ask-checker-name-clash.md) | 中文

## Problem

一次 ask 携带 ≥2 个 multiSelect 问题时，两题的 checker 表单都从 `askq_opt_1` 起编号——checkOptions 渲染器只按选项在题内的序号给 checker 命名。飞书按卡片级校验交互组件 name 唯一，卡片创建被拒（HTTP 400，code 230099，ErrCode 11310 `name(askq_opt_1) duplicate`）。`sendAskQuestionsCard` 的 `sendCard` catch 不留痕迹，飞书平台又没有 `sendWithButtons` 能力，于是 ask 降级为编号纯文本：回数字仍可作答，但可点选的卡片再也没出现。2026-09-01 09:05 生产首次触发：dida 待办整理的一次 ask 带两道 multiSelect 题（9 + 8 个选项）。单问题卡永不撞名；多问题卡里的单选题走 listItem 按钮路径、载荷自带题号——只有 multiSelect 的 checker 路径命名漏了题号。

## Decision

checker name 带上题号：`askq_opt_{q}_{n}`，`q` 从 checkOptions 的 action（`askq_multi:{q}`）提取——与同一表单里 submit 按钮的既有模式（`askq_multi_submit_{q}`）一致。提交解析 `collectAskqMultiSelected` 改为取 key 最后一个下划线之后的选项号：新格式 `askq_opt_{q}_{n}` 与修复前单题卡的裸格式 `askq_opt_{n}` 都能读（旧卡在 daemon 尚存其 interactive state 的窗口内仍可点）。engine 的 ask 卡与权限卡发送级联（`sendCard` → `sendWithButtons` → 纯文本）在每一级回退补 `console.warn`（带 session key 或工具名与错误消息）：生产事故在 engine 层零痕迹，只能靠 axios 全局错误处理器定位。

## Alternatives considered

**用 label 派生或 hash 生成 checker name。** 否决：解析端需要逆向映射；数字段直接承载选项号且排序自然。

**严格按 `{q}_{n}` 拆分并让 `q` 与 submit 的题号比对。** 否决：form_value 只携带所属表单的组件值（飞书保证），题号段在那里是冗余；取末段下划线的读法还顺带覆盖旧单题格式，无需第二个分支。

## Consequences

多问题 multiSelect 的 ask 卡恢复可创建。旧 name 的兼容窗口等于 daemon 的生命周期：重启后 interactive states 清空，旧卡本就是死按钮（既有行为）。checker name 没有其他消费方——全库检索只有渲染器与提交解析两处。

## Testing

`tests/feishu/card.spec.ts`：两道 multiSelect 题的卡渲染出卡片级唯一的控件名（该 400 的最小复现）。`tests/feishu/card-action.spec.ts`：新格式 key `askq_opt_1_2`/`askq_opt_1_10` 解析为 `askq:1:2,10`；裸格式既有测试继续通过。
