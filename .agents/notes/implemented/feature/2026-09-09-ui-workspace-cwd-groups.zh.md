# Agent Note：未记账侧栏会话的目录分组

Status: implemented

[English](2026-09-09-ui-workspace-cwd-groups.md) | 中文

## 问题

工作区浏览器只通过手工 Workspace 记账（Host workspace 存储的 `sessionIds`）分组会话；所有未记账会话——凡在 Web UI 之外创建的，例如经 persistence 只读根挂载进来的 feishu-bridge 守护进程的全部会话——都拖尾在同一个不加区分的 Ungrouped 桶里。挂载 bridge 存储后该桶一次吞进约 1500 个会话。

## 决策

`ui-workspace` 的派生把未记账会话按各自不同的 `cwd` 拆分：每个路径一个目录分组，键为 `cwd:<path>`（与 Workspace UUID 及空的 Ungrouped 键都不冲突），标签为目录 basename。目录分组之间按各自最新成员排序、组内按最近更新排序；不参与手动排序，也不持久化顺序。无 cwd 的会话仍按原有浏览器本地顺序语义拖尾在 Ungrouped 桶。`owningGroupKey` 增加 `cwd` 参数，当前选中会话的组解析（自动展开、contains-current 高亮）因此路由到目录分组；真实 Workspace 记账始终优先于 cwd 路由。组头渲染自带的标签，字典里的 Ungrouped 文案只保留给无 cwd 的桶（`workspaceId` 与 `cwd` 均为 undefined）。在目录分组内拖拽是无操作——现有拖拽提交路径找不到该键的记账，天然如此。

## 备选方案

**Host 侧自动记账：把 cwd 匹配的 Session 自动加进 `WorkspaceView.sessionIds`。** 否决：把手工导航记账变成排序、归档、移动语义都不清晰的混合体；且 Web 进程对外来会话只有冷列表发现，没有创建事件可挂钩。

**一次性脚本把 bridge 会话写进 workspace 存储。** 否决：运行中的 Web 进程在内存中持有该存储并经单一写链回写，外部编辑会丢失；且每来一批新 bridge 会话都要重跑，还会累积一堆一次性 worktree 目录。

## 后果

真实 Workspace 分组、其手动顺序、Ungrouped 桶的已存顺序均不变。浏览器持久化的展开键自然延伸到 `cwd:` 键。被删除 Workspace 的会话现在按 cwd 重新归入目录分组，而不是汇入 Ungrouped。

## 测试

`tree.client.spec.ts`：未记账会话按 cwd 拆分为目录分组（标签、组间最新成员排序、组内最近更新排序），无 cwd 会话留在 Ungrouped，已记账会话绝不泄漏进目录分组。`workspace-browser.client.spec.tsx`：带 cwd 的未记账当前会话自动展开其目录分组，组头不渲染工作区菜单。`rows.client.spec.tsx`：目录分组渲染目录 basename 标签而非 Ungrouped 字典文案，后者只属于无 cwd 的桶。全包套件通过（153 测试）。
