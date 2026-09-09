---
description: "飞书桥的 chatroom 层：多角色聊天室编排——角色组、主持人、/chatroom 命令族与 feishu_bridge_chatroom 工具——面向在一个飞书群里并行运行多个 agent 角色的团队。"
kind: "package-bundle"
---

# dsh-feishu-bridge-chatroom（中文）

[English](README.md) | 中文

## 概述

在一个飞书群里编排多 agent 聊天室：通过 `feishu_bridge_chatroom` 工具或 `/chatroom` 命令启动角色组或主持人，把一个问题扇出给所有角色并把回答汇聚成一份摘要，跑一轮闪电轮（`poll`）从每个未启动的人设各收一句廉价无工具表态——整个角色库每场都参与，而只有核心席保持常驻 agent（每条表态都会落成本次账本 RECORD.md 的出席行，开场轮先于 `start` 建账本结算时也能自愈落盘）——或让主持人跨独立角色会话驱动圆桌讨论——包括对运行中的角色中途引导（`ask` 带 `delivery: 'steer'`，gather 武装期间同样可用，回复仍算该角色的本轮回答）。裸敲 `/chatroom` 全程点选引导：有历史聊天室时先出开始方式卡（新讨论或继续最近几场），主持人在选择卡里推荐话题与角色——选题卡自带自由输入框，输入的题目直接进入角色挑选；`pick-roles` 在 picker 从未武装时（纯文本题目消息绕过了命令路径）会以 `topic` 参数自举——无推荐兜底角色卡在开场快答进行中与任何一次主持人唤醒后的整窗口内推迟发放（排序腿拥有完整超时），用户已动手点选后迟到的 `pick-roles` 原样丢弃、如实回报未生效，绝不谎称已渲染（`pick-topic` 遵循同一契约）——未显式给出模式的多角色启动前还有一张模式卡（普通讨论 / 研究·自动 / 研究·手动）——`--continue` / `--research` / `--mode` 保留为高级覆盖，显式给出即跳过对应卡片。角色以 dsh agent 运行，persona 来自 persona 目录的整体提示词替换；research 模式先跑一段有界澄清阶段，把用户背景与约束收进账本（最多两张追问卡，已收集的背景足够时可跳过），再向所有角色收一份纯判断的数据需求清单，由挂在 hub 下的数据管家把公共数据集一次性预取进共享研究工作区，再以每角色一个助手做角度化深挖，全程遵守抓取台账约定。聊天室跨次累积可共享资产：每个聊天室保有自己按次独立的账本目录（收尾时写入结束状态与 REPORT.md 结论文本；收官时 hub 自己的 spawn 群条目也随角色清理一并置 done——头像变灰），`history` 动作列出历史聊天室与共享研究工作区，`/chatroom --continue`（或 `start: inherit`）向新账本播种前情指针、由主持人甄别后才采信——共享材料是待验证的输入，不是既定事实。项目用 `enabled: false` 退出：命令消失、工具定义从该项目的模型请求中掩除、内置主持 skill 隐藏。

## 目录

- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

飞书桥的 chatroom 插件：多角色聊天室编排——角色组、主持人、`/chatroom` 命令族、`feishu_bridge_chatroom` 工具与内置 chatroom-moderator skill——作为独立的 dsh 包，挂载在 `@deepseek-ai/dsh-feishu-bridge` 旁（依赖方向：本包引用桥的导出面；桥绝不引用本包）。引擎接缝的两半走桥服务的 `feishuBridge/*` 事件；各引擎的配置与命令注册在插件启动扫描中应用，时机是桥报告就绪之后。配置了 `enabled: false` 的项目（本插件的 `defaults` 或其 `projects` 条目）没有 `/chatroom` 命令，其 agent 调 `feishu_bridge_chatroom` 会 fail loud，且工具定义与内置主持 skill 经桥服务的按引擎 deny 注册表从其会话的模型请求中掩除——skill 掩蔽在会话 workdir 落入其他启用项目 workdir 时（spawn workspace override、按群 `/dir`）依然成立。

