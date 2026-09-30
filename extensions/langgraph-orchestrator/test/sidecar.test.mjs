import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sidecarSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sidecar', 'src');

const { parseDecision, fallbackDecision, normalizePlan, summarize, tierForNode, buildOrchestratorGraph, MAX_SUPERVISOR_ROUNDS, formatConfirmPrompt } = require(path.join(sidecarSrc, 'graph.js'));
const { LlmClient, tierFor, tierForRole } = require(path.join(sidecarSrc, 'llm.js'));
const { Gate, Orchestrator } = require(path.join(sidecarSrc, 'orchestrator.js'));
const { SidecarRpc } = require(path.join(sidecarSrc, 'rpc.js'));
const { describeToolCall } = require(path.join(sidecarSrc, 'notes.js'));
const { PassThrough } = require('node:stream');
const { createServer } = require('node:http');
// LangGraph резолвится из node_modules сайдкара: у корня расширения своей зависимости нет.
const { MemorySaver, Command } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));

/**
 * Граф с поддельным LLM: супервизор отдаёт заданный план, воркеры отвечают текстом.
 * Нужен, чтобы проверить очередь и отмену узла без расхода реальных ключей.
 */
function buildHarness({ plan, maxParallelWorkers = 1, gate = new Gate(), language = 'ru', maxVerifyRetries = 0 }) {
	const emitted = [];
	const calls = { supervisor: 0, workers: [], prompts: [] };
	const llm = {
		complete: async (role, messages) => {
			calls.prompts.push(messages.map(m => m.content).join('\n'));
			if (role === 'supervisor') {
				calls.supervisor += 1;
				return calls.supervisor === 1
					? { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'high' }
					: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'high' };
			}
			calls.workers.push(role);
			return { text: `worker ${role} ok`, toolCalls: [], usedKeyName: 'kimi-k3', usedTier: 'low' };
		},
	};
	const graph = buildOrchestratorGraph({
		llm,
		tools: [],
		invokeTool: async () => ({ output: 'ok' }),
		gate,
		maxParallelWorkers,
		maxVerifyRetries,
		language,
		emit: event => emitted.push(event),
	});
	return { graph, emitted, calls };
}

/** Последний снапшот состояния графа. */
async function runGraph(graph) {
	const stream = await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values' });
	let last;
	for await (const values of stream) {
		last = values;
	}
	return last;
}

// ---------- parseDecision / normalizePlan ----------

test('parseDecision: валидные nodes', () => {
	const d = parseDecision('{"nodes":[{"id":"coder#1.0","kind":"code","goal":"сделай"},{"id":"tester#1.1","kind":"test","goal":"покрой","deps":["coder#1.0"]}]}', { round: 0, results: {} });
	assert.equal(d.nodes.length, 2);
	assert.equal(d.nodes[0].agent, 'coder');
	assert.equal(d.nodes[1].agent, 'tester');
	assert.deepEqual(d.nodes[1].deps, ['coder#1.0']);
	assert.equal(d.finish, '');
	assert.equal(d.invalid, false);
});

test('parseDecision: finish', () => {
	const d = parseDecision('{"finish":"всё готово"}', { round: 0, results: {} });
	assert.equal(d.finish, 'всё готово');
	assert.equal(d.nodes.length, 0);
});

test('parseDecision: мусорный ответ помечается invalid (ретрай у планировщика)', () => {
	const d = parseDecision('я не понял вопрос', { round: 0, results: {} });
	assert.equal(d.invalid, true);
	assert.equal(d.nodes.length, 0);
});

test('fallbackDecision: мусор без результатов → узел coder', () => {
	const d = fallbackDecision('я не понял вопрос', { round: 0, results: {}, task: 'задача' });
	assert.equal(d.nodes.length, 1);
	assert.equal(d.nodes[0].agent, 'coder');
});

test('fallbackDecision: мусор + есть результаты → finish с объяснением', () => {
	const d = fallbackDecision('проза без json', { round: 1, results: { 'coder#1.0': { status: 'ok' } } });
	assert.equal(d.nodes.length, 0);
	assert.ok(d.finish.includes('не смог сформировать'));
});

test('parseDecision: лимит раундов → принудительный finish', () => {
	const d = parseDecision('{"nodes":[{"kind":"code","goal":"ещё"}]}', { round: 3, results: {} });
	assert.ok(d.finish.includes('Лимит раундов'));
});

test('parseDecision: неизвестный агент приводится к code/coder', () => {
	const d = parseDecision('{"delegates":[{"agent":"hacker","instruction":"x"},{"agent":"coder","instruction":"y"}]}', { round: 0, results: {} });
	assert.equal(d.nodes.length, 2);
	assert.equal(d.nodes[0].agent, 'coder');
	assert.equal(d.nodes[0].kind, 'code');
});

test('normalizePlan: старые delegates получают id/kind, deps-индексы резолвятся в id', () => {
	const nodes = normalizePlan([{ agent: 'coder', instruction: 'a' }, { agent: 'tester', instruction: 'b', dependsOn: [0] }], 1);
	assert.equal(nodes[0].id, 'coder#1.0');
	assert.equal(nodes[1].id, 'tester#1.1');
	assert.equal(nodes[1].kind, 'test');
	assert.deepEqual(nodes[1].deps, ['coder#1.0']);
});

test('tierForNode: search/boilerplate принудительно low, иначе хинт или роль', () => {
	assert.equal(tierForNode({ kind: 'search', agent: 'coder', tier: 'high' }), 'low');
	assert.equal(tierForNode({ kind: 'boilerplate', agent: 'coder' }), 'low');
	assert.equal(tierForNode({ kind: 'code', tier: 'mid', agent: 'coder' }), 'mid');
	assert.equal(tierForNode({ kind: 'code', agent: 'tester' }), 'low');
	assert.equal(tierForNode({ kind: 'code', agent: 'coder' }), 'high');
});

test('summarize: не больше 5 строк и ограничение длины', () => {
	const s = summarize('a\nb\nc\nd\ne\nf\ng');
	assert.ok(s.startsWith('a'), 'первая строка сохранена');
	assert.ok(s.includes('…'), 'лишние строки свёрнуты');
	assert.ok(s.split('\n').length <= 6);
	assert.equal(summarize(''), '');
});

// ---------- tierFor / эскалация ----------

test('tierFor: роли на своих тирах', () => {
	assert.equal(tierFor('supervisor'), 'high');
	assert.equal(tierFor('coder'), 'high');
	assert.equal(tierFor('tester'), 'low');
	assert.equal(tierFor('security-auditor'), 'mid');
	assert.equal(tierFor('unknown-role'), 'mid');
});

test('LlmClient: эскалация тира после сбоев', async () => {
	const tiers = [];
	const fakeRpc = {
		request: async (_method, params) => {
			tiers.push(params.tier);
			if (tiers.length < 3) {
				throw new Error('429 rate limit');
			}
			return { text: 'ok', toolCalls: [] };
		},
	};
	const llm = new LlmClient(fakeRpc, { escalationThreshold: 2 });
	const result = await llm.complete('tester', [{ role: 'user', content: 'x' }], []);
	assert.equal(result.text, 'ok');
	assert.deepEqual(tiers, ['low', 'mid', 'high']);
});

