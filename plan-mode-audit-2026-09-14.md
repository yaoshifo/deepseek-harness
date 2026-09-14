# plan 模式实现审计（补充报告，2026-09-14）

- **基线**：`dev` @ `fa9b76a005`（含 09-11 上游 rc.2 同步）
- **本文件定位**：同一主题的**第二份独立审计**。仓库根目录已有一份并行会话产出的 `plan-mode-audit-2026-09-12.md`（169 行、26 条发现，本文简称「09-12 报告」）。两份互不重叠为主：本文的 F1 / F4a / F6 是 09-12 报告**没有**的（含一条**已实测复现的红门禁**），其余条目与它部分重叠、并补充了证据或反向。
- **本次不实施任何修复**（用户裁定 2026-09-12）：本文件只记录调研结果；§0 给出两份报告的交叉索引，§4 给出合并后的修复顺序。
- **置信度标注**：**实测** = 本次实际跑过/逐例算过；**静态核对** = 逐行/逐字节读过；**机制推断** = 从代码路径推演、未实际触发。
- **复审**：2026-09-14（另一并行会话，dev @ cb939daaf0）——F1-F8 独有发现全数复核属实（F1 为静态坐实：5 份 JSON sidecar + ptc 的 system-prompt 类型块确认过期、门禁接线与 CI 触发核实）；F1 的 dsh-memory 行与样本计数已勘误，§4 分组口径已更正（均见文内复审注）。

---

## 0. 交叉索引（我的发现 ↔ 09-12 报告）

| 本文条目 | 09-12 报告 | 关系 |
| --- | --- | --- |
| **F1 回放门禁已红（实测）** | 无 | **新增**。09-12 报告只在方案里写「改完刷新工具描述相关快照」，未发现门禁当前即为红（复审勘误：失效清单 6 份——原计 7 份中的 dsh-memory 已被 96d11f14db 清掉） |
| **F2 假保护声明** | #1（附带一句「『plan mode 会拦住它』也不准确」） | 重叠；补充：全仓核实**不存在任何机制**、子任务不继承 plan 状态，故建议把文案改成义务陈述而非只改工具名 |
| **F3 契约强制力窄于文案** | #5（围栏/非 ATX 误报）、#6（三处文案承诺过强）、#11（测试名名不副实） | 重叠；补充：漏网面清单（h1/h3/带后缀/粗体/缩进/引用）、**「已在计划模式里再发 `/plan`」文案错**、退出工具判据不对称、**非 bridge 装配（preset/base）完全没有分层口径**（09-12 的 #8 讲的是 bridge 子会话） |
| **F4a 取消与落盘的时序窗口** | 无（它的 #3/#4/#12/#13 是渲染生命周期族，见下） | **新增**（渲染族第 5 个缺陷） |
| F4b 失败后不重试 | #4 | 重叠（结论一致：哈希在派发时记录） |
| **F5 死代码与重复** | #15（`sentPlanContent`）、#16（`getRenderStatus`）、#23–25（三处可简化） | 重叠；补充：`preRenderingKey` 死字段、Go 残留分支与其敌意测试、**导出面 51 个中约 33 个无模块外消费者**、**两份渲染模板 84% 逐行重复**（这两条 09-12 报告未提） |
| **F6 台账漏记这次嫁接** | 无 | **新增**（含 37 份样本固定面作为重嫁接成本） |
| **F7 记录失真** | #9（bridge README:34 的撤销机制）、#21（README:48 尺寸声明）、#22（注释 3/4 口径） | 部分重叠；补充：README:75 的「no mechanical gate」、**`bundle-patch.spec.ts:91` 永真断言**、三份 feature note 的「五份副本」、chatroom 两段不可达引导文本 |
| **F8 缺失测试** | #18（拒绝门边界）、#13（心跳时序） | 部分重叠；补充：`set()` 直提交路径 append 失败、pre-step 的 reject/aborted 守卫、compaction 那条**同义反复**测试 |
| **F9 其余** | #17（`get().pending` 同名异义）、#20（`get` 无消费者） | 部分重叠；补充：`layers` 在 asker 侧未校验、i18n 三处同值 + locale 覆盖不一致、同一计划三套标题派生、计划文件覆盖时丢弃分层（有意边界） |

**对 09-12 报告两处结论的复核（我重算了，结论支持它）**：

