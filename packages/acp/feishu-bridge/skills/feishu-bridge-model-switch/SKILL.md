---
name: feishu-bridge-model-switch
description: "切换 feishu-bridge live bot（运维虾）的 LLM 模型：网关实测 → switch-model.mjs 双落点联动 → 手动 reload → 验收。触发例句：「换模型」「切换模型」「switch model」「运维虾用 glm/deepseek」「切到 deepseek-v4-flash」「还是 glm 模型」。"
when_to_use: "当用户要更换 feishu-bridge live bot（运维虾）使用的模型，或反馈模型切换未生效/仍是旧模型时使用。涵盖：主模型切换、spawn 群默认路由切换、新模型网关实测与登记。"
allowed-tools:
  - Bash(node *)
  - Bash(curl *)
  - Bash(grep *)
  - Bash(tail *)
  - Bash(zstd *)
  - Read
  - Edit
---

# feishu-bridge 模型切换

把 live bot 切到目标模型：实测网关（新模型）→ 跑切换脚本（双落点联动）→ 用户手动 reload → 验收 → 可回滚。

## 输入

- 目标模型 id：如 `deepseek/deepseek-v4-flash`、`zhipuai/glm-5.3`（用户消息给出）
- 范围：仅主模型 / 含 spawn 群默认 / 存量群处理——第 1 步向用户确认

## 步骤

### 1. 范围确认

「换模型」通常指主模型，但 spawn 群默认路由（`spawnProvider`）是独立配置项。问清三件事：
① 仅主模型还是连 spawn 群默认一起切（后者加 `--also-spawn`）？
② 存量钉旧路由的群（state.json `provider_overrides`）要不要逐群处理？

**成功标准**：范围明确，用户答复覆盖①②。

### 2. 模型检查

读 `~/.dsh/tools/switch-model.mjs` 的 `KNOWN_MODELS` 表：

- 目标已在表内 → 直接下一步
- 不在表内 → **MUST 先读 `references/gateway-probe.md`**，按流程实测网关，全过后登记进表（改脚本 + 跑 `~/.dsh/tools/switch-model.test.mjs` 全绿）才继续

**成功标准**：目标模型已在 KNOWN_MODELS 表内。

**规则**：新模型不实测就是瞎编——contextWindow 和 effort 档位是网关实测结论（GLM 的 medium 会 400 这类坑只有实测能发现），从目录抄值 ≠ 网关接受。

### 3. 执行切换

```sh
node ~/.dsh/tools/switch-model.mjs <model-id> [--also-spawn]   # 可先加 --dry-run 预览
```

脚本自动完成：cordis.patch.yml 三处 + settings.yaml 镜像层同步、带时间戳备份、落盘前结构自检（坏了不落盘）、dump-config 预检。

**成功标准**：exit 0、输出含「已落盘」、无「预检失败」。
**产物**：备份路径（`.bak-switch-model-*`），记下来供回滚。

### 4. [human] reload

提醒用户手动 `/reload`（选空闲时机；重启中断进行中的轮次，transcript 回滚到最后完整轮次）。

**规则**：绝不自动 reload、绝不自排 reload 定时任务（用户裁定，reload 时机永远归用户手动）。

**成功标准**：用户确认已 reload。

### 5. 验收

两个信号都要看：
- 群里发条消息，完成卡 🤖 行显示 `<目标模型>·max`
- 会话日志 `request/header` 的 model = 目标模型（`~/.dsh/feishu-bridge-sessions/<workdir>/<session>/session.v*.jsonl.zstd`，zstdcat 解压）

**成功标准**：两个信号都确认。

**规则**：本机 18090 代理已于 2026-09-11 退役（改直连 mify 上游），它写的 `~/workspace/op-dev/rate-limit-logger/logs/api.jsonl` 不再有 live 请求——验收只看会话日志与完成卡两个信号。

### 6. 回滚说明

告知用户两档回滚：
- 即时：群内 `/provider <旧条目名>`（无需 reload；条目名见 KNOWN_MODELS 的 entry 字段）
- 彻底：恢复第 3 步的备份文件后再次 reload

## Gotchas

- **dump-config 绿 ≠ 生效** → 预检只组 cordis 层；`~/.dsh/settings.yaml` 的 `mify-dsh.models` 是用户层镜像，**数组合并时整体替换**组合层——漏同步即 `UNKNOWN_MODEL`（2026-09-10 事故）。脚本已自动同步；绕过脚本手工改配置时必查两处。
- **spawn 群 ≠ 主路由** → `spawnProvider` 独立于 `agent.provider`；存量 spawn 群钉死在 state.json `provider_overrides`，改配置**不迁移存量**，需逐群 `/provider`。
- **▶ 标记 ≠ 实际请求** → `/provider` ▶ 指向的是路由解析结果；实际请求模型看会话日志 `request/header`（zstd 解压）或完成卡 🤖 行。两者矛盾时是模型选择覆盖链问题，单独排查，别急着改配置。
- **换 key 免 reload、换模型必须 reload** → llm-pi-ai 的 settings 层热载（chokidar），但 bridge 层配置（agent.provider / spawnProvider / providers 表）要重启生效。
- **本机专属** → 脚本与路径（~/.dsh、mify 上游 `http://model.mify.ai.srv/anthropic`、仓库 bin.js）均为 Mac live 环境硬编码；dev 服务器（运维驴）需手工同步三落点，不能直接跑本脚本。
- **改脚本必须跑测试** → `node ~/.dsh/tools/switch-model.test.mjs`（沙盒跑，不碰 live 配置）——脚本一改就要跑，全绿才算改完。

## references

- `references/gateway-probe.md` — 新模型的网关实测流程（探测命令模板、判定标准、登记步骤）。目标模型未在 KNOWN_MODELS 时 **MUST 先读**。