test('LlmClient: исчерпание эскалации → бросок', async () => {
	const fakeRpc = { request: async () => { throw new Error('down'); } };
	const llm = new LlmClient(fakeRpc, { escalationThreshold: 1 });
	await assert.rejects(() => llm.complete('tester', [], []), /down/);
});

test('LlmClient mock: supervisor сначала делегирует, потом финиширует', async () => {
	const llm = new LlmClient(null, { mock: true });
	const first = await llm.complete('supervisor', [{ role: 'user', content: 'task' }], []);
	assert.ok(first.text.includes('nodes'));
	const second = await llm.complete('supervisor', [{ role: 'user', content: 'results MOCK worker coder: done' }], []);
	assert.ok(second.text.includes('finish'));
});

// ---------- Gate ----------

test('Gate: waitIfPaused блокирует до resume', async () => {
	const gate = new Gate();
	gate.pause();
	let passed = false;
	const p = gate.waitIfPaused().then(() => { passed = true; });
	await new Promise(r => setTimeout(r, 400));
	assert.equal(passed, false);
	gate.resume();
	await p;
	assert.equal(passed, true);
});

test('Gate: abort пробивает паузу и кидает исключение', async () => {
	const gate = new Gate();
	gate.pause();
	gate.abort();
	await gate.waitIfPaused();
	assert.throws(() => gate.throwIfAborted(), /cancelled/);
});

// ---------- SidecarRpc ----------

test('SidecarRpc: корреляция res по id и маршрутизация evt', async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let written = '';
	output.on('data', d => { written += d; });
	const rpc = new SidecarRpc(input, output);
	const events = [];
	const promise = rpc.request('chat.complete', { role: 'coder' }, (event, data) => events.push([event, data]));
	input.write(JSON.stringify({ kind: 'evt', id: 1, event: 'token', data: 'hel' }) + '\n');
	input.write(JSON.stringify({ kind: 'evt', id: 1, event: 'token', data: 'lo' }) + '\n');
	input.write(JSON.stringify({ kind: 'res', id: 1, ok: true, result: { text: 'hello' } }) + '\n');
	const result = await promise;
	assert.equal(result.text, 'hello');
	assert.deepEqual(events, [['token', 'hel'], ['token', 'lo']]);
	assert.ok(written.includes('"method":"chat.complete"'));
});

test('SidecarRpc: res с ok=false → reject', async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	output.on('data', () => {});
	const rpc = new SidecarRpc(input, output);
	const promise = rpc.request('tool.invoke', {});
	input.write(JSON.stringify({ kind: 'res', id: 1, ok: false, error: 'denied' }) + '\n');
	await assert.rejects(promise, /denied/);
});

// ---------- Orchestrator (mock LLM, полный цикл) ----------

test('Orchestrator: полный цикл mock-задачи с чекпоинтами', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => { throw new Error('no rpc in mock'); },
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	const started = await orch.handleCommand('start', { task: 'test task', tools: [] });
	assert.equal(started.started, true);
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const types = notifications.filter(n => n.method === 'graph.event').map(n => n.params.type);
	assert.ok(types.includes('graph.started'));
	assert.ok(types.includes('graph.finished'));
	const checkpoints = notifications.filter(n => n.method === 'checkpoint');
	assert.ok(checkpoints.length >= 2);
	const last = checkpoints[checkpoints.length - 1].params;
	assert.ok(Object.keys(last.results).some(k => k.startsWith('coder#')));
	assert.ok(Object.keys(last.results).some(k => k.startsWith('tester#')));
	assert.ok(Object.keys(last.results).some(k => k.startsWith('security-auditor#')));
});

test('Orchestrator: resume подхватывает чекпоинт той же задачи', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => { throw new Error('no rpc'); },
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	const started = await orch.handleCommand('start', {
		task: 'test task',
		tools: [],
		resumeState: { task: 'test task', round: 2, results: { 'coder#1.0': 'done' } },
	});
	assert.equal(started.resumed, true);
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const resumedLog = notifications.find(n => n.method === 'graph.event' && n.params.message?.includes('resume из чекпоинта'));
	assert.ok(resumedLog, 'expected resume log message');
});

test('Orchestrator: повторный start во время работы отклоняется', async () => {
	const fakeRpc = { notify: () => {}, request: async () => ({}) };
	const orch = new Orchestrator(fakeRpc, { mock: true });
	orch.runPromise = Promise.resolve();
	await assert.rejects(() => orch.handleCommand('start', { task: 'x' }), /already running/);
	orch.runPromise = null;
});

// ---------- ноты агентов ----------

test('describeToolCall: ноты агенту по-русски — видно, чем он занят', () => {
	assert.equal(describeToolCall('fs.readFile', { path: 'src/host.ts' }), 'читаю src/host.ts');
	assert.equal(describeToolCall('fs.writeFile', { path: 'src/a.ts' }), 'пишу src/a.ts');
	assert.equal(describeToolCall('fs.search', { query: 'approval' }), 'ищу approval');
	assert.equal(describeToolCall('terminal.run', { command: 'npm test' }), 'запускаю npm test');
	assert.equal(describeToolCall('diagnostics.get', {}), 'собираю ошибки');
	assert.equal(describeToolCall('выдуманный', {}), 'выдуманный');
});

test('describeToolCall: длина ноты ограничена', () => {
	const note = describeToolCall('terminal.run', { command: 'npx tsc '.repeat(50) });
	assert.ok(note.length <= 120, `note too long: ${note.length}`);
	assert.ok(note.endsWith('…'));
});

// ---------- очередь подзадач ----------

test('Gate: отмена одной подзадачи не отменяет запуск целиком', () => {
	const gate = new Gate();
	gate.abortNode('tester#1.1');
	assert.equal(gate.nodeAborted('tester#1.1'), true);
	assert.equal(gate.nodeAborted('coder#1.0'), false);
	assert.equal(gate.aborted(), false);
});

test('граф: план больше лимита воркеров — очередь вычерпывается целиком', async () => {
	const plan = [
		{ agent: 'coder', instruction: 'сделай' },
		{ agent: 'tester', instruction: 'покрой тестами' },
		{ agent: 'security-auditor', instruction: 'проверь' },
		{ agent: 'reviewer', instruction: 'отревьюй' },
	];
	const { graph, emitted, calls } = buildHarness({ plan, maxParallelWorkers: 1 });
	const values = await runGraph(graph);

	// Раньше fan-out обрезал план до лимита воркеров — три задачи из четырёх молча терялись.
	assert.deepEqual(Object.keys(values.results).sort(), ['coder#1.0', 'reviewer#1.3', 'security-auditor#1.2', 'tester#1.1']);
	assert.deepEqual(calls.workers.sort(), ['coder', 'reviewer', 'security-auditor', 'tester']);
	assert.equal(values.summary, 'готово');

	const queued = emitted.filter(e => e.type === 'node.queued');
	assert.equal(queued.length, 4, 'весь план виден в очереди сразу');
	assert.deepEqual([...new Set(queued.map(e => e.node.status))], ['idle']);
	const workers = emitted.filter(e => ['node.started', 'node.finished'].includes(e.type) && e.node.role !== 'supervisor');
	const startedWorkers = workers.filter(e => e.type === 'node.started');
	assert.equal(startedWorkers.length, 4);
	assert.equal(workers.filter(e => e.type === 'node.finished').length, 4);
	assert.deepEqual([...new Set(startedWorkers.map(e => e.node.tier))], ['high', 'low', 'mid']);
});

