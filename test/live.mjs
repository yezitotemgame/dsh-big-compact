/**
 * 真机联调：不打 dsh，直接按 pi-ai 的协议调中转，验证「12 MB 压缩请求 →
 * 分块摘要 → 合并」整条链路能跑通（这是 dsh 自带压缩会 404 的那类请求）。
 *
 * 用法：node test/live.mjs [MB] [并发]
 */
import { readFileSync } from 'node:fs';
import { summarizeAll } from '../lib/index.js';

const BASE = 'http://43.248.3.158:20039/v1';
const MODEL = 'deepseek-v4.1-flash';
const MB = Number(process.argv[2] ?? 12);
const CONCURRENCY = Number(process.argv[3] ?? 2);

function apiKey() {
	const raw = readFileSync('/root/.dsh/.credentials.yaml', 'utf8');
	const match = raw.match(/^\s*A_API_KEY:\s*"?([^"\s]+)"?\s*$/m);
	if (!match) throw new Error('A_API_KEY 不在 .credentials.yaml 里');
	return match[1];
}

/** 用 fetch + SSE 复刻一个最小 llmStream：返回 raw chunk 流。 */
function makeLiveStream(key) {
	return async function* liveStream(options) {
		const body = {
			model: options.model ?? MODEL,
			messages: options.messages.map((message) => ({
				role: message.role,
				content: message.content.map((block) => block.text ?? '').join('\n')
			})),
			max_tokens: options.maxTokens ?? 3000,
			stream: true,
			stream_options: { include_usage: false }
		};
		const response = await fetch(`${BASE}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) {
			const text = (await response.text()).slice(0, 300);
			throw new Error(`${response.status}: ${text}`);
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let total = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') continue;
				try {
					const json = JSON.parse(payload);
					const delta = json.choices?.[0]?.delta?.content;
					if (delta) {
						total += delta;
						yield { type: 'text-delta', index: 0, text: delta };
					}
				} catch {
					// 忽略注释/心跳行
				}
			}
		}
		if (total.trim().length === 0) {
			yield { type: 'finish', reason: { kind: 'error', failure: { message: '空响应', code: 'EMPTY' } } };
			return;
		}
		yield { type: 'finish', reason: { kind: 'stop' } };
	};
}

function buildRequest(mb) {
	const messages = [];
	const perMessage = 300_000; // 每条 300 KB
	const count = Math.ceil((mb * 1024 * 1024) / perMessage);
	for (let i = 0; i < count; i += 1) {
		messages.push({
			id: `m-${i}`,
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: [
				{
					type: 'text',
					text: `[第 ${i} 条] 我们在改一个 DSH 插件：讨论分块压缩、阈值、日志路径 /root/dsh-big-compact。` + '内容'.repeat(perMessage / 6)
				}
			]
		});
	}
	messages.push({
		id: 'instruction',
		role: 'user',
		content: [
			{
				type: 'text',
				text: [
					'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint.',
					'',
					'## Primary Request and Intent',
					'## Key Technical Concepts',
					'## Files and Code',
					'## Errors and Fixes'
				].join('\n')
			}
		]
	});
	return { provider: 'a', model: MODEL, messages, maxTokens: 8000, purpose: 'compaction' };
}

const cfg = {
	thresholdBytes: 4_000_000,
	chunkBytes: 900_000,
	chunkMaxTokens: 1200,
	finalMaxTokens: 3000,
	concurrency: CONCURRENCY,
	retries: 1,
	maxMessageChars: 400_000,
	maxDepth: 1,
	verbose: true
};

const request = buildRequest(MB);
const size = Buffer.byteLength(JSON.stringify(request.messages));
console.log(`[live] 输入 ≈ ${(size / 1024 / 1024).toFixed(2)} MB，${request.messages.length} 条消息，并发 ${CONCURRENCY}`);
const started = Date.now();
const text = await summarizeAll(makeLiveStream(apiKey()), request, cfg, (message) => console.log(`[live] ${message}`));
console.log(`[live] 完成：${((Date.now() - started) / 1000).toFixed(1)}s，摘要 ${text.length} 字`);
console.log('---- 摘要开头 ----');
console.log(text.slice(0, 600));
