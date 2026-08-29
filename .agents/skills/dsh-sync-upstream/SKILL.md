---
name: dsh-sync-upstream
description: "Use when syncing the GitHub upstream (deepseek-ai/deepseek-harness) into the fork's secondary-development branch dev — triggers include 「同步上游」「master 有更新」「合到 dev」「sync upstream」「merge upstream into dev」. Guarded routine fork maintenance: preview, merge, verify, confirm, push."
---

# DSH Sync Upstream

把上游 deepseek-ai/deepseek-harness 的更新安全合入二次开发分支 dev 并推送。步骤顺序本身就是护栏，具体命令可按情境调整，但三处硬约束不可跳：**合并前必须预演过、验证绿了才推、推送前必须用户确认**。

## 分支约定

- `master`：跟踪 `upstream/master`（deepseek-ai/deepseek-harness），只 fast-forward，不做开发
- `dev`：二次开发分支，日常改动都在这，跟踪 `origin/dev`（fork）
- 完成产物：dev 吸收 master 全部提交；typecheck + 聚焦测试绿；`origin/dev` 与 `origin/master` 均已推送

## 步骤

### 1. 预检与测量

dev 工作区干净、与 origin/dev 同步后 `git fetch upstream`，量三个数：

- `master..upstream/master`：上游新提交，>0 则先在 master 上 `git merge --ff-only upstream/master`
- `dev..master`：master 上 dev 未吸收的提交——**用户说「master 有更新」通常指这个量，不是上一个**
- `master..dev`：dev 本地提交数（本次合并要保护的改动面）

同步窗口 = merge-base 提交日期 → upstream/master tip 日期。报规模用三件套：rev-list 总数 + `--first-parent` PR 合并数 + merge-base 日期。上游高velocity（约 18 个 PR 合并/天）且用合并队列/集成分支批量推进 master，隔几天同步出 700~1100 提交是正常水位——先按此校准，再谈异常。报数字前确认三处一致：本地 dev 的 merge-base、`git fetch origin` 后的 origin/dev、`ssh dev` 查 dev 服务器（并行会话/双机可能已同步而本地不知）。

**成功标准**：三个量都已知，明确本次要合多少提交，且同步窗口的起止日期向用户如实报告。

### 2. 零副作用预演

`git merge-tree --write-tree --name-only dev master`

exit 0 且只输出一个 tree oid = 零冲突。有冲突则列出文件、判断归属（fork-local 还是双方共享改动），拿不准停下问用户。

**成功标准**：零冲突，或冲突面已评估并经用户同意继续。

### 3. 合并

dev 上 `git merge master`。用 merge 不用 rebase：保留 dev 已推送的提交历史、免 force-push 公共分支。

**成功标准**：出现 `Merge branch 'master' into dev` 提交。

### 4. 依赖、再生成与 typecheck

`CI=true pnpm install`（CI=true 必带，见 Gotcha 1）→ **跑全部五个生成器** → `pnpm run typecheck`（会顺带构建部分包，属正常）。

生成产物（api-catalog、config-catalog、tool-catalog、图文档、client slot-catalog）的冲突解法是取一侧后靠再生成收敛，fork 本地包会自动回到生成结果：

```sh
pnpm run gen-cordis-api        # packages/extensions/tool-cordis/src/api-catalog.ts
pnpm run gen-config-catalog    # docs/config-catalog.md
pnpm run gen-tool-catalog      # docs/tool-catalog.md
pnpm run gen-doc-graphs        # docs/ 事件矩阵等 8 个图文档
pnpm run gen-client-catalog    # cordis-client-runner 的 slot-catalog（易漏，漏了到 doc-sync 才炸）
```

生成后中文对侧（`.zh.md`）按需回填 fork 段落，再 `pnpm run verify-translation-pairing --write <owner.md>` 重写受影响配对记录——pre-commit 的暂存配对检查用**暂存内容**比对，改完必须重新 `git add`。

**成功标准**：三条命令 exit 0，生成器无一遗漏。

### 5. 聚焦测试与 fork seam 自查

归纳 dev 改动面包：`git diff --name-only master...dev | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn`，对改动面包跑 `pnpm vitest run <packages/... 路径>`。上游那批提交的上游 CI 已验证过，风险面只在 fork 改动与上游改动的交叠处。

fork 本地包（feishu-bridge adapter、feishu-bridge-chatroom 等）用 `*Like` 结构接口和手写假件消费上游服务，typecheck 和单测都可能看不见上游服务 API 面的删除或改名——上游合入后额外做一遍 seam 自查：列出 fork seam 对上游服务的调用面，再到上游包源码逐一确认仍存在；并跑 seam 的真组合测试（组合真实上游服务而非假件的那些用例，如 `pnpm vitest run packages/acp/feishu-bridge/tests/agent-dsh/adapter.spec.ts -t 'real UserQuestionService'`）。典型反例见 2026-08-29 oc_cd00410d 事故：上游删 `userQuestions.registerProvider` 改 waterfall，adapter 仍调旧 API，假件全绿，重建重启后全 daemon 追问卡片 NO_PROVIDER。

**成功标准**：全绿且 seam 调用面逐项在上游源码命中；失败走第 6 步分流，不要直接开修。

