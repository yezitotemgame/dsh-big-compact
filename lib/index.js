/**
 * dsh-big-compact — 超大会话压缩（宿主插件）。
 *
 * 背景：dsh 自带压缩（compaction-basic）会把「要压缩的旧历史」一次性塞进
 * 一个模型请求。会话大到一定程度后，这个请求会超过中转的请求体上限，
 * 中转返回 404 `Model "…" is not supported by any configured account in this group`，
 * `/compact` 只能报 “Compaction could not produce a useful summary”。
 *
 * 做法：在 `llm/stream` 瀑布上挂一层监听，只拦截 **purpose === "compaction"**
 * 且请求体超过阈值（默认 4 MB）的调用：
 *   1. 把历史消息按时间顺序切成若干块（默认 900 KB/块）；
 *   2. 每块单独做一次小请求，压成结构化要点；
 *   3. 把各块摘要合并后，连同 dsh 原本的压缩指令再请求一次，得到最终检查点；
 *   4. 按 dsh 的 raw chunk 协议把结果回放给压缩引擎（text 块 + stop）。
 *
 * 小会话（≤ 阈值）以及所有普通对话请求都直接 `next()`，走 dsh 自带逻辑，
 * 行为与未安装本插件时完全一致。
 *
 * 配置（可选）：/root/.big-compact/config.json，字段见 DEFAULTS。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const CONFIG_PATH = '/root/.big-compact/config.json';

const DEFAULTS = Object.freeze({
	/** 超过该字节数才分块；4 MB 已被中转验证可正常处理。 */
	thresholdBytes: 4_000_000,
	/** 每一块折叠前的字节预算。 */
	chunkBytes: 900_000,
	/** 每块摘要的 maxTokens（模型思考也吃这个预算，给足）。 */
	chunkMaxTokens: 6000,
	/** 最终合并请求的 maxTokens。 */
	finalMaxTokens: 8000,
	/** 分块请求并发数。 */
	concurrency: 3,
	/** 单块失败后的重试次数（仍失败则二分再试）。 */
	retries: 2,
	/** 目标模型声明的上下文窗口（tokens）。超过窗口 × fill 时即使字节没超也要分块。 */
	maxContextTokens: 500_000,
	/** 上下文填充比例：实测上下文超过 context × ratio 就分块（防上游静默截断）。 */
	contextFillRatio: 0.85,
	/** 单条消息最多保留的字符数（防止一个巨大工具结果吃掉整块）。 */
	maxMessageChars: 200_000,
	/** 块失败后二分重试的最大深度。 */
	maxDepth: 2,
	/** 打印进度日志。 */
	verbose: true
});

const CHUNK_SYSTEM =
	'你是一个会话压缩器。下面是一段按时间顺序排列的对话记录（可能是某个更大会话的一部分）。' +
	'请把它压缩成简洁的结构化要点，保留：用户的目标与变化（关键原话引用）、技术概念与约定、' +
	'出现的文件路径与关键代码或命令、做过的决定与原因、失败与修复、尚未解决的问题。' +
	'不要客套，不要复述无关细节，输出 Markdown 列表，控制在 2000 字以内。';

const MERGE_SYSTEM =
	'你是一个会话压缩器。下面是同一个长会话按时间顺序分成的多段摘要。' +
	'请合并成一份去重、按主题组织的总摘要，保留所有关键事实、路径、决定和未决问题，不要新增事实。';

/** 读取可选配置文件并与默认值合并。 */
function loadConfig() {
	let overrides = {};
	try {
		if (existsSync(CONFIG_PATH)) overrides = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {};
	} catch (error) {
		console.error('[big-compact] 配置文件读取失败，使用默认值：', error);
	}
	return { ...DEFAULTS, ...overrides };
}

