# Agent Note: feishu-bridge 卡片回调表单值——wire 键名是 `form_value`

Status: implemented

[English](2026-08-20-feishu-bridge-card-action-form-value-key.md) | 中文

## 问题

用户在一张 AskUserQuestion 多选卡（34 条未迁移命令）上提交后，agent 只收到光杆协议串 `askq:0`——勾选项全部丢失，答案里没有任何选择。同样的静默丢失还波及两条从未测过的通路：权限卡的拒绝理由（`deny_reason`）和 hint 按钮输入框的值（`hint_arg_*`），它们同样经表单提交回传。

移植的 `CardActionTriggerEvent` 类型把回调的表单载荷声明为 `action.formValue`（camelCase），所有读取点都用了这个键。飞书 wire 载荷在 `action` 里用的是 snake_case 的 `form_value`；node-sdk 的 `EventDispatcher.invoke` → `RequestHandle.parse` 路径只解 v2 信封的 `event` 对象、键名原样透传，所以运行时 `action.formValue` 是 `undefined`，`collectAskqMultiSelected(undefined)` 返回空表，派发的答案就只剩问题序号。更早引入收集逻辑的修复（4e484936ab，"multi submit collects form indices"）在测试里看起来是对的——因为测试载荷照抄了同一个错误键名。

事故报告里容易误导的一段：事发群里的值班 agent 诊断"daemon 还没 reload，修复只在仓库里"。机制上这是错的——commit 4e484936ab 落于 2026-08-19 22:47，daemon 于 2026-08-20 18:02 带新构建重启，修复已在线上却照样丢勾选项。真正待 reload 的是之后两笔提交（权限卡原地换卡、答案冻结卡），报告把它和这笔混为一谈了。

## 决策

字段改回 wire 键名并只读它：`CardActionTriggerEvent.action.form_value`（`Record<string, unknown>`），四个读取点同步更新——perm 拒绝理由的两处（派发内容与回退卡正文）、`collectAskqMultiSelected(action.form_value)`、`cmd:` 分支的 hint 输入值查找。接口 JSDoc 改为如实说明各自的验证途径：root 嵌套经真机载荷确认，`form_value` 键名对照 Go oapi-sdk-go 卡片事件结构体的 json tag（`card/model.go`：`FormValue map[string]interface{} \`json:"form_value"\``）确认——生产环境的 Go bridge 一直经这个 tag 读到值。原先"confirmed against live payloads"的注释夸大了实际验证范围，让错误键名熬过了评审。

本该拦住这个 bug 的多选测试只断言了 `isAskqCardAction`——空选择下它同样为真；现在它断言派发内容带收集到的索引（`askq:0:2,10`）。

## 考虑过的替代方案

**两个键都接受（`formValue ?? form_value`）。** 让错误键名永久存活，且类型继续对 wire 格式说谎；SDK 对 wire 键名逐字透传，正确的名字只有一个。

**修复前先拿真机载荷验证。** 运行中的 daemon 对原始 card-action 载荷零日志，而加日志本身就需要那次我们想省掉的 reload。Go SDK 的 json tag 加上生产 Go bridge 在同类卡片上一直可用已是权威依据；reload 后的真机冒烟是最终确认。

## 后果

多选答案带着勾选索引到达引擎，拒绝理由和 hint 输入值在回调中存活，冻结确认卡（标记勾选子集）也有了真实索引可标。类型里不再残留 wire 格式歧义。留给引擎侧的后续决策：零索引的多选提交目前派发光杆协议串，引擎把它当用户消息递给了模型——空提交是否应改为提示「未勾选任何选项」是引擎策略问题，超出本次范围。

## 测试

`tests/feishu/card-action.spec.ts` 载荷从 `formValue` 换成 `form_value`：红跑精确复现线上症状（6 个失败——拒绝理由正文丢失、hint 参数丢失、冻结卡无 ✅ 标记、派发内容缺索引），多选索引测试新增 `content === 'askq:0:2,10'` 断言。修复后全包 1930 绿。
