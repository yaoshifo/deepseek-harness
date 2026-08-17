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

**成功标准**：三个量都已知，明确本次要合多少提交。

### 2. 零副作用预演

`git merge-tree --write-tree --name-only dev master`

exit 0 且只输出一个 tree oid = 零冲突。有冲突则列出文件、判断归属（fork-local 还是双方共享改动），拿不准停下问用户。

**成功标准**：零冲突，或冲突面已评估并经用户同意继续。

### 3. 合并

dev 上 `git merge master`。用 merge 不用 rebase：保留 dev 已推送的提交历史、免 force-push 公共分支。

**成功标准**：出现 `Merge branch 'master' into dev` 提交。

### 4. 依赖与 typecheck

`CI=true pnpm install`（CI=true 必带，见 Gotcha 1）→ `pnpm run typecheck`（会顺带构建部分包，属正常）。

**成功标准**：两条命令 exit 0。

### 5. 聚焦测试

归纳 dev 改动面包：`git diff --name-only master...dev | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn`，对改动面包跑 `pnpm vitest run <packages/... 路径>`。上游那批提交的上游 CI 已验证过，风险面只在 fork 改动与上游改动的交叠处。

**成功标准**：全绿；失败走第 6 步分流，不要直接开修。

### 6. 失败分流

- `EACCES: mkdtemp /home/hm/.dsh-*` 且命令 stderr 带 `landlock-run` → 宿主沙箱环境问题：按仓库 AGENTS.md「Host sandbox failures」用最窄放权**原样重跑**该测试文件，过即证明非回归
- 其它失败 → 先判归因：该测试在合并前的 dev（`origin/dev`）上是否也红？dev 既有欠账或合并引入的语义冲突，都修在 merge 之后、**单独提交**，commit message 注明归因

**成功标准**：聚焦测试集全绿，每个修复独立成提交。

### 7. 推送（人工检查点）

用户确认后 `git push origin dev master`——`origin/master` 一并推齐，fork 的 master 常年落后。

**成功标准**：两分支推送成功，`git status` 显示 dev 与 origin/dev 同步。

## Gotchas

- 症状：`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` → 做法：`CI=true pnpm install`。lockfile 大改后必现，是无 TTY 确认问题，不是故障。
- 症状：merge-tree 零冲突但测试红 → 做法：merge-tree 只保证文本干净；上游重构内部接口造成的语义冲突靠 typecheck + 聚焦测试抓。
- 症状：产品沙箱测试 `EACCES mkdtemp /home/hm/.dsh-*` → 做法：宿主 landlock 沙箱挡 $HOME 写入。放权原样重跑即绿，别当回归修。
- 症状：gen-tool-catalog 断言实际比预期多出 fork 工具 → 做法：fork 加工具包要同步三处：`scripts/gen-tool-catalog.ts` 的 TOOL_PACKAGES、重新生成 `docs/tool-catalog.md`、`packages/core/tools/tests/gen-tool-catalog.spec.ts` 的硬编码清单（`node --import tsx/esm scripts/gen-tool-catalog.ts --check` 验证）。
- 规则：修复一律新提交，不 amend、不混入 merge commit（仓库规约：优先新提交）。
- 规则：push 是外部可见操作，确认后再推；`origin/master` 每次一并推。
