# Agent Note: 计划审批拒绝开启讨论轮

Status: implemented

[English](2026-09-02-plan-rejection-discussion-round.md) | 中文

## 问题

飞书桥的计划审批被拒绝（带反馈）后，模型按引导句「If review rejects it, incorporate the feedback and present again」在同一 turn 内重新调用 exit_plan_mode：回应反馈的正文留在该 turn 的进度卡（实时播报段）里，新计划卡与审批卡紧随其后发出——回答被埋在用户必须翻越的卡片上方，唯一找回途径是已结算卡上可发现性差的「查看完整回复」按钮。根因是交互契约本身：回答与重提交共用一个 turn，turn 的最终回复投递永远轮不到这段回答。

## 决策

拒绝现在开启的是讨论轮：模型在正文中回应反馈并结束回合——回答随该回合的最终回复卡落在会话尾部、无卡片掩埋——仅当用户要求更新计划时才重新提交（拒绝备注中明确要求重看视为已开口；否则以收尾追问选项提供更新，复用引擎既有的非阻塞「后续处理」建议卡）。空反馈时反问要调整什么而非瞎猜。

契约落在 plan-mode 策略的既有归属：deployment-owned 的 `section` 配置。两层 patch 携带逐字相同的句子——`packages/bundle/base/cordis.patch.yml` 与 `packages/acp/feishu-bridge/cordis.patch.yml`（bridge profile 按序合成两层，live 会话读到的是 bridge 覆盖）——bundle-patch 的 lockstep spec 保持绿色（两文件差值仍恰好是那一句委派句）。exit_plan_mode 工具描述中性化为只述机制（"their feedback comes back in the tool result"，`packages/plan/plan-mode/src/index.ts`），不再有指令与 section 相争，策略保持按部署可配：三份 preset（standard/cordis/ptc）经由各自 section 维持 Claude Code 经典的「吸收反馈再提交」。钉住旧描述句的 37 个快照期望文件与 docs/tool-catalog.md 做了机械替换（回放从活源码重建工具 schema，手改期望夹具是正确的 keyless 更新程序）。

## 备选方案

**桥侧 flush：拒绝后的正文段在新计划卡前以独立卡片投递。** 用户否决：仍是插在消息流中间的一张卡、机械更多，且节奏（立即重提交）没改对。

**硬门：同 turn 重提交自动拒绝**（引擎的 `feishuBridge/ask-approval` 瀑布已存在，role-pick 自动审批在用）。搁置而非否决：决定性强，但会误拒拒绝备注中明确要求立即重看的合法情形（「改完直接给我看」）。设计记录于此；仅当活体观察发现引导被无视时再挂。

**section 内声明压过工具描述**（"these rules override the description's revise-and-present-again clause"）。用户否决：不优雅；更干净的修法是把策略从描述里拿掉（机制/策略分离），即已上线方案。

## 后果

桥引擎与卡片代码零改动——回答走既有 turn 终局投递，追问选项走既有收尾卡转换。presets 与 base/bridge 的节奏分歧保留至按 fork 同步节奏适时向上游提议。live profile 部署需先把 `@deepseek-ai/dsh-plan-mode` 加为 `link:` 依赖（profile 现经 registry 钉版的 dsh-base 解析它），`/reload` 才能拿到中性化后的描述。快照套件存在已知预存金样漂移（fs 工具 `sandbox_permissions` schema 字段；见[09-07 审计注记](../process/2026-09-07-full-suite-audit-fork-drift.zh.md)）——本改动经主仓基线对照验证未新增失败。