test('tierForRole: хинт подзадачи важнее роли', () => {
	assert.equal(tierForRole('coder', 'low'), 'low');
	assert.equal(tierForRole('tester', 'high'), 'high');
	assert.equal(tierForRole('coder', undefined), 'high');
	assert.equal(tierForRole('tester', 'не-тир'), 'low');
});

test('граф: DAG — зависимая подзадача ждёт закрытия dependencies, независимые летят параллельно', async () => {
	// tester зависит от coder: при лимите 2 он не может стартовать в первой пачке,
	// и запускается только во второй, после результата coder'а.
	const plan = [
		{ agent: 'coder', instruction: 'сделай' },
		{ agent: 'tester', instruction: 'покрой', dependsOn: [0] },
	];
	const { graph, emitted } = buildHarness({ plan, maxParallelWorkers: 2 });
	const values = await runGraph(graph);
	assert.deepEqual(Object.keys(values.results).sort(), ['coder#1.0', 'tester#1.1']);
	const startedCoder = emitted.filter(e => e.type === 'node.started' && e.node.id === 'coder#1.0');
	const startedTester = emitted.filter(e => e.type === 'node.started' && e.node.id === 'tester#1.1');
	assert.equal(startedCoder.length, 1);
	assert.equal(startedTester.length, 1);
	// Тестер стартует после: время старта не раньше, чем закончился кодер.
	assert.ok(startedTester[0].node.startedAt >= emitted.find(e => e.type === 'node.finished' && e.node.id === 'coder#1.0').node.finishedAt);
});

test('граф: verify самозалечивает провал воркера без супервизора', async () => {
	const plan = [{ agent: 'coder', instruction: 'сделай' }];
	const emitted = [];
	// Воркер дважды отвечает ошибкой, потом успехом; супервизор планирует один раз.
	let workerCalls = 0;
	let supervisorCalls = 0;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		if (workerCalls <= 2) {
			throw new Error('boom ' + workerCalls);
		}
		return { text: 'worker fixed', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph2 = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 1, maxVerifyRetries: 2, language: 'ru',
		emit: e => emitted.push(e),
	});
	const values = await runGraph(graph2);
	assert.equal(workerCalls, 3, 'воркер перезапускался до успеха');
	assert.equal(values.results['coder#1.0'].status, 'ok');
	assert.equal(values.results['coder#1.0'].summary, 'worker fixed');
	assert.equal(values.attempts['coder#1.0'], 2);
	const retryNotes = emitted.filter(e => e.type === 'node.note' && e.node.role === 'verify');
	assert.ok(retryNotes.length >= 2, 'verify виден на доске');
});

test('граф: verify сдаётся после лимита ретраев', async () => {
	const plan = [{ agent: 'coder', instruction: 'сделай' }];
	let workerCalls = 0;
	let supervisorCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'сдаюсь' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		throw new Error('boom');
	}};
	const emitted = [];
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 1, maxVerifyRetries: 1, language: 'ru',
		emit: e => emitted.push(e),
	});
	const values = await runGraph(graph);
	assert.equal(workerCalls, 2, 'один запуск + один ретрай');
	assert.equal(values.results['coder#1.0'].status, 'failed');
	assert.ok(values.errors.some(e => e.node === 'coder#1.0'), 'провал попал в errors');
	const giveUp = emitted.find(e => e.type === 'node.error' && e.node.role === 'verify');
	assert.ok(giveUp, 'verify сообщил об исчерпании ретраев');
});

test('граф: рискованная подзадача ставит граф на паузу, resume продолжает', async () => {
	// Резолвим из node_modules сайдкара: у test/ своей зависимости нет.
	const { MemorySaver, Command } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));
	const plan = [
		{ agent: 'coder', instruction: 'сделай' },
		{ agent: 'coder', instruction: 'запушь в прод', confirm: true },
	];
	let workerCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			return { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const emitted = [];
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 2, language: 'ru',
		emit: e => emitted.push(e),
	}, { checkpointer: new MemorySaver() });
	const cfg = { configurable: { thread_id: 'gate-test' } };
	// Шаг 1: обе подзадачи летят в одной пачке; confirm-подзадача замирает на interrupt,
	// суперстеп (и стрим) ждёт её — незаконченная ветка держит весь шаг.
	let last;
	for await (const v of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 50, streamMode: 'values', ...cfg })) {
		last = v;
	}
	assert.ok(last, 'стрим отдал значения до interrupt');
	const st = await graph.getState(cfg);
	assert.ok(st.next.includes('worker'), 'граф ждёт на воркере');
	const events = emitted.filter(e => e.type === 'interrupt.requested');
	assert.equal(events.length, 1, 'событие interrupt.requested ушло в панель');
	assert.equal(events[0].interrupt.role, 'coder');
	assert.ok(workerCalls >= 1, 'обычный воркер успел отработать');
	// Шаг 2: решение пользователя из панели — граф продолжается с места паузы.
	let final;
	for await (const v2 of await graph.stream(new Command({ resume: { approved: true } }), { recursionLimit: 50, streamMode: 'values', ...cfg })) {
		final = v2;
	}
	assert.equal(final.results['coder#1.1'].status, 'ok', 'подтверждённая подзадача выполнена');
	assert.equal(final.results['coder#1.0'].status, 'ok');
});

test('Orchestrator: interrupt.resolve/rewind/patchState/history ходят по RPC', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => { throw new Error('no rpc in mock'); },
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	await orch.handleCommand('start', { task: 'test task', tools: [] });
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const history = await orch.handleCommand('history', { limit: 5 });
	assert.ok(history.entries.length >= 2, 'история чекпоинтов пишется');
	const target = history.entries[0];
	assert.ok(target.checkpointId, 'у шага есть checkpointId');
	// rewind на последний шаг графа — граф уже завершён, поток пуст.
	const rewound = await orch.handleCommand('rewind', { checkpointId: target.checkpointId });
	assert.equal(rewound.rewound, true);
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const patchResult = await orch.handleCommand('patchState', { checkpointId: target.checkpointId, patch: { summary: 'правка руками' } });
	assert.equal(patchResult.patched, true);
});

