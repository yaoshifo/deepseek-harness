# 新模型网关实测流程

目标模型不在 `KNOWN_MODELS` 表时，**实测全过才能登记切换**。探测的是 mify 网关（`127.0.0.1:18090`，透明转发 `model.mify.ai.srv/anthropic`）——模型 id 原样透传，能否用取决于上游，所以每个新模型都要单独探。

## 前置

- **key**：`~/.dsh/.credentials.yaml` 的 `FB_MIFY_API_KEY`（env 段）
- **wire 格式**：必须用 pi-ai 实际发出的形态——anthropic-messages + provider 级 `forceAdaptiveThinking` 兜底下的 `thinking: {type: "adaptive", display: "summarized"}` + `output_config: {effort: <档>}`。用别的形态（比如 budget_tokens）探过 ≠ 线上能用。

```sh
KEY=$(grep "FB_MIFY_API_KEY" ~/.dsh/.credentials.yaml | sed 's/^ *FB_MIFY_API_KEY: *//; s/"//g')
```

## 探测清单（六项，全过才登记）

### 1. 基础调用（effort=max）

```sh
curl -sS -m 60 http://127.0.0.1:18090/v1/messages?beta=true \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"<MODEL-ID>","max_tokens":16,"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"max"},"messages":[{"role":"user","content":"hi"}]}'
```

**过**：HTTP 200，`content` 含 `type: "thinking"` 块（带 `signature` 字段——没有 signature 会导致无签名 thinking→text 回传环）。

### 2. effort 档位逐个探

对 `low` / `high` / `xhigh` / `max` 各发一次（同上改 effort 值）。

**过**：全部 200。**要记录**：哪些档被拒（GLM 的 `medium` 会 400 code 1210——这类结论只来自实测）。KNOWN_MODELS 的 `efforts` 表只登记实测通过的档（wire 直传字符串）。

### 3. 图片输入

```sh
# content 换成 [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}},{"type":"text","text":"what color is this image? one word"}]
```

**过**：200 且正常回答（input_tokens 明显大于纯文本）。不过则该模型不收图——`defaultInput` 只有 text，read_image 会 400，须在登记时注明。

### 4. 长输入（≥200K token）

用 ~1MB ASCII 文本（`("The quick brown fox jumps over the lazy dog. " * 21000)[:1050000]`）做 user content，max_tokens: 1。

**过**：200。mify 曾有模型相关的 200K 输入上限（proxy.js 旧注释），逐模型实测才算数。

### 5. 跨模型恢复（存量会话切换）

```json
{"model":"<MODEL-ID>","max_tokens":32,"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":"max"},
 "messages":[{"role":"user","content":"hi"},
   {"role":"assistant","content":[{"type":"thinking","thinking":"greeting analysis","signature":"foreign-sig-style-abc123"},{"type":"text","text":"Hello! How can I help?"}]},
   {"role":"user","content":"say OK"}]}
```

**过**：200。回放带外来签名 thinking 块的历史不报错——live 会话切模型靠这个。

### 6. 反证（无效模型名）

```sh
# model 换成 "<MODEL-ID>-nonexistent"
```

**过**：401「该模型不在 Key 的可用模型范围内」。这一步证明 key 白名单真实生效——前面 200 不是网关静默兜底到别的模型。

## 判定全过后：登记

1. 取 contextWindow：优先 OpenRouter 目录录制值（`packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json` 按精确模型 id 查）；无录制值时用保守实测下限并注明。
2. 在 `~/.dsh/tools/switch-model.mjs` 的 `KNOWN_MODELS` 加条目：

```js
'<MODEL-ID>': {
  entry: '<条目名>',            // bridge providers 的 key，如 deepseek-flash
  name: '<展示名> (mify)',
  contextWindow: <数值>,          // 不带下划线分隔
  efforts: { low: 'low', high: 'high', max: 'max' },  // 只列实测通过的档
},
```

3. 跑测试：`node ~/.dsh/tools/switch-model.test.mjs` 全绿（沙盒，不碰 live 配置）。
4. 之后走 SKILL.md 第 3 步正常切换。

## 探测留痕

网关日志 `~/workspace/op-dev/rate-limit-logger/logs/api.jsonl` 记录每次探测（request_fields 含 thinking/output_config wire 档位）——事后排障可直接查。
