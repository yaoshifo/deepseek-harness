# Agent Note: 并行探索的单焦点广度判据

Status: implemented

[English](2026-09-03-single-focus-breadth-criterion.md) | 中文

## Problem

2026-09-03 dev 服务器的一个会话（飞书群 `oc_81b7ae794ae8ce01fb5a4efcebf18fe6`，glm-5.3，reasoning effort max）对一次 328 提交 / 32 PR 的上游合并审查做了全程串行探索——86 次 tool call 里 0 次子任务 spawn——而其落盘请求里每一面引导都可核实在场：system prompt 里的 2–5 角度句与执行顺序句、AGENTS.md 注入、32 工具目录里的工具。首轮 reasoning 把该审查归类为 "a single-focus investigation — one or a few git commands"，援引的正是例外句 "keep exploration serial only for a single-focus question one or two reads can answer"。该句按命令数判定单焦点：一个答案要覆盖整个仓库各子系统的审查，仍会被读成「几条命令能扫完」，于是例外压过了同一句前半段陈述的规则（repo-wide scan 即多个调查）。同一周里同一模型同一工具在更窄的多角度任务上正常 fan-out，缺口因此定位在例外句措辞，而非部署或模型能力。

## Decision

- 例外句改为按答案广度判定单焦点："keep exploration serial only for a single-focus question one or two reads can answer — judge focus by how many subsystems or directions the answer must cover, not by how few commands could skim it."
- 拆分清单增加显式类目："a repo-wide scan, cross-cutting audit, broad merge or release review, or a request naming several directions is several investigations"。
- 两处修改逐字落在全部五份副本：dsh-base bundle patch、bridge bundle patch（[bundle patch 所有权](../architecture/2026-09-01-feishu-bridge-plan-mode-guidance-in-bundle-patch.zh.md)）、三份 preset 副本。base≡bridge lockstep 门禁仍然只允许那一句委派句作为差异。
- `feishu_bridge_subtask` 工具描述增加执行期镜像句 "Judge independence by whether the groups span disjoint subsystems or directions, not by how few commands could chain them."——plan-mode 段在批准时卸载，工具描述在执行决策点承载该判据；`subtask-tool.spec` 钉住。
- `feishu-bridge-subtask` skill 的 frontmatter description 与排除段用中文陈述同一判据：单焦点按答案要覆盖几个子系统/方向判定，不看命令数；大合并审查、发布审查、全仓库扫描、横切审计不算单焦点。

## Alternatives considered

- **不改——模型的判断站得住。** 几条 git 命令确实能列出一个合并的表层，且该会话的计划本身是合理的分层串行。但已发布的契约（[调研并行默认化](2026-08-31-parallel-exploration-default-guidance.zh.md)、[批准后执行引导](2026-09-02-post-approval-parallel-execution-guidance.zh.md)）是广度型任务默认并行，而例外句措辞正是把这个情形与同一周的 fan-out 情形区分开的东西。
- **按提交数阈值强制大合并 fan-out。** 提示词里的硬阈值会偏离任务实际到达的形态；广度判据直接读任务形状。
- **按项目覆写提示词。** 重现 2026-09-01 bundle patch 收编已退役的按机漂移。

## Consequences

- `bundle-patch.spec` 钉住两个新短语并保持 lockstep 精确匹配；`subtask-tool.spec` 钉住执行期镜像句。
- 验收沿用 8-31 的多任务标准：在既有形状之外复放一个合并审查型任务——广度型审查应在一个 message 里 fan out 2–5 个只读 spawn；小合并保持串行是正确行为，不是失误。
- 部署随 link 包的 pull + `/reload`（双机；patch yml 与编译后的工具描述）；skill markdown 无需 reload 即时生效。dev 服务器需先走例行传播。
- 已知残余：措辞调整的是模型判断而非绑定；判据提升广度型任务的 fan-out 率但不保证每一次。按 8-31 抽样标准，多次复放仍是验收门。
