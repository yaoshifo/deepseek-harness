# Agent Note: feishu-bridge 工具进度标签色承载调用状态

Status: implemented

[English](2026-08-30-feishu-bridge-tool-tag-status-color.md) | 中文

## Problem

流式 Tool Process 卡上的每条工具行都以状态 emoji 结尾：🟢 成功、🔴 失败、🟡 运行中，thinking 行固定 🟢。emoji 在每行重复，且占用的是该行本就拥有的通道——工具名上的彩色 `text_tag`。自按家族细分图标（a0c1bf027c）以来，每个标签把家族编码了两遍：一遍在图标（💻 📝 🔍 🤖 🌐 …），一遍在颜色（blue/turquoise/purple/orange）。颜色通道冗余，可腾出来承载状态。

## Decision

`ProgressEntry.render` 从 `hasResult`/`success` 推导 `ToolCallStatus`（`'running' | 'success' | 'failed'`）并传入标签：`toolTagForProgress` 新增可选第三参（默认 `'running'`，exports 面签名向后兼容），skill 标签分支经同一 `tagColorForStatus` 映射取色。结果落地后取 `green`（成功）或 `red`（失败）；运行中的条目保持家族色。工具行与 thinking 行行尾的状态 emoji 全部移除。

家族身份在每行仍可由图标读出，调用进行中时还能由家族色读出——运行中的行就是那条非绿非红的行。`green`/`red` 不被任何家族占用，完结色与运行色永不冲突。skill 条目的 📚 标签同样按状态取色。`markCompleted` 的终局兜底把 pending 行翻成绿色，与旧的「兜底即 🟢」语义一致。注册时声明（[`declareToolFamily`](../architecture/2026-08-27-feishu-bridge-chatroom-service-events.zh.md)）仍为兄弟插件工具的运行行着家族色。

## Alternatives considered

**用专属运行色（yellow）彻底退役家族色。** 否决：颜色只承载一种语义，但所有运行行将长得一样，家族色——运行期间仍有信息量——从卡片上消失；黄色还与 orange 家族视觉接近。运行行保留家族色后，「非绿非红」本身就是运行中信号，无需新增颜色词汇。

**用彩色圆点标签替换 emoji。** 否决：只是把行尾标记左移一格，没有去掉它；诉求是去掉行尾状态标记。

## Consequences

完结行显示绿或红标签；运行中的调用就是仍处家族色的那行。park 卡的 pending 行永远保持家族色——旧渲染在那里显示永久的 🟡，同样是「未完结」语义，未引入新状态。红绿色弱用户相对 emoji 方案无损失（🟢 与 🔴 本就同样不可辨）。thinking 行失去固定的 🟢——它从不反映真实成功。已知局限：turn 落定后，家族只能从图标读出、不能从颜色读出——完结行上图标是唯一的家族通道。

## Testing

`tests/streaming.spec.ts` `tool tag status colors`：成功渲染绿标签、失败红、无结果条目保持家族色、skill 标签按落定状态取色、thinking 行不带状态 emoji；`toolTagForProgress` 状态覆盖用例表钉住第三参与默认值；markCompleted 兜底测试断言绿标签。`tests/engine/engine-subagent-card.spec.ts` 钉住已结算子行与终局兜底父行都渲染绿标签。
