/**
 * dsh-big-compact 单元测试（离线，不联网）：
 *  - summarizeAll 的分块装箱、并发、合并、最终回放；
 *  - llm/stream 监听器只拦「超大压缩请求」，其余一律 next()。
 */
import assert from 'node:assert/strict';
import { summarizeAll, apply } from '../lib/index.js';

const CFG = {
	thresholdBytes: 3_000_000,
	chunkBytes: 500_000,
	chunkMaxTokens: 111,
	finalMaxTokens: 222,
	concurrency: 3,
	retries: 0,
	maxMessageChars: 200_000,
	maxDepth: 1,
	verbose: false
};

/** 构造一个假 llm：按请求内容返回固定文本，并记录每次调用。 */
function makeFakeLlm(finalText = '## 检查点\n- 用户在做压缩插件，涉及分块、阈值与日志路径。') {
	const calls = [];
	const stream = (options) => {
		calls.push(options);
		return (async function* () {
			const system = options.messages?.[0]?.content?.[0]?.text ?? '';
			const isChunk = String(system).includes('会话压缩器') && !String(system).includes('按主题组织');
			const text = isChunk ? `片段要点 ${calls.length}：用户在做压缩插件，讨论分块与阈值。` : finalText;
			yield { type: 'block-start', index: 0, blockType: 'text' };
			yield { type: 'text-delta', index: 0, text };
			yield { type: 'block-end', index: 0, block: { type: 'text', text } };
			yield { type: 'finish', reason: { kind: 'stop' } };
		})();
	};
	return { stream: stream, calls };
}

/** 造一个 n 条消息、每条 chars 字的压缩请求。 */
function makeCompactionRequest(n, chars) {
	const messages = [];
	for (let i = 0; i < n; i += 1) {
		messages.push({
			id: `m-${i}`,
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: [{ type: 'text', text: `第 ${i} 条：` + 'x'.repeat(chars) }]
		});
	}
	messages.push({
		id: 'instruction',
		role: 'user',
		content: [{ type: 'text', text: 'You are now acting as a compaction engine for this AI coding assistant. 输出检查点。' }]
	});
	return { provider: 'a', model: 'deepseek-v4.1-flash', messages, maxTokens: 128000, purpose: 'compaction' };
}

// —— 1. summarizeAll：分块 + 并发 + 最终合并 ——
{
	const fake = makeFakeLlm('## Primary Request and Intent\n- 完成压缩与交付。');
	const request = makeCompactionRequest(400, 10_000); // ≈ 4 MB
	const text = await summarizeAll((o) => fake.stream(o), request, CFG, () => {});
	assert.match(text, /Primary Request and Intent/, '应返回最终模型的文本');
	const systemOf = (call) => String(call.messages?.[0]?.content?.[0]?.text ?? '');
	const finalCalls = fake.calls.filter((call) => systemOf(call).includes('按主题组织'));
	const chunkCalls = fake.calls.filter((call) => systemOf(call).includes('会话压缩器') && !systemOf(call).includes('按主题组织'));
	assert.ok(chunkCalls.length >= 6, `应切成多块（实际 ${chunkCalls.length}）`);
	assert.equal(finalCalls.length, 1, '最后应有且仅有一次合并请求');
	assert.ok(
		finalCalls[0].messages[1].content[0].text.includes('acting as a compaction engine'),
		'合并请求应带上 dsh 原始压缩指令'
	);
	assert.ok(
		finalCalls[0].messages[1].content[0].text.includes('片段 1/'),
		'合并请求应带上分段摘要'
	);
	for (const call of chunkCalls) assert.equal(call.maxTokens, CFG.chunkMaxTokens, '分块请求用 chunkMaxTokens');
	assert.equal(finalCalls[0].maxTokens, CFG.finalMaxTokens, '最终请求用 finalMaxTokens');
	for (const call of fake.calls) assert.notEqual(call.purpose, 'compaction', '子请求不能再触发拦截（避免递归）');
	console.log(`[unit] summarizeAll 通过：${chunkCalls.length} 个分块 + 1 次合并`);
}