test('Orchestrator: restartNode возвращает подзадачу в очередь и продолжает граф', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => ({ output: 'ok' }),
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	await assert.rejects(() => orch.handleCommand('restartNode', { nodeId: 'coder#1.0' }), /no graph instance/);
	await orch.handleCommand('start', { task: 'restart task', tools: [] });
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const before = await orch.graphRef.getState(orch.threadConfig);
	const nodeId = Object.keys(before.values.itemState || {})[0];
	assert.ok(nodeId, 'в состоянии есть подзадачи');
	await assert.rejects(() => orch.handleCommand('restartNode', {}), /nodeId is required/);
	await assert.rejects(() => orch.handleCommand('restartNode', { nodeId: 'нет-такой' }), /node not found/);
	const result = await orch.handleCommand('restartNode', { nodeId });
	assert.equal(result.restarted, true);
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const after = await orch.graphRef.getState(orch.threadConfig);
	assert.ok(after.values.itemState[nodeId], 'нода заново получила статус');
	assert.ok(after.values.results[nodeId], 'результат ноды пересчитан');
	assert.ok(
		notifications.some(n => n.params && n.params.type === 'log' && String(n.params.message).includes(nodeId)),
		'перезапуск ноды виден в логе',
	);
});

test('граф: язык подсказки супервизору следует языку панели', async () => {
	const plan = [{ agent: 'coder', instruction: 'сделай' }];
	const ru = buildHarness({ plan, language: 'ru' });
	await runGraph(ru.graph);
	assert.ok(ru.calls.prompts[0].includes('in Russian'), 'русская панель — русские инструкции');
	const en = buildHarness({ plan, language: 'en' });
	await runGraph(en.graph);
	assert.ok(en.calls.prompts[0].includes('in English'), 'английская панель — английские инструкции');
});

test('граф: один ключ тянет нескольких агентов — ключ виден на каждой карточке', async () => {
	const plan = [{ agent: 'coder', instruction: 'a' }, { agent: 'tester', instruction: 'b' }];
	const { graph, emitted } = buildHarness({ plan, maxParallelWorkers: 2 });
	await runGraph(graph);
	const keyNotes = emitted.filter(e => e.type === 'node.note' && e.node.keyName);
	assert.equal(keyNotes.length, 2, 'каждый воркер отдаёт ключ, которым ответил');
	assert.ok(keyNotes.every(e => e.node.keyName === 'kimi-k3'));
});

// ---------- события запуска для панели ----------

test('Orchestrator: события несут план, итог запуска и настоящие тиры', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => { throw new Error('no rpc in mock'); },
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	await orch.handleCommand('start', { task: 'test task', tools: [] });
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const events = notifications.filter(n => n.method === 'graph.event').map(n => n.params);

	const started = events.find(e => e.type === 'graph.started');
	assert.equal(started.run.maxRounds, MAX_SUPERVISOR_ROUNDS);

	const queued = events.filter(e => e.type === 'node.queued');
	assert.equal(queued.length, 3, 'план виден в очереди до запуска воркеров');

	const planEvent = events.find(e => e.type === 'node.finished' && e.node.id === 'supervisor' && e.run);
	assert.equal(planEvent.run.planned, 3);
	assert.equal(planEvent.run.round, 1);

	const finished = events.find(e => e.type === 'graph.finished');
	assert.ok(finished.run.summary.includes('MOCK summary'));
	assert.ok(events.every(e => !e.node || e.node.tier !== 'mock'), 'mock-тир не должен утекать в панель');
});

test('Orchestrator: cancelNode снимает одну подзадачу, не трогая остальные', async () => {
	const fakeRpc = { notify: () => {}, request: async () => ({}) };
	const orch = new Orchestrator(fakeRpc, { mock: true });
	const result = await orch.handleCommand('cancelNode', { nodeId: 'tester#1.1' });
	assert.deepEqual(result, { cancelled: true, nodeId: 'tester#1.1' });
	assert.equal(orch.gate.nodeAborted('tester#1.1'), true);
	assert.equal(orch.gate.aborted(), false);
	await assert.rejects(() => orch.handleCommand('cancelNode', {}), /nodeId is empty/);
});

// ---------- DAG: зависимости, тир-хинты, verify, interrupt, time-travel ----------

test('граф: verifyCommand гоняет реальную проверку и подмешивает вывод в ретрай', async () => {
	const plan = [{ agent: 'coder', instruction: 'сделай' }];
	const toolCalls = [];
	const retryInstructions = [];
	let workerCalls = 0;
	let supervisorCalls = 0;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		if (workerCalls === 1) {
			throw new Error('boom');
		}
		// Инструкция ретрая — последний user-месседж: там должен быть вывод проверки.
		retryInstructions.push(messages[messages.length - 1].content);
		return { text: 'worker fixed', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [],
		invokeTool: async (name, input) => {
			toolCalls.push({ name, command: input.command });
			return { ok: true, output: 'FAIL src/a.test.ts — expected 1 to be 2' };
		},
		gate: new Gate(), maxParallelWorkers: 1, maxVerifyRetries: 1,
		verifyCommand: 'npm test', language: 'ru',
		emit: () => {},
	});
	const values = await runGraph(graph);
	assert.deepEqual(toolCalls, [{ name: 'terminal.run', command: 'npm test' }], 'verify запускает команду проверки');
	assert.equal(workerCalls, 2);
	assert.ok(retryInstructions[0].includes('ПРЕДЫДУЩАЯ ПОПЫТКА ПРОВАЛИЛАСЬ'), 'воркер знает о провале');
	assert.ok(retryInstructions[0].includes('expected 1 to be 2'), 'воркер получает вывод проверки');
	assert.equal(values.results['coder#1.0'].status, 'ok');
});

test('граф: ошибка verifyCommand не роняет граф, ретрай идёт с текстом провала', async () => {
	const plan = [{ agent: 'coder', instruction: 'сделай' }];
	const retryInstructions = [];
	let workerCalls = 0;
	let supervisorCalls = 0;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ delegates: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		if (workerCalls === 1) {
			throw new Error('boom');
		}
		retryInstructions.push(messages[messages.length - 1].content);
		return { text: 'worker fixed', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [],
		invokeTool: async () => { throw new Error('terminal not available'); },
		gate: new Gate(), maxParallelWorkers: 1, maxVerifyRetries: 1,
		verifyCommand: 'npm test', language: 'ru',
		emit: () => {},
	});
	const values = await runGraph(graph);
	assert.equal(workerCalls, 2, 'ретрай состоялся без вывода проверки');
	assert.ok(retryInstructions[0].includes('ПРЕДЫДУЩАЯ ПОПЫТКА ПРОВАЛИЛАСЬ'));
	assert.ok(!retryInstructions[0].includes('Вывод проверки'), 'вывода проверки нет — команда не выполнилась');
	assert.equal(values.results['coder#1.0'].status, 'ok');
});

