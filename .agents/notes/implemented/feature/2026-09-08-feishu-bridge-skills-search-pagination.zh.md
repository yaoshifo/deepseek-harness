# Agent Note：/skills 模糊搜索、分页与 /skill 别名

Status: implemented

[English](2026-09-08-feishu-bridge-skills-search-pagination.md) | 中文

## 问题

`/skills` 把整个目录渲染成一张平铺卡片——生产环境挂载约 60 个 skill，卡片要滚动好几屏，想找一个 skill 只能通读列表。没有按关键词收窄的手段；`/skill` 能触发纯属巧合（恰为 `skills` 的 ≥2 字符前缀），不是受保证的别名。

## 决策

`/skills [关键词] [页码]`（别名 `/skill`，在 match 函数中显式写出，不再依赖前缀规则）。搜索为模糊匹配：每个空白分隔的关键词都须是条目名称**或**描述的大小写不敏感子串——单词场景与促成本功能的名称包含示例完全一致，而描述命中让中文描述的 skill 也可搜。引擎 deny 掩码先过滤、关键词后过滤；目录为空与关键词零命中回复不同文案（`skills_empty` 与 `skills_no_match`）。

超过 `SKILLS_PAGE_SIZE`（15，与 `dirCardPageSize`/`listPageSize` 同为硬编码常量）的列表按页渲染：分页标题（`skills_title_paged`）、带 命中/总数 的 🔍 关键词行、上一页/下一页 `nav:/skills <n>` 按钮、页脚页码提示（提示文案同时点名 `/skills <关键词> <页码>` 形式——纯文本降级保留 note 但按钮只是死提示，文本平台靠重敲命令翻页）。命令参数中尾随的独立正整数即页码，`/skills lark 2` 直接跳到过滤结果的第 2 页；名字恰为纯数字的 skill 经此形式搜不到。

翻页重渲的是**命令执行时捕获的快照**。注册卡片动作 seam（`registerCardAction`）是同步的，而 `ctx.skills.list()` 是异步的 FS 读取服务调用，处理器无法重拉：`cmdSkills` 把 deny 与关键词过滤后的列表存入每次注册独有的 `Map`，键为 `stripUserID(msg.sessionKey)`，`/skills` 卡片动作从其渲染请求页。通道级键与 `/dir` 卡片动作用的是同一槽位，列表作者与同群按键成员落到同一条目。快照缺失（reload 前的所有旧卡、或已 dispose）渲染 `skills_stale` 提示而非静默无响应。`renderSkillsCard` 是唯一渲染源；命令路径经 `replyWithCard` 发送，动作路径返回同一卡片交给引擎原地 PATCH。

## 备选方案

**放宽 `CardActionHandler` 允许 `Promise`、每次翻页重拉。** 否决：为没人要求的实时性改动中央引擎 seam、每次按键重复 `listSkills` 的 FS 扫描、翻页途中数据可能漂移。快照让翻页廉价且页面一致。

**页码放首参，复用 `pageArg` 的首 token 读取。** 否决：`/list` 无关键词所以首参空闲，`/skills` 的主参数是关键词。尾随数字形式保住 `/skills lark` 的无歧义性，代价是纯数字命名的边角场景。

**仅匹配名称。** 否决：生产环境许多 skill 的语义在中文描述里而名称是英文，描述匹配才让搜索可用。单词场景两种语义等价。

**把工作目录放进按钮值作为快照键。** 否决：通道键与 `/dir` 卡片动作先例一致、无需在值里穿参，且让同群用户正确共享同一条目。

## 后果

各页展示的是该群最后一次 `/skills` 运行时的目录——重载或目录变化后需重发命令，与 `/list` 翻页同一新鲜度语义；reload 后的旧按钮以提示卡自解释。群里最新一次运行替换快照，同群并发搜索翻到的是最新关键词的结果（同群共享一个工作目录，群内自洽）。i18n 面为五个新键（`skills_no_match`、`skills_title_paged`、`skills_query_line`、`skills_page_hint`、`skills_stale`）加改写的 `skills`/`skills_usage`；`CardPrev`/`CardNext` 复用。`/mcp` 不动。

## 测试

`tests/engine/skills-mcp-commands.spec.ts`（21 例）：名称子串过滤（大小写不敏感）、描述命中、多关键词 AND、无命中与空目录分流、显式别名解析、尾随页码（纯页码、带关键词、越界钳制）、分页卡结构（分页标题、按钮值、note、单页两者皆无）、`nav:/skills 2` 原地 PATCH（含跨用户键映射）、翻页保持关键词范围、stale 提示、dispose 连同快照摘除卡片动作。