- 它的 #5：`/^##\s*(实施细节|技术细节|Implementation Details?|Implementation Notes?)\s*$/m` 逐例实测——`##Implementation Details`（无空格，CommonMark 里不是标题）**命中**、`##\n实施细节`（跨行）**命中**（`\s*` 吃换行）、`### 实施细节` 不命中；`\`\`\`\n## 实施细节\n\`\`\`` 命中（围栏内也拦）。双向都有问题，成立。
- 它的 #3：`routeAskResponse` 里 `approving ? cancelPlanRenders : cancelRenders`（`packages/acp/feishu-bridge/src/engine/engine.ts:6059-6063`）确实在判决路由（`:6073-6076`）**之前**执行；非判决自由文本时 `approving` 为假 → 走 `cancelRenders` 杀掉在途 plan 渲染，而 `routePermissionResponse` 只回 `PermissionHint`（`:6225`）并保持 ask 挂起。成立（行号与其引用略有偏移）。
- 它的 #143「i18n 齐全」与我的 F9 **范围不同**，不冲突：`plan_content_header` / `plan_details_panel` 确有 5 个 locale（`src/i18n/messages.ts:147-149`），而 `plan_export_btn` / `render_status_*` / `render_tag_plan` 只有 en+zh（`:242-247`）。

---

## 1. 发现清单

### F1（实测，最高优先）网页回放的固定样本断言现在是红的

**证据**

- 复现（本机，需按 host-sandbox 条款提权，见附录 B）：

  ```
  DSH_SNAPSHOT=replay ./node_modules/.bin/vitest run --config vitest.web.config.ts \
    apps/web/tests/replay-round-trip.e2e.ts
  → Tests  8 passed (8)                      # 8 个用例全过
  → FAIL（suite 级）: snapshots/web/fresh-round-trip/session.v3.jsonl:
      tool-schema pin: expected '{\n  "initial": [\n    {\n      "name…' to be '…'
  ```

  断言点 `apps/web/tests/scaffold.ts:1082`（`assertReplaySession` `:1067` → `compareOrRefreshGolden`）：pin 的 fixture 会把 live 的 system prompt / tool schema 与 sidecar 逐字节比对。

- 过期内容（逐字节核对）：`snapshots/web/fresh-round-trip/tool-schemas.expected.json` 里 `exit_plan_mode` 仍是 fork 改动**之前**的上游形态——description 结尾停在 `…comes back in the tool result.`，`parameters.properties` 只有 `plan`，**没有 `details`**；现码是 `packages/plan/plan-mode/src/index.ts:80-86`（两条 fork 文案）+ `:296-298`（`details` 参数）。
- 成因链：`6cbbfd489b`（09-10 20:59）改 `EXIT_DESCRIPTION`，其 `--stat` 未触碰 `snapshots/`；`38b665610b`（09-11 00:05）批量刷新覆盖 30 份、漏了这批；`f9b30e90e0` 同样只覆盖操作者跑过的 lane。
- 失效清单（复审勘误 2026-09-14 后 **6 份**；全库 217 份 `expected.*` 中 37 份已带 fork 文案——复审实测含拒绝句者 36 份、差 1 疑为口径差——2 份仍是旧措辞 `revise and present again`）：

  | 样本 | 性质 | 暴露面 |
  | --- | --- | --- |
  | `snapshots/web/fresh-round-trip` | 无 `details`、旧文案 | **已实测红** |
  | `snapshots/web/schedule-catalog` | 同上 | web lane |
  | `snapshots/web/cordis-tool-round` | 同上 | web lane |
  | `snapshots/web/ptc-round` | 仅 `system-prompt.expected.md` | web lane |
  | `snapshots/acp/dsh-memory` | 复审勘误 2026-09-14：sidecar 已于 96d11f14db（09-13 23:26，早于本报告提交 15 小时）刷成当前形态（`plan`+`details` 参数、拒绝句俱全），原行描述的是 f9b30e90e0 时代中间态 | acp lane 仅剩既存 key 失败（replay 需 `DEEPSEEK_API_KEY`），无工具面过期 |
  | `snapshots/session/pwsh-tool-turn` | 无 `details`、旧文案 | `platform: pwsh`，本机/Linux 跳过，Windows 才暴露 |
  | `snapshots/session/persistent-pwsh-tool-turn` | 同上 | 同上 |

- 门禁接线：`scripts/run-gates.ts:489-507`（`webSnapshotGate` → `test:web:ci` / `test:web:built`）、`:651-660`（`snapshotGate` → `test:snapshot`）。
- 为什么没人发现：CI 只在 PR 上触发（`.github/workflows/ci.yml:3` 的 `on: pull_request`），fork 直接推 `dev`；本地按仓库政策不默认跑全量。

**影响**：`test:web` / `test:web:ci` 在 `dev` 上是红的；任何本地跑该 lane 的人都会撞上并误以为是自己改坏的；两份 pwsh 样本在 Windows 上同样会红。

**建议**：刷新受影响 lane（网页 + 会话 + acp），两份 pwsh 样本手工对齐；刷新 diff 人工过一遍确认无其他漂移；把「改了 `EXIT_DESCRIPTION` 要刷哪些 lane」写进 owner 清单。**注意顺序**：09-12 报告的 #6 还要再改一次工具描述文案，必须「先改文案、后刷新」，只刷一次。

**置信度**：实测。

---

### F2（静态核对）任务派发 skill 宣称「plan mode 会拦住执行型 spawn」，实际没有任何机制

**证据**

