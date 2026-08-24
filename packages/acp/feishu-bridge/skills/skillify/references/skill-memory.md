# 跨运行记忆（按需）

只有当一个 skill 需要「跨运行记住状态」时才加——典型是每日汇总、增量回顾类（要算「自上次以来变了什么」）。无状态 skill（draw / tdd / lark 增删改查 / 一次性脚本）**不要**加，避免噪音与 token 浪费。

## 约定

- 日志路径：`~/.claude/skill-memory/<skill-name>.log`（append-only 纯文本；已被 `.gitignore` 默认忽略、不进库）。普通 skill 和插件 skill 都用这一条路径。
- 每次运行三步：
  1. 先 Read 该日志看历史 → 告诉用户记得什么（尤其最近一次）。
  2. 干活。
  3. 把本次关键结果 append 一行 `<UTC 时间戳>\t<一行摘要>`：

```bash
mkdir -p ~/.claude/skill-memory && \
  printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "<一行摘要>" \
  >> ~/.claude/skill-memory/<skill-name>.log
```

## 写进新 skill

把上面三步写成该 skill 自己 SKILL.md 里的运行指令，路径里的 `<skill-name>` 换成实际名字。

## 天花板

「每次一条、纯文本 append」无并发控制、无结构化查询。要更强升级到 JSONL / SQLite / 加文件锁——非必要不碰。
