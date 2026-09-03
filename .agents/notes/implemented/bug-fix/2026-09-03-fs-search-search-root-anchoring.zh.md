# Agent Note: glob/grep 模式锚定在搜索根

Status: implemented

[English](2026-09-03-fs-search-search-root-anchoring.md) | 中文

## Problem

2026-09-03 一个 feishu-bridge 会话连续三次 `glob` 调用对确认存在的文件返回 `No files found`：`path=/Users/hm/.claude/skills` + `pattern=html/**`、`path=…/packages/acp/feishu-bridge` + `pattern=skills/*/SKILL.md`、`path=…/packages/acp/feishu-bridge-chatroom` + `pattern=src/**/*.ts`。机制（对打包 rg 实测 R1–R8 验证）：工具把 pattern 原样传给 `rg --files --glob=<pattern>`、搜索根作为尾部 `-- <path>` argv 元素，spawn cwd 钉在 session cwd。ripgrep 的 `--glob` 候选路径形式由 path 参数形式决定——绝对 `path` 产生绝对路径候选、相对的产生 cwd 相对候选——相对 pattern（每个模型都带的 Claude Code Glob/Grep 惯例）在两种形式下都匹配不到任何东西。两个加重因素：`~` 前缀的 pattern 与 path 原样进 argv（无 shell 层展开），且绝对形式 pattern 在 globset 下不可靠（前导 `/` 的处理使其失配），模型手工展开 `~` 依然得到静默空。修复前唯一可靠用法是「不传 `path` + pattern 带 cwd 完整前缀」——一旦使用 `path` 必然空结果，与参数存在意义自相矛盾。缺陷继承自上游（`e0f20088d8` 引入钉死 cwd；`18700f428d` 定型 argv 形态）；上游 master `49a606bc5b`（0.1.2-alpha.5，2026-09-03 核实）仍带全部三个缺陷，fork 自 merge-base 起只改过 grep 的 description 文案。

## Decision

- rg 的 cwd 现在钉在搜索根：`runRipgrep` 接受 `spawnCwd`（缺省 session cwd），`buildGlobCommand` 不再把 `path` 放进 argv。pattern（及 grep 的 `include`）因此相对搜索根匹配——即 `path` 参数、缺省会话工作区——与模型既有的 Claude Code 语义一致。
- `resolveSearchRoot`（search-core）锚定搜索根：单独的 `~` 与 `~/` 前缀按 home 目录展开，相对路径 join session cwd，绝对路径原样通过。
- `resolveGlobPattern`（glob）以同样方式锚定 pattern：`~/` 前缀 pattern 先展开；搜索根内的绝对 pattern 剥离为根相对形式；pattern 恰为搜索根时折叠为 `**`；搜索根之外的绝对 pattern 抛普通参数错误并指向 `path` 参数——静默空会被读成「文件不存在」。
- grep 的文件 `path` 从其父目录运行、basename 置于 `--` 之后（不存在的路径走同一形态，由 rg 在报错中点名）；目录 `path` 与 glob 一样在根上运行。
- 两个工具都把 rg 的搜索根相对输出在返回前重新锚定到 session cwd：工作区内相对、工作区外绝对——每个返回路径都保持可被 `read` 后续读取。
- 「搜索根位于 VCS 目录内」的排除从 argv 的 `!**/.git/**` glob（rg 的 cwd 移到根后候选失去 `.git/` 前缀，该 glob 不再触发）改为前置的路径段检查并返回空结果；`RipgrepRun.workdir` 失去最后一个消费者，已删除。

## Alternatives considered

- **只文档化旧语义而不改行为。** 旧语义不是单一语义：候选随 `path` 形式在绝对与 cwd 相对之间漂移，任何文案都无法自洽陈述，而模型直觉（pattern 相对 `path`）会继续踩坑。
- **内部把 pattern 重写为 `<path 前缀>/pattern`。** 死于绝对形式：绝对 `--glob` 在 globset 下永不匹配，bug 的绝对 `path` 一半原样保留。
- **保留 argv 根并让 rg 匹配绝对候选。** rg 没有改变 `--glob` 匹配基准的选项；cwd 是唯一杠杆。

## Consequences

- 测试：integration.spec.ts 钉住三个事故形态（绝对/相对 `path` + 带分隔符 pattern、工作区外搜索根返回绝对可读路径、绝对 pattern 的剥离/拒绝/即根）与 grep 的带分隔符 include、绝对文件目标；tools.spec.ts 钉住解析纯函数、spawn cwd 在根上的 argv 契约、重新锚定的输出。
- 快照：四个参数 description 改了 model-visible 文本，37 个快照文件（tool-schemas.expected.json 与 system-prompt.expected.md）做了机械替换，docs/tool-catalog.md 重新生成。16 个 SDK 回放快照通过 worktree 软链的 node_modules 加载主树构建的 lib，因此要到干净构建环境（CI）里验证；session-sandbox-root 与 PTY 类快照失败在本会话沙箱下于未改动的主树上同样预存。
- 修复前的可靠形态（pattern 带 cwd 完整前缀再加 `path`）现在返回空——pre-release 立场下的有意破坏性变更；description 写明了新锚定。
- 部署：host 构建 + `/reload`；下一个带 `path` 与相对 pattern 的会话就是活体验证信号。
- 若上游后来修复同一缺陷，下次吸收会在四个源文件、快照 expected 与 README/tool-catalog 配对上撞到本改动。裁决者是本包测试套件——合并后跑 `node_modules/.bin/vitest run packages/fs/tool-fs-search/tests/`：绿说明上游修复覆盖钉住的事故形态（采纳上游文本、保留我们的测试），红说明其更弱（保留本实现、吸收其余改动）。tool-catalog 靠重新生成收敛；快照 expected 按胜出的实现做同款机械 description 替换。merge-tree 预演与冲突归属的通用流程见 `dsh-sync-upstream`。