- `packages/acp/feishu-bridge/skills/feishu-bridge-subtask/SKILL.md:16`：「**执行型 spawn（子任务要改文件、建 worktree）是「执行」**，plan mode 会拦住它，必须先过用户的批准门。」（同族问题见 09-12 报告 #1：该 skill 三处还教错工具名 `ExitPlanMode`。）
- 全仓无该门禁：`packages/acp/feishu-bridge/src/tools/subtask.ts` 中 `planMode` 命中 0 次；`packages/subagent/*/src`、`packages/core/*/src` 的 spawn 路径无 `planMode` / `plan/mode` 判断；plan mode 自述为提示层（`packages/plan/plan-mode/README.md:81`）。
- 子任务不继承 plan 状态：`packages/acp/feishu-bridge/src/agent-dsh/adapter.ts:2040-2046` 显式 `planMode.set(agent,false)`；child 的 `plan:policy` 回调在 inactive 时返回空串（`packages/plan/plan-mode/src/index.ts:234-238`）。
- plan:policy 反而**鼓励**规划期派发（`packages/acp/feishu-bridge/cordis.patch.yml:150` 的并行探索 delta）。

**影响**：模型可依赖一个不存在的保护——brief 未写明「只读」的 child 能在批准前落盘改动，用户审批门被静默绕过。与 `packages/AGENTS.md`「Enforce a decision in the operation that makes it」冲突。

**建议**：(a) 改文案为义务陈述（「plan mode **不会**拦住它；批准前不得派发改写型 child」）——推荐，一行；或 (b) 落地真门禁（bridge 已能读 `ctx.get('planMode')`，child 已支持工具掩码）。用户 2026-09-03 已裁定 plan 模式暂不加固，故本次建议只做 (a)。

**置信度**：静态核对；「是否加门禁」属决策。

---

### F3（静态核对 + 实测语义）分层契约的强制力窄于文案承诺，且非飞书装配没有口径来源

**证据**

- 检测规则 `packages/plan/plan-mode/src/index.ts:104` 三重收窄：仅二级标题、标题名整行精确（无后缀）、仅在 `details` 缺席时检查（`:318-325`）。
- 漏网面（逐例实测）：`### 实施细节`、`#### 技术细节`、`# Implementation details`、`## Implementation details（附加说明）`、`## Implementation details (annex)`、`## **实施细节**`、`  ## 实施细节`（缩进）、`> ## 实施细节`（引用）、`## 实施细节与风险`、`## Details` 全部**不拒** → 静默退回单块计划卡（正是 `6cbbfd489b` 要治的症状：其 commit 记录 glm-5.3 四次采样中三次内联）。
- 误伤面（与 09-12 报告 #5 同源，我重算过）：围栏内的 `## 实施细节` 会拒；`##Implementation Details` 与跨行 `##\n实施细节` 也会命中（`\s*` 允许零空格与换行）。
- 测试覆盖不对称：`packages/plan/plan-mode/tests/plan-mode.spec.ts:872-885` 只钉 `## 实施细节` 与 `## 技术细节` 两个中文组合；英文别名零测试，而 `packages/plan/plan-mode/README.md:95` 把它写成契约。
- 有意接受的重复未记录为限制：`tests/plan-mode.spec.ts:887-892` 接受「plan 内联 + 已提交 details」，卡片会出现白话层被撑大 + 折叠面板重复同一内容（09-12 报告 #11 同点，建议只改测试名）。
- 模型可见文案自相矛盾：`:80-86` 同时写「Send the COMPLETE plan」与「An **optional** `details` argument…」；`:297` 写「omit only when the plan carries no implementation detail」；拒绝文案 `:322-323` 却要求「the plan keeps the plain-language layer only」。09-12 报告 #6 从「承诺过强」角度看同一处，我补的是「描述内部自相矛盾」（前者字面鼓励把细节塞进 `plan`）。
- 非飞书装配没有口径：`details`/两层/拒绝句全是 fork 新增，而 `packages/bundle/base/cordis.patch.yml:301-315` 与 `packages/preset/agent-presets/presets/{standard,ptc,cordis}/agent.cordis.yml` 的 plan section 对 `details`/分层**零提及**（`grep -c details` = 0）；两层口径只存在于 `packages/acp/feishu-bridge/src/engine/agent-conventions.ts:43-46`（bridge 普通会话专有；09-12 报告 #8 指出 bridge 子会话也拿不到，我补的是 preset/base 装配同样拿不到）。这些装配的模型只能从英文描述或报错学到分层，却同样被拒绝门拦。
- 用户可见文案错：`src/index.ts:272-287` 把 `queued`/`cancelled`/`noop` 压成同一句——已在计划模式里再发 `/plan`（常见 `/plan <补充说明>`）会被告知「Entering plan mode (applies from the next step)」，实际什么都不发生；刚排了退出再发还被说成「正在进入」（实为取消退出）。对照 `:255-270` off 分支有四路文案。
- 判据不对称：退出工具 guard 只读落盘状态（`:312`），提示段（`:237`）与 `set()`（`:456`）用 `pending ?? logged`；批准后 pending 已置 false（`:381`）而落盘仍 true，同一 assistant 批次内第二次 `exit_plan_mode` 会再开一张评审卡（09-12 报告 #19 只把这处建议为「注释互指」）。

