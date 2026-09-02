# Agent Note: Full-suite fork-drift audit after the 08-26..09-06 syncs

Status: implemented

[English](2026-09-07-full-suite-audit-fork-drift.md) | 中文

## Problem

08-30 的全量绿跑是 08-31 与 09-06 两次上游同步前最后一次完整测试；两次同步都只用定向检查做了验证。2026-09-07 的四套件全量跑出 86 个失败：41 个真实失败（九类根因），外加 45 个来自 agent 会话文件沙箱的假阳性（HOME mkdtemp、posix_openpt、`/bin/ps`、嵌套 sandbox-exec）——会话内全量跑的观感远比仓库实际状态糟糕。

## Decision

九类根因已在 dev 上全部修复。持久事实与后续规则：

- 金样漂移是主因。上游行为变更（默认模型 v4-pro → v4-flash、ACP 初始化的 `config_option_update` 推送、`list_agents` 状态图例、`read_image` 无扩展名路径描述、`cwdOverride` provider 能力位），或 fork 特性落地时未刷新金样（mcp-workspace 一次性警告 stderr 行，15 个测试），都会让 `test:expected` 与 `test:snapshot` 保持红，直到跑一次 keyless 的 `DSH_SNAPSHOT=refresh` 并按已知变更类别逐 diff 复核。内联 stderr 断言（如 `expect(result.stderr).toBe('')`）刷不动，需随行为一起改。
- fork 本地资产必须跟上随合并进来的上游门禁：六对 README 缺 doc-standard 的 frontmatter 与骨架（含组级 README——两级扫描会漏掉它），115 个 session fixture 停在旧 packed 布局——`migrate:packed-session-fixtures` 是规定的机械修复。
- 归因方法：把失败文件在提权沙箱模式下重跑；那里能过的属于环境，仍然挂的才是真实问题。会话内 `pnpm run test` 还会撞 pnpm store 的 SQLite 拒绝——直接调 `node_modules/.bin/vitest`。refresh 也必须提权跑，否则沙箱拒绝文本会被烘焙进金样。
- 发现但有意不在本次修的缺陷：`DSH_SNAPSHOT=refresh` 把 `sourceEventSeqs` 以 packed-range 形式写回，与规范枚举布局相抵触——每次 refresh 后重跑迁移脚本（上游相关）；node 24.3.0 的 `fs.glob` 在 `**` 加快照 prompt 符号链接上崩溃（上游带同样的符号链接；失同步的 `2026-08-31-parallel-exploration-default-guidance` 配对已由[staged-sides 钩子笔记](../process/2026-09-02-pre-commit-pairing-covers-staged-sides.zh.md)重新记录）；e2e 的子路径行加载构建产物 `lib/`，源码改动要先重建包才会反映到 e2e。
- 防再发规则：上游同步的验证必须包含 `test`、`test:expected`、`test:snapshot` 与无 key `test:e2e` 各一次全量跑。定向检查让漂移跨三次同步静默累积。[suppression 接缝笔记](../architecture/2026-09-07-agent-instructions-suppression-host-plane-service.zh.md)记录了本次审计逼出的唯一一个架构决策。

## Alternatives considered

**同步后继续用定向检查验证。** 证据否决：三次同步累积了 41 个失败，任何定向门禁都没有察觉——每类根因都活在定向检查没摸到的面上（金样、README 门禁、preset 挂载）。

**在审计批次内顺手修掉发现的缺陷（refresh 写回、node glob 崩溃、过期笔记对）。** 暂缓：每项要么上游相关、要么独立于九类根因，捆进来会让本已很大的批次更大；上文已记录它们，下一次全量跑可以据此区分新漂移与已知缺陷。

## Consequences

四套件重新全绿（会话内跑会看到的沙箱假阳性除外），同步流程多了显式的全量义务。规则的代价是每次同步多一段较长的验证；审计已经展示了跳过它买到什么——三次同步的静默金样与门禁漂移。
