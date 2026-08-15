# Agent Note: 指令候选的每目录首个命中选择

Status: proposed

[English](2026-08-15-agent-instructions-first-match-candidates.md) | 中文

## 问题

`@deepseek-ai/dsh-agent-instructions` 会加载每个项目目录中 `instructionFileCandidates` 的所有现存条目，仅按目录折叠去首尾空白后内容相同的文件（见 [workspace context](../../implemented/feature/2026-06-24-workspace-context.md)；语义归 `packages/context/agent-instructions/src/config.ts` 与 `src/files.ts` 所有）。部署因此无法表达偏好顺序：默认 `['AGENTS.md', 'CLAUDE.md']` 下，内容不同的两个同级文件都会渲染，任何排序都压不掉靠后的那个。

cc-connect 桥接 profile（本仓库之外的 `dsh-cc-connect-bridge` 仓库）在 2026-08-15 遇到了这一点：它希望两文件并存时 `CLAUDE.md` 胜出，同时只有 `AGENTS.md` 的项目仍由 `AGENTS.md` 兜底。配置表达不了这层意思，该 profile 只得钉死 `instructionFileCandidates: ['CLAUDE.md']`，于是所有只有 `AGENTS.md` 的项目悄悄失去了项目级指令。

## 提案

为 `agent-instructions` 增加一个经校验的配置字段，选择每目录的候选选择规则，对 `instructionFileCandidates` 与 `localInstructionFileCandidates` 生效同一规则：

```ts ignore-check
interface Config {
  // existing fields unchanged; default preserves today's behavior
  candidateSelection: 'all-existing' | 'first-existing'
}
```

`first-existing` 下，每个目录在一份列表中至多贡献一个文件：命中最早现存的候选（常规文件，跟随末段符号链接，探测方式与今日相同）即加载，该目录中更靠后的候选无论内容一律跳过。默认 `all-existing` 的行为与今日逐字节一致，含按目录的内容去重；`first-existing` 下去重被包含——每目录每列表至多加载一个文件。用户全局槽位 `$DSH_HOME/AGENTS.md` 不走候选选择，保持不变。

`workspaceBaselineIdentity` 加入该字段，使 resume 能察觉语义变化——与它已经覆盖的候选列表优先级变化同理。协调所需的 scope 集合本就按目录监视每个已配置候选名，所需文件事件已经到达；选择规则只是在协调变更目录时增加目录级的胜者判定。

请求方部署随后配置 `['CLAUDE.md', 'AGENTS.md']` 加 `first-existing`（overlay 配 `['CLAUDE.local.md', 'AGENTS.local.md']`），时机是某个 `dsh-base` 发布携带该字段，或其 profile 链接工作区构建。字段与取值的确切命名留待实现定夺；上文的选择语义是本提案的承诺。

## 备选方案

**保持只配 `['CLAUDE.md']`，并在只有 AGENTS.md 的项目里补 `CLAUDE.md → AGENTS.md` 软链。** 不作为长久之计：它一次改一个无关项目的文件树、永无止境，每个只有 AGENTS.md 的新项目都要重做一遍，漏做时没有任何信号。

**沿用默认 `['AGENTS.md', 'CLAUDE.md']` 并依赖内容去重。** 否决：去重只折叠内容相同的文件，内容确实不同的同级文件仍会双份注入，这正是请求方部署拒绝支付的成本。

**由桥接层的旁路插件过滤已注入的指令消息。** 否决：`agent-instructions` 在组装自身投影之处拥有选择权；从外部拦截组装好的消息，等于把决策重新实现在无法强制执行的位置，并与投影队列竞态。

**在包内硬编码文件名别名表。** 否决：把工具特定的别名烧进代码是隐性默认；选择策略属于显式、经校验的配置。

## 验收标准

- `first-existing` 下：同时持有 `CLAUDE.md` 与 `AGENTS.md` 的目录只渲染 `CLAUDE.md`；只有 `AGENTS.md` 的目录渲染 `AGENTS.md`；两者皆无的目录不渲染；本地 overlay 对遵循同一规则；`all-existing` 的输出与今日逐字节一致，既有测试不改而通过。
- 实时协调：删除某目录的首选候选会把下一个现存同级文件提升为更新后的指令集；新建首选候选会压制此前加载的同级文件。
- 模式变化时 `workspaceBaselineIdentity` 随之改变，且 resume 的优先级变化快照增加一个模式翻转用例。
- 同一变更内更新配置目录与两份包 README，并按测试政策通过真实可运行示例的无 key 快照覆盖该选择行为。

## 风险

- 为单一外部消费者给已发布的包增加一个配置字段；若各生态最终收敛到同一个指令文件名，该字段将休眠且没有退役触发点。
- 协调敏感度变宽：`first-existing` 下目录内任一候选的变化都可能改变胜者，目录级重选必须考虑每个被监视的候选，而不只是此前加载的那个。
- 命名会引来争论；本 note 固定的是语义而非拼写，实现 PR 一次性定名。