**影响**：换标题级别/加括号就静默退回单块卡片；合法计划可能因围栏内同名标题被误拒并看到错怪用户的报错；用户读到与实际相反的切换文案；极端下出现两张评审卡。

**建议**：正则改逐行扫描（跳围栏、`[ \t]` 收空格、层级 2–6、英文大小写不敏感）+ 表驱动边界测试（与 09-12 报告 #5/#18 合并做）；`:272-287` 按 outcome 分出 `noop`/`cancelled` 文案；`:312` 统一 `pending ?? logged` 并补「批准后再调用应被拒」；`:80-86`/`:296-298` 与三处传播文案条件化（**钉死措辞**与 09-12 报告 #6 一并做）；`README.md:95` 收窄。是否给 preset/base 补口径属决策（会加深对上游文件的嫁接，见 F6）。

**置信度**：静态核对（漏网/误伤为逐例实测语义）。

---

### F4（机制推断 + 静态核对）渲染族第 5 个缺陷：取消与落盘的时序窗口

**F4a 批准计划时「渲染失败」会盖掉「已取消」**

- `packages/acp/feishu-bridge/src/engine/plan-render.ts:1406-1410` 先 `existsSync` 再判 `signal.aborted`；`renderPlanToHTML` 无论成功与否都返回写盘路径（`:994-1027`）→「文件在」≠「渲染成功」；`:1170` 的 `deliverRenderedImage` 首行在 aborted 时抛错；`:1432-1435` 的 catch 记 `'failed'`，与 `:1416` 的 `'cancelled'` 意图相反。触发链：渲染 fork 已写盘 → 用户批准 → `cancelPlanRenders` abort → 状态显示「渲染失败」+ 一条 deliver failed 日志。
- 这是 09-12 报告渲染族（#3 判决前取消、#4 哈希、#12 临时目录、#13 心跳）之外的**第 5 处**，两报告合起来覆盖该族。
- 无任何测试覆盖该窗口。**置信度**：路径静态确定、时序为机制推断，落地时应先写能复现的红测试。

**F4b 一次渲染失败后，同样内容的计划再也不出图**（与 09-12 报告 #4 同点）

- `plan-render.ts:554-563` 在**派发时**写入去重哈希与时间戳，`:1415-1435` 的失败分支都不回滚；`engine.ts:3229-3232`（`3d6df58dcd`）删掉每轮 `planRevisionCount = 0` 后 revision 恒 ≥2，`:558` 的 `revision > 1 &&` 兜底（原「首轮必渲染」等于隐式重试）不再命中；`tests/engine/plan-render.spec.ts:62-69` 只钉节流，未钉「失败后可重试」。

**建议**：两处各先写红测试（stub 渲染「先写盘再挂起」；失败后再呈现同内容），再分别改判断顺序与哈希记录时机；与 09-12 报告的渲染组（复审后组三）同批做（它已含 #4）。

---

### F5（静态核对）死代码与重复（与 09-12 报告合并后的并集）

09-12 报告已列：`sentPlanContent`（#15）、`getRenderStatus`（#16）、`sendPlanContent`/`sendInlinePlanContent` 尾部重复（#23）、两条渲染状态机重复（#24）、渲染 prompt 前言重复（#25）。以下为本文补充项：

| 项 | 位置 | 证据 | 建议 |
| --- | --- | --- | --- |
| 死字段 `preRenderingKey` | `engine.ts:485-486` + `plan-render.ts:1252/1340` | 只有赋值/清空，全仓 0 读取 | 删 |
| Go 移植残留分支 | `plan-render.ts:585-592`、`:600-603`、`:1051-1057` | 两个生产调用点（`:1255`/`:1376`）都传非 undefined；唯一传 undefined 的是 `plan-render.spec.ts:220-226` 的 `@ts-expect-error nil-handle mirror of the Go test`（同进程类型化值的敌对测试替不存在的调用方保活）；`deliverReplyHTML` 的 `_e` 自认只为签名对齐 | 收窄签名 + 删该测试行 |
| 导出面过大 | `plan-render.ts` 51 个 export | 全包只有 3 个 import 源（`engine.ts` 取 13 值+3 类型、`src/index.ts:61` 取 `renderSkillName`、`plan-file.ts:14` 取 2 个）；约 33 个无模块外消费者；`package.json` 无该模块子路径 | 收回模块内（注意 per-file 100% 覆盖） |
| 两份渲染模板 84% 重复 | `plan-render-templates.ts:13` / `:16` | 实测 6855 / 6982 字符，按行共享 5765（84%）；真实差异仅 plan 16 行 / reply 18 行（accent、徽章文字、h2/h3 字号、pre position+语言角标、断点、file-list 边距、font-size）；`pnpm run duplication` 看不见字符串模板里的重复 | base 模板 + `{{ACCENT}}`/`{{BADGE}}`/`{{EXTRA_CSS}}` 覆盖；风险最高，单独提交 |