test('FileSaver: чекпоинты переживают пересоздание saverа (рестарт сайдкара)', async () => {
	const { FileSaver } = require(path.join(sidecarSrc, 'fileSaver.js'));
	const os = require('node:os');
	const fs = require('node:fs');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-fsaver-'));
	const file = path.join(dir, 'store.json');
	const config = { configurable: { thread_id: 't1' } };

	const first = new FileSaver(file);
	const checkpointId = 'cp-1';
	await first.put(config, { id: checkpointId, v: 1, channel_values: { task: 'x' }, channel_versions: {}, versions_seen: {}, pending_sends: [] }, { source: 'loop' });
	// checkpoint_ns — строка и в putWrites, и в getTuple: ключи хранилища обязаны совпасть.
	await first.putWrites({ ...config, configurable: { ...config.configurable, checkpoint_ns: '', checkpoint_id: checkpointId } }, [['__error__', 'упс']], 1);

	// Новый saver как после рестарта процесса: хранилище поднимается из файла.
	const second = new FileSaver(file);
	const tuple = await second.getTuple({ configurable: { thread_id: 't1', checkpoint_id: checkpointId } });
	assert.ok(tuple, 'чекпоинт найден после пересоздания');
	assert.equal(tuple.checkpoint.channel_values.task, 'x');
	assert.ok(tuple.pendingWrites.some(([, channel, value]) => channel === '__error__' && value === 'упс'), 'pendingWrites восстановлены');

	const listed = [];
	for await (const snap of second.list({ configurable: { thread_id: 't1' } }, { limit: 10 })) {
		listed.push(snap.checkpoint.id);
	}
	assert.deepEqual(listed, [checkpointId]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('Orchestrator: thread_id стабилен при resume одной задачи', async () => {
	const notifications = [];
	const fakeRpc = {
		notify: (method, params) => notifications.push({ method, params }),
		request: async () => { throw new Error('no rpc'); },
	};
	const orch = new Orchestrator(fakeRpc, { mock: true });
	await orch.handleCommand('start', { task: 'same task', tools: [] });
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	const firstId = orch.threadId;
	assert.ok(firstId, 'thread_id назначен');

	await orch.handleCommand('start', {
		task: 'same task',
		tools: [],
		resumeState: { task: 'same task', round: 1, results: {}, threadId: firstId },
	});
	for (let i = 0; i < 100 && orch.running; i++) {
		await new Promise(r => setTimeout(r, 50));
	}
	assert.equal(orch.threadId, firstId, 'resume продолжает тот же поток чекпоинтов');
});

// ---------- LLM через локальный HTTP-прокси ----------

/** Мини-сервер, который отвечает на один запрос и запоминает его. */
function fakeProxy(handler) {
	const seen = { requests: [] };
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			seen.requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : {} });
			handler(res);
		});
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			seen,
			url: `http://127.0.0.1:${server.address().port}`,
			close: () => new Promise(done => server.close(done)),
		}));
	});
}

test('LlmClient: прокси получает тир и токен, ответ пробрасывается', async () => {
	const proxy = await fakeProxy(res => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ text: 'ok', toolCalls: [{ id: 't1', name: 'fs.readFile', input: {} }], usedTier: 'low', usedKeyName: 'k1' }));
	});
	try {
		const llm = new LlmClient(null, { proxyUrl: proxy.url, runToken: 'secret-token' });
		const result = await llm.complete('tester', [{ role: 'user', content: 'x' }], []);
		assert.equal(result.text, 'ok');
		assert.equal(result.usedTier, 'low');
		assert.deepEqual(result.toolCalls, [{ id: 't1', name: 'fs.readFile', input: {} }]);
		const request = proxy.seen.requests[0];
		assert.equal(request.url, '/v1/chat/completions');
		assert.equal(request.auth, 'Bearer secret-token');
		assert.equal(request.body.tier, 'low', 'в теле — тир роли, а не имя модели');
		assert.equal(request.body.role, 'tester');
		assert.equal(request.body.tools, undefined, 'пустой список инструментов не отправляется');
	} finally {
		await proxy.close();
	}
});

test('LlmClient: ошибка прокси не уходит в RPC-фолбэк', async () => {
	let rpcCalls = 0;
	const proxy = await fakeProxy(res => {
		res.writeHead(500, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'all tiers exhausted' }));
	});
	try {
		const llm = new LlmClient({ request: async () => { rpcCalls += 1; return {}; } }, { proxyUrl: proxy.url, runToken: 't' });
		await assert.rejects(() => llm.complete('coder', [], []), /500/);
		assert.equal(rpcCalls, 0, 'при заданном прокси RPC-путь не используется');
	} finally {
		await proxy.close();
	}
});

test('parseDecision: deps/tier/confirm попадают в узлы', () => {
	const d = parseDecision(JSON.stringify({
		nodes: [
			{ id: 'a', kind: 'code', goal: 'a', deps: [] },
			{ id: 'b', kind: 'test', goal: 'b', deps: ['a'], tier: 'low' },
			{ id: 'c', kind: 'review', goal: 'c', deps: ['a', 'b'], confirm: true },
		],
	}), { round: 0, results: {} });
	assert.equal(d.nodes.length, 3);
	assert.deepEqual(d.nodes[1].deps, ['a']);
	assert.equal(d.nodes[1].tier, 'low');
	assert.equal(d.nodes[2].confirm, true);
});

// ---------- planner: валидация JSON + один ретрай ----------

