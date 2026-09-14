# Agent Note: 回滚 reply 直写渲染长度分档

Status: implemented

[English](2026-09-14-reply-render-tier-revert.md) | 中文

## 问题

4956ae127e 作为 2026-09-13 chatroom 复盘的成本修复（见[批次 note](2026-09-14-chatroom-session-postmortem-fixes.zh.md)）给投机 reply→HTML 渲染加了长度分档：不超过 `planRenderDirectLen`（默认 2000 rune）的回复跳过渲染会话 fork——engine 自己写 `markdownToSimpleHTML` 片段并原地组装 reply 模板。部署前评审发现直写档产出的是有缺陷、且冗余的产物：

1. **违背模板契约。** reply 模板唯一的页面内边距挂在片段自带的 `.wrap` 容器上、文档标题从片段的 `<h1>` 提取——这两样都是渲染 skill 的片段契约。直写片段两样皆无：渲染出的文字从 (0,0) 像素开始、贴死图片边缘，`<title>` 为空，投递的 PNG 文件名退化为 `render.png`、图片卡无标题。标题降级为同字号 `<b>`、列表变纯文本圆点、表格变 `<pre>` 里的 ASCII。已用真实管线（`markdownToSimpleHTML` + `assembleHTMLInPlace` + 生产栅格化参数）拼装直写片段并量得首文本节点包围盒在 (0,0) 验证。
2. **逐字重复。** reply 渲染的输入优先取尾部实时播报段——正是完成卡上留存的同一段文本——于是图片逐字重复用户刚读过的内容，每条中短回复付一次 Chromium 栅格化加图片上传。渲染 skill 自身的契约是一屏提炼概览（「完整回复已在对话里，不进片段」）。

## 决策

- 长度分档在任何部署前回滚：`renderReplyToHTML` 恢复对每条回复 fork 渲染会话，`planRenderDirectLen`/`directLen` 配置面删除，`plan-render-fork.spec.ts` 恢复原始短 fixture。批次其余修复——机标 ask 豁免、poll 一次性会话、汇报去重、一次性血缘、账本卫生、save 合并写、监督配置、gather 补醒——不动。
- 中短回复渲染 fork 的成本发现（该场 81 会话中的 43 个）重开为已知未解成本，本次不再另做方案。

## 考虑过的替代方案

- **修直写档的片段（包 wrap、合成 `<h1>`）。** 否：能修好视觉，但仍在投递完成卡内容的逐字重复——每条中短回复一次栅格化+上传换不来任何信息增量。
- **阈值以下干脆跳过渲染（不出图）。** 产品所有者裁定不走：每条 ≥500 rune 的回复保留 fork 渲染卡；成本项改为记录在案的未解项。
- **维持已合入的分档。** 否：输出缺陷与重复在每个启用 plan_render 的 bot 的每条中短回复上都用户可见。

## 后果

- 每条达到预渲染门槛（≥500 rune）的回复重新消耗一个渲染会话 fork；2026-09-13 的成本画像按裁定回归。chatroom 场次仍是压力点——再咬人时重开。
- 回滚落在任何部署之前：线上构建产物从未包含分档，两侧都没有用户可见的行为变化。
- 测试：reply fork 契约与 render 父血缘用例都在 `plan-render-fork.spec.ts`；`plan-render-direct.spec.ts` 删除。