---

### F6（静态核对）嫁接台账没有登记这次两层计划的源码改动

**证据**

- `upstream-graft-ledger.md` 只有 `:57` 一行与 plan 有关，且只覆盖「引导散文」（bridge patch 单点 + lockstep 防线）——**没有**任何一行记录对上游包源码的改动。
- 实际 fork delta（`git diff master...dev --stat`，指定路径）：16 文件 / 约 191 行插入，落在**四个上游包**：`packages/plan/plan-mode/src/index.ts` +57、`packages/interaction/user-questions/src/types.ts` +12、`packages/compaction/compaction-basic/src/summarizer.ts` +3（+各 README/i18n）。
- 引入提交：`de2def5b0e`（两层拆分 + `layers` 类型）、`6cbbfd489b`（拒绝门）、`797294d9d1`+`4379cb7e06`（压缩保留）、`38b665610b`+`f9b30e90e0`（样本刷新）。均为 fork 侧作者（对照：`fff1ed7aa2`/`996278e6ce` 来自上游 PR 分支，不在此列）。
- 重嫁接成本未记录：**37 份 `expected.*` 固定了 `exit_plan_mode` 的文案与参数**；`38b665610b` 的记录还显示需为 fork 自有 acp 场景补 `session.v3.jsonl` 后继。
- 设计记录本身写着「to be proposed upstream once stable」（`2026-09-10-plan-details-structured-split.md:15`），台账却没有对应行；`layers` 全仓唯一读取点是 `packages/acp/feishu-bridge/src/agent-dsh/adapter.ts:1038`，属「待提上游」还是「现接受为 fork 局部」没有落字。

**影响**：下次同步上游时无法回答「要重嫁接什么、成本多少」。

**建议**：台账补三行（见附录 A），状态写明；「37 份样本固定面」记为重嫁接成本。

---

### F7（静态核对）记录失真（并集；09-12 报告已列的 #9/#21/#22 不重复）

| 位置 | 现状 | 事实 |
| --- | --- | --- |
| `packages/acp/feishu-bridge/README.md:75` + `README.zh.md:75` | 「whether the model fills `details`… has no mechanical gate — an unfilled details degrades the card back to the single-block display」 | 机械门禁 `6cbbfd489b` 已落地；该 bullet 写于同日 09:51，未同步（commit stat 未触碰 bridge README） |
| `tests/bundle-patch.spec.ts:91` | `expect(text).not.toContain('background subagent delegations')` | **永真断言**：该句 base 与 bridge 都不存在、上游从未有（`git show upstream/master:… \| grep -c` = 0）；它原本要守的前提已随 `1a847c57c6` 消失 |
| `2026-09-03-single-focus-breadth-criterion.md:15`、`2026-08-31-parallel-exploration-default-guidance.md:19`、`2026-09-02-post-approval-parallel-execution-guidance.md:18` | 「五份/四份副本同步」「只差一句委派句」 | 2026-09-06 已把 base 与三份 preset 回退成上游原文（`2026-09-06-fork-conflict-surface-reduction.md:17/:35`）；fork 的 live 引导只剩 bridge patch 一处，三份 preset 不在 live profile 链上（`packages/acp/feishu-bridge/profile/package.json:6-12`） |
| `packages/acp/feishu-bridge-chatroom/src/engine/chatroom-priming.ts:283` / `:326` | 「若处于 plan mode：先调 `exit_plan_mode`…」 | 构造上**不可达**：两段文本由 `chatroom-pick.ts:312`/`:867` 发送且都带 `modeOverride: 'default'`，moderator persona 另带 `forceMode: 'default'`（`chatroom-policy.ts:231/:251`）→ `adapter.ts:2055-2075` 必然 `planMode.set(agent,false)`；且它点名的工具在非 plan 模式仍注册，调用即抛 → 诱使无效调用 |

**建议**：README bullet 改写（门禁只覆盖「内联标题」子集）；`:91` 改钉成会失败的锚点或删除；三份 note 各加 partial-supersession 回指；聊天室两段死文本删除或注明预留。

---

### F8（静态核对）缺失测试（与 09-12 报告 #18 互补）

