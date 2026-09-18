# Agent Note: Fill the skill entry's input line and keep the model envelope off the card

Status: implemented

[English](2026-09-18-feishu-bridge-skill-entry-card-window.md) | 中文

## Problem

工具过程卡把每个工具条目渲染成固定 5 行的代码块——一行输入行、一条 `---` 分隔线、3 行结果窗口——因为卡片的代码块区必须在多次 PATCH 之间、以及条目轮换进出时保持高度恒定（`padToFixedLines`、`minCodeBlockLineWidth`）。

模型调用的 `skill` 把技能名放进 header 标签（尾截断到 16 字符），只把调用可选的 `args` 留作条目正文。于是不带 `args` 的调用把输入行渲染成 100 个空格，结果窗口显示的是模型面信封的头两行——`<skill_content name="…">` 与 `<skill_resources>`——再加一个溢出标记。这条目读起来像坏掉的卡，且不含任何可用信息：2026-09-18 在 live profile 复现（`08:44:07 📚 -pre-push-checks · 1`、`... (138 more lines)`）。

## Decision

- 条目工厂在调用不带 `args` 时把技能名留在条目正文里，输入行因此始终承载这次调用自己的输入。完整名字在那里也重新可读——超过 16 字符时 header 标签做不到这件事。
- `ProgressEntry.resultNotice` 承载结果槽的替代文案；`render` 仅在成功的结果上用它取代载荷。引擎在所有 `skillName` 非空的条目上（`tool_use` 臂）把它设为 `Msg.SkillLoaded`，`/<名字>` 手势臂设置同一个字段，因此两条 skill 路径渲染同一种形状：输入行 / 分隔线 / 通知。
- 失败的加载保留其载荷。skill 工具在名字未知、非法或不可被模型调用时抛错，适配器报 `toolSuccess: false`，诊断原文照旧留在红色标签下的结果窗口里。
- 5 行代码块现在由测试钉住三种形状（带输入的工具、不带 args 的 skill、带 args 的 skill）——该不变量此前只有代码与注释，没有测试。

## Alternatives considered

- **无输入的条目去掉输入行与分隔线**（3 行代码块）。否决：固定 5 行正是让卡片代码块区不跳的条件，去掉后条目高度会随形状变化。
- **在 `updateToolResult` 里做通知替换**。否决：`/<名字>` 手势条目从不经过那个方法，同一个视觉会来自两个不同字段。
- **解析 `<skill_content>` 信封、改为预览技能自己的指令正文**。否决：这会让飞书桥耦合 `packages/skill` 拥有的文本格式，信封一变就静默劣化；而且指令载荷是模型面材料，不是卡面内容。

## Consequences

- 不带 args 的 skill 调用在输入行显示完整技能名；header 标签保持尾截断，那仍是一个未决的呈现问题。
- 成功的 skill 加载结算成一行状态文案，不再显示信封的两行样板；失败的加载与改动前完全一致。
- 代码块的高度与宽度行为不变：每条目 5 行，首行补齐到 `minCodeBlockLineWidth`。
- 通知文案归 i18n 所有（`Msg.SkillLoaded`），本次未新增任何文案，英文 profile 读到的是 "Skill instructions loaded"。
- 其它工具的条目一律未变。非 skill 工具若真传了空输入串，那一行仍会是空白；实际不存在这样的调用（无参数调用传的是 `{}`）。
- 线上生效需要操作者手动 `/reload`；回滚即 revert 该提交。
