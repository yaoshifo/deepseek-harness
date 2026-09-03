# Agent Note: Cross-chatroom sharing shares pointers, adoption passes a screening gate

Status: implemented

[English](2026-09-03-feishu-bridge-chatroom-cross-sharing.md) | 中文

## Problem

聊天室之间没有可发现的共享资产：中间结果（ledger 三件套）按 `hashID(hubKey)` 目录隔离，end 后只是留在磁盘上——没有索引、新聊天室的 priming 不引用历史；收尾的文字总结只在群消息里，不落盘；「延续上次」只存在于选题 blurb 的文字层面。更糟的是实现调研发现：同一 hub 顺序开第二次聊天室会**整目录覆写**前一次的 ledger（`initChatroomLedger` 全量重写三件套），同群复用——最常见的模式——下历史根本留不住。同时，直接把前次综述/数据喂给新聊天室会让一次下载错误或错误结论跨室传播、代际累积，循环印证还会让错误显得「被多次验证」。

## Decision

三句话：**每室自持状态 + 读侧目录扫描；继承只写指针；实质内容进入新讨论必须经过一次显式甄别采纳。**

- **按次账本目录**：hub 状态加持久 `chatroomLedgerRun` 计数，第 2+ 次运行落 `<hash>-<run>` 目录（首跑保持 Go 布局，加性、存量兼容）；`chatroomLedgerDirFor` 读 hub 状态解析。修掉同群覆写。
- **引擎簿记**：收尾/中断向 SYNTHESIS.md 头部写 `- 结束：<时间>（已收尾|已中断）`（在 marker 之前，note 更新保留它）；`note` 加 `section: report` 落盘 REPORT.md。
- **发现**：工具新 action `history`——扫描 `ledgers/*/` 读头部（议题/角色/起止/状态）+ 探测报告文件，按开始时间倒序（目录 mtime 破同秒平局），外加共享研究工作区一节（`DATA_LEDGER.md` 存在时）。头部解析收拢为 `readChatroomLedgerHeader` 单一导出，写读共用一份格式。
- **指针式继承**：`/chatroom --continue[=<ref>]` 与工具 `start: inherit`（缺省取最近；精确目录名 → 议题子串，新→旧）。`initChatroomLedger` 只写固定文案的前情区（在 marker 之前）——**不读不抄前次内容**。未点名角色时默认沿用前情阵容（避免把 inherit 穿过 picker 状态机）。内容缺失/手改的边界随指针化消失。
- **甄别闸（防错误传播）**：两版 moderator priming 前情段——先 Read 前情逐条分类（直接采信/复核后采信/存疑/推翻），采信部分 note 进综述并标注来源；复核用**新的独立证据**（复读同一批数据是循环印证）；错误用「修正：」显式留痕；单跳继承不传递累积。研究侧：persona 的「先查再拉」升级为「先查再甄别再拉」（台账三列判适配、关键数据 spot-check、可疑重下登记新行），研究版 priming 第 2 轮任务同步。
- **可见性**：普通（非 research）聊天室的 priming 在工作区有台账时加共享研究数据段——历史研究下取的数据对普通讨论可见了。

## Alternatives considered

**共享 `INDEX.md` 索引文件。** 否决：与 `ledgers/` 目录构成双事实源（漂移）、跨室写竞争；状态行写进各室自己的 SYNTHESIS.md + 读侧扫描后，事实源唯一。

**继承时整段复制前次综述。** 否决（v2 设计，被用户质疑后撤回）：未甄别内容静默流入每个角色的上下文（角色被要求「回答前先读账本」，必然把前情当图景）；指针 + 显式 note 采纳让污染必须经过一次显式动作。

**自动继承/按议题匹配自动引用历史。** 否决：上下文污染与议题漂移；显式 `--continue`/`inherit` 与 `history` 查询足够。

## Consequences

共享模型 = 引擎写事实（目录/结束行/REPORT/解析），甄别纪律活在 priming/persona 文本里（compliance 只能复挖会话日志度量——与既有 research 去重约定同级）；角色项目记忆是另一条既有跨室通道，本设计未加闸（deferred）。跨项目共享 = 配同 `moderatorDir`/`researchWorkspace`（撞名与无锁追加已知）。模型可见文本钉在包内 spec（本包惯例：priming/persona/tool 文本全由包 spec 断言；顶层快照树零 chatroom 覆盖，未新增 recorded-session 快照）。验证：包内 280 测试全绿（新增 ledger 17+sharing 10+tool 6+priming/persona 5），`tsc -b` 包级干净。