<a id="model-experience"></a>
## 模型体验

### 模型看到什么

- `feishu_bridge_chatroom` 工具（family 标签 `feishu_bridge_chatroom`）：主持人通过其 actions（`start` / `ask` / `gather` / `poll` / `pick-roles` / `pick-topic` / `ask-human` / `end` / `list` / `note` / `history`）编排聊天室；角色 persona 通过整体提示词替换引用它。
- Chatroom persona：role、direct-role、moderator 与 research-assistant 会话以完整系统提示词替换运行，提示词由 persona 目录的扁平化 CLAUDE.md 加参与/研究契约组装（由 session-start-options 监听器预计算；adapter 将其注册为 `complete: true` section）。role 与 direct-role persona 另携带跨场记忆纪律段——完整替换会丢掉 dsh-memory 的策略段，纪律段是唯一教角色用 memory_* 工具沉淀跨场判断的提示词面；moderator 与助手不携带。每条主持→角色回合消息（串行 ask、普通 gather 与 research gather，全部走共享的 `askRoleInternal` 路径）追加一行固定的人设再锚定——一次性注入的系统提示词人设在长研究会话里会衰减成远端弱信号，而主持人的任务语域又把角色往研究运营腔里拉，每轮锚定是对冲。
- Moderator priming 与唤醒消息（gather 扇入摘要、end-barrier 收束、重启恢复 note），以及随 subtask 启动选项携带的 research-assistant 前言——同一份前言服务各角色助手与 hub 预配的数据管家，携带抓取台账、按角色数据目录、同域限速与按场运行目录草稿纪律；配置了 playbook 时还带「先读、只追加」的经验手册指针、uv 优先的共享 venv 装包指引与学术检索走 scholar skill 的路由。
- research 模式由 moderator priming 编排的流程：先跑有界澄清阶段——普通 gather 收各角色的用户背景问题，合并成一张追问卡，回答以「用户背景与约束」落进账本综述段（最多 2 轮；议题清晰且已注入背景足够时可跳过）；随后一次普通（非 research）gather 收各角色的数据需求清单；管家把合并后的公共数据抓进工作区 `data/core/` 并把每次抓取登记进 `DATA_LEDGER.md`；第 1 轮广播把各角色指向该台账，其助手只补缺口；后续轮次复用台账，裁决靶点点名分配、最多争议方加一位中立方各拉一路。所有抓取面（第 1 轮任务、第 2 轮尾注、管家任务书、引擎 gather 前缀）一律优先研究 playbook 的已验证配方、聚合器只作登记台账的回退；收尾在最后一轮与报告渲染之间加一段只读数字对账子任务（报告数字逐个映射台账/数据/脚本产物，只许本地复算，失败或静默即跳过）。
- 跨聊天室共享面：`history` 动作（历史聊天室——议题/结束状态/账本目录/报告——外加共享研究工作区，前提是其抓取台账存在）、`start: inherit` / `/chatroom --continue`（引擎向新账本播种前情指针，未点名角色时沿用前情阵容）、`note: section report`（REPORT.md 收尾结论）、两版 moderator priming 按条件携带的前情甄别与共享研究数据段、以及 ledger-read prompt 对 REPORT.md / 前情区的提及——前情区只是指针，被采纳的内容要经主持人综述才到达角色。讨论记录是分段日志：RECORD.md 超 64 KB 按行边界轮转进 `RECORD-<n>.md` 归档（归档先写——轮转中途崩溃最多把条目重复进下一号归档，不会丢），读指令把角色指向活动尾部、归档按需回溯。
- 内置 `feishu-bridge-chatroom-moderator` skill，作为隔离的 skill provider 挂载。

#### Token 影响

