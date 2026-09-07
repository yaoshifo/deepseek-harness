# Agent Note: chatroom userProfile 注入配置面移除

Status: implemented

[English](2026-09-06-chatroom-user-profile-injection-removal.md) | 中文

## Problem

chatroom 的 `userProfile` 配置项（Go `user_profile` 迁移残留）把一份用户背景文件无条件注入所有 chatroom persona（角色、主持人、direct-role），并在 `/chatroom` 启动与工具 `start` 动作处 fail loud 校验可读性。该机制已被有意废弃：chatroom 前身仓库（yaoshifo/chatroom）早在 36beb5f 就把「启动自动注入」改为「主持人出卡确认后按需 `Read` vault 的 user-profile.md」，决策规则由 books 主持人契约（books/chatroom/CLAUDE.md「用户背景」段）承载。生产 profile 从未配置该键，但配置面存在本身就是漂移源——哪天配上即双机制打架：系统提示词已注入全文，主持人仍按契约出卡问用户「要不要加载」。

## Decision

整面移除：`Config.userProfile` 接口字段与 schema 键、`userProfileCfg` 字段与 apply 分支、`userProfile()` 读取器；persona 组装的 `loadUserProfile` 与「## 用户背景（服务对象）」注入段及 `userProfilePath` 参数；policy 两处传参；`/chatroom` 与工具 `start` 的 `chatroomUserProfileError` 启动 gate；i18n 三处（en/zh/枚举）；README 双语与 SKILL.md 对应表述。SKILL.md 顺带把 `AskUserQuestion` / `MultiSelect` / `(Recommended)` 旧工具名对齐引擎真名 `ask_user_question` / `multi_select` / `recommended: true`（与 books 侧 2026-09-06 的同族修复补齐 dsh 半边）。

## 备选方案

**books 主持人契约加防呆说明。** 否决：说明防不住配置面本身——误配入口还在，写「不要配」不如让键不存在。

**保留配置项作为未来消费方的前向兼容。** 否决：与 context_window 链移除（2026-09-03）同款论证——自迁移起就无人配置的死配置面只会招来运维抄写。

## Consequences

生产无该键，运行时行为零变化；「按需加载用户背景」成为唯一机制，其单源是 books 主持人契约（引擎不再有平行的注入通路）。存量配置里遗留的 `userProfile:` 行会被 Schema 当未知键静默剥离（惰性无害；生产 profile 已核无此键）。用户背景进入讨论的唯一通路收敛为：主持人出卡 → 用户确认 → `Read` vault 文件 → 摘录进账本综述段。

## Testing

absence 经 grep 验证：`userProfile` / `user-profile` / `AskUserQuestion` / `MultiSelect` 在包内 src/tests/README/skills 零残留（SKILL.md 保留的 `vault/.claude/user-profile.md` 路径是按需 Read 的目标文件，非配置引用）。死行为测试随行为删除（persona 注入/跳过、config ~ 展开、tool start fail-loud、engine 启动 gate），policy 的 persona 组装测试改写为断言 base 段存在。聚焦 196 测试绿（persona/config/policy/tool 60 + engine/gather 136）；全仓 typecheck 通过。