- **`set()` 直提交路径**（`src/index.ts:453-473`：无 open turn + `session.append` 抛错）无测试：现有两个 append 失败用例（`tests/plan-mode.spec.ts:411-435`、`:437-452`）都在 `openTurn()` 之后，只走 `onBoundary`（`:484`）。影响：`set()` 抛出后 `/plan <说明>` 的 `agent.steer`（`:274`）不执行 → 用户附带的文本静默丢失；bridge 场景是建会话直接失败（`adapter.ts:2070-2075` 忽略返回值）。
- **pre-step 守卫**（`src/index.ts:211-228` 的 `decision.kind === 'reject' || signal.aborted`）零测试，而 `packages/core/agent/src/model-selection.ts:112` 是逐字同构 guard 且其 spec 两个分支都测（`tests/model-selection.spec.ts:148-172`）。影响：删/重排该守卫零失败信号 → 被 block 的一步仍写 `plan/mode`，模型在「上下文未更新」的 step 里拿到相反模式。
- **compaction 的 plan 保留测试是同义反复**：`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts:1368-1386` 传 `{ messages: [] }`（空对话、无 plan、无 tool call），断言「派发的指令文本包含该指令文本」——无论 plan 是否被保留结果都相同；且该特性零程序化实现（全仓 `grep -rn plan packages/compaction/*/src/` 只命中 `summarizer.ts:63,66` 两行提示词），落盘前只校验「非空 text block」与「摘要短于被遮蔽 span」，**不检测 plan 缺席**，而 `packages/compaction/compaction-basic/README.md:246` 写着「fail closed … rather than silently dropping plan content」。
- 另无任何测试/快照同时覆盖 plan + compaction（`snapshots/web/plan-review/session.v3.jsonl` compaction 事件 0；`compaction-recovery`、`image-compaction` 的 plan/mode 事件 0）。

**建议**：前两条补测试（成本极低）；compaction 见 §3 拍板项 A。

---

### F9（静态核对）其余观察

- **`layers` 在用户提问边界未被校验**：`packages/interaction/user-questions/src/index.ts:108-129` 注释自述「asserts two things」，实际只校验「`approve` ∈ 本题选项」与「`detail !== undefined`」；而桥的卡片在 `layers !== undefined` 时**整体丢弃**已校验的 `content`（`plan-render.ts:1557-1562`）→ 展示给用户的整块计划这条边界少了第三条断言。今日单一生产者下可利用性低，但两路已证明会分叉（`engine.ts:5435-5437` 计划文件覆盖时把 layers 置空只留 content）。
- **`ctx.planMode.get()` 无生产消费者**（同 09-12 报告 #20）：`src/index.ts:431-435`，全仓只有测试调用（`tests/plan-mode.spec.ts` 40+ 处）；bridge 只用 `set`，web 读投影视图，SDK/Python 零命中。
- **「计划」标签三处分裂 + locale 覆盖不一致**：模板 CSS 硬编码中文并写死 `lang="zh-CN"`（`plan-render-templates.ts:13/:16`，20+ 个 `content:"中文"` 字面量）；`i18n/messages.ts:147`（`plan_content_header`，5 locale）与 `:247`（`render_tag_plan`，仅 en/zh，同值）；`:242-248` 的 `plan_export_btn`/`render_status_*` 只有 en/zh，回退链（`i18n/index.ts:128-145`）让 ja/es 落英文、zh-TW 落简体 → en/ja/es 用户拿到中文图片而同屏卡片是本地化文案。
- **同一计划三套标题派生**：卡片头 i18n（`engine.ts:5806-5807`）／`.html` 产物名（`plan-render.ts:1003-1012`）／PNG 名与图片卡标题（`:1193-1194`、`:1205-1206` 取渲染 fork 自己写的 `<h1>`）。计划侧不解析 markdown（`markdownToSimpleHTML` 唯一调用点 `:1037` 是 reply 路径），故无重复解析成本，不一致只在命名。
- **计划文件覆盖会丢弃分层**：`engine.ts:5429-5439` 在 agent 本轮写过计划文件且可读时用文件覆盖 `content` 并 `planLayers = undefined`（卡片退回单块）。**有意设计且有测试**（`tests/engine/engine-m3-plan.spec.ts:394`），本次不改，仅记录为已知边界。

---

## 2. 已核查但不成立的候选（与 09-12 报告「已验证无问题的面」合并去重）

