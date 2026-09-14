# Agent Note: 拒绝富化模式推广到 edit 匹配错误、write 未读覆盖与 skill unknown

Status: implemented

[English](2026-09-13-rejection-enrichment-round-two.md) | 中文

## Problem

「拒绝即赋能」模式（[edit 未读拒绝附文件内容](2026-09-13-edit-unread-rejection-content-attachment.zh.md)）上线并实测后，按同一判据（拒绝后模型还需一轮拿信息才能自愈）扫描了其余模型可见面，确认三处同款摩擦：`edit` 的 `FS_EDIT_NOT_FOUND` 零线索、`FS_AMBIGUOUS_EDIT` 只报次数不带位置（模型写不精确 old_string 只能再 read）；`write` 未读覆盖已存在文件仍走三轮自愈；`skill` 的 unknown 错误完全不可自愈（不知道有什么可用）。`read` 的 offset 越界错误已带总行数，达标不动；bash 沙箱拒绝的被拒路径在沙箱后端内部拿不到，暂缓。

## Decision

三处独立落地，共用同一模式的四要素（附自愈信息、做掉自愈副作用、更准失败、回退不劣于现状）：

- **edit 匹配错误**（`packages/fs/fs-local/src/fsio.ts`）：歧义错误附每处匹配的起始行号与起始行原文（超过 10 处列前 10 并注明总数）；not-found 以 old_string 首行 trim 为探针找候选行（保留缩进原样，最多 3 个，模型能看出空白差异），无候选逐字节回退原文本。错误码不变，调用方按码分支的契约不受影响（README 明言 callers branch on the code）。
- **write 未读覆盖**（`packages/fs/tool-fs/src/write.ts`）：edit 的 `enrichNotObserved` 提为共享模块 `src/unread-attachment.ts`（动词参数化：`retry the edit/write directly`、`cannot edit/write "…": not found`），write 的 catch 接入。附带内容同时给模型「正要覆盖的现有内容」一眼确认，防丢数据。
- **skill unknown**（`packages/skill/tool-skill/src/index.ts`）：错误附「最相近的至多 3 个 model-invocable skill 名 + 总数」；判定为小写包含优先（字母序）、无包含退化为字母序前 3、无任何 skill 报 `no skills are available in this session`；清单来自 `ctx.skills.list` 同 scope 同 lookup（当前会话实际可见），只建议可调用的名字。

## Alternatives considered

**把相近判定做成通用模糊匹配库。** 放弃：三处的「相近」语义各不相同（编辑距离 vs 子串包含 vs 行探针），各写十行确定性代码胜过引入共享抽象；无新依赖。

**not-found 附全文（与未读拒绝同款）。** 放弃：edit 匹配失败时模型通常已读过文件（策略保证），全文已在上下文；缺的是「现在文件里最像的那几行」——行级候选比全文窗口信息密度高且省 token。

## Consequences

- 三处自愈各省一轮；skill unknown 从不可自愈变为一步修正。
- 消息全部有界（行号列表 ≤10、候选 ≤3、skill 名 ≤3）；无候选/空清单场景逐字节回退或明确退化，最坏不劣于现状。
- 上游 sync 注意：fsio.ts 的两个消息模板与 tool-skill 的诊断函数是本 fork 增量；若上游改这些错误行，保留富化段即可。

## Testing

fs-local `filesystem.spec.ts` 新增 4 用例（歧义附位置、超 10 封顶、not-found 附候选、无候选逐字节回退）；tool-fs `integration.spec.ts` write 未读覆盖改为断言附带内容并新增直接重试成功用例（372 绿）；tool-skill `tool-skill.spec.ts` 新增 3 用例（子串建议/字母序退化/空清单，35 绿）。包级 oxlint/tsc 全过；快照无连带（fs-policy-reject 只锁 edit 未读消息，A/C 消息无快照引用）。