// —— 2. packChunks 行为：单条超大消息会被切段 ——
{
	const fake = makeFakeLlm('ok 这是足够长的最终摘要文本。');
	const request = makeCompactionRequest(2, 600_000); // 单条 600 KB > chunkBytes
	const text = await summarizeAll((o) => fake.stream(o), request, { ...CFG, maxMessageChars: 1_000_000 }, () => {});
	assert.equal(text, 'ok 这是足够长的最终摘要文本。');
	const systemOf2 = (call) => String(call.messages?.[0]?.content?.[0]?.text ?? '');
	const chunkCalls = fake.calls.filter((call) => systemOf2(call).includes('会话压缩器') && !systemOf2(call).includes('按主题组织'));
	assert.ok(chunkCalls.length >= 3, `超大单条应被切段（实际 ${chunkCalls.length} 块）`);
	console.log('[unit] 超大单条消息切段 通过');
}

// —— 3. 监听器：小压缩请求走 next()，超大压缩请求走分块 ——
{
	const listeners = [];
	const fakeLlm = makeFakeLlm('## 检查点结果\n- 已完成同步与校正。');
	const ctx = {
		inject(deps, callback) {
			assert.deepEqual(deps, ['llm']);
			callback({
				llm: { stream: (o) => fakeLlm.stream(o) },
				on(event, listener) {
					assert.equal(event, 'llm/stream');
					listeners.push(listener);
				}
			});
		}
	};
	apply(ctx);
	assert.equal(listeners.length, 1, '应注册一个 llm/stream 监听器');
	const handler = listeners[0];

	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;
		return (async function* () {
			yield { type: 'finish', reason: { kind: 'stop' } };
		})();
	};

	// 普通对话 → next()
	handler({ purpose: 'chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, next);
	assert.equal(nextCalls, 1, '普通请求必须放行');

	// 小压缩（< 4 MB 且远低于上下文安全线）→ 放行给自带压缩
	const small = makeCompactionRequest(5, 1000);
	const smallStream = handler(small, next);
	for await (const _ of smallStream) { /* 消费以驱动放行 */ }
	assert.equal(nextCalls, 2, '小压缩必须放行给自带压缩');

	// 字节没超但 tokens 超上下文安全线（≈1.2M 字符 ≈ 600k tokens > 500k×0.85）→ 也要分块
	const dense = makeCompactionRequest(12, 100_000); // ≈ 1.2M 字符 / ~1.2 MB 字节
	const denseStream = handler(dense, next);
	assert.equal(nextCalls, 2, 'tokens 超安全线时必须拦截');
	for await (const _ of denseStream) { /* 消费掉 */ }

	// 超大压缩 → 分块
	const big = makeCompactionRequest(300, 20_000); // ≈ 6 MB
	const stream = handler(big, next);
	assert.equal(nextCalls, 2, '超大压缩不应放行');
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	assert.equal(chunks[0].type, 'block-start');
	assert.equal(chunks[1].type, 'text-delta');
	assert.equal(chunks[1].text, '## 检查点结果\n- 已完成同步与校正。');
	assert.deepEqual(chunks[chunks.length - 1].reason, { kind: 'stop' });
	console.log('[unit] llm/stream 拦截逻辑 通过');
}

// —— 4. 分块请求失败时给出 error finish（而不是抛异常） ——
{
	const ctx = {
		inject(deps, callback) {
			callback({
				llm: {
					stream: () =>
						(async function* () {
							yield {
								type: 'finish',
								reason: { kind: 'error', failure: { message: '404: model_not_found', code: 'PI_AI_ERROR' } }
							};
						})()
				},
				on() {}
			});
		}
	};
	apply(ctx);
	// 直接验证 compactStream 的兜底（通过 exported summarizeAll 抛错 + 监听器路径）
	const big = makeCompactionRequest(300, 20_000);
	const listeners = [];
	const ctx2 = {
		inject(deps, callback) {
			callback({
				llm: {
					stream: () =>
						(async function* () {
							yield {
								type: 'finish',
								reason: { kind: 'error', failure: { message: '404: model_not_found', code: 'PI_AI_ERROR' } }
							};
						})()
				},
				on(_e, listener) {
					listeners.push(listener);
				}
			});
		}
	};
	apply(ctx2);
	const chunks = [];
	for await (const chunk of listeners[0](big, () => (async function* () {})())) chunks.push(chunk);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].type, 'finish');
	assert.equal(chunks[0].reason.kind, 'error');
	assert.match(chunks[0].reason.failure.message, /big-compact/);
	console.log('[unit] 失败兜底 通过');
}

