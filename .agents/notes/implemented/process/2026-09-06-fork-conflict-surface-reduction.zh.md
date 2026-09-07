# Agent Note: Fork 冲突面收敛波

Status: implemented

[English](2026-09-06-fork-conflict-surface-reduction.md) | 中文

## Problem

2026-09-06 的 dev×master 审计（dev 领先 master d347e70390 共 706 个 fork 提交；新增 1074 个文件、修改 381 个上游文件）确认落位原则有效——fork 本地包在近两次同步的双边交集（88 与 193 个文件）中零出现——并把持续性合并成本定位到一批结构性错位上：tsconfig 重复引用死块、plan 引导散文嫁接在四个上游文件、四个被上游门禁拒绝的空 invariant companion、主 lane 退回后仍残留原生解析的四个 vitest lane、三处漂移被 `as` 强转静默吸收的陈旧 adapter 切片、AGENTS.md 里的无关措辞编辑，以及原则 2 要求提上游的嫁接改动没有常备清单。

## Decision

十二个提交落地本收敛波：

1. **减法**——session-controller 的 tsconfig 引用块合并回上游原序加唯一真实的 mcp-workspace 引用（-76 行）；AGENTS.md 三处无关润色回退；根目录 chatroom 抽取计划底稿删除、已提交的 htmls/ 产物退出跟踪。
2. **空 invariant companion 拆除**（feishu-bridge、feishu-bridge-chatroom、mcp-workspace、tool-subagent-report）；每对 README 记录包特定的省略理由；`verify-package-invariants` 转绿。
3. **plan 引导搬移**——三个 preset 文件与 base bundle patch 回到上游逐字原文；bridge bundle patch 持有 fork 引导，lockstep spec 钉住恰好三个 delta：经 `feishu_bridge_subtask` 的并行探索、并行/串行组标注、拒绝后的讨论轮。非 bridge 组合重新看到上游引导；bridge 部署行为不变。
4. **vitest 归一**——五条 lane 全部经 `vite-tsconfig-paths` 解析；2026-08-27 note 如实记录两步退回；development/testing 的工具链偏差文档段与配对记录回到上游。
5. **mcp-workspace 缺席警告**改走 scoped logger（入口组合点同款通道），快照 harness 的十六行特判收敛为空 stderr 断言。
6. **切片编译期 conformance**——`src/agent-dsh/conformance.ts` 把每个手写 `*Like` 切片钉到真实导出服务；随之修正三处陈旧切片（persistence list 签名、subagent prompt/content/source 擦除）。上游签名漂移从此在 typecheck 炸而不是经静默强转上线——flat/wrapped SessionEvent 事故的类别。
7. **auto-compress** 改由 `contextPressure.projectedTokens` 触发——与 /context 卡同源的 provider 锚定占用、压缩落地即回落——删除 chars-per-rune 的第二套 token 账（[feature note](../feature/2026-09-06-feishu-bridge-auto-compress-projection-source.zh.md)）。
8. **dsh-context 溯源修正**——aggregate/chartspec 移植头注明真实来源：bowenliang123/dsh-context，live profile 直链的独立仓库，从来不是本仓的工作区依赖。
9. **上游嫁接台账**落在 sync skill 的 references，由 fork-policy notes 指向：每处坐在上游拥有 seam 上的 fork 改动及其提案状态，原则 2 的工作量从此可见、上游等价物落地即删行。
10. **mcp-workspace 经 setup seam 挂载 continuable 子代理**——包自注册 `registerContinuableSetup` 贡献者（seam 扩展为 async；被 await 的子插件必须先于首个 prompt 装配安装），subagent 与 in-process-driver 两包去掉对该 fork 本地包的直接依赖。one-shot 挂载留在 child-agent 的本地最小接口后，由 mcp-workspace 的集成特征测试钉住（[architecture note](../architecture/2026-09-06-mcp-workspace-continuable-setup-contribution.zh.md)）。

## Alternatives considered

- **继续嫁接。** 每次吸收照付每处嫁接；审计的双边交集已为现状定价。
- **立即全部提上游。** seam 提案是治本但属对外分批动作；本波清掉一切无需提案即可消除的项。pilot（acp 竞态修复）与 S 级批仍在台账排队。
- **直接 import dsh-context。** 跨仓、非工作区依赖；profile 链接成不了仓库依赖。

## Consequences

- 十三个上游文件回到零 fork 差异（修改面 381 → 368；docs 54 → 48）：presets、development/testing 对及其配对记录、四处 companion 接线、harness 特判。
- 非 bridge 组合（headless 演示）重新看到上游 plan 引导；无 mcp-workspace 部署的 continuable 子代理不再警告——上游包不再知道这个可选特性的存在。
- conformance 文件把下一次上游签名漂移变成 typecheck 失败而非静默运行时变化；one-shot 挂载经 mcp-workspace 集成 spec 获得同等保护。
- 每次 vitest 运行顶部重现迁移警告：工具链对齐的已接受成本。
- 剩余结构项等同一个上游 seam——通用 agent-setup contribution——它落地时一并退休 one-shot 挂载、session-controller wrap 与 duck-typed 接口。
