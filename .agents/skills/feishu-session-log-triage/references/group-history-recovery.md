# 从飞书群历史找回丢失内容

**适用场景**：dsh 重启丢掉并行子任务调度、会话日志缺失或不完整，但需要找回子任务的汇报全文或当时的实施计划。

**原理**：子任务的汇报以「子任务完成」卡片留在子任务飞书群里——report 调用全文与 exit_plan_mode 的完整计划文本都在群里（进度卡会镜像工具调用）。群历史是飞书侧持久数据，与 dsh 进程生命周期无关；丢的只是主会话内存里的回报路由。

## 步骤

1. 用 lark-cli 的 IM 历史能力拉群消息。子命令名以 `lark-cli skills read lark-im` 的当前文档为准——im 子命令经历过改名，报错先查当前 help，不要反复重试旧签名。2026-08-24 实测签名：

   ```bash
   lark-cli im +chat-messages-list --chat-id <oc_...> --as user --sort ByCreateTimeDesc --no-reactions
   ```

2. 返回的卡片是深层转义 JSON：落盘后用 python 先解 `body_content` → `json_card`，再递归提取 `content` 字段，得到汇报全文。无需用户手动复制粘贴。

## 注意

- 只读操作，可直接执行。
- lark-cli 查询类调用可能撞 macOS 钥匙串沙箱（`keychain Get failed`）——提权重试即可，不是凭证失效。
- 单条卡片带正文投影用 messages-mget 比 list 稳定；但 v2 interactive 卡的投影会吞空行（`\n\n` 投影成 `\n`），不能凭投影判断原文空行。
- 找不到子任务的群 chat_id 时，从 daemon 日志找回：`grep -a "spawned group chat" ~/.dsh/feishu-bridge-stdout.log`（历史轮转 `.old-*` 文件一并搜）。
- 找回内容后按正常排查流程继续：内容在群里 ≠ 会话日志可用，两者互为备份。
