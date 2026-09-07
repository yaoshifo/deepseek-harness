# Agent Note：研究场收尾先做数字对账；所有抓取面绑定 playbook

Status: implemented

[English](2026-09-07-chatroom-research-recon-and-playbook-binding.md) | 中文

## Problem

2026-09-06/07 的沪深300/中证500 定投研究场以一批流程内无人复算的终稿数字收场（三路审计——台账盘点、独立重拉、会话日志回放——发现）：「500 五口径散布 76pp」用本场自有数据复算不出（全口径×全窗口上限约 54pp）；阈值换算「指数≤4047点」与所述 PE 阈值差约 1.4%（EPS 取数时点漂移）；某角色 findings 声称挂牌利率「三源核对」，但点名的三个源里两个在会话日志中没有任何抓取动作——数字本身没错（管家层已双源），声明是虚的。结构性根因：主持人契约禁止其下场做研究，角色只在场上交叉验证有争议的数字，收尾 HTML 渲染器只搬运不核验——终稿散文里的派生数字没有归属人。同一审计还暴露两个相邻缺口：playbook 里已有统计局 CPI 官方配方（同日早些时候由并行场的 dalio 追加），本场助手仍默认走了 akshare→金十单源 CPI 镜像，因为角色转达的抓取任务从没提 playbook——「开工先读」的前言 bullet 是建议性的且只在助手侧；以及本场的腾讯个股 PE 坑（对官方 EY 闭合差 -21~-24%）没有回流进 playbook——收尾回流清单（books 仓库的 moderator CLAUDE.md）里没有 playbook 这一项。

## Decision

- 研究模式收尾新增「0. 先数字对账」步骤（`chatroom-priming.ts`，以 `researchWs` 为门控）：渲染报告 HTML 前，主持人派一个只读对账子任务（dir = 研究工作区），把账本 SYNTHESIS/SUBPROBLEMS/RECORD 里的全部关键数字映射到 `DATA_LEDGER.md` 台账行、`data/` 数据文件或脚本/结果产物；允许用工作区 venv 本地复算，禁止联网重抓与装包；「X 源核对」类声明对照台账核验；结果落账本目录的 `RECON.md`。主持人用 `note` 把未命中并进综述段（错得明确的修正，其余标「对账存疑」+置信度）；子任务失败或约 15 分钟无回报即跳过——收尾绝不被对账卡死。对账先于渲染，HTML 读的就是修正后的账本。默认（非研究）聊天室不获得该步骤：没有共享工作区就没有可映射的台账。
- 抓取指令在所有触达抓取者的面上显式绑定 playbook：研究 priming 的第 1 轮任务模板与第 2 轮深挖尾注、管家预取任务书、引擎注入的 research-gather 前缀（`chatroom.ts`）——优先 playbook 已验证配方（宏观/估值先查速查表匹配官方端点），无配方才用聚合器且登记台账。第 1 轮任务与 gather 前缀的绑定是无条件的：playbook 挂在 research-assistant persona 上（`chatroom-policy.ts` 装饰每个助手与管家会话），与共享工作区无关。
- 收尾回流清单新增 playbook 教训回流步骤；该契约在 books 仓库的 moderator `chatroom/CLAUDE.md`（persona 侧配对改动，随该仓库提交），在此记录使两半互相可寻。

## Alternatives considered

- **主持人自己核验。** 否决：让主持人远离研究的那条契约线正是编排保持廉价的原因；核验与 HTML 渲染一样走派发。
- **用户看完 HTML 后再对账。** 否决：HTML 是持久产物；修正必须落在渲染之前。
- **引擎层强制数字核验。** 否决：数字出处活在散文里；提示词层约定与抓取台账先例一致，遵从度照旧靠复挖会话日志度量。
- **在助手前言里硬性门控 playbook 阅读。** 前言已带「开工先读」bullet；实测的失败模式是转达的任务从没提它——绑定任务文本即可闭合该缺口，不需要新造一层强制。

## Testing

`engine-chatroom-gather.spec.ts`：对账腿断言门控——带研究工作区时含「数字对账」/「RECON.md」/「禁止联网重抓、禁止装包」/「对账存疑」，无工作区与默认 moderator priming 均不含；playbook 绑定断言在两种工作区形态的第 1 轮任务、管家任务书与第 2 轮尾注，以及引擎 research-gather 卡片正文（连同未变的连续短语「数据可靠性要求：让助手只用权威一手源」）。包内全套 25 文件 361 测试绿；包内 `tsc --noEmit` 干净。

## Consequences

对账实际运行的每场收尾多约 10–20 分钟（有界：只读 + 本地复算，失败或静默即跳过）；每轮 research gather 的角色消息多约 40 token。`RECON.md` 落按次账本目录、与 `summary.html` 同级——若日后有发布链路整体拾取账本目录的 Markdown，把对账产物改指研究工作区（此边界记录在案）。books 侧回流步骤与本次 priming 改动作为一对机制上线；playbook 本身只随后续场次执行新回流步骤而获得实战教训——审计场的腾讯个股 PE 坑在此之前保持未记录，这是用户明确圈定的范围。