function humanBytes(n) {
	if (!Number.isFinite(n)) return String(n);
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/** 内容块 → 纯文本（丢弃图片本体与推理内容）。 */
function blockToText(block, limit) {
	if (block == null) return '';
	if (typeof block === 'string') return block.slice(0, limit);
	if (typeof block !== 'object') return String(block).slice(0, limit);
	switch (block.type) {
		case 'text':
			return String(block.text ?? '').slice(0, limit);
		case 'reasoning':
			return '';
		case 'image':
			return '[图片]';
		case 'file':
			return '[文件]';
		case 'tool-call': {
			const name = block.name ?? block.toolName ?? '';
			const args = block.arguments ?? block.input ?? '';
			return `[调用工具 ${name}] ${typeof args === 'string' ? args : JSON.stringify(args)}`.slice(0, limit);
		}
		case 'tool-result': {
			const body = Array.isArray(block.content)
				? block.content.map((part) => blockToText(part, limit)).join('\n')
				: String(block.content ?? block.text ?? '');
			return `[工具结果] ${body}`.slice(0, limit);
		}
		default:
			try {
				return JSON.stringify(block).slice(0, limit);
			} catch {
				return '';
			}
	}
}

/** 一条消息 → 纯文本行。 */
function messageToText(message, cfg) {
	if (message == null) return '';
	const role = message.role ?? 'unknown';
	const content = Array.isArray(message.content)
		? message.content.map((block) => blockToText(block, cfg.maxMessageChars)).join('\n')
		: blockToText(message.content, cfg.maxMessageChars);
	const body = content.trim();
	if (body.length === 0) return '';
	return `### ${role}\n${body}`;
}

/** 请求体的近似字节数（消息正文 + 工具定义）。 */
function estimateMessagesBytes(messages) {
	try {
		return Buffer.byteLength(JSON.stringify(messages ?? []), 'utf8');
	} catch {
		return 0;
	}
}

/** 每个会话最近一次实测的上下文 tokens（实时监测，跨请求更新）。 */
const liveContextTokens = new Map();
/** 每个 provider/model 的上下文窗口（从 dsh 的模型信息动态解析并缓存）。 */
const contextWindowCache = new Map();

/** 动态解析目标模型的上下文窗口：优先 dsh 的模型信息，其次配置，最后兜底。 */
async function resolveContextWindow(ctx, options, cfg) {
	const key = `${options.provider}/${options.model}`;
	if (contextWindowCache.has(key)) return contextWindowCache.get(key);
	let window = null;
	try {
		const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
		if (typeof info?.context?.contextWindow === 'number' && info.context.contextWindow > 0) window = info.context.contextWindow;
	} catch (error) {
		console.error('[big-compact] 读取模型上下文窗口失败，改用配置兜底：', error?.message ?? error);
	}
	if (window === null) window = (cfg.maxContextTokens ?? 0) > 0 ? cfg.maxContextTokens : 500_000;
	contextWindowCache.set(key, window);
	return window;
}
/** 已经提示过「上下文接近窗口」的会话，避免刷屏。 */
const warnedNearLimit = new Set();

/**
 * 实时测一次会话上下文 tokens。
 * 优先用 dsh 的 tokenMeter（权威、带增量缓存）；拿不到会话时返回 null。
 */
function measureLiveTokens(ctx, options) {
	if (!options?.sessionId) return null;
	try {
		const sessions = ctx.get?.('sessions');
		const meter = ctx.get?.('tokenMeter');
		if (!sessions || !meter) return null;
		const session = sessions.get(options.sessionId);
		if (!session) return null;
		const measured = meter.measure(session);
		const tokens = typeof measured?.totalTokens === 'number' ? measured.totalTokens : null;
		if (tokens !== null) liveContextTokens.set(options.sessionId, tokens);
		return tokens;
	} catch {
		return null;
	}
}

/** 粗略估算 tokens：中文约 1 字/token、英文约 4 字符/token，取 2 字符/token 偏保守。 */
function estimateTokens(messages) {
	let chars = 0;
	const walk = (value) => {
		if (typeof value === 'string') {
			chars += value.length;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value && typeof value === 'object') {
			for (const key of ['text', 'content', 'arguments', 'name']) if (key in value) walk(value[key]);
		}
	};
	walk(messages);
	return Math.ceil(chars / 2);
}

/**
 * 是否需要接管。
 * 触发条件按「该会话上下文的实时实测值」判定（上下文会随每轮波动），
 * 取 实测 tokens 与 请求体估算 tokens 的较大者，对上上下文窗口 × contextFillRatio（默认 0.85）；
 * 另外保留字节阈值作为中转请求体上限的兜底。
 */
function shouldTakeOver(ctx, options, cfg, window) {
	const bytes = estimateMessagesBytes(options.messages);
	const configured = (cfg.maxContextTokens ?? 0) > 0 ? cfg.maxContextTokens : 500_000;
	const effectiveWindow = window ?? configured;
	const ratio = cfg.contextFillRatio ?? 0.85;
	const line = Math.floor(effectiveWindow * ratio);
	const live = measureLiveTokens(ctx, options);
	const estimated = estimateTokens(options.messages);
	const tokens = Math.max(live ?? 0, estimated);
	if (tokens > line) {
		return {
			take: true,
			bytes,
			tokens,
			reason: `上下文 ${tokens} tokens（${live === null ? '估算' : '实测'}）> 窗口 ${effectiveWindow} × ${ratio} = ${line}`
		};
	}
	if (bytes > cfg.thresholdBytes) {
		return { take: true, bytes, tokens, reason: `请求体 ${humanBytes(bytes)} > 阈值 ${humanBytes(cfg.thresholdBytes)}` };
	}
	return { take: false, bytes, tokens, live };
}

/** 是否是压缩请求（优先看 purpose，其次认 dsh 的压缩指令原文）。 */
function isCompactionRequest(options) {
	if (options?.purpose === 'compaction') return true;
	const messages = options?.messages ?? [];
	const last = messages[messages.length - 1];
	const text = Array.isArray(last?.content)
		? last.content.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('\n')
		: String(last?.content ?? '');
	return text.includes('acting as a compaction engine');
}

/** 取压缩指令原文（最后一条用户消息）。 */
function instructionOf(options) {
	const messages = options?.messages ?? [];
	const last = messages[messages.length - 1];
	const text = Array.isArray(last?.content)
		? last.content.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('\n')
		: String(last?.content ?? '');
	return text.trim();
}

/** 把若干段文本按「UTF-8 字节」预算装箱（中转限制是按字节算的）。 */
function packChunks(texts, limitBytes) {
	const chunks = [];
	let current = '';
	let currentBytes = 0;
	// 单条消息超预算时按字符切段：CJK 最坏 3 字节/字符，取 limit/3 字符必然不超。
	const pieceChars = Math.max(1000, Math.floor(limitBytes / 3));
	for (const text of texts) {
		if (!text) continue;
		if (Buffer.byteLength(text, 'utf8') > limitBytes) {
			for (let offset = 0; offset < text.length; offset += pieceChars) {
				const piece = text.slice(offset, offset + pieceChars);
				if (current.length > 0) {
					chunks.push(current);
					current = '';
					currentBytes = 0;
				}
				chunks.push(piece);
			}
			continue;
		}
		const bytes = Buffer.byteLength(text, 'utf8');
		if (currentBytes + bytes + 2 > limitBytes && current.length > 0) {
			chunks.push(current);
			current = '';
			currentBytes = 0;
		}
		current = current.length === 0 ? text : `${current}\n\n${text}`;
		currentBytes += bytes + 2;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** 把一条流向调用收成纯文本；出错时抛异常（带 code）。 */
async function collectText(stream, signal) {
	let text = '';
	let failure = null;
	for await (const chunk of stream) {
		if (signal?.aborted) {
			const error = new Error('分块压缩已取消');
			error.code = 'ABORTED';
			throw error;
		}
		switch (chunk?.type) {
			case 'text-delta':
				text += chunk.text ?? '';
				break;
			case 'finish': {
				const kind = chunk.reason?.kind;
				if (kind === 'error' || kind === 'aborted') {
					failure = chunk.reason?.failure ?? { message: kind, code: String(kind).toUpperCase() };
				}
				break;
			}
			default:
				break;
		}
	}
	if (failure !== null) {
		const error = new Error(failure.message ?? '分块请求失败');
		error.code = failure.code ?? 'CHUNK_FAILED';
		throw error;
	}
	return text;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 摘要一段文本；失败重试，仍失败则二分递归。 */
async function summarizeText(llmStream, base, text, cfg, log, depth, systemText = CHUNK_SYSTEM) {
	let lastError = null;
	for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
		if (base.signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
		try {
			// 重试时放大输出预算：模型可能把 token 花在思考上，导致正文为空。
			const budget = attempt === 0 ? base.maxTokens : Math.min(20000, Math.max(8000, Math.round((base.maxTokens ?? cfg.chunkMaxTokens) * 2)));
			const output = await collectText(
				llmStream({
					...base,
					maxTokens: budget,
					messages: [
						{ id: randomUUID(), role: 'system', content: [{ type: 'text', text: systemText }] },
						{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }] }
					]
				}),
				base.signal
			);
			const trimmed = output.trim();
			if (trimmed.length < 10) {
				throw Object.assign(new Error(`分块摘要为空或过短（${trimmed.length} 字，maxTokens=${budget}）`), { code: 'EMPTY_SUMMARY' });
			}
			return output;
		} catch (error) {
			lastError = error;
			if (error?.code === 'ABORTED') throw error;
			log(`分块请求失败（第 ${attempt + 1} 次）：${error?.message ?? error}`);
			await sleep(500 * (attempt + 1));
		}
	}
	if (depth >= cfg.maxDepth || text.length < 120_000) throw lastError;
	const middle = Math.floor(text.length / 2);
	log(`分块过大仍失败，二分重试（depth=${depth + 1}）`);
	const left = await summarizeText(llmStream, base, text.slice(0, middle), cfg, log, depth + 1, systemText);
	const right = await summarizeText(llmStream, base, text.slice(middle), cfg, log, depth + 1, systemText);
	return `${left}\n${right}`;
}

/** 限并发地跑一组任务。 */
async function mapPool(items, limit, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: width }, async () => {
			while (true) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) return;
				results[index] = await worker(items[index], index);
			}
		})
	);
	return results;
}