01. `presentCall`/`presentResult` 无 in-tree 消费者 ⇒ 可删：否（2026-08-23 记录为保留的 Host API，Web Client 不消费属记录在案分工）。
02. 退出工具在非 plan 模式仍注册：否，2026-07-22 既定决策；代价 ≈1155 字符（≈289 tokens）/请求，fork 新增 456 字符。
03. `activeAtLastHeader`/narration 冗余：否（捕捉 append 前的真相，`tests/plan-mode.spec.ts:369-408` 已覆盖三种抑制）。
04. `pendingIntents` 可被投影取代：否（exit 的静默选择不产生 command 事件）。唯一 tiny 冗余：投影 fold 里 `running.wanted` 与 `wanted` 观测等价（建议留 TODO）。
05. append 失败重试无测试：部分成立（`:411-435`/`:437-452` 已覆盖 `onBoundary`；缺直提交路径，见 F8）。
06. reload/disposed 无测试：否（`:1175-1199`、`:333-347`、`:1263-1282`、`:1163`）。
07. 多 agent/session 无覆盖：否（`:610-653`/`:655-691`/`:707-787`）。
08. REAL-composition 缺口：否（`apps/web/tests/plan-review.e2e.ts` 等，挂 CI aggregate）。
09. `intent.layers` 只有桥读 ⇒ 应删：否（intent 类型自述可扩展；生成物 `api-catalog.ts` 逐字一致）。真问题是校验（F9）。
10. 投影死字段：否（`active`/`pending` 都被 web 消费）。
11. `/plan off` 五分支与 `set()` 四返回值覆盖不全：否；仅 open-turn 的 `cancelled` 返回值未直接断言（可补一行）。
12. invariant 伴生应删：不建议（比对 durable 历史读取路径，属保留类）。
13. 测试共享资源风险：否。
14. `sendPlanContent` 的 layers 形参不可达：否（`planFilePath === ''` 时经 `persistPlanFile` 落盘再读回，且有测试）。
15. `persistPlanFile` 写后立刻读回是浪费：不报（非维护性/用户可见问题）。
16. `fitSVGTextSizes`/`sanitizeSVGVars`/`ensureSVGViewBox` 与 render skill 同公式重复：有意（作用于 LLM 产物边界）。
17. reload 后计划卡导出/状态降级：非本链路引入，已注释（`engine.ts:1582-1592`）。
18. 计划卡状态 note 永久停在「已发送 Ns」：移植自 Go 的设计。
19. `plan:policy` 英文文案与「中文白话」冲突：否（模型指令 ≠ client UI 文案）；真冲突是 F3 的文案自相矛盾。
20. lockstep 的 re-adapt 成本是主要问题：否（`bundle-patch.spec.ts:179` 是有意 tripwire；上游对 base section 只在 2026-08-06 写过一次，义务至今未触发）。
21. three-mirror 散文重复：有意设计（三面同边界 + 各自 spec 钉住）。
22. `docs/tool-catalog.md:161-186` 与 plan-mode README 覆盖不足：否（逐字含 `details`、`required:["plan"]`、拒绝句）。
23. 压缩摘要超限会静默截断：否（超限走 max-tokens 抛错，整笔落盘或整笔失败）。
24. compaction 的逐字保留靠读事件/字段实现：否（完全不读，只有两行提示词）。

---

## 3. 待拍板项（各附推荐；与 09-12 报告 #7 部分重叠）

| # | 项 | 推荐 | 代价 |
| --- | --- | --- | --- |
| A | compaction：加「落盘前必须含已批准计划」的包含性检查（frameSummary 比对 shadowed region 里 `exit_plan_mode` 的原参数），并把 README 的「fail closed」变成事实；同 09-12 报告 #7 | **做**（现在只有提示词 + 同义反复测试，承诺强于代码） | 改上游包 compaction-basic 的落盘校验 + README 双语 + 行为测试 |
| B | `layers` 在 asker 侧补第三条校验（或让桥从 `detail` 派生分层） | **做**（补第三断言最小） | 落在上游共享类型包；也可 fork 局部加固 |
| C | 删 `ctx.planMode.get()`（零生产消费者；同 09-12 报告 #20） | **可做**（pre-stable 允许） | 公共 API 变更，需改 40+ 处测试断言；09-12 报告建议随上游提案（与它的 #17 同名异义同族） |
| D | 计划图片中文标签本地化 / 词条补齐（ja/es/zh-TW）；至少合并同值词条 | **看你要不要**（图片是否本地化属产品决定） | 模板改造或补 4 个 locale |
| E | 把「两层计划」整体提上游（`details` + `layers` + 拒绝门） | **待定** = F6 台账的状态栏 | 需要一份上游 PR；fork 侧 diff 可归零 |

---

## 4. 合并后的修复顺序（两份报告的并集；本次不实施）

- **Wave 1（并行，文件面不相交）**
  - **G1 引导面**：09-12 报告 A 组（#1 工具名 + 内容 pin、#2 patch 补第 4 个 delta 与 lockstep 口径、#6 三处文案条件化、#9/#21 README、#22 计数）+ 本文 F2（假保护声明改义务陈述）、F3 的 `/plan` 文案与 guard 判据、F7 的 README:75 / 永真断言 / 三份 note / chatroom 死文本。
  - **G2 渲染与校验**：09-12 报告 B 组（#3 #4 #12 #13 #14 #15）+ 本文 F4a（取消与落盘时序）、F5 的补充死代码项。
  - **G3 测试补强**：09-12 报告 C 组（#5/#11/#18）+ 本文 F8（`set()` 直提交失败、pre-step 守卫）。
  - **G4 台账与结构合并**：本文 F6（三行 + 固定面成本）、F5 的模板 84% 合并与状态机合并（各自单独提交）。
