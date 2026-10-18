# dsh-big-compact

**[中文](README.md) | [English](README.en.md)**

**超大会话压缩插件。** dsh 自带压缩（compaction-basic）会把要压缩的旧历史一次性塞进一个模型请求；会话涨到几 MB 之后，中转会拒绝（404 `model_not_found`），`/compact` 只剩一句 “Compaction could not produce a useful summary”。本插件在 `llm/stream` 瀑布上兜底：**只在压缩请求超过阈值时接管**，把它切成多块分别摘要、再合并成最终检查点；小会话与普通对话一律原样放行。

设计取向参考 [billion-context](https://github.com/ranxianglei/billion-context)：普通请求/小上下文不走它，只有大到本地压缩处理不了时才启用。

## 触发条件（实时监测）

1. 每次 `llm/stream` 都用 `ctx.tokenMeter.measure(session)` **实测该会话当前上下文 tokens**（上下文每轮都在变，按实测算）；
2. **窗口是动态的**：每次压缩请求先 `ctx.llm.resolveModelInfo(provider, model)` 读模型声明的 `contextWindow`（例如 profile 里写 850000 → 安全线 850000 × 0.85 = 722500）；解析失败才退回配置/500k 兜底；
3. 实测值（拿不到时退回请求体估算）> **窗口 × 0.85** 就分块；
4. 另外保留 **请求体 > 4 MB** 的字节兜底（中转请求体上限）。

上下文占到 85% 时会打一行预告：`上下文实时监测：… tokens，已达窗口 … 的 95%，下次压缩将分块`。

## 工作方式

```
dsh 压缩引擎
  └─ ctx.llm.stream({ purpose: 'compaction', messages: [系统提示, 历史…, 压缩指令] })
       └─ [本插件] 先实测上下文 / 解析窗口，再决定
            ├─ 未超线 → next()，走 dsh 自带压缩（行为不变）
            └─ 超线   → 分块模式
                 1. 历史消息按时间顺序装箱（默认 1.5 MB/块）
                 2. 每块一个小请求 → 结构化要点（默认 max_tokens 6000，3 路并发）
                 3. 各块摘要合并；合并后仍超线就再做一轮
                 4. 合并摘要 + dsh 原始压缩指令发给模型，得到最终检查点
                 5. 按 raw chunk 协议回放（text 块 + finish stop）给压缩引擎落盘
```

- 子请求的 `purpose` 是 `compaction-chunk` / `compaction-final`，不会再次触发插件（无递归）。
- **空摘要算失败**：某块返回空或少于 10 字时，自动重试并把输出预算翻倍（最多 20000 tokens），仍失败则二分再试（最多 2 层）。
- 整条链路失败时回放 `finish{kind:'error'}`，`/compact` 会照常报错并写会话日志，不会静默。

## 配置

`/root/.big-compact/config.json`（不存在时用默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `thresholdBytes` | 4000000 | 请求体超过该字节数才接管（字节兜底） |
| `maxContextTokens` | 0 | 0 = 按模型动态解析 `contextWindow`；>0 = 强制覆盖 |
| `contextFillRatio` | 0.85 | 实测上下文 > 模型窗口 × 该比例 就接管 |
| `chunkBytes` | 1500000 | 每块字节预算（UTF-8 字节） |
| `chunkMaxTokens` | 6000 | 每块摘要的 max_tokens（重试时翻倍，上限 20000） |
| `finalMaxTokens` | 8000 | 最终合并的 max_tokens |
| `concurrency` | 3 | 分块请求并发数 |
| `retries` | 2 | 单块失败重试次数 |
| `maxMessageChars` | 200000 | 单条消息最多保留字符数（防一个巨大工具结果吃掉整块） |
| `maxDepth` | 2 | 失败二分重试的最大深度 |
| `verbose` | true | 是否打印每块进度 |

## 日志

`/root/dsh-web.log` 里搜 `[big-compact]`：

```
[big-compact] 已启用：窗口 按模型动态解析，安全线 85%，分块 1.43 MB，并发 3
[big-compact] 上下文实时监测：6464308 tokens，已达窗口 850000 的 760%（安全线 85%），下次压缩将分块
[big-compact] 超大压缩请求（上下文 6464308 tokens（实测）> 窗口 850000 × 0.85 = 722500）→ 分块模式
[big-compact] 压缩请求 23.13 MB，切成 9 块
[big-compact] 分块 1/9 完成（1.43 MB → 3621 字）
...
[big-compact] 压缩完成：9 块，用时 96.6s，摘要 3586 字
```

## 测试

```bash
node test/unit.mjs          # 离线：分块、合并、拦截边界、空摘要重试、动态窗口、失败兜底
node test/live.mjs 12 3     # 真机联调：12 MB 合成压缩请求 → 分块 → 合并（直连中转）
```

## 安装 / 卸载

- 已注册进 `profiles/web/package.json`（依赖 + `dsh.profile.bundles`）并建立
  `node_modules/dsh-big-compact` 链接；**重启一次 web 生效**（`patchReload: startup`）。
- 卸载：从 `dependencies` 与 `dsh.profile.bundles` 删掉 `dsh-big-compact`，
  删 `node_modules/dsh-big-compact` 链接；重启 web。插件文件在 `/root/dsh-big-compact`。

## 已知限制

- 分块摘要是有损的：每块只保留要点，细节以原会话日志为准。
- 依赖中转能接受单块 1.5 MB 的请求；若某个中转更严格，把 `chunkBytes` 调小即可。
- 只处理 `purpose === 'compaction'` 的请求；普通对话不拦截。
