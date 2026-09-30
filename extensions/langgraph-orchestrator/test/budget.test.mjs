import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');

const { buildOrchestratorGraph } = require(path.join(sidecarSrc, 'graph.js'));
const { normalizeLimits, nodeOverLimit, runOverLimit, nodeBudgetNote, runBudgetTitle, formatBudget } = require(path.join(sidecarSrc, 'budget.js'));
const { usageOf } = require(path.join(sidecarSrc, 'agents.js'));
const { Gate } = require(path.join(sidecarSrc, 'orchestrator.js'));
const { MemorySaver, Command } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));

// ---------- чистые хелперы бюджета ----------

test('normalizeLimits: мусор и отрицательные → 0 (без лимита)', () => {
	assert.deepEqual(normalizeLimits({ runTokens: '100', runCost: -5, nodeTokens: null, nodeCost: 0.5 }), {
		runTokens: 100, runCost: 0, nodeTokens: 0, nodeCost: 0.5,
	});
	assert.deepEqual(normalizeLimits(undefined), { runTokens: 0, runCost: 0, nodeTokens: 0, nodeCost: 0 });
});

test('nodeOverLimit/runOverLimit: порог включительный по токенам и деньгам', () => {
	const limits = normalizeLimits({ nodeTokens: 1000, nodeCost: 0.5, runTokens: 5000 });
	assert.equal(nodeOverLimit(limits, { tokens: 999, cost: 0.1 }).any, false);
	assert.equal(nodeOverLimit(limits, { tokens: 1000, cost: 0.1 }).tokens, true);
	assert.equal(nodeOverLimit(limits, { tokens: 10, cost: 0.5 }).cost, true);
	assert.equal(runOverLimit(limits, { tokens: 4000, cost: 2 }).any, false, 'лимит денег запуска не задан');
	assert.equal(runOverLimit(limits, { tokens: 5000, cost: 0 }).tokens, true);
});

test('nodeBudgetNote/runBudgetTitle: причина и лимит видны в тексте', () => {
	const limits = normalizeLimits({ nodeTokens: 100, nodeCost: 0.2, runTokens: 1000, runCost: 1 });
	assert.ok(nodeBudgetNote(limits, { tokens: 150, cost: 0 }).includes('токены'));
	assert.equal(formatBudget({ tokens: 1500, cost: 0.25 }), '1500 токенов / $0.2500');
	const title = runBudgetTitle('ru', { tokens: 2000, cost: 1.5 }, limits);
	assert.ok(title.includes('Бюджет запуска исчерпан'));
	assert.ok(title.includes('2000 токенов'));
});

test('usageOf: разбирает usage и терпим к его отсутствию', () => {
	assert.deepEqual(usageOf({ usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 } }), {
		inputTokens: 10, outputTokens: 5, costUsd: 0.02, total: 15,
	});
	assert.deepEqual(usageOf({ usage: { input_tokens: 4, output_tokens: 6 } }), {
		inputTokens: 4, outputTokens: 6, costUsd: 0, total: 10,
	});
	assert.equal(usageOf({}).total, 0);
});

// ---------- граф: лимиты реально останавливают ----------

/** План из одной задачи + поддельная модель, отдающая учёт расхода. */
function budgetHarness({ budget, usage }) {
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'сделай', deps: [] }];
	const emitted = [];
	const calls = { supervisor: 0, workers: 0 };
	const llm = {
		complete: async (role) => {
			if (role === 'supervisor') {
				calls.supervisor += 1;
				return calls.supervisor === 1
					? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'high', usage }
					: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'high', usage };
			}
			calls.workers += 1;
			return { text: 'worker ok', toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'low', usage };
		},
	};
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru',
		emit: event => emitted.push(event),
		invokeTool: async () => ({ output: 'ok' }),
		budget,
	}, { checkpointer: new MemorySaver() });
	return { graph, emitted, calls };
}

test('Этап 5.1: лимит узла останавливает ноду — needs_human и карточка (без второго вызова модели)', async () => {
	const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.01 };
	const { graph, emitted, calls } = budgetHarness({ budget: { nodeTokens: 100 }, usage });
	const cfg = { configurable: { thread_id: 'budget-node' } };

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до interrupt */ }

	assert.equal(calls.workers, 1, 'модель вызвана один раз — дальше лимит не пустил');
	const st = await graph.getState(cfg);
	assert.ok(st.next.includes('escalate'), 'граф замер на человеке');
	assert.equal(st.values.results['coder#1.0'].status, 'needs_human');
	assert.equal(st.values.results['coder#1.0'].reason, 'budget');
	assert.equal(st.values.results['coder#1.0'].tokens, 300);
	assert.equal(st.values.results['coder#1.0'].cost, 0.01);
	assert.equal(st.values.budget.tokens, 300);

	const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && e.interrupt.role === 'human');
	assert.ok(banner, 'карточка подтверждения ушла в панель');
	assert.ok(banner.interrupt.title.includes('лимит'), 'заголовок объясняет бюджет, а не проверки');
});

test('Этап 5.1: лимит запуска ставит весь граф на паузу + interrupt, resume продолжает', async () => {
	const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.01 };
	const { graph, emitted } = budgetHarness({ budget: { runTokens: 100 }, usage });
	const cfg = { configurable: { thread_id: 'budget-run' } };

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до interrupt */ }

	const paused = await graph.getState(cfg);
	assert.ok(paused.next.includes('budgetGate'), 'граф замер на бюджетном гейте');
	const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && e.interrupt.node === 'budget');
	assert.ok(banner, 'interrupt бюджета запуска поднят');
	assert.ok(banner.interrupt.title.includes('Бюджет запуска исчерпан'));

	// Согласие человека: граф продолжается и завершает запуск.
	let final;
	for await (const v of await graph.stream(new Command({ resume: { approved: true } }), { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	assert.equal(final.budgetAck, true, 'повторно не спрашиваем');
	assert.equal(final.budgetHalt, false);
	assert.equal(final.summary, 'готово', 'супервизор дошёл до финала');
});

test('Этап 5.1: отказ человека по бюджету останавливает запуск (budgetHalt → deliver)', async () => {
	const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.01 };
	const { graph } = budgetHarness({ budget: { runTokens: 100 }, usage });
	const cfg = { configurable: { thread_id: 'budget-halt' } };

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до interrupt */ }

	let final;
	for await (const v of await graph.stream(new Command({ resume: { approved: false } }), { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	const st = await graph.getState(cfg);
	assert.equal(final.budgetHalt, true);
	assert.ok(final.summary.includes('остановлено') || final.summary.includes('Остановлено'), 'итог объясняет причину');
	assert.deepEqual(st.next, [], 'граф завершён, а не крутит бюджетные паузы');
});

test('Этап 5.1: без лимитов бюджетный гейт не мешает (регресс)', async () => {
	const usage = { inputTokens: 100, outputTokens: 200, costUsd: 0.01 };
	const { graph, emitted } = budgetHarness({ budget: {}, usage });
	const cfg = { configurable: { thread_id: 'budget-none' } };
	let final;
	for await (const v of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	assert.equal(final.budget.tokens > 0, true, 'расход всё равно считается');
	assert.equal(final.budgetHalt, false);
	assert.ok(!emitted.some(e => e.type === 'interrupt.requested'), 'лимитов нет — пауз нет');
});