### 6. 失败分流

- `EACCES`/`EPERM` 且 stderr 是对 `$HOME` 下路径（`/home/hm/.dsh-*`、`acp-snap-cwd-*` 等）的 mkdtemp → 宿主沙箱环境问题：按仓库 AGENTS.md「Host sandbox failures」用最窄放权**原样重跑**该测试文件，过即证明非回归
- 其它失败 → 先判归因：该测试在合并前的 dev（`origin/dev`）上是否也红？归因的标准做法是临时 worktree 复跑：`git worktree add /tmp/dev-premerge origin/dev` + `CI=true pnpm install` + `pnpm run build` + 只跑失败的套件，用完 `git worktree remove --force`。dev 既有欠账或合并引入的语义冲突，都修在 merge 之后、**单独提交**，commit message 注明归因

**成功标准**：聚焦测试集全绿，每个修复独立成提交。

### 7. 推送（人工检查点）

用户确认后 `git push origin dev master`——`origin/master` 一并推齐，fork 的 master 常年落后。

**成功标准**：两分支推送成功，`git status` 显示 dev 与 origin/dev 同步。

## Gotchas

- 症状：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` → 做法：`CI=true pnpm install`。lockfile 大改后必现，是无 TTY 确认问题，不是故障。
- 症状：merge-tree 零冲突但测试红 → 做法：merge-tree 只保证文本干净；上游重构内部接口造成的语义冲突靠 typecheck + 聚焦测试抓。
- 症状：typecheck 绿、单测绿，但重建重启后 seam 调用抛 `TypeError: <service>.<method> is not a function` 或工具毫秒级返回 NO_PROVIDER 类显式错误 → 做法：fork seam 用 `*Like` 结构接口 + 手写假件，静态与单测都看不见上游 API 删改。按第 5 步 seam 自查逐项对上游源码，并给 seam 补真组合测试（实例：2026-08-29 userQuestions registerProvider→waterfall，oc_cd00410d 全 daemon 追问卡片失效）。
- 症状：产品沙箱测试 `EACCES mkdtemp /home/hm/.dsh-*` → 做法：宿主 landlock 沙箱挡 $HOME 写入。放权原样重跑即绿，别当回归修。
- 症状：gen-tool-catalog 断言实际比预期多出 fork 工具 → 做法：fork 加工具包要同步三处：`scripts/gen-tool-catalog.ts` 的 TOOL_PACKAGES、重新生成 `docs/tool-catalog.md`、`packages/core/tools/tests/gen-tool-catalog.spec.ts` 的硬编码清单（`node --import tsx/esm scripts/gen-tool-catalog.ts --check` 验证）。
- 症状：上游新增门禁暴露 fork 既有欠账（如 zh 链接 locale 规则、fixture 守卫）→ 做法：归因确认非合并引入后当独立提交修掉；注意门禁只认固定模式（语言切换行必须是 `[English](…) | 中文` 顺序）。
- 症状：refresh（`DSH_SNAPSHOT=refresh`）重写的期望文件在下次 replay 失败 → 做法：refresh 是「先写后比」，会把被测应用的**瞬时**行为烤进 fixture（实例：initialize 竞态让 `promptCapabilities.image` 一次性翻成 false）。refresh 产物一律 diff 审查后才可提交，initialize 期取值的变化未经普通 replay 确认视为可疑；机械噪音（比较器会归一化的裸 UUID）直接回滚即可。详见 Agent Note `implemented/process/2026-08-21-snapshot-refresh-transient-capability.md`。
- 症状：批量回滚 refresh 噪音文件时把手工修复一起冲掉 → 做法：回滚前先提交已完成的未提交修复，或按显式文件清单回滚，不要按 `git diff --name-only` 全量循环。
- 症状：刚同步过 dev 却报告「上游攒了 1000+ 提交待合」，用户质疑数字 → 做法：大概率是量法错而非状态错。区间内最老提交日期（长命分支可达 merge-base 前十余天）不是同步窗口；上游 rc 发布冻结期间 master 停在切点数日、合并队列攒单后集中 flush，导致「上次同步只捕获冻结点、这次 fetch 突然看到一周的货」。按第 1 步的 merge-base 量法重报，并核对三处状态后再下结论（实例：2026-08-28，1079 提交=6.5 天正常水位）。
- 规则：fork 二次开发五原则——同步节奏封顶（上游重构期 2–3 天、平静期至多一周、待合超过 ~800 提交立即同步）、改动优先落 fork 本地包（必须动上游缝时收敛文件数、稳定后提上游）、不编辑上游拥有的双语 README 正文、不偏离上游工具链（构建/测试基础设施逐字一致）、吸收操作纪律（中途 `pnpm add` 后必须全量 `CI=true pnpm install` 复核、不熟悉的失败先开纯净 upstream worktree 归因、每批冲突解完即跑 typecheck）。完整决策与理由见 Agent Note `implemented/process/2026-08-29-fork-secondary-development-principles.md`。
- 规则：修复一律新提交，不 amend、不混入 merge commit（仓库规约：优先新提交）。
- 规则：push 是外部可见操作，确认后再推；`origin/master` 每次一并推。
