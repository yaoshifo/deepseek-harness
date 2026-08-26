# Agent Note: feishu-bridge listItem 行持有自己的 markdown；投影层不得重复加粗

Status: implemented

[English](2026-08-26-feishu-card-list-item-double-bold.md) | 中文

## Problem

所有交互式列表行卡片（/dir 选择卡、/sessions、delete-mode、/help、chatroom 角色与话题选择卡）在飞书上都裸露出 markdown 星号——/dir 行显示 `◻ ** 16. ** /Users/...`，而非加粗行号加代码样式路径。根因是同一次 M2/M4 移植里落地的两半不一致：卡片构建方（dir-card、session-card 经 `list_item` i18n 模板、misc-commands、chatroom-pick）传入的 `CardListItem.text` 已自带 markdown（`◻ **16.** \`/path\``），而飞书投影（`renderElement` listItem 分支）又把这文本再包一层 `**…**`。嵌套定界符随后破坏了 `padBoldDelimiters`——其正则按最近 `**…**` 边界配对：它把 `**◻ **` 配成一段加粗，在错误的边界插入补位空格，产出 `**◻ ** 16. ** /path**`，飞书渲染成裸星号。修复前已从源码逐字复现该投影字符串。

## Decision

`CardListItem.text` 是调用方持有的 markdown 内容；仅当调用方未自行排版时，行才默认渲染为加粗行标签。飞书 listItem 投影检查 `elem.text.includes('**')`：已排版的文本原样进入 `finalizeFeishuCardMarkdown`，纯文本保持默认 `**…**` 包裹。这与同一字段另外两个既有消费方一致——delete-mode checker 变换（lark_md，不包裹）和 `Card.renderText()`（不包裹）本就把该文本当调用方 markdown，投影层的无条件包裹才是异类，不是调用方。

## Alternatives considered

- **完全去掉包裹，让纯标签调用方（`ask.ts`）在构造处加粗。** 否决：ask 卡作答冻结往返会把 `elem.text` 存回选项标签（`askCardMeta`）并经同一构建器重建行，构造侧加粗会在每次 card-action 替换时叠成 `****label****`；修好它要动 `ask.ts` 和 `platform.ts`，视觉上零收益。
- **修 `padBoldDelimiters` 让嵌套加粗正确配对。** 否决：文本损坏只是症状，输入本身已是非法嵌套强调。该路径上没有其它嵌套来源，模型生成内容里的嵌套加粗是下面另行记录的独立潜在问题。
- **`listItemBtn` 收到含 `**` 的文本时构建期报错。** 否决：五个已上线调用点都依赖 markdown 行文本；契约是「调用方持有 markdown」，不是「调用方传纯文本」。

## Consequences

- 五个受影响表面（/dir、/sessions、/help、chatroom 选择卡）现在正确渲染单层加粗；纯标签 askq 行保持加粗标签，含作答卡冻结路径。
- 文本含未配对 `**` 的行（如会话摘要里字面量 `2**3`）会跳过包裹，仍可能经飞书自身的最近配对解析漏出星号——不比修复前更糟，修复前每一行都被损坏。
- `padBoldDelimiters` 对模型生成 markdown 里的畸形嵌套加粗（如正文中的 `**a **b** c**`）仍会错误配对；listItem 嵌套消除后没有现存调用方会触发，但该解析器仍是逐对匹配，真修需要一个真正的 tokenizer。
- 由 `tests/feishu/card.spec.ts`（已排版行原样透传；纯文本行仍加粗）及既有 dir-card/session-card/delete-mode specs 覆盖。
