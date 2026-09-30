import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');

const { buildOrchestratorGraph } = require(path.join(sidecarSrc, 'graph.js'));
const { Tracer } = require(path.join(sidecarSrc, 'trace.js'));
const { Gate } = require(path.join(sidecarSrc, 'orchestrator.js'));
const { MemorySaver } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));

// ---------- tracer ----------

test('Tracer: кольцевой буфер не растёт бесконечно', () => {
	const tracer = new Tracer({ maxSpans: 3, traceId: 'r1' });
	for (let i = 0; i < 5; i++) {
		tracer.start('llm', { kind: 'llm', node: 'n' + i }).end({ status: 'ok' });
	}
	const spans = tracer.list();
	assert.equal(spans.length, 3, 'хранятся только последние maxSpans');
	assert.equal(spans[0].node, 'n2');
	assert.ok(spans.every(s => typeof s.durationMs === 'number'), 'длительность зафиксирована');
});

test('Tracer: summary считает топ по времени и по деньгам', () => {
	const tracer = new Tracer({ traceId: 'r2' });
	tracer.finish({ id: 'a', name: 'worker', kind: 'node', node: 'coder#1.0', startedAt: Date.now() - 100, durationMs: 0 }, { durationMs: 100, cost: 0.01 });
	tracer.finish({ id: 'b', name: 'worker', kind: 'node', node: 'tester#1.1', startedAt: Date.now(), durationMs: 0 }, { durationMs: 10, cost: 0.5 });
	const summary = tracer.summary();
	assert.equal(summary.byTime[0].node, 'coder#1.0', 'самая долгая нода — первая');
	assert.equal(summary.byCost[0].node, 'tester#1.1', 'самая дорогая нода — первая');
});

// ---------- графовые спаны ----------

test('Этап 5.2: граф пишет спаны нод и LLM-вызовов, опционально JSONL', async () => {
	const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.01 };
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'сделай', deps: [] }];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-trace-'));
	const file = path.join(dir, 'spans.jsonl');
	const tracer = new Tracer({ traceId: 'graph-run', file, maxSpans: 200 });
	const llm = {
		complete: async (role) => (role === 'supervisor'
			? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'high', usage }
			: { text: 'worker ok', toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'low', usage }),
	};
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru',
		emit: () => {}, invokeTool: async () => ({ output: 'ok' }),
		tracer,
	}, { checkpointer: new MemorySaver() });

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', configurable: { thread_id: 'trace-run' } })) { /* до конца */ }

	const spans = tracer.list();
	const nodeSpans = spans.filter(s => s.kind === 'node');
	const llmSpans = spans.filter(s => s.kind === 'llm');
	assert.ok(nodeSpans.some(s => s.node === 'supervisor'), 'спан супервизора записан');
	const worker = nodeSpans.find(s => s.node === 'coder#1.0');
	assert.ok(worker, 'спан воркера записан');
	assert.equal(worker.cost, 0.01);
	assert.equal(worker.tokensIn, 100);
	assert.equal(worker.tokensOut, 200);
	assert.ok(llmSpans.length >= 2, 'спаны на каждый вызов модели');
	assert.equal(llmSpans[0].model, 'kimi-k3');

	// В спанах нет промптов — только метаданные.
	assert.ok(!JSON.stringify(spans).includes('You are the'), 'в трейсе нет текста промптов');

	// JSONL-файл: каждая строка — валидный JSON-спан.
	const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
	assert.ok(lines.length >= 3, 'спаны дописаны в файл');
	assert.equal(JSON.parse(lines[0]).traceId, 'graph-run');
	fs.rmSync(dir, { recursive: true, force: true });
});
