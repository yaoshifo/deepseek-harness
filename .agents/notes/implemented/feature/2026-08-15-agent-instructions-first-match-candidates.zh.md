# Agent Note: 指令候选的每目录首个命中选择

Status: implemented

[English](2026-08-15-agent-instructions-first-match-candidates.md) | 中文

## 问题

`@deepseek-ai/dsh-agent-instructions` 会加载每个项目目录中 `instructionFileCandidates` 的所有现存条目，仅按目录折叠去首尾空白后内容相同的文件（见 [workspace context](../../implemented/feature/2026-06-24-workspace-context.zh.md)；语义归 `packages/context/agent-instructions/src/config.ts` 与 `src/files.ts` 所有）。部署因此无法表达偏好顺序：默认 `['AGENTS.md', 'CLAUDE.md']` 下，内容不同的两个同级文件都会渲染，任何排序都压不掉靠后的那个。

cc-connect 桥接 profile（本仓库之外的 `dsh-cc-connect-bridge` 仓库）在 2026-08-15 遇到了这一点：它希望两文件并存时 `CLAUDE.md` 胜出，同时只有 `AGENTS.md` 的项目仍由 `AGENTS.md` 兜底。配置表达不了这层意思，该 profile 只得钉死 `instructionFileCandidates: ['CLAUDE.md']`，于是所有只有 `AGENTS.md` 的项目悄悄失去了项目级指令。

## 决策

经校验的 `agent-instructions` 配置字段 `candidateSelection: 'all-existing' | 'first-existing'` 选择每目录的候选选择规则，对 `instructionFileCandidates` 与 `localInstructionFileCandidates` 生效同一规则。默认 `all-existing` 的行为与全量加载逐字节一致，含按目录的内容去重。

`first-existing` 下，每个目录在一份列表中至多贡献一个文件：命中最早现存的候选（常规文件，跟随末段符号链接，探测方式与 `all-existing` 相同）即加载，该目录中更靠后的候选无论内容一律跳过。去重仍然运行：base 列表胜者与 local overlay 胜者去首尾空白后内容相同时，折叠到较早的那个。协调在每一轮重新执行目录级胜者判定：删除首选候选会把下一个现存同级文件提升上来，新建首选候选会移除此前加载的同级文件。`workspaceBaselineIdentity` 携带该字段，模式翻转会在 resume 时取代可见基线。用户全局槽位 `$DSH_HOME/AGENTS.md` 不走候选选择，保持不变。

请求方部署随后配置 `['CLAUDE.md', 'AGENTS.md']` 加 `first-existing`（overlay 配 `['CLAUDE.local.md', 'AGENTS.local.md']`）。

## 备选方案

**保持只配 `['CLAUDE.md']`，并在只有 AGENTS.md 的项目里补 `CLAUDE.md → AGENTS.md` 软链。** 不作为长久之计：它一次改一个无关项目的文件树、永无止境，每个只有 AGENTS.md 的新项目都要重做一遍，漏做时没有任何信号。

**沿用默认 `['AGENTS.md', 'CLAUDE.md']` 并依赖内容去重。** 否决：去重只折叠内容相同的文件，内容确实不同的同级文件仍会双份注入，这正是请求方部署拒绝支付的成本。

**由桥接层的旁路插件过滤已注入的指令消息。** 否决：`agent-instructions` 在组装自身投影之处拥有选择权；从外部拦截组装好的消息，等于把决策重新实现在无法强制执行的位置，并与投影队列竞态。

**在包内硬编码文件名别名表。** 否决：把工具特定的别名烧进代码是隐性默认；选择策略属于显式、经校验的配置。

## 后果

请求方 profile 下，同时持有 `CLAUDE.md` 与 `AGENTS.md` 的目录只渲染 `CLAUDE.md`，只有 `AGENTS.md` 的项目保留其指令；其它部署的默认行为不变。协调敏感度变宽：`first-existing` 下目录内任一候选的变化都可能改变胜者，目录级重选会探测每个被监视的候选而不只此前加载的那个，且跳过重新探测被去重同级文件的 baseline 排除快速路径在该模式下不适用。该字段为必须给工具特定文件名排序的部署而存在；若各生态最终收敛到同一个指令文件名，它将休眠且没有退役触发点。

## 测试

`packages/context/agent-instructions/tests/agent-instructions.spec.ts` 的单元测试覆盖每列表的首个命中选择、overlay 独立性、删除提升、新建压制与模式翻转的基线替换；既有测试套件不改而全部通过，锁定 `all-existing` 的逐字节一致。keyless 快照 `examples/headless-agent/tests/workspace-context-resume.snapshot.ts` 通过真实 Loader 组合演练两条路径：模式翻转取代已种入的基线，新建首选候选在 resume 时压制已加载的同级文件。
