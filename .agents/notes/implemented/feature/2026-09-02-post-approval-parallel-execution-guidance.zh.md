# Agent Note: 审批后并行执行引导

Status: implemented

[English](2026-09-02-post-approval-parallel-execution-guidance.md) | 中文

## Problem

2026-08-31 的引导让调研默认 fan-out，但计划审批通过后的实施仍保持串行——除非用户说「并行」。缺口是结构性的，已在代码中核实：`plan:policy` section 在 plan 模式退出的瞬间卸载（模式切换只换 prompt section），审批结果文本不含任何派发语义（"Plan approved — plan mode exited; carry out the plan starting with your next step."），而计划模板的并行组标注没有任何消费者——没有任何 surface 告诉 agent 在执行期兑现这个标注。执行顺序也没有任何持久载体：计划正文是 surface 内容、压缩时会被摘要掉，todo 列表没有再注入通道（模型只能通过自己过去的工具调用记录看到 todo）。

## Decision

- 三个 surface 陈述同一条边界——互不依赖的工作块默认并行、轻量单焦点保持串行：
  1. 全局指令（`~/.claude/CLAUDE.md`，即 `~/.dsh/AGENTS.md` 符号链接的真身）新增「并行推进」守则：已批准计划里标注独立的组在执行开始时一起派发，串行依赖的组自己按序实施，其他明显独立的多块工作同理。这反转了 2026-08-31 note 对 AGENTS.md 倾向的「量小、接受此缺口」判定——非 plan 面从此被有意覆盖。
  2. 计划模板的标注在两份有门禁的拷贝（bundle base patch + bridge patch）里升级为命令式执行顺序声明："state the execution order — independent groups dispatched together as parallel subtask spawns when execution begins, serially dependent groups executed in order"。执行策略成为用户审批的计划内容；`bundle-patch.spec` 钉住该句并维持 base≡bridge lockstep。
  3. 委派面陈述同一边界：`feishu_bridge_subtask` 工具描述新增审批后执行句（`subtask-tool.spec` 钉住），`feishu-bridge-subtask` skill 的 frontmatter description 与 plan-mode 段携带同一触发词。
- 分层原则：原则层（全局指令、skill、计划模板）只承载决策边界。机制——worktree 默认值与只读例外、派发节奏、gather 屏障——留在工具描述里，模型在 spawn 决策点读到的正是它。2–5 路上限是调研形状的护栏、只留在 plan-mode 调研句里；执行期 fan-out 广度由计划自身经用户审批的分组界定，不设数字。
- preset 不动：三份 preset 拷贝不在 fork 的 live 装配链（web-app 面）且已落后一版；base↔bridge lockstep 门禁覆盖 live 那一对。

## Alternatives considered

- **带持久状态的执行相位 prompt section**（新会话事件 + 折叠投影 + 下一次 `/plan` 时卸载的 `plan:execution` section）。机制上干净——`plan:policy` 本就按状态切换——但「执行结束」没有干净的日志信号（turn/end 太早、执行跨多个 turn；todo 完成是可选项；agent 自报需要新事件），而且状态机器（SessionEventMap → SDK 双投影、stateVersion、invariant）是在为一个文本问题服务。升级触发条件：若验收复放显示审批后仍串行，这成为第二阶段。
- **扩展审批结果文本**（plan-mode 的工具渲染）。一次性的 surface 文本、压缩即被摘要，上游产品文本被快照钉死，且 seam 归属错误——该行为属于委派而非 plan-mode。
- **无条件的全局推力（「尽量并行」）。** 在轻量工作上过度触发；每个 spawn 是完整 agent 会话。带单焦点例外的条件句措辞是安全阀。
- **只改全局指令。** 覆盖广度，但给不了用户审批的执行契约、也够不着 spawn 决策面；常驻全局文本还是注意力最弱的位置——工具描述与 skill 早已写着「并行」，执行照样串行。

## Consequences

- 部署：全局指令热重载、双端（dsh 与 Claude Code）即时生效，无需构建；dev 服务器的全局文件需手动同步。bridge patch 与工具描述随 link 包的 pull + `/reload` 生效（仅用户触发）；skill markdown 实时生效、无需 reload。
- 验收：不带「并行」复放四个形状——含 ≥2 独立组的 plan 审批流（首个执行 turn fan-out）、小计划/单组（不派发）、含两个独立 slice 的非 plan 直执行任务（fan-out），外加显式「并行」回归。适用 8-31 的采样标准：单次复放不构成证据。spawn 广度应与计划标注的组数一致。
- 已知残余：执行顺序活在 surface 上（tool call 参数里的计划正文），压缩后不保证逐字存活；持久解（落日志的计划事件或 runtime-context 再注入）推迟到文本层被复放证伪之后。todo 列表共享同一个再注入缺口与同一条推迟线。
