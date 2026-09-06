# 盘点命令集（第 1 段）

定位最近一次上游合并并产出变化报告。命令按发现顺序组合执行，全部只读。

## 定位合并

```sh
# 最近几次 merge（找 "Merge branch 'master' into dev"）
git log --merges -8 --date=iso --pretty='%h %ad %s' dev
```

用户给了日期窗口或 merge 引用就直接用；缺省取最近一次 master→dev merge。

## 合并本体

```sh
# 父提交 + 完整提交信息（信息里通常有冲突裁决摘要——直接引用它，别自己重推）
git show --format='%H%n%P%n%an %ad%n%B' --stat --no-patch <merge>
```

记下 p1（dev 侧父）与 p2（master 侧父），后面全用 `'p1..p2'` 与 `<p1> <merge>` 展开。

## 规模与主题

```sh
# 非合并提交数
git rev-list --count --no-merges 'p1..p2'
# 提交全文（供人工浏览）
git log --oneline --no-merges 'p1..p2'
# 按 type(scope) 聚合分布（识别大头主题）
git log --no-merges --format='%s' 'p1..p2' | sed -E 's/^([a-z]+)\(([^)]*)\).*/\1(\2)/; s/^([a-z]+):.*/\1/' | sort | uniq -c | sort -rn | head -30
# PR 清单
git log --merges --format='%h %s' 'p1..p2' | grep 'Merge pull request'
# 提交时间跨度
git log --no-merges --format='%ad' --date=short 'p1..p2' | sort -u | sed -n '1p;$p'
```

## diff 足迹

```sh
# 总量
git diff --stat 'p1' <merge> | tail -1
# 受影响目录 Top N（cut 的 -f1-3 按包粒度收拢，可调）
git diff --name-only 'p1' <merge> | cut -d/ -f1-3 | sort | uniq -c | sort -rn | head -25
```

## fork 侧状态

```sh
# 合并后 fork 自己打的补丁（适配/修复）
git log --oneline <merge>..dev
# 与远端关系、工作区是否干净
git status -sb | head -3
# 上一次同步是什么时候（校准本次窗口）
git log --merges --format='%h %ad %s' --date=short dev | grep -m2 "Merge branch 'master' into dev"
```

## 报告结构

1. **一句话结论**：合并时间、版本跨度、规模（提交数/PR 数/文件数/行数）、当前 dev 状态
2. **主题分布**：聚合表 + 逐主题一句人话（最大头先说）
3. **值得二开注意的**：与桥/chatroom/cron/subtask 等 fork 面相关的能力
4. **冲突裁决摘要**：从 merge message 摘录
5. **fork 补丁**：合并后适配提交列表
6. 上次同步日期（说明这次窗口多长）

深度适配：默认「概括」；用户要「通俗的解释」时用白话直讲（直接讲事情本身、术语展开成大白话，2-3 个核心部分各配表格或具体例子），重答而非续跑。