// —— 5. 实时监测：tokenMeter 报的会话上下文超 0.85 时，即使请求体不大也拦截 ——
{
	const listeners = [];
	const fakeLlm = makeFakeLlm('## 实时监测结果\n- 上下文已超安全线。');
	const ctx = {
		inject(deps, callback) {
			callback({
				llm: { stream: (o) => fakeLlm.stream(o) },
				get(name) {
					if (name === 'sessions') return { get: () => ({ id: 's-live' }) };
					if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 480_000 }) };
					return undefined;
				},
				on(_e, listener) {
					listeners.push(listener);
				}
			});
		}
	};
	apply(ctx);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;
		return (async function* () {
			yield { type: 'finish', reason: { kind: 'stop' } };
		})();
	};
	const req = makeCompactionRequest(4, 1000); // 请求体很小，但会话实测 480k tokens > 425k
	req.sessionId = 's-live';
	const stream = listeners[0](req, next);
	assert.equal(nextCalls, 0, '实测上下文超线时必须拦截');
	for await (const _ of stream) { /* 消费 */ }
	console.log('[unit] 实时上下文监测（tokenMeter 0.85）通过');
}

// —— 6. 动态窗口：模型声明 850k 时，600k tokens 不该被接管 ——
{
	const listeners = [];
	const fakeLlm = makeFakeLlm('## 不该被分块\n- 600k 在 850k 窗口内。');
	const ctx = {
		inject(deps, callback) {
			callback({
				llm: {
					stream: (o) => fakeLlm.stream(o),
					resolveModelInfo: async () => ({ context: { contextWindow: 850_000 } })
				},
				on(_e, listener) {
					listeners.push(listener);
				}
			});
		}
	};
	apply(ctx);
	let nextCalls = 0;
	const next = () => {
		nextCalls += 1;
		return (async function* () {
			yield { type: 'finish', reason: { kind: 'stop' } };
		})();
	};
	const req = makeCompactionRequest(12, 100_000); // ≈ 600k tokens < 850k × 0.85 = 722.5k
	req.model = 'big-model-850k';
	const stream = listeners[0](req, next);
	for await (const _ of stream) { /* 消费 */ }
	assert.equal(nextCalls, 1, '窗口 850k 时 600k tokens 应放行给自带压缩');
	console.log('[unit] 动态窗口（850k）通过');
}

// —— 7. 空摘要必须重试（模型把预算花在思考上时可能返回空正文） ——
{
	let calls = 0;
	const stream = (options) => {
		calls += 1;
		const isChunk = String(options.messages?.[0]?.content?.[0]?.text ?? '').includes('会话压缩器');
		const text = isChunk && calls === 1 ? '' : '有效摘要：用户在做压缩插件。';
		return (async function* () {
			yield { type: 'text-delta', index: 0, text };
			yield { type: 'finish', reason: { kind: 'stop' } };
		})();
	};
	const request = makeCompactionRequest(3, 2000);
	const text = await summarizeAll((o) => stream(o), request, { ...CFG, retries: 1 }, () => {});
	assert.match(text, /有效摘要/, '空摘要应触发重试并拿到有效结果');
	console.log('[unit] 空摘要重试 通过（共调用', calls, '次）');
}

console.log('[unit] PASS — dsh-big-compact');
