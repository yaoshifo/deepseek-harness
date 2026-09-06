# 落地清单（第 3 段）

拍板后的实施。第一道门（评估拍板）已过，本段自带第二道门（计划批准）。

## 计划（第二道门）

完整实施计划过 plan 模式批准：分组按执行顺序、每组含改动文件与测试落点、成功标准可验证、边界与失败模式写清、明确不做的单列。用户的追问（如 discoverability）折进计划再提交。

## TDD 垂直切片

- 动手前加载 `tdd` skill；**一个测试 → 一个实现 → 重复**，不写完所有测试再实现
- 按层切片（如 adapter → engine → tool），每片先红：**跑测试亲眼看它因正确的原因失败**
- 优先扩既有 fake/recorder（补一个字段断言往往就是现成切口），不新建测试基座
- 改既有签名后，同步更新既有测试桩与断言（`toEqual` 是精确匹配，记录形状变了旧断言要跟着写明新值——顺便把默认值钉进文档性断言）

## 全量验证与 flaky 甄别

```sh
# 包级全量（聚焦改动包，别跑全仓）
CI=true pnpm vitest run packages/acp/<pkg>
```

全量冒红时**先甄别再动手**：

```sh
git stash && CI=true pnpm vitest run <失败的 spec/包> ; git stash pop
```

- 基线也红（尤其只在该 spec 单跑绿、全量红时）→ 既有竞态被新增测试的调度时移确定性暴露；修法参考**同文件姊妹测试对同一条件的既有模式**（如 `vi.waitFor` 包住异步清理断言），并在 Agent Note 的 Testing 段记录
- 基线绿、带改动红 → 自己引入，回去修

typecheck（6GiB 堆，别与 lint 并行）：

```sh
CI=true NODE_OPTIONS=--max-old-space-size=6144 pnpm run typecheck
```

## 文档四件套

1. **Agent Note 三件套**：`.agents/notes/implemented/<kind>/YYYY-MM-DD-<slug>.md` + `.zh.md` + `.i18n.yaml`（sidecar 用 `pnpm run verify-translation-pairing --write <md>` 生成）。zh 侧内链必须指向 `.zh.md` 文件
2. **双语 README**：改到语义处两侧同步（外科手术式改句，不重排段落），随后 `verify-translation-pairing --write <README.md>` 重录
3. `pnpm run verify-agent-note-format` 过
4. `pnpm run verify-translation-pairing` 全量绿（fork 豁免 doc-sync，但这两个门禁照跑）

## 提交

- 信息写进 `mktemp` 临时文件，`git commit -F`；按文件名 `git add`，不用 `git add -A`
- 只暂存本任务文件；**不 push**（用户明示才推）
- pre-commit 钩子（pairing/lint/whitespace/secrets）全过才算提交完成