/**
 * 分块压缩主流程：返回最终摘要文本。
 * @param llmStream - (options) => AsyncIterable<chunk>
 * @param options - 原始压缩请求（provider/model/messages/signal）
 */
export async function summarizeAll(llmStream, options, cfg, log = () => {}) {
	const messages = options.messages ?? [];
	const instruction = instructionOf(options);
	const history = messages.slice(0, Math.max(0, messages.length - 1));
	const texts = history.map((message) => messageToText(message, cfg));
	const chunks = packChunks(texts, cfg.chunkBytes);
	if (chunks.length === 0) throw new Error('没有可压缩的历史内容');
	log(`压缩请求 ${humanBytes(estimateMessagesBytes(messages))}，切成 ${chunks.length} 块`);

	const base = {
		provider: options.provider,
		model: options.model,
		maxTokens: cfg.chunkMaxTokens,
		purpose: 'compaction-chunk',
		...(options.signal === undefined ? {} : { signal: options.signal })
	};

	const started = Date.now();
	let done = 0;
	const summaries = await mapPool(chunks, cfg.concurrency, async (chunk, index) => {
		const text = await summarizeText(llmStream, base, chunk, cfg, log, 0);
		done += 1;
		if (cfg.verbose) {
			log(`分块 ${done}/${chunks.length} 完成（${humanBytes(Buffer.byteLength(chunk, 'utf8'))} → ${text.length} 字）`);
		}
		return `## 片段 ${index + 1}/${chunks.length}\n${text.trim()}`;
	});

	let merged = summaries.join('\n\n');
	// 摘要本身仍然过大：再做一轮合并压缩。
	let round = 1;
	while (merged.length > cfg.thresholdBytes && round <= 3) {
		log(`第 ${round} 轮合并：摘要 ${humanBytes(merged.length)} 仍偏大`);
		const groups = packChunks([merged], cfg.chunkBytes);
		const parts = await mapPool(groups, cfg.concurrency, (group) =>
			summarizeText(llmStream, base, group, cfg, log, 0, MERGE_SYSTEM)
		);
		merged = parts.join('\n\n');
		round += 1;
	}

	const finalMessages = [
		{ id: randomUUID(), role: 'system', content: [{ type: 'text', text: MERGE_SYSTEM }] },
		{
			id: randomUUID(),
			role: 'user',
			content: [
				{
					type: 'text',
					text: `以下是原会话按时间顺序的分段摘要：\n\n${merged}\n\n---\n\n${instruction}`
				}
			]
		}
	];
	const finalTextRaw = await collectText(
		llmStream({
			provider: options.provider,
			model: options.model,
			messages: finalMessages,
			maxTokens: cfg.finalMaxTokens,
			purpose: 'compaction-final',
			...(options.signal === undefined ? {} : { signal: options.signal })
		}),
		options.signal
	);
	const finalText = finalTextRaw.trim();
	if (finalText.length < 10) throw Object.assign(new Error(`最终摘要为空或过短（${finalText.length} 字）`), { code: 'EMPTY_SUMMARY' });
	log(`压缩完成：${chunks.length} 块，用时 ${((Date.now() - started) / 1000).toFixed(1)}s，摘要 ${finalText.length} 字`);
	return finalText;
}

