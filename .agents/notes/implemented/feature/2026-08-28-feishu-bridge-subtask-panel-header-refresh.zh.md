# Agent Note: 子任务面板 header 采用工具过程卡的执行中拼装

Status: implemented

[English](2026-08-28-feishu-bridge-subtask-panel-header-refresh.md) | 中文

## 问题

后台子任务实时面板的 header 只告诉用户子任务「在跑」，却说不出「是否还在跑」。标题（"⚙️ 后台子任务 · N 个运行中"，静态蓝色）两次刷新之间从不变化，行内措辞又把十秒内的任何活动折叠成「刚刚活跃」——两半都在掩盖时长，一个已经无声停滞的子任务与一个刚刚产出事件的子任务读起来完全一样，直到整整一个停滞窗口（默认 120s）后 ⚠️ 标记才出现。工具过程卡早已解决过同款问题：它的 `执行中 · HH:MM:SS · N` header 携带最近一次工具调用的墙上时刻，工作持续时不断前进、停止时一眼冻结。

## 决策

面板 header 对齐工具过程卡的执行中拼装，行内计时改为绝对时刻优先（`renderSubtaskPanelCard`，`src/engine/subtask-panel.ts`）：

- **Header**：`后台子任务 · N 个运行中 · HH:MM:SS`——时刻取未汇报子任务中最新的 `lastEventAt`，随面板每次 tick（默认 15s）重渲染，任一子任务在工作就持续前进、全部停滞即冻结。任一子任务越过 `features.subtaskLivePanelStallMs` 后模板由黄翻橙、标题追加 `⚠️ N 个疑似停滞`；转圈图标（平台的 executing 动图）经新增的 `CardHeader.icon` 字段挂上 header，按 schema-2.0 `custom_icon` 渲染。终态维持绿 done / 灰 drained 卡，无图标。
- **行内容**：`上次活跃 HH:MM:SS（刚刚 / N 秒前 / N 分钟前）`——绝对时刻是主信号（PATCH 失联的死卡上依然可读，读者拿它对照自己的钟表即可），相对时长退居括号，⚠️ 停滞前缀保留原有措辞缀于行首。小于 10 秒的特殊分支不复存在。
- **管道**：平台经 `LiveCardIconSource` 结构化能力暴露图标（`liveCardIconKey(): Promise<string>`，FeishuPlatform 基于既有 `spinnerCfg()`/`spinnerKeyForState('running')` 实现），引擎不导入任何飞书类型；面板记录在发表时解析一次 key，之后每次刷新 PATCH 复用。解析失败渲染为无图标，绝不阻塞发表。footer 由 markdown 行改为卡片 note 元素（小号灰字），对齐工具卡的 footer 样式。

## 已考虑的替代方案

- **只调措辞（去掉「刚刚活跃」，保留「N 分钟前」）。** 否决：依然没有一眼可辨的信号——相对措辞需要读者阅读并换算；标题里冻结的墙上时刻替读者完成了这次换算。
- **只给停滞加专用 header 颜色、不带时刻。** 否决：颜色单独无法区分「一个子任务停滞、其余正常」与「全部停滞了两分钟」，而且它重新触发的时间问题正是时间戳已经回答的那个。
- **header 走比 body 更快的独立子间隔刷新。** 否决：面板已有定时 PATCH；为同一份 PATCH 能携带的信息再开一个定时器只是把 PATCH 预算翻倍。

## 后果

- 停滞的子任务有两处一眼可见：header 时刻停止前进；越过停滞窗口后模板翻橙并带停滞计数。墙上时刻让死卡（PATCH 失败、daemon 已亡）也能凭冻结的时间戳自诊。
- `CardHeader.icon` 是通用的卡片模型字段；未来的实时卡（聊天室面板、monitor 卡）可以带 header 图标而无需碰渲染器。`LiveCardIconSource` 是唯一新增的平台能力。
- i18n：`subtask_panel_title` 去掉 ⚙️ emoji（活性由图标承担），`subtask_panel_ago_*` 键改为纯相对时长（`刚刚`/`N 秒前`/`N 分钟前`），新增 `subtask_panel_last_active` 与 `subtask_panel_stalled_suffix`。无新增配置面：间隔、停滞窗口与开关沿用既有 `features.subtaskLivePanel*` 键。
- 由 `tests/engine/subtask-panel.spec.ts` 钉死：header 三段式拼装、黄→橙翻色与停滞后缀、首事件前省略时刻段、行内绝对+相对配对、图标透传与终态忽略、图标解析失败仍发表。前作见[2026-08-27 后台子任务活体面板](2026-08-27-feishu-bridge-background-subtask-panel.zh.md)。