工具描述与 schema 到达启用该项目里每个 dsh agent（工具是进程级、按调用方路由的）；配置了 `enabled: false` 的项目把定义从其会话请求中掩除（adapter 在会话创建时 restrict 服务登记的拒绝名），内置主持 skill 的目录条目也一并离开（provider 以启用项目 workdir 为 cwd 前缀作用域挂载）。Persona 提示词整体替换各 chatroom 会话的系统提示词而非追加；moderator 唤醒与 relay 卡是用户可见消息，不进模型请求。research 模式用一次廉价的普通 gather 需求轮加一次管家预取，换掉原本各家助手重复抓取的轮次；priming 与 research-assistant 前言增长的是台账与限速纪律文本，role/direct persona 携带的跨场记忆纪律段给每个角色会话增加一小段固定文本；每轮人设再锚定给每条主持→角色回合消息增加一行短固定文本（它随回合文本走，加长的是消息历史而非稳定前缀）。工具描述与 schema 随 history 动作、inherit 参数、report section 与带 `round` 参数的 poll 动作增长；按条件出现的 priming 段（前情甄别、共享研究数据）与 persona 复用纪律只给携带它们的会话增加提示词文本。

#### KV Cache 影响

Chatroom 会话使用整体替换的 persona 提示词，因此每个 role/moderator 会话拥有各自稳定的前缀；工具 schema 会对桥自有 agent 的模型请求做扩展，叠加（而非使其失效）其可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **就绪前窗口**：桥的引擎启动到本插件 `whenReady()` 扫描之间平台投递的消息，会按默认值的 chatroom 配置处理（无 roles 目录覆盖、ledger 关闭）——这是桥内接线所没有的窗口。它结构性源于兄弟插件的挂载顺序；恢复及之后所有轮次看到的都是扫描后的配置。
- **工具掩码有启动窗口**：桥就绪到本插件扫描（登记按引擎 deny 掩码组、挂载带 cwd 前缀的 skill provider）之间创建的会话仍能看到 `feishu_bridge_chatroom` 定义与主持 skill 条目；它们的调用改在工具 execute 检查处 fail loud。扫描之后创建的会话两者都看不到。
- **内置 skill 按 cwd 作用域，跨项目场景由按引擎拒绝兜底**：主持 skill 的目录条目——其描述点名 `/chatroom`——本身就是行为入口（看得见它的模型可以加载并照做），因此 provider 以启用引擎的 base workdir 为 `cwdPrefixes` 挂载，且禁用分支同时在桥服务的按引擎 skill 掩码（`denySkills`）上登记该名字——禁用项目的会话即便 workdir 落在启用项目 workdir 之下（spawn workspace override、按群 `/dir`）也看不到条目。天花板：cwd 对启用侧仍是代理——启用项目的会话把工作目录切到别处会失去条目但保留命令与工具、共享同一 workdir 的两个项目无法区分、不带 cwd 的宿主面查询看不到任何作用域根。
- **禁用项目会话的 subtask 子会话仍可能列出主持 skill**：continuable-subagent 请求不带 skills 挂点，跑在启用项目 workdir 下的受派发子会话能看到目录条目；其继承的 `toolFilter` 仍拒绝 `feishu_bridge_chatroom`，照做该 skill 会在工具调用处 fail loud。
- **卸载插件丢失内存态聊天室状态**：已武装的 barrier 实例、未决串行提问条目、进行中标记与 gather 轮次戳都是进程内的；dispose 插件 fiber 即丢弃。持久化的 `featureState.chatroom` 段保留——各会话访问器就地写入，无 codec 的保存会原样持久化——重启恢复走持久化快照而非实例：barrier 携已收回复收束，恢复出的串行提问每条一次有界唤醒后退役（作答回合已随进程死亡）。
- **闪电轮只在引擎内存且边缘靠提示词纪律**：poll barrier 从不持久化（跟踪的一次性查询随进程消亡，重启恢复无物可续——主持人重新发起该轮）；收尾补盲只在主持人遵循 priming 指令时发生（无 `end` 时刻强制）；每条表态在配置的 `pollProvider` 路由或默认路由上跑完整 persona 会话——保留角色记忆连续性，代价是每个即弃会话一次 LLM 标题生成。表态唤醒与 gather 摘要同等有界；并发查询以 `pollMaxConcurrent`（默认 4）为帽，防止 13 人的库一次性扇出网关。
- **Picker 状态在内存**：daemon 重启会丢弃已武装的 picker；孤儿 pick 卡的下次点击会原位换成灰色过期卡并提示重新 `/chatroom`（Go 版对孤儿按钮是静默或假确认）。
- **引导式模式卡只覆盖多角色启动**：单角色确认直接进入 1:1 直聊（研究需要主持人编排）；研究自动模式不设轮数上限——卡片行写明，主持人自判图景完整才收尾；引导式「继续」原样沿用前情阵容——空前情阵容落回角色选择卡并丢弃前情，与显式 `--continue` 路径一致。
- **部署迁移是手动的**：生产 profile 在其自演化的 `cordis.patch.yml` 里把 chatroom 段放在 `feishu-bridge` 行下；桥现在会对这类残留 fail loud，需要把段迁移到本插件自己的配置（`defaults` + 按 `projects`、以桥项目名为键）。迁移片段与 profile 模板更新随 C3 部署批次落地。
- **REAL 组合面的覆盖**：apply/HMR spec 把插件挂在真实 Cordis 服务上（事件总线、工具注册表、skill 注册表、桥服务），但未经过 Loader 与 `cordis.yml`；走 Loader 的组合测试与生产 `/reload` 冒烟清单随 C3 落地。
- **用户参与可发现但不强制；收尾卡与群残留是既有行为**：hub 群的普通消息一直能中途到达主持人——就绪卡与 research 进度卡现在写明这一点；活动进度卡是 gather 状态的唯一投影，每 60 秒心跳刷新等待中的角色与已进行分钟数，密集的动态更新经 2 秒合并窗合并，终态立即落地，auto 模式 priming 指示每轮一条进展同步，中途发言并入下一轮或经 `ask` 转达。仍延后：auto 模式收尾 `ask_user_question` 无超时兜底（无限等待，daemon 重启即失效——过期卡提示还会让用户"用文字回答当前问题"，而问题已不存在）；`end`/`/chatroom stop` 停掉聊天室子树里的全部会话——角色、角色助手及其递归于会话、管家及其抓取子任务——但从不删除它们的飞书群（桥没有解散群 API），这些群只能手动清理。聊天室还在运行时在 hub 群发 `/done` 会转走同一中断路径（经桥的 `feishuBridge/pre-done` 接缝：屏障被消费、persona 标志被清、台账记为已中断、已清理的角色群被认领、桥自己的后代清理循环跳过它们）；已收尾的 hub 保持普通 `/done` 清理路径。
- **research 数据去重是提示词层约定**：抓取台账、按角色数据目录、同域限速与认领分区都活在 priming 与前言文本里——遵从是软性的，只能靠按记录基线复挖 research 聊天室的会话日志来度量（见 2026-09-02 Agent Note）；引擎层的兜底（单一调度器接缝、按域名抓取队列）保持延后。
- **跨聊天室共享是引擎簿记 + 提示词层甄别**：按次账本目录、结束行、REPORT.md 与 history/inherit 解析是引擎写入的事实，但甄别纪律（采纳前给前情判断分类、台账三列检查、独立源复核）活在 priming 与 persona 文本里——遵从只能靠复挖会话日志度量。角色项目记忆（按 persona workdir 跨聊天室积累）是另一条既有跨室通道，本设计未加闸——role/direct persona 携带跨场记忆纪律段（持久判断当场写、宁缺毋滥），写入遵从是提示词层约定，只能靠复挖会话日志度量。跨项目共享 = 两个项目把 `moderatorDir`/`researchWorkspace` 指到同一路径。并行聊天室的助手草稿由引擎簿记隔离：每个研究助手与数据管家拿到预建好的按场目录（`<researchWorkspace>/runs/<账本标记>/assistant-<角色>/`、`.../steward/`）并写进各自前言，工作区根目录的草稿名不再互撞；共享资产（venv、`data/core/`、`DATA_LEDGER.md`）仍留在工作区根。剩余毛边：同角色并行两场时 `data/<角色>/` 撞名、单一 `DATA_LEDGER.md` 的尾追加竞态、同角色跨场记忆 lost-update（dsh-memory 索引 upsert 是 last-write-wins——dsh-memory 通用并发事实，延后到该包处理）。共享 venv 的基础包清单可配置（`researchVenvPackages`；默认钉 `pandas<3`——akshare 依赖声明无上限而 pandas 3 会破坏它），每次研究启动对照 venv 内 marker 对账——后续扩充配置清单可热升级现网 venv，不动助手自装的包。`researchPlaybook` 让研究助手指向一份持久 playbook 文件、不随研究工作区归档消失：抓取前先读、把新跑通的数据源打法追加进去（与台账同款尾追加毛边）。并行 research 场数据源重叠还会放大单域抓取压力，应错峰。`--continue` 只在前情账本没记录阵容时才落到角色挑选卡；要覆盖前情阵容请显式点名角色。
- **两类聊天室关系有电平触发的静默监督**：hub↔数据管家关系，以及每个未决串行提问（gather 轮之外主持人对单角色的提问——提问身份路由为每次 ask 登记持久 `pendingSerialAsks` 条目）。关系静默超过 `assistantStallSec`（默认 1800 秒，0 关闭，非零下界 600）即收到监督唤醒——携带事实（谁、静默分钟数、最后回复摘录）与选项（催办/收尾或跳过/停止）；已声明的等待（任一侧打开的回合、停驻的 ask、在飞后台任务、已武装的屏障、等待中的助手汇报）不计时，只有关系的有机活动重置周期——对监督唤醒自身的答复不重置——连续三次唤醒无进展后熔断，改为每个窗口发一条可见群通知（2026-09-06 oc_97be4a1c）。全部状态每次扫描都从持久 `featureState` 推导：没有武装定时器，interrupt/结束翻掉主持人标志即停止，重启天然恢复。边界：角色↔助手等待不在此监督（其武装 gather 自带超时）；数据管家确已收工而主持人仍在 discussing 中静默的房间也会被判为 stall——叫醒主持人推进房间正是设计意图。
- **research 澄清卡与收尾卡同暴露**：auto 模式下澄清 `ask_user_question` 无超时兜底、等用户回答（与普通聊天室 3 轮澄清同暴露）；manual 模式下 research-manual 的 10 分钟 whole-ask auto-default 会按默认选项代答。
- **gather 超时先重挂一次屏障，再降级为自由转发**：第一次超时不销毁屏障，而是按 `gatherRearmSec`（默认 1200 秒）再等一个窗口并唤醒主持人告知重挂契约——未交角色的迟到回复继续走 gather 汇聚路径，全部到齐（或窗口耗尽）会再次唤醒主持人并附上届时的全部回复（2026-09-06 事故：4 份超时后 5-10 分钟落盘的迟到交付被提问身份路由判为过期 ask——只在群聊可见、不注入、不唤醒——监督网又花了 30-60 分钟才拉回）。窗口耗尽后才到的回复降级为重挂前的自由转发。每轮只重挂一次，总等待上界 ≈ 2× gather 超时；`rearmed` 标志持久化在 `featureState`，重启恢复仍一次性收束本轮——没有角色回合能在重启后存活，恢复的屏障不会重挂窗口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。聊天室的可变状态（featureState 段、armed barrier、picker）都存在 feishu-bridge 引擎的会话注册表里，并在被行使处校验——codec 投影/携带 spec 与 gather/end/recovery 套件钉住每条保存与重置路径；包在运行时没有自己的事件流。
