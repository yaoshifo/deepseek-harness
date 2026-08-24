# Agent Note: feishu-bridge /done 自动删除已合入包含性目标的子群 worktree

Status: implemented

[English](2026-08-24-feishu-bridge-done-merged-worktree.md) | 中文

## Problem

`/done` 本就会收掉整个 spawn 子树——子群走 `cleanupOneChat`，原生 continuable 后代走 `drainNativeDescendants`——但任何领先 base 有提交的 worktree 都按 dirty 处理并保留（`worktreeDirty` 把未提交改动与领先提交混为一谈）。而 agent 约定要求任务收尾自动提交，于是几乎所有真正干了活的子群都落在保留分支：用户必须逐个进入子群再跑一次 `/done`、回答 Keep/Remove 卡片；没人去做时 worktree 就持续积压（2026-08-24 观察到 `.claude/worktrees/<slug>` 目录与 `cc/<slug>` 分支共约 60 条、5.3 GB，四天累积）。Go cc-connect 同样是无差别保留，M4-A 移植如实复刻了它。

保留直觉对只存在于子分支上的工作是对的；对已经落进集成分支的工作是错的——那时删除零丢失。

## Decision

拆分 dirty 判定，并以每个 worktree 自己的包含性目标作为自动删除的闸门（`packages/acp/feishu-bridge`）：

- **`worktreeDirtyDetail`** 取代布尔版 `worktreeDirty`（已删除——无调用方残留）：返回 `{ uncommitted, ahead }`。未提交改动无条件保留 worktree；领先提交是无损删除的候选。
- **目标默认取创建时的 base 分支**：`createWorktree` 在记 base SHA 的同时记录当时 HEAD 所在分支（`git rev-parse --abbrev-ref HEAD`，detached 归一为 ''），贯穿 Session 元组、native child 记录与两种持久化格式。判定逐仓库自动正确、零配置——检出在 `dev` 就判 `dev`，检出在 `main` 就判 `main`；在 worktree 里再 spawn 的嵌套子任务自动以其父 worktree 的分支为目标，语义恰好正确。
- **`spawn.integrateBranch`**（新增 `SpawnConfig` 字段 + schema + `Engine.setSpawnIntegrateBranch`；缺省 `''`）降为全局覆盖：给检出常年在特性分支、但落地永远走同一分支的部署用。
- **包含性判定**（`worktreeMergedInto`）：先 `git merge-base --is-ancestor branch target`，失败再退到 `git cherry target branch` 无 `+` 行——覆盖 rebase / cherry-pick 之后的 patch 等价，以及冗余 merge 形态（分支唯一独有提交是已落地内容的重复合并，实际发生过）。任何 git 失败都按未合并处理，worktree 保留。
- **两条回收路径对称接入**：群路径（`cleanupOneChat`）对已合并子群调用 `finishWorktreeRemoval` 删除，并回报新增的 `worktree_removed_merged` 消息（点名目标分支）；原生 drain 路径（`removeNativeWorktreeQuiet`）静默删除已合并子群。dirty 子群汇总与交互式 Keep/Remove 卡片精确保留给未合并与未提交两种情况。

## Alternatives considered

**父群 `/done` 强删所有 dirty 子群。** `removeWorktree` 用 `git branch -D` 删分支、不管合并状态；从未落地任何地方的提交会被静默销毁。弃用——聊天里子任务的汇报文本是仅存的另一份产物。

**只认配置的分支名（本变更的第一版）。** 引擎无从得知各仓库的落地分支——这里叫 `dev`、别处叫 `main`——全局配置对不匹配的仓库静默失效，还要求每加一个项目就记得补一行配置。改用记录创建时 base 分支，同一个事实逐仓库自动获得、零配置；显式配置只作为覆盖保留。

**只做祖先判定、不做 `git cherry` 兜底。** 会漏掉 rebase / cherry-pick 落地与冗余 merge 形态；那些分支仍会不断索要手工卡片答复。两段式判定对每个 dirty 子群只多一次 git 调用。

**按时间的定期清扫。** 没有合并语义、会误伤 merely slow 的子群，还要给引擎引入它不拥有的调度器。`/done` 才是天然的结算点：用户刚宣告整棵子树完工。

## Consequences

对创建时能解析出 base 分支的 worktree，自动删除默认开启；从 detached HEAD 创建（或早于该字段存在）的 worktree 退回 `spawn.integrateBranch` 覆盖，覆盖也未设时保留交互式路径。自动删除只在包含性判定通过后执行 `branch -D`，删除汇总点名目标分支；git reflog 仍是判定失误（例如落地与 `/done` 之间目标分支被回退）的兜底恢复路径。判定至多给每个 dirty 子群的回收增加两次 git 子进程。一个值得点名的副作用：`slugify` 剥除非 ASCII，中文任务描述会退化成裸 `task-MMDD-HHmmss` slug——`/done` 时的自动删除正是让这个匿名群体不再积压的机制。