test('граф: planner ретраит невалидный JSON и продолжает по валидному плану', async () => {
	const emitted = [];
	let supervisorCalls = 0;
	let workerCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			if (supervisorCalls === 1) {
				return { text: 'это вообще не json', toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
			}
			if (supervisorCalls === 2) {
				return { text: JSON.stringify({ nodes: [{ id: 'coder#1.0', kind: 'code', goal: 'сделай', deps: [] }] }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
			}
			return { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 1, language: 'ru', emit: e => emitted.push(e),
	});
	const values = await runGraph(graph);
	assert.equal(supervisorCalls, 3, 'два планирующих вызова (ретрай) + финальный');
	assert.equal(workerCalls, 1);
	assert.equal(values.results['coder#1.0'].status, 'ok');
	assert.ok(emitted.some(e => e.type === 'log' && e.message.includes('невалидный JSON')), 'ретрай виден в логе');
});

// ---------- reducer: структурированные results, бюджет, чистый raw ----------

test('граф: reducer сжимает вывод воркера, чистит raw и копит бюджет', async () => {
	const nodes = [
		{ id: 'coder#1.0', kind: 'code', goal: 'сделай', deps: [] },
		{ id: 'tester#1.1', kind: 'test', goal: 'покрой', deps: [] },
	];
	const emitted = [];
	let supervisorCalls = 0;
	let finishSawStructuredResult = false;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			if (supervisorCalls === 1) {
				return { text: JSON.stringify({ nodes }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
			}
			finishSawStructuredResult = messages.some(m => typeof m.content === 'string' && m.content.includes('[ok]'));
			return { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		return { text: 'line1\nline2\nline3\nline4\nline5\nline6\nline7', toolCalls: [], usedKeyName: 'k', usedTier: 'low', usage: { totalTokens: 11 } };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		collectDiff: async () => ({ diff_stat: ' 1 file changed', commit: 'abc1234' }),
		maxParallelWorkers: 2, language: 'ru', emit: e => emitted.push(e),
	});
	const values = await runGraph(graph);
	for (const id of ['coder#1.0', 'tester#1.1']) {
		const r = values.results[id];
		assert.equal(r.status, 'ok');
		assert.equal(r.commit, 'abc1234');
		assert.equal(r.diff_stat, ' 1 file changed');
		assert.ok(r.summary.split('\n').length <= 6, 'резюме не длиннее 5 строк + свёртка');
		assert.ok(r.summary.includes('…'), 'лишние строки свёрнуты');
	}
	assert.deepEqual(values.raw, {}, 'сырой вывод воркеров вычищен из state');
	assert.equal(values.budget.tokens, 22, 'токены обеих веток просуммированы');
	assert.ok(finishSawStructuredResult, 'планировщик видит структурированные резюме');
});

// ---------- Этап 3: критерии приёмки ядра графа ----------

test('критерий: три независимые подзадачи реально идут параллельно, а не по очереди', async () => {
	const plan = [
		{ id: 'a#1.0', kind: 'code', goal: 'A', deps: [] },
		{ id: 'b#1.1', kind: 'code', goal: 'B', deps: [] },
		{ id: 'c#1.2', kind: 'code', goal: 'C', deps: [] },
	];
	const emitted = [];
	let supervisorCalls = 0;
	let entered = 0;
	let release;
	const allEntered = new Promise(resolve => { release = resolve; });
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		entered += 1;
		if (entered === 3) {
			release();
		}
		// Барьер: первый воркер ждёт всех остальных. Сериализованный граф на этом
		// зависнет, поэтому тест падает по таймауту, а не проходит ложно.
		await Promise.race([
			allEntered,
			new Promise((_, reject) => setTimeout(() => reject(new Error('воркеры не пересеклись во времени')), 3000)),
		]);
		return { text: `worker ${role} ok`, toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 3, language: 'ru', emit: e => emitted.push(e),
	});
	const values = await runGraph(graph);
	assert.equal(entered, 3, 'все три воркера одновременно были в работе');
	assert.deepEqual(Object.keys(values.results).sort(), ['a#1.0', 'b#1.1', 'c#1.2']);
	const starts = emitted.filter(e => e.type === 'node.started' && e.node.role !== 'supervisor');
	const firstFinish = emitted.find(e => e.type === 'node.finished' && e.node.role !== 'supervisor');
	assert.equal(starts.length, 3, 'три старта воркеров');
	assert.ok(starts.every(e => e.node.startedAt <= firstFinish.node.finishedAt), 'ни одна подзадача не ждала завершения другой');
});

test('критерий: после kill сайдкара запуск продолжается с последнего чекпоинта', async () => {
	const { FileSaver } = require(path.join(sidecarSrc, 'fileSaver.js'));
	const os = require('node:os');
	const fs = require('node:fs');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-kill-'));
	const file = path.join(dir, 'graph-store.json');
	const plan = [
		{ id: 'step#1.0', kind: 'code', goal: 'первый шаг', deps: [] },
		{ id: 'gate#1.1', kind: 'code', goal: 'рискованный шаг', deps: ['step#1.0'], confirm: true },
	];
	let supervisorCalls = 0;
	// Отдельный инстанс графа — это и есть «сайдкар»: kill = пересоздание графа
	// и FileSaver'а поверх того же файла.
	const makeGraph = () => buildOrchestratorGraph({
		llm: { complete: async (role) => {
			if (role === 'supervisor') {
				supervisorCalls += 1;
				return supervisorCalls === 1
					? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
					: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
			}
			return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
		}},
		tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 1, language: 'ru', emit: () => {},
	}, { checkpointer: new FileSaver(file) });

	const cfg = { configurable: { thread_id: 'kill-run' } };
	try {
		const first = makeGraph();
		for await (const _ of await first.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 100, streamMode: 'values', ...cfg })) { /* доходим до interrupt */ }
		const stateBefore = await first.getState(cfg);
		assert.ok(stateBefore.next.includes('worker'), 'первый прогон замер на подтверждении');
		assert.equal(stateBefore.values.results['step#1.0'].status, 'ok', 'первый шаг успел закоммититься до kill');

		// Новый сайдкар видит историю того же запуска и ту же точку остановки.
		const second = makeGraph();
		let checkpoints = 0;
		for await (const _ of second.getStateHistory(cfg, { limit: 50 })) {
			checkpoints += 1;
		}
		assert.ok(checkpoints >= 3, 'история чекпоинтов пережила kill');
		const resumedState = await second.getState(cfg);
		assert.ok(resumedState.next.includes('worker'), 'новый граф видит ту же точку остановки');

		let final;
		for await (const v of await second.stream(new Command({ resume: { approved: true } }), { recursionLimit: 100, streamMode: 'values', ...cfg })) {
			final = v;
		}
		assert.equal(final.results['step#1.0'].status, 'ok');
		assert.equal(final.results['gate#1.1'].status, 'ok', 'задача продолжилась с чекпоинта после рестарта');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('критерий: rewind на несколько шагов назад + правка goal — граф идёт дальше с правкой', async () => {
	const { MemorySaver } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));
	const plan = [
		{ id: 'n1#1.0', kind: 'code', goal: 'ЦЕЛЬ-1', deps: [] },
		{ id: 'n2#1.1', kind: 'code', goal: 'ЦЕЛЬ-2', deps: [] },
		{ id: 'n3#1.2', kind: 'code', goal: 'ЦЕЛЬ-3', deps: [] },
	];
	const instructions = [];
	let supervisorCalls = 0;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		// Воркер эхом отдаёт инструкцию: по results.summary видно, какая цель реально исполнена.
		const instruction = String(messages[messages.length - 1].content);
		instructions.push(instruction);
		return { text: instruction, toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool: async () => ({ output: 'ok' }), gate: new Gate(),
		maxParallelWorkers: 1, language: 'ru', emit: () => {},
	}, { checkpointer: new MemorySaver() });
	const cfg = { configurable: { thread_id: 'rewind-run' } };

	// Первый прогон до конца: набираем историю чекпоинтов.
	let done;
	for await (const v of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		done = v;
	}
	assert.deepEqual(Object.keys(done.results).sort(), ['n1#1.0', 'n2#1.1', 'n3#1.2']);

	// Ищем чекпоинт сразу после планирования: очередь полна, next = router.
	let target = null;
	let stepsBack = 0;
	let index = 0;
	for await (const snap of graph.getStateHistory(cfg, { limit: 100 })) {
		if ((snap.next || []).includes('router') && (snap.values.queue || []).some(q => q.id === 'n1#1.0')) {
			target = snap;
			stepsBack = index;
			break;
		}
		index += 1;
	}
	assert.ok(target, 'нашёлся чекпоинт после планирования');
	assert.ok(stepsBack >= 3, `точка отката не меньше трёх шагов назад (${stepsBack})`);

	// Правка goal через update_state (он же «edit» из IDE) на выбранном чекпоинте.
	const targetConfig = { configurable: { thread_id: 'rewind-run', checkpoint_id: target.config.configurable.checkpoint_id } };
	const editedGoal = 'ЦЕЛЬ-ИЗМЕНЁННАЯ';
	const patchNode = item => item.id === 'n1#1.0' ? { ...item, goal: editedGoal } : item;
	const patchedConfig = await graph.updateState(targetConfig, {
		plan: target.values.plan.map(patchNode),
		queue: target.values.queue.map(patchNode),
	}, target.next[0]);

	// Продолжение с исправленного чекпоинта: граф идёт дальше по новой цели.
	instructions.length = 0;
	let final;
	for await (const v of await graph.stream(null, { recursionLimit: 200, streamMode: 'values', ...patchedConfig })) {
		final = v;
	}
	assert.ok(instructions.some(text => text.includes(editedGoal)), 'воркер выполнил исправленную цель');
	// Эффективный итог: правка переживает прогон — последний результат узла отражает её,
	// а не первоначальную цель.
	assert.ok(final.results['n1#1.0'].summary.includes(editedGoal), 'в результатах осталась исправленная цель');
	assert.ok(!final.results['n1#1.0'].summary.includes('ЦЕЛЬ-1'), 'первоначальная цель перезаписана');
	assert.deepEqual(Object.keys(final.results).sort(), ['n1#1.0', 'n2#1.1', 'n3#1.2'], 'граф дошёл до конца после отката');
});

