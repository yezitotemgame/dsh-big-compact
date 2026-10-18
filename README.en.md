# dsh-big-compact

**[中文](README.md) | [English](README.en.md)**

**Chunked compaction for oversized sessions.** DSH's built-in compaction (`compaction-basic`) sends the whole span of history being compacted in a single model request. Once a session grows to several MB, the relay rejects that request (`404 model_not_found`) and `/compact` only reports *"Compaction could not produce a useful summary"*. This plugin hooks the `llm/stream` waterfall and takes over **only when the compaction request is oversized** — it splits the history into chunks, summarizes each chunk, merges the summaries, and finally asks the model to produce the checkpoint from the merged context plus DSH's original compaction instruction. Small sessions and normal chat are passed through untouched.

The design follows the "only handle oversized contexts" idea of [billion-context](https://github.com/ranxianglei/billion-context): normal requests never go through it; it only kicks in when local compaction can no longer handle the size.

## When it takes over (live monitoring)

1. Every `llm/stream` call measures the current session context with `ctx.tokenMeter.measure(session)` — the context changes on every turn, so the live value is what counts.
2. The window is **dynamic**: on each compaction request the plugin resolves `contextWindow` through `ctx.llm.resolveModelInfo(provider, model)` (e.g. a profile entry of 850000 → threshold 850000 × 0.85 = 722500). The configured value / 500k is only a fallback.
3. Take over when the measured value (request-body estimate if measurement is unavailable) exceeds **window × 0.85**.
4. A **request body > 4 MB** byte fallback is also kept (relay body limit).

When the context reaches 85% the plugin logs a heads-up: `上下文实时监测：… tokens，已达窗口 … 的 95%，下次压缩将分块`.

## How it works

```
dsh compaction engine
  └─ ctx.llm.stream({ purpose: 'compaction', messages: [system, history…, instruction] })
       └─ [this plugin] measure live context / resolve window first
            ├─ under the line → next(), built-in compaction (unchanged behavior)
            └─ over the line  → chunked mode
                 1. pack history messages in order (default 1.5 MB per chunk)
                 2. one small request per chunk → structured bullets (default max_tokens 6000, 3-way concurrency)
                 3. merge chunk summaries; if still over the line, do another round
                 4. send merged summaries + the original compaction instruction to the model
                 5. replay as raw chunks (text block + finish stop) so the engine can commit the checkpoint
```

- Sub-requests use `purpose: 'compaction-chunk'` / `'compaction-final'`, so they never re-enter the plugin (no recursion).
- **Empty summaries count as failures**: if a chunk returns empty or fewer than 10 characters, the plugin retries with a doubled output budget (up to 20000 tokens); if it still fails, the chunk is split in half (up to 2 levels).
- If the whole pipeline fails, the plugin replays `finish{kind:'error'}` — `/compact` reports the failure and records it in the session log; nothing is silently swallowed.

## Configuration

`/root/.big-compact/config.json` (defaults apply when the file is absent):

| Field | Default | Meaning |
|---|---|---|
| `thresholdBytes` | 4000000 | Take over when the request body exceeds this many bytes (byte fallback) |
| `maxContextTokens` | 0 | 0 = resolve `contextWindow` dynamically; >0 = force this window |
| `contextFillRatio` | 0.85 | Take over when measured context > model window × this ratio |
| `chunkBytes` | 1500000 | Per-chunk budget in UTF-8 bytes |
| `chunkMaxTokens` | 6000 | max_tokens per chunk summary (doubled on retry, capped at 20000) |
| `finalMaxTokens` | 8000 | max_tokens of the final merged summary |
| `concurrency` | 3 | Concurrent chunk requests |
| `retries` | 2 | Retries per chunk |
| `maxMessageChars` | 200000 | Max characters kept per message (so one huge tool result cannot eat a whole chunk) |
| `maxDepth` | 2 | Max depth of binary-split retries |
| `verbose` | true | Print per-chunk progress |

## Logs

Search `/root/dsh-web.log` for `[big-compact]`:

```
[big-compact] 已启用：窗口 按模型动态解析，安全线 85%，分块 1.43 MB，并发 3
[big-compact] 上下文实时监测：6464308 tokens，已达窗口 850000 的 760%（安全线 85%），下次压缩将分块
[big-compact] 超大压缩请求（上下文 6464308 tokens（实测）> 窗口 850000 × 0.85 = 722500）→ 分块模式
[big-compact] 压缩请求 23.13 MB，切成 9 块
[big-compact] 分块 1/9 完成（1.43 MB → 3621 字）
...
[big-compact] 压缩完成：9 块，用时 96.6s，摘要 3586 字
```

## Tests

```bash
node test/unit.mjs          # offline: chunking, merge, trigger boundaries, empty-summary retry, dynamic window, failure fallback
node test/live.mjs 12 3     # live: 12 MB synthetic compaction request → chunks → merge (direct relay call)
```

## Install / uninstall

- Already registered in `profiles/web/package.json` (dependency + `dsh.profile.bundles`) with a
  `node_modules/dsh-big-compact` link; **restart the web app once** to load it (`patchReload: startup`).
- Uninstall: remove `dsh-big-compact` from `dependencies` and `dsh.profile.bundles`, delete the
  `node_modules/dsh-big-compact` link, restart. The plugin source lives at `/root/dsh-big-compact`.

## Known limitations

- Chunked summarization is lossy: each chunk keeps the essentials only; the raw session log remains the source of truth.
- It assumes the relay accepts 1.5 MB per request; lower `chunkBytes` if your relay is stricter.
- Only requests with `purpose === 'compaction'` are handled; normal chat is never intercepted.