- **Wave 2（串行，必须最后）**：**F1 的样本刷新与复验**。硬约束：G1 里所有模型可见文案（工具描述、拒绝文案）改完才刷，只刷一次；受影响 lane = 网页 + 会话（复审勘误：acp 的 dsh-memory 已被 96d11f14db 清掉，该 lane 仅剩既存 key 失败），两份 pwsh 样本手工对齐；刷新后 `git diff snapshots/` 人工过一遍。
- 合并两份报告后建议仍按「先改文案 → 再刷新 → 最后结构重构」的次序；两条 Windows-only 样本无法本机刷新属已知残余。
- **（复审更正 2026-09-14）分组口径**：上表「文件面不相交」不成立——G1（09-12 #6 的包内文案、本文 F3 的 `/plan` 文案与 guard 判据）与 G3（#5/#11/#18、F8）共享 `packages/plan/plan-mode/`。执行以 09-12 报告 §3 复审后的三组为准：**组一 plan-mode 包**（#5 + #6 包内两处 + #11 + #18 + 本文 F3 的 index.ts 项 + F8）、**组二 bridge 引导面**（#1 #2 #6 桥侧 #9 #21 #22 + 本文 F2 + F7）、**组三 bridge 渲染生命周期**（#3 #4 #12 #13 #14 #15 + 本文 F4a + F5 死代码）；G4 与 Wave 2 结构不变。F1 失效清单同步勘误为 6 份（见 F1）。

---

## 附录 A：台账草案（可黏进 `upstream-graft-ledger.md`）

```
| plan 两层评审：exit_plan_mode 的 details 参数 + plan-review intent.layers（含 bridge 折叠渲染） | de2def5b0e | 待提上游（消费者仅 fork bridge；`layers` 已在共享类型 AskUserQuestionIntent 内） |
| 内联实施细节段的纠正性拒绝门禁（4 个标题名，h2 精确匹配） | 6cbbfd489b | 待提上游（随上行同批；当前收窄，模型换级别会漏、围栏会误伤） |
| compaction 逐字保留已批准计划（summarizer 指令 + 双参数措辞） | 797294d9d1 / 4379cb7e06 | 待提上游（纯提示词，无程序化保证；落盘无包含性检查） |
```

重嫁接成本备注：**37 份 `snapshots/**/expected.*` 固定了 `exit_plan_mode` 的文案与参数**；上游重录样本时会与 fork 文案冲突，`38b665610b` 另需为 fork 自有 acp 场景补 `session.v3.jsonl` 后继。

## 附录 B：实测复现记录

```
$ DSH_SNAPSHOT=replay ./node_modules/.bin/vitest run --config vitest.web.config.ts \
    apps/web/tests/replay-round-trip.e2e.ts
 ✓ drives the recorded prompt to a settled turn (all modes)
 ✓ ends the system prompt with the source checkout, Web surface, and session cwd
 ✓ exposes the assembled Web URL to the real bash tool
 ✓ rendered the settled turn: markdown, tool row, composer restore
 ✓ matches the conversation aria golden with stable anchors
 ✓ renders the system prompt disclosure inside the expanded Turn process
 ✓ expands and collapses the reasoning fold from its click target
 ✓ stayed clean: no pageerrors, no reconnect self-healing, no server errors

 ⎯⎯ Failed Suites 1 ⎯⎯
 FAIL apps/web/tests/replay-round-trip.e2e.ts > web e2e: fresh round trip through the real assembly
 AssertionError: snapshots/web/fresh-round-trip/session.v3.jsonl: tool-schema pin:
   expected '{ "initial": [ { "name…' to be '{ "initial": [ { "name…'
 ❯ apps/web/tests/scaffold.ts:1082  (assertReplaySession → compareOrRefreshGolden)
 Tests  8 passed (8)
```

操作注意：本会话直接跑会先撞两层障碍——(1) 嵌套 `sandbox-exec` 被会话沙箱拒绝（子进程 `SandboxUnavailableError` / `sandbox_apply: Operation not permitted`），需按仓库 host-sandbox 条款一次性提权；(2) `pnpm exec/run` 会触发依赖检查报 `ERR_SQLITE_ERROR`，改用 `./node_modules/.bin/vitest`。

## 附录 C：未做的验证与边界

- 未执行刷新、未修改任何仓库文件（除本文件）。仓库根目录另有并行会话的 `plan-mode-audit-2026-09-12.md`（untracked），本文件不改动它。
- 两份 `platform: pwsh` 样本的失效为静态核对，本机（macOS）与 Linux 都跳过；`snapshots/acp/dsh-memory` 所在簇另有既存失败（replay 需 `DEEPSEEK_API_KEY`），红/绿需在有 key 的环境确认。
- F4a 的时序窗口、F4b 的「失败后不可重试」为代码路径静态确定 + 触发时序推断，落地时应各自先写红测试。
- `presentCall` 零消费者限定 in-tree。
- 未逐条核对 `truncatePlanLayers` 的截断阈值是否与 `detail` 一致（同一事实两路截断，极端长度下可能分叉）。
