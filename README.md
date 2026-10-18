# dsh-big-compact

**超大会话压缩**：dsh 自带压缩（compaction-basic）把要压缩的旧历史一次性塞进一个模型请求；会话大到几 MB 之后，中转会拒绝（返回 404 `model_not_found`），`/compact` 只剩一句 “Compaction could not produce a useful summary”。这个插件在 `llm/stream` 瀑布上做一层兜底：**只有压缩请求超过阈值时才接管**，把它切成多块分别摘要，再合并成最终检查点；小会话和普通对话一律原样放行。

设计取向参考 [billion-context](https://github.com/ranxianglei/billion-context)：普通请求/小上下文不走它，只有大到本地压缩处理不了时才启用。

## 工作方式

```
dsh 压缩引擎
  └─ ctx.llm.stream({ purpose: 'compaction', messages: [系统提示, 历史…, 压缩指令] })
       └─ [本插件] 估算请求体大小
            ├─ ≤ thresholdBytes（默认 4 MB）→ next()，走 dsh 自带压缩（行为不变）
            └─ > thresholdBytes → 分块模式
                 1. 历史消息按时间顺序装箱（默认 900 KB/块）
                 2. 每块一个小请求 → 结构化要点（默认 max_tokens 3000，3 路并发）
                 3. 各块摘要合并；合并后仍超阈值就再做一轮
                 4. 把合并摘要 + dsh 原始压缩指令发给模型，得到最终检查点
                 5. 按 raw chunk 协议回放（text 块 + finish stop）给压缩引擎落盘
```

- 触发条件（按**实时监测**，上下文每轮都在变）：
  1. 每次 `llm/stream` 都用 `ctx.tokenMeter.measure(session)` 实测该会话上下文 tokens；
  2. 窗口是**动态**的：每次压缩请求先 `resolveModelInfo(provider, model)` 读模型声明的 `contextWindow`
     （例如 profile 里写 850000 → 安全线 850000 × 0.85 = 722500），解析失败才退回配置/500k 兜底；
  3. 实测值（拿不到时退回请求体估算）> 窗口 × 0.85 就分块；
  3. 另外保留 **请求体 > 4 MB** 的字节兜底（中转请求体上限）。
- 上下文涨到 85% 时会打一行预告：`上下文实时监测：475000 tokens 已达窗口 500000 的 95%，下次压缩将分块`。
- 子请求的 `purpose` 是 `compaction-chunk` / `compaction-final`，不会再次触发插件（无递归）。
- 单块失败会重试（默认 2 次），仍失败则二分再试（最多 2 层）。
- 整条链路失败时回放一个 `finish{kind:'error'}`，`/compact` 会照常报错并写会话日志，不会静默。

## 配置

`/root/.big-compact/config.json`（不存在时用默认值）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `thresholdBytes` | 4000000 | 超过该字节数才接管；≤ 时走 dsh 自带压缩 |
| `maxContextTokens` | 0 | 0 = 按模型动态解析（`ctx.llm.resolveModelInfo` 的 `contextWindow`）；>0 = 强制覆盖 |
| `contextFillRatio` | 0.85 | 实时实测上下文 tokens > 该模型窗口×该比例 就接管 |
| `chunkBytes` | 900000 | 每块字节预算 |
| `chunkMaxTokens` | 3000 | 每块摘要的 max_tokens |
| `finalMaxTokens` | 8000 | 最终合并的 max_tokens |
| `concurrency` | 3 | 分块请求并发数 |
| `retries` | 2 | 单块失败重试次数 |
| `maxMessageChars` | 200000 | 单条消息最多保留字符数（防一个巨大工具结果吃掉整块） |
| `maxDepth` | 2 | 失败二分重试的最大深度 |
| `verbose` | true | 是否打印每块进度 |

## 日志

`/root/dsh-web.log` 里搜 `[big-compact]`：

```
[big-compact] 已启用：阈值 4.00 MB，分块 900.0 KB，并发 3
[big-compact] 超大压缩请求 17.5 MB → 分块模式（≤ 4.00 MB 的仍走自带压缩）
[big-compact] 压缩请求 17.5 MB，切成 20 块
[big-compact] 分块 1/20 完成（900.0 KB → 1840 字）
...
[big-compact] 压缩完成：20 块，用时 96.4s，摘要 15420 字
```

## 测试

```bash
node test/unit.mjs          # 离线：分块、合并、拦截边界、失败兜底
node test/live.mjs 12 2     # 真机联调：12 MB 合成压缩请求 → 分块 → 合并（直连中转）
```

## 安装 / 卸载

- 已注册进 `profiles/web/package.json`（依赖 + `dsh.profile.bundles`）并建立
  `node_modules/dsh-big-compact` 链接；**重启一次 web 生效**（`patchReload: startup`）。
- 卸载：从 `dependencies` 与 `dsh.profile.bundles` 删掉 `dsh-big-compact`，
  删 `node_modules/dsh-big-compact` 链接；重启 web。插件文件在 `/root/dsh-big-compact`。
