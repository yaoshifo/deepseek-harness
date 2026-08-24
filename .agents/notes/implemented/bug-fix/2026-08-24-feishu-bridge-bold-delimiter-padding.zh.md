# Agent Note: 飞书卡片 markdown 渲染前为贴合文字的加粗定界符补空格

Status: implemented

[English](2026-08-24-feishu-bridge-bold-delimiter-padding.md) | 中文

## 问题

飞书卡片 markdown（schema 2.0 富文本组件）只在定界符两侧都留有空白时才渲染 `**加粗**`——平台文档写明「若加粗效果未显示，请确保加粗语法前后保留一个空格」。agent 回复常产出 CommonMark 合法的 `**……上。**mico 服务器……`：闭合 `**` 紧贴下一个字符，飞书拒绝该配对，卡片上显示出裸露的 `**`（群 oc_5dd09d0ef27a0ddc0ff07e0916c75bd4，2026-08-24）。用存档回复经 `buildPreviewCardJSON` 离线重放证明 bridge 管线是原样透传标记的——缺陷在平台解析器，不是我们侧的文本损坏。

## 决策

`padBoldDelimiters`（`src/feishu/markdown.ts`）对匹配到的 `**…**` / `__…__` 配对，在每个贴合侧插入一个空格，即平台文档自荐的补救。函数逐行处理，跳过围栏代码块并遮蔽行内代码 span，代码内容永不被改动；前后断言使 3 个及以上的定界符连排（`***x***`，文档明言该形态渲染不可靠）保持原样。该步骤接入两个卡片 markdown 拼装点：`finalizeFeishuCardMarkdown`（独立回复卡与所有结构卡的 `{kind:'markdown'}` 投影）和 `buildPreviewCardJSON` 文本路径（流式预览卡与完成/停止卡——本次 bug 的观察面）。工具进度条目不做补空格：其文本渲染在代码块内。导出按钮交付的是原始回复文件，不经过本管线。

## 备选方案

**把贴合配对改写为 `<b>…</b>`（已在标签白名单内）。** 不作为第一步：无可见文本变化，但每个改写对必须保持配对，否则卡片以 API 错误 11311 发送失败，且标签内嵌套行内格式需要自己的转义故事。补空格是平台文档给的补救，没有失败模式。

**要求模型输出带空格的加粗。** 否决：prompt 级约定撑不过每个模型、每种语言；渲染器才是所有回复必经的唯一收口。

## 后果

贴合的加粗配对在贴合侧多出一个半角空格（如 `……。** mico`），是让配对得以渲染的轻微 CJK 排版代价。若真机验证发现飞书对补空格后的某些形态仍拒绝，`<b>` 改写仍是同一 `padBoldDelimiters` 缝后面的退路。3 个及以上定界符连排与代码内容保持现有行为。

## 测试

`tests/feishu/markdown.spec.ts`（`padBoldDelimiters`）：表驱动覆盖闭合贴合字母/中文/全角标点、起始贴合、双侧贴合、已带空格与行边界配对不变、代码块与行内代码不动、3/4 星连排不动、下划线变体、未配对定界符；另有 bug 复现句与 `finalizeFeishuCardMarkdown` 管线断言。`tests/feishu/card.spec.ts`（`buildPreviewCardJSON` 补加粗定界符空格）：真实回复首句经预览卡管线重放。完整 mico 存档回复的离线重放报告剩余贴合配对为零。