// ---------- Этап 4.1: изоляция воркеров в worktree ----------

test('Этап 4.1: два воркера правят один файл в разных worktree и не мешают друг другу', async () => {
	const plan = [
		{ id: 'a#1.0', kind: 'code', goal: 'правка A', deps: [] },
		{ id: 'b#1.1', kind: 'code', goal: 'правка B', deps: [] },
	];
	const toolCalls = [];
	const worktrees = new Map();
	let supervisorCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const invokeTool = async (name, input, nodeId) => {
		toolCalls.push({ name, input, nodeId });
		if (name === 'git.worktreeAdd') {
			worktrees.set(nodeId, { worktree: input.worktree, branch: input.branch });
			return { isolated: true, worktree: input.worktree, branch: input.branch };
		}
		if (name === 'git.commitWorktree') {
			return { commit: `sha-${nodeId}`, clean: false };
		}
		if (name === 'git.diffStat') {
			return { diffStat: ' 1 file changed' };
		}
		if (name === 'git.mergeNode') {
			return { ok: true, conflicts: [] };
		}
		if (name === 'git.finalPatch') {
			return { stat: ' 2 files changed', files: ['src/a.ts', 'src/b.ts'] };
		}
		return { output: 'ok' };
	};
	const graph = buildOrchestratorGraph({
		llm, tools: [], invokeTool, gate: new Gate(),
		maxParallelWorkers: 2, language: 'ru', emit: () => {},
		runId: 'run-1', workspaceRoot: '/repo', baseCommit: 'base123',
	});
	const values = await runGraph(graph);

	// Два разных рабочих дерева и ветки — общий файл больше не пересекается.
	// (Плюс отдельное run-дерево merge, его считаем отдельно.)
	const added = toolCalls.filter(c => c.name === 'git.worktreeAdd' && c.nodeId !== 'merge');
	assert.equal(added.length, 2);
	assert.ok(added.every(c => c.input.baseCommit === 'base123'), 'worktree — от базового коммита запуска');
	assert.equal(new Set(added.map(c => c.input.worktree)).size, 2);
	assert.equal(new Set(added.map(c => c.input.branch)).size, 2);
	assert.ok(toolCalls.some(c => c.name === 'git.worktreeAdd' && c.nodeId === 'merge'), 'run-дерево для merge создано');

	// Коммит/дифф/ветка узла — ссылки в results, а не сырые логи.
	assert.equal(values.results['a#1.0'].branch, worktrees.get('a#1.0').branch);
	assert.equal(values.results['a#1.0'].commit, 'sha-a#1.0');
	assert.equal(values.results['a#1.0'].diff_stat, ' 1 file changed');
	assert.deepEqual(Object.keys(values.isolations).sort(), ['a#1.0', 'b#1.1']);
});

test('Этап 4.1: без git изоляция выключается, воркер работает в корне (не падает)', async () => {
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'правка', deps: [] }];
	const calls = [];
	let supervisorCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru', emit: () => {},
		invokeTool: async (name, input, nodeId) => {
			calls.push({ name, input, nodeId });
			// Как расширение вне git-репозитория: worktree не создаётся.
			if (name === 'git.worktreeAdd') {
				return { isolated: false, reason: 'not a git repository' };
			}
			return { output: 'ok' };
		},
		runId: 'run-1', workspaceRoot: '/repo', baseCommit: 'base123',
	});
	const values = await runGraph(graph);
	assert.equal(values.results['coder#1.0'].status, 'ok');
	assert.deepEqual(values.isolations, {}, 'изоляции нет — чистить нечего');
	assert.ok(!calls.some(c => c.name === 'git.commitWorktree'), 'без worktree коммит узла не нужен');
});

// ---------- Этап 4.2: самолечение и человек в петле ----------

test('Этап 4.2: сломанный тест → 3 попытки → needs_human и карточка подтверждения', async () => {
	const { MemorySaver } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'почини', deps: [] }];
	let workerCalls = 0;
	let supervisorCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const emitted = [];
	let checkRuns = 0;
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru',
		emit: e => emitted.push(e),
		checks: [{ command: 'npm test', timeoutMs: 1000 }],
		maxFixIterations: 3,
		invokeTool: async (name) => {
			if (name === 'terminal.run') {
				checkRuns += 1;
				return { ok: true, output: 'FAIL src/a.test.ts\n  ✗ делает штуку\n(exit code 1)' };
			}
			return { output: 'ok' };
		},
	}, { checkpointer: new MemorySaver() });
	const cfg = { configurable: { thread_id: 'heal-run' } };

	let last;
	for await (const v of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		last = v;
	}
	assert.equal(workerCalls, 3, 'ровно три попытки правки — без бесконечного цикла');
	assert.equal(checkRuns, 3, 'проверки гоняются после каждой попытки');
	const st = await graph.getState(cfg);
	assert.ok(st.next.includes('escalate'), 'граф остановлен на человеке');
	assert.equal(st.values.results['coder#1.0'].status, 'needs_human');
	const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && e.interrupt.role === 'human');
	assert.ok(banner, 'карточка подтверждения ушла в панель');
	assert.ok(banner.interrupt.title.includes('требует человека'));
	// В резюме — выжимка ошибок, а не сырой лог.
	assert.ok(last.results['coder#1.0'].summary.includes('FAIL src/a.test.ts'), 'ошибка видна в карточке');

	// Решение человека продолжает граф без повторного interrupt.
	let final;
	for await (const v of await graph.stream(new Command({ resume: { approved: false, note: 'разберусь сам' } }), { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	assert.equal(final.itemState['coder#1.0'], 'human-ack', 'узел подтверждён — повтора нет');
});

test('Этап 4.2: прошедшие проверки не трогают лимит и не зовут человека', async () => {
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'сделай', deps: [] }];
	let workerCalls = 0;
	let supervisorCalls = 0;
	let checkRuns = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		workerCalls += 1;
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru',
		checks: [{ command: 'npm test', timeoutMs: 1000 }], maxFixIterations: 3,
		emit: () => {},
		invokeTool: async (name) => {
			if (name === 'terminal.run') {
				checkRuns += 1;
				return { ok: true, output: '1 passing\n(exit code 0)' };
			}
			return { output: 'ok' };
		},
	});
	const values = await runGraph(graph);
	assert.equal(workerCalls, 1, 'одной правки достаточно');
	assert.equal(checkRuns, 1);
	assert.equal(values.results['coder#1.0'].status, 'ok');
	assert.deepEqual(values.itemState, { 'coder#1.0': 'done' });
});

