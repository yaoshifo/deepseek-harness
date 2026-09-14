# Agent Note: 执行两份 plan 模式审计的修复批次

Status: implemented

[English](2026-09-14-plan-mode-audit-fixes.md) | 中文

## 问题

两份 plan 模式实现审计（[2026-09-12 主审计](../../../../packages/acp/feishu-bridge/docs/plan-mode-audit-2026-09-12.md)，26 项发现；[2026-09-14 补充审计](../../../../packages/acp/feishu-bridge/docs/plan-mode-audit-2026-09-14.md)，F1-F9；均经复审勘误后为准）核出四族缺陷：

1. **引导面失真**：feishu-bridge-subtask skill 三处教 Go 时代工具名 `ExitPlanMode`（dsh 真名 `exit_plan_mode`）；宣称 plan mode 会拦截执行型 spawn（无任何机制，子会话被 `planMode.set(agent, false)` 强制关闭）；patch 的 plan-mode 段单层叙事与 agent-conventions 两层契约同请求矛盾；三处文案承诺强于实际校验。
2. **提交/命令层缺陷**：`EMBEDDED_DETAILS_HEADING` 单行正则对围栏内标题误拒、对 `##\n实施细节` 跨行误命中；`/plan` 重发把 queued/cancelled/noop 压成同一句「正在进入」；退出工具 guard 只读落盘状态与 `plan:policy` 的 `pending ?? logged` 口径不一（批准后同批次可开第二张评审卡）。
3. **渲染生命周期族**：非判决澄清文本杀在途 plan 渲染；去重哈希在渲染启动时记录（失败即永久跳过）；批准触发的 abort 把已写盘渲染记成 failed；attempt-1 临时目录泄漏；心跳 PATCH 与终态 PATCH 网络层乱序；挂起审批期间文本+附件组合中附件未 stage；两个死状态字段。
4. **记录与门禁**：README/note 携带已撤销机制的叙事；嫁接台账漏记 plan 源码改动；6 份 `expected.*` 样本停在 fork 前形态，web 回放门禁在 dev 上是红的。

## 决策

- 按复审更正的**三组文件互斥分组**并行执行（plan-mode 包 / bridge 引导面 / bridge 渲染生命周期），git worktree 隔离、每发现一个 commit、全程 TDD 先红后绿；组内顺带修复同族的清单外发现（09-01 note 失真叙事、reply 路径的 F4a 姊妹缺陷）。
- 拒绝门重写采**保守口径**：只做审计指定的四项（围栏跟踪含 CRLF 行尾容忍、`[ \t]+` ATX 空格、英文大小写不敏感、层级 2–6）；同义词/尾随内容漏网维持设计笔记钉定的 graceful degradation，作为边界测试钉住。
- #14 修法为在 routePermissionResponse 非判决分支补附件 stage（镜像 questions 路径），不加纯附件豁免（handleMessage 在 ask 路由前已拦截纯附件，豁免是死检查）。
- Wave 1.5 结构清理：Go 残留签名收窄；导出面收回按「测试算消费者」口径收回 12 个零消费者导出；两份渲染模板合并为共享片段 + 各自原序组装（两模板规则顺序互异，单 base + 占位符无法保 byte-identical），以合并前后 5 份渲染产物 `diff -r` 为空 + shasum 全等 + 四导出字符串逐一 `===` 为验收。
- 台账补三行 plan 源码嫁接（两层评审 / 拒绝门 / 压缩保留）与 36 份快照固定面成本。
- 样本刷新（Wave 2）在全部模型可见文案改动之后一次性执行，先刷新会造成二次返工。

## 考虑过的替代方案

- **拒绝门激进扩大命中面**（同义词 `## 实现细节`/`## Technical Details`、带尾随内容、粗体/缩进/引用形态全命中）。否：两份审计的修复范围都只列四项，设计笔记把不可识别形态定为 graceful degradation；扩大枚举集会把「教模型分层」变成「玩标题躲猫猫」。
- **#14 镜像 questions 路径的纯附件豁免**。否：纯附件在 handleMessage 就被 stage 并 return，到不了 ask 路由；镜像会新增一段生产不可达的死检查。
- **渲染状态机骨架合并**（09-12 #24）。否：该报告自评风险大于收益，09-14 虽列入 G4，按保守方裁定跳过；模板合并（84% 逐行重复）作为 09-14 新发现保留执行。
- **顺手修复并行会话的 typecheck 债**（engine-answer-delivery.spec 的 Message 强转、platform.spec 的 uuid 两处）。否：u5/u6 是 dsh-im 吸收批的进行中提交，归属其会话；本批次只修自己引入的 ProgressDrain stub 类型错。

## 后果

- 三组 + Wave 1.5 全部合入 dev：验收面 plan-mode 101/101、bridge 引导面 175/175、渲染生命周期 9 spec 285/285（合并后 4×232 稳定性验证）、结构清理 260/260；模板合并对拍零差异。
- 时序测试的教训（ProgressDrain flake，~1/4 概率）：fake-clock 固定次数前进无法驱动流程中的真实 fs I/O，负载下流程停在前置 await——条件驱动（可观测信号 + 真实时钟预算 + 负向对照）是这类测试的确定性写法。
- 遗留：client fixture 的 /plan 文案二分面未镜像新四路文案。tool-catalog 与新 EXIT_DESCRIPTION 的漂移已随目录按当前源码重生成关闭，两条 Windows-only pwsh 快照已由 d762ff098c 随其余 Wave 2 lane 一并刷新。
- Wave 2（6 份过期样本对齐 + 全量受影响 lane 一次刷新）以 d762ff098c 落地；本批次已在 origin/dev。