/** 把摘要按 dsh 的 raw chunk 协议回放给压缩引擎。 */
function compactStream(ctx, options, cfg) {
	return (async function* () {
		const log = (message) => console.log(`[big-compact] ${message}`);
		try {
			const text = (await summarizeAll((call) => ctx.llm.stream(call), options, cfg, log)).trim();
			if (text.length === 0) throw new Error('分块压缩得到空摘要');
			yield { type: 'block-start', index: 0, blockType: 'text' };
			yield { type: 'text-delta', index: 0, text };
			yield { type: 'block-end', index: 0, block: { type: 'text', text } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		} catch (error) {
			const message = `big-compact 分块压缩失败：${error?.message ?? error}`;
			console.error(`[big-compact] ${message}`);
			yield {
				type: 'finish',
				reason: { kind: 'error', failure: { message, code: error?.code ?? 'BIG_COMPACT_FAILED' } }
			};
		}
	})();
}

export const name = 'dsh-big-compact';

/** 非压缩请求的实时监测：记录上下文实测值，越过安全线打一次预告。 */
function monitorLive(ctx, options, cfg) {
	if (!options?.sessionId) return;
	const live = measureLiveTokens(ctx, options);
	if (live === null) return;
	const key = `${options.provider}/${options.model}`;
	const cached = contextWindowCache.get(key);
	if (cached === undefined) {
		resolveContextWindow(ctx, options, cfg)
			.then((window) => warnNear(ctx, options, cfg, live, window))
			.catch(() => {});
		return;
	}
	warnNear(ctx, options, cfg, live, cached);
}

/** 上下文占到窗口的 ratio 以上时提示一次（不改变行为，只为可观测）。 */
function warnNear(ctx, options, cfg, live, window) {
	const ratio = cfg.contextFillRatio ?? 0.85;
	if (live <= window * ratio || warnedNearLimit.has(options.sessionId)) return;
	warnedNearLimit.add(options.sessionId);
	console.log(
		`[big-compact] 上下文实时监测：${live} tokens，已达窗口 ${window} 的 ${Math.round((100 * live) / window)}%（安全线 ${Math.round(ratio * 100)}%），下次压缩将分块`
	);
}

/** 压缩请求：先动态解析该模型的窗口，再决定是否分块（窗口读取是异步的）。 */
function compactionStream(ctx, options, cfg, next) {
	return (async function* () {
		try {
			const window = await resolveContextWindow(ctx, options, cfg);
			const verdict = shouldTakeOver(ctx, options, cfg, window);
			if (!verdict.take) {
				yield* next();
				return;
			}
			console.log(`[big-compact] 超大压缩请求（${verdict.reason}）→ 分块模式（小会话仍走自带压缩）`);
			warnedNearLimit.delete(options.sessionId);
			yield* compactStream(ctx, options, cfg);
		} catch (error) {
			console.error('[big-compact] 压缩拦截失败，回退到自带压缩：', error);
			yield* next();
		}
	})();
}

export function apply(ctx) {
	const cfg = loadConfig();
	ctx.inject(['llm'], (llmCtx) => {
		llmCtx.on('llm/stream', (options, next) => {
			try {
				if (!isCompactionRequest(options)) {
					monitorLive(llmCtx, options, cfg);
					return next();
				}
				return compactionStream(llmCtx, options, cfg, next);
			} catch (error) {
				console.error('[big-compact] 拦截失败，回退到自带压缩：', error);
				return next();
			}
		});
	});
	const windowHint = (cfg.maxContextTokens ?? 0) > 0 ? String(cfg.maxContextTokens) : '按模型动态解析';
	console.log(
		`[big-compact] 已启用：窗口 ${windowHint}，安全线 ${Math.round((cfg.contextFillRatio ?? 0.85) * 100)}%，分块 ${humanBytes(cfg.chunkBytes)}，并发 ${cfg.concurrency}`
	);
}