// ---------- Этап 4.3: merge ----------

test('Этап 4.3: конфликт merge поднимает interrupt с файлами, без авто-резолва моделью', async () => {
	const { MemorySaver } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));
	const plan = [
		{ id: 'a#1.0', kind: 'code', goal: 'A', deps: [] },
		{ id: 'b#1.1', kind: 'code', goal: 'B', deps: [] },
	];
	let supervisorCalls = 0;
	const llm = { complete: async (role) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		return { text: 'worker ok', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const emitted = [];
	const calls = [];
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 2, language: 'ru', emit: e => emitted.push(e),
		runId: 'run-9', workspaceRoot: '/repo', baseCommit: 'base1',
		invokeTool: async (name, input) => {
			calls.push({ name, input });
			if (name === 'git.worktreeAdd') return { isolated: true, worktree: input.worktree, branch: input.branch };
			if (name === 'git.commitWorktree') return { commit: 'sha', clean: false };
			if (name === 'git.diffStat') return { diffStat: ' 1 file changed' };
			if (name === 'git.mergeNode') return { ok: false, conflicts: ['src/shared.ts'] };
			if (name === 'git.finalPatch') return { stat: '', files: [] };
			return { output: 'ok' };
		},
	}, { checkpointer: new MemorySaver() });
	const cfg = { configurable: { thread_id: 'merge-run' } };

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до interrupt */ }
	const st = await graph.getState(cfg);
	assert.ok(st.next.includes('mergeGate'), 'граф ждёт решения человека на mergeGate');
	const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && e.interrupt.role === 'merge');
	assert.ok(banner, 'конфликт показан в панели');
	assert.ok(banner.interrupt.title.includes('src/shared.ts'), 'файлы конфликта видны');
	assert.ok(calls.some(c => c.name === 'git.mergeAbort'), 'конфликтный merge откачен, а не авторезолвнут');

	// Решение человека продолжает граф; канал конфликтов очищается.
	let final;
	for await (const v of await graph.stream(new Command({ resume: { approved: false } }), { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	assert.deepEqual(final.mergeConflicts, {}, 'конфликты очищены после решения');
});

// ---------- Этап 4.4: предохранитель ----------

test('Этап 4.4: опасное действие останавливает граф, resume с approved его выполняет', async () => {
	const { MemorySaver } = require(path.join(sidecarSrc, '..', 'node_modules', '@langchain', 'langgraph'));
	const plan = [{ id: 'coder#1.0', kind: 'code', goal: 'поправь конфиг', deps: [] }];
	let supervisorCalls = 0;
	const llm = { complete: async (role, messages) => {
		if (role === 'supervisor') {
			supervisorCalls += 1;
			return supervisorCalls === 1
				? { text: JSON.stringify({ nodes: plan }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' }
				: { text: JSON.stringify({ finish: 'готово' }), toolCalls: [], usedKeyName: 'k', usedTier: 'high' };
		}
		// Первый раунд агентного цикла просит записать .env — это защищённый файл.
		if (messages.length <= 2) {
			return { text: '', toolCalls: [{ id: 't1', name: 'fs.writeFile', input: { path: '.env', content: 'x' } }], usedKeyName: 'k', usedTier: 'low' };
		}
		return { text: 'готово', toolCalls: [], usedKeyName: 'k', usedTier: 'low' };
	}};
	const emitted = [];
	const toolCalls = [];
	const graph = buildOrchestratorGraph({
		llm, tools: [], gate: new Gate(), maxParallelWorkers: 1, language: 'ru', emit: e => emitted.push(e),
		invokeTool: async (name, input) => {
			toolCalls.push({ name, input });
			return { ok: true, output: 'ok' };
		},
	}, { checkpointer: new MemorySaver() });
	const cfg = { configurable: { thread_id: 'guard-run' } };

	for await (const _ of await graph.stream({ task: 'задача', round: 0, results: {}, summary: '' }, { recursionLimit: 200, streamMode: 'values', ...cfg })) { /* до interrupt */ }
	const st = await graph.getState(cfg);
	assert.ok(st.next.includes('worker'), 'граф замер на предохранителе');
	assert.ok(!toolCalls.some(c => c.name === 'fs.writeFile'), 'до подтверждения инструмент не выполнялся');
	const banner = emitted.find(e => e.type === 'interrupt.requested' && e.interrupt && String(e.interrupt.title).includes('секрет'));
	assert.ok(banner, 'карточка предохранителя ушла в панель');

	let final;
	for await (const v of await graph.stream(new Command({ resume: { approved: true, note: 'ок' } }), { recursionLimit: 200, streamMode: 'values', ...cfg })) {
		final = v;
	}
	assert.ok(toolCalls.some(c => c.name === 'fs.writeFile' && c.input.path === '.env'), 'после подтверждения инструмент выполнен');
	assert.equal(final.results['coder#1.0'].status, 'ok');
});

// ---------- Этап 4.5: очистка изоляции (отклонение патча) ----------

test('Этап 4.5: cleanup удаляет worktree узлов и run-дерево', async () => {
	const invocations = [];
	const fakeRpc = {
		notify: () => {},
		request: async (method, params) => { invocations.push(params); return { removed: true }; },
	};
	const orch = new Orchestrator(fakeRpc, {});
	orch.workspaceRoot = '/repo';
	orch.threadId = 'run-x';
	orch.lastSnapshot = {
		isolations: {
			'a#1.0': { worktree: '/repo/.aura/worktrees/run-x/a', branch: 'aura/run-x/a' },
			'b#1.1': { worktree: '/repo/.aura/worktrees/run-x/b', branch: 'aura/run-x/b' },
		},
	};
	const res = await orch.handleCommand('cleanup', {});
	assert.equal(res.cleaned, 3, 'два узла + run-дерево');
	const removals = invocations.filter(p => p.name === 'git.worktreeRemove');
	assert.equal(removals.length, 3);
	assert.ok(removals.some(p => p.input.branch === 'aura/run-x/run'), 'run-ветка тоже удаляется');
	assert.deepEqual(orch.lastSnapshot.isolations, {}, 'состояние очищено');
});
