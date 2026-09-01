# Agent Note: feishu-bridge 追问卡回退为一题一卡

Status: implemented

[English](2026-09-01-feishu-bridge-ask-card-one-card-per-question-rollback.md) | 中文

## Problem

B2 追问卡重写（`9422ef636e`，2026-08-24）把多题追问合并到一张活表单卡上：所有题保持可交互，每次作答都经卡片回调响应整卡重建，任何题在追问结算前都可修改。上线 8 天内，追问链路累计 7 笔修复（08-31 的活表单系列 `ddc8a8fd1b`/`80ae39f2d2`/`4e8104d485`/`8ee498dbaa`/`5011cb9862`，加 `aa61da55fa` 的 checker 命名空间）与 2 起生产事故；此前 14 天只有 3 笔小修、0 起事故：

- 2026-09-01 09:05，oc_cd832bf1：一张卡上两道多选题的 checker 组件重名（两处 `askq_opt_1`），飞书拒绝建卡（ErrCode 11310），追问静默降级为纯文本（`aa61da55fa`）。
- 2026-09-01 14:28，oc_52c9347bd：一张 5 题卡（3 单选 + 2 多选）答第 1、2、5 题都正常——每次作答都通过回调响应整卡替换——但从第 3 次替换起，后续所有按钮点击不再产生 `card.action.trigger` 回调。四个层面同时静默：卡片无变化、无提示消息、journald 无日志、会话事件无记录。排查只能靠排除法：会话日志证明点击从未到达引擎（`ask_user_question` 工具调用一直未结算），群消息列表证明卡上的已答标记来自卡片回调而非聊天文字。

这套架构把追问状态机放到了飞书卡片平台上，而平台恰好在设计所依赖的每个轴上都是黑盒：整卡替换可能被静默拒绝（200673/200830：按 JSON 2.0 存储的卡拒绝 1.0 响应体），逐题替换链放大该风险（N 题 = N−1 次替换，每次都要过 1.0→2.0 转换、组件名校验、30 KB 上限），卡片级组件命名空间是一题一卡结构上不存在的失败面，平台侧与引擎侧双答案账本（`askqAnswered`/`askqMetaCache` vs `pending.answers`）还需要专门的同步修复（`4e8104d485`、`8ee498dbaa`）。

## Decision

用户决策：回退一题一卡。以正向重写实施，不做 git revert——B2 之后合入的通用修复（cron 槽位点击路由 `475652edbd`、i18n 化追问文案、空提交拒绝 `80ae39f2d2`、每题文字作答通道 `ddc8a8fd1b`）全部保留；多题活表单不保留。

- `engine/ask.ts`：`buildAskQuestionsCard`（带逐题修订状态的活表单）替换为 `buildAskQuestionCard(q, qIdx, total)`——每题一张追问卡——与 `buildAskQuestionCardSettled(q, qIdx, total, answer)`——只读答案快照，仅在答案回调时把追问卡一次性替换为终态。标题在发送时烙上进度后缀 `(N/M)`；冻结重建从这个后缀恢复 `total`。
- `engine.ts`：`sendAskQuestionPrompt` 发送首个未答题（卡 → inline 按钮 → 纯文本的降级链保留）；`routeQuestionResponse` 把每个答案记入引擎账本，且当被答的题正是当前开放题（落账前的第一个未答题）时，fire-and-forget 发出下一题的卡。带题号寻址的文字作答（`3: …`）答后面的题只记账不推进——开放卡保持不变。
- `platform.ts`：多题账本删除（`askqAnswered`、`askqCardMsgIDs`、`syncAskCard`、`buildAskCardResponse`，以及把完全相同的重复点击无声吞掉的平台侧去重——oc_52c9347bd 事故里「点了没反应」体验的直接来源）。`askqMetaCache` 每会话只保存一个开放题。askq 回调分支在 dispatch **之前**读取并消耗 meta——dispatch 会结算答案、引擎随即发出下一题的卡，而那次发送会覆写同一缓存键——然后返回冻结快照作为回调响应。无缓存 meta 的回调仍然 dispatch（引擎的追问状态是唯一答案账本），但在控制台打 warn：这个静默分支已经让我们付出过数小时排除法排查的代价。
- 题号寻址（`2: …`）保留用于修订：自由文字答当前开放题，寻址可修订任何其他已记录的题。

已知取舍（用户接受）：多题追问现在发 N 张卡（B2 想解决的消息噪音回归）；「卡上任意改题」收窄为「答当前卡或按题号寻址修订」。

## Alternatives considered

**保留一卡多题架构、修补可观测性**（去重命中给 toast、静默分支补日志、PATCH 双写让被拒的替换无法冻结卡片）。否决：治标——替换链、卡片级命名空间、双账本都还在，飞书侧每来一个新的转换怪癖就再买一起事故。

**一卡多题但去掉活表单**（已答题原地冻结、开放题发新卡接续）。否决：为没有明确收益的中间方案保留半套多题账本。

## Consequences

追问卡不再有中间态：发出 → 作答 → 冻结。每张卡至多经历一次终态替换，且替换失败无害——下一题的卡是独立消息，流程从不依赖替换落地。引擎的 `pending.answers` 是唯一答案账本；平台缓存仅用于冻结渲染。冻结卡不带任何控件，重复点击面被直接消除；竞态中的重复回调会重新 dispatch（引擎侧记账幂等）并打出 `ask card callback without cached question` warn，而不是凭空消失。

## Testing

`tests/engine/ask.spec.ts`：单题卡构建器——进度标题、header 回退、单选行、多选 checker 表单、无选项题的纯文字表单、冻结快照的勾选标记与自填文本、i18n 面。`tests/engine/engine-ask.spec.ts`：首个未答题一张卡、答当前题即推进（卡片动作与自由文字同样）、寻址答后面的题只记账不推进、全部答完才结算。`tests/engine/engine-m3-askq.spec.ts`：逐题发送的降级链与已答题跳过。`tests/feishu/card-action.spec.ts`：发送时缓存 meta（标题后缀携带 total）、回调冻结与答案标记、文字提交与多选提交载荷、空提交拒绝、meta 缺失时 dispatch 加 warn、重复点击的 re-dispatch 行为、文案本地化。
