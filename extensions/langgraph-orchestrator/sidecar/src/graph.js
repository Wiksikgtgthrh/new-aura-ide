'use strict';

const { Annotation, Send, StateGraph, START, END, interrupt } = require('@langchain/langgraph');
// interrupt требует чекпоинтера: buildOrchestratorGraph принимает compileOptions
// (checkpointer) и прокидывает их в compile.
const { runAgentLoop, isInterruptError } = require('./agents');
const { tierFor } = require('./llm');
const { shorten } = require('./notes');
const { worktreePath, nodeBranch, needsIsolation, runWorktreePath, runBranch } = require('./worktrees');
const { parseFailures, checkFailed, fixInstruction } = require('./checks');
const { classifyAction, guardTitle } = require('./guardrails');
const { normalizeLimits, hasRunLimit, runOverLimit, nodeBudgetNote, runBudgetTitle } = require('./budget');

const MAX_SUPERVISOR_ROUNDS = 4;
const ALLOWED_AGENTS = ['coder', 'tester', 'security-auditor', 'reviewer'];
const DEFAULT_MAX_WORKERS = 3;
const DEFAULT_MAX_RETRIES = 2;
const TIERS = ['high', 'mid', 'low'];
const DEFAULT_VERIFY_COMMAND = 'npm test';
/** Жёсткий лимит правка→проверка внутри воркера (Этап 4.2), если настройки нет. */
const DEFAULT_MAX_FIX = 3;

/**
 * kind подзадачи → агент. kind описывает тип работы, роль выводится из него:
 * план говорит «что делать», а не «кого звать».
 */
const KIND_ROLES = {
	search: 'coder',
	boilerplate: 'coder',
	code: 'coder',
	test: 'tester',
	review: 'reviewer',
	security: 'security-auditor',
};
/** Механическая работа всегда на дешёвом тире, что бы ни сказал супервизор. */
const LOW_KINDS = new Set(['search', 'boilerplate']);
const DEFAULT_KIND = 'code';
/** Обратный маппинг для старых планов, где был только agent. */
const AGENT_KINDS = { coder: 'code', tester: 'test', 'security-auditor': 'security', reviewer: 'review' };

/** Сводка результата: столько строк человек реально читает в карточке. */
const SUMMARY_MAX_LINES = 5;
const SUMMARY_MAX_CHARS = 600;
/** Сырой ответ воркера — транзитный; ограничиваем его, чтобы чекпоинт не пух. */
const RAW_MAX_CHARS = 4000;

/**
 * Каналы стейта оркестратора. results/raw/itemState/attempts — merge-редьюсеры:
 * параллельные воркеры пишут в них одновременно, не затирая друг друга.
 * raw очищается ссылкой на null (merge-редьюсер понимает это как удаление),
 * поэтому к моменту финиша в state остаются только резюме и ссылки.
 */
const OrchestratorState = Annotation.Root({
	task: Annotation({ reducer: (_a, b) => b, default: () => '' }),
	round: Annotation({ reducer: (_a, b) => b, default: () => 0 }),
	/** DAG раунда: nodes[{id, goal, deps[], tier, kind, files_hint[], agent, confirm}] */
	plan: Annotation({ reducer: (_a, b) => b, default: () => [] }),
	/** Непустой `finish` супервизора: план сохраняем для панели, а маршрут решаем здесь. */
	planDone: Annotation({ reducer: (_a, b) => b, default: () => '' }),
	/**
	 * node_id -> {status, summary, diff_stat, commit, tokens, cost}.
	 * Запись null удаляет результат: так перезапуск ноды возвращает её в очередь.
	 */
	results: Annotation({
		reducer: (a, b) => {
			const out = { ...a };
			for (const [key, value] of Object.entries(b || {})) {
				if (value === null) {
					delete out[key];
				} else {
					out[key] = value;
				}
			}
			return out;
		},
		default: () => ({}),
	}),
	/** node_id -> сырой ответ воркера (transient, сжимается reducer'ом). */
	raw: Annotation({
		reducer: (a, b) => {
			const out = { ...a };
			for (const [key, value] of Object.entries(b || {})) {
				if (value === null) {
					delete out[key];
				} else {
					out[key] = value;
				}
			}
			return out;
		},
		default: () => ({}),
	}),
	/** Расход запуска: токены и (когда известна) стоимость. */
	budget: Annotation({
		reducer: (a, b) => ({
			tokens: (a.tokens || 0) + (b.tokens || 0),
			cost: (a.cost || 0) + (b.cost || 0),
		}),
		default: () => ({ tokens: 0, cost: 0 }),
	}),
	/** [{node, message}] — короткие ошибки, не логи. */
	errors: Annotation({ reducer: (a, b) => [...a, ...b], default: () => [] }),
	summary: Annotation({ reducer: (_a, b) => b, default: () => '' }),
	/** Подзадачи, ещё не отправленные воркерам. */
	queue: Annotation({ reducer: (_a, b) => b, default: () => [] }),
	/** Пачка, отправленная воркерам на этом шаге; пустая — очередь исчерпана. */
	batch: Annotation({ reducer: (_a, b) => b, default: () => [] }),
	/** Жизненный цикл подзадач: dispatched → done/failed/denied/skipped. */
	itemState: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
	/** Сколько раз подзадача перезапускалась после провала верификации. */
	attempts: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
	/** node_id -> {worktree, branch}: изоляция узлов для merge и очистки (Этап 4.1). */
	isolations: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
	/** node_id -> true: ветка узла уже влита в run-ветку (Этап 4.3). */
	merged: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
	/** Путь рабочего дерева run-ветки (merge-фаза). */
	runWorktree: Annotation({ reducer: (_a, b) => b, default: () => '' }),
	/** Конфликты merge: node_id -> файлы. Заменяется целиком, а не мержится. */
	mergeConflicts: Annotation({ reducer: (_a, b) => b, default: () => ({}) }),
	/** Бюджет запуска уже подтверждён человеком: повторно interrupt не поднимаем. */
	budgetAck: Annotation({ reducer: (_a, b) => b, default: () => false }),
	/** Запуск остановлен по бюджету (человек не разрешил продолжать). */
	budgetHalt: Annotation({ reducer: (_a, b) => b, default: () => false }),
});

/** Роль агента по типу работы. */
function roleForKind(kind) {
	return KIND_ROLES[kind] || 'coder';
}

/** Тир подзадачи: сначала принудительно дешёвые kind, потом хинт, потом роль. */
function tierForNode(node) {
	if (node && LOW_KINDS.has(node.kind)) {
		return 'low';
	}
	if (node && TIERS.includes(node.tier)) {
		return node.tier;
	}
	return tierFor((node && node.agent) || 'coder');
}

/** Дедупликация id плана: коллизия id склеила бы разные подзадачи. */
function dedupeIds(nodes) {
	const seen = new Set();
	return nodes.map(node => {
		let id = node.id;
		while (seen.has(id)) {
			id = `${node.id}~${seen.size}`;
		}
		seen.add(id);
		return { ...node, id };
	});
}

/**
 * Нормализует выход планировщика в DAG-узлы. Принимает и новый контракт
 * (id/goal/deps/kind), и старые delegates (agent/instruction/dependsOn) —
 * чтобы mock-режим и ранее сохранённые планы не ломались.
 */
function normalizePlan(items, round) {
	const source = Array.isArray(items) ? items : [];
	const prepared = source.map((item, idx) => {
		const agent = ALLOWED_AGENTS.includes(item && item.agent) ? item.agent : null;
		const kind = item && typeof item.kind === 'string' && KIND_ROLES[item.kind]
			? item.kind
			: (agent ? AGENT_KINDS[agent] : DEFAULT_KIND);
		const id = String((item && (item.id || item.key)) || `${agent || roleForKind(kind)}#${round}.${idx}`);
		const tier = TIERS.includes(item && item.tier)
			? item.tier
			: (TIERS.includes(item && item.tierOverride) ? item.tierOverride : undefined);
		return {
			id,
			goal: String((item && (item.goal || item.instruction)) || '').trim(),
			deps: Array.isArray(item && item.deps) ? item.deps.slice() : (Array.isArray(item && item.dependsOn) ? item.dependsOn.slice() : []),
			tier,
			kind,
			files_hint: Array.isArray(item && item.files_hint) ? item.files_hint.filter(f => typeof f === 'string') : [],
			agent: agent || roleForKind(kind),
			round,
			confirm: !!(item && item.confirm === true),
		};
	}).filter(node => node.goal !== '');

	const nodes = dedupeIds(prepared);
	const byId = new Set(nodes.map(node => node.id));
	for (const node of nodes) {
		const resolved = [];
		for (const dep of node.deps) {
			const id = typeof dep === 'number' ? (nodes[dep] ? nodes[dep].id : '') : String(dep);
			if (id && byId.has(id) && id !== node.id && !resolved.includes(id)) {
				resolved.push(id);
			}
		}
		node.deps = resolved;
	}
	return nodes;
}

/** Подзадачи, готовые к запуску: зависимости закрыты результатами. */
function readyItems(queue, results) {
	return queue.filter(item => (item.deps || []).every(dep => Boolean(results[dep])));
}

/** Человекочитаемый запрос подтверждения рискованной подзадачи — для карточки панели. */
function formatConfirmPrompt(item, language = 'ru') {
	const head = language === 'en'
		? `The orchestrator paused before a risky subtask (${item.agent}).`
		: `Оркестратор остановился перед рискованной подзадачей (${item.agent}).`;
	return `${head}\n${item.goal || item.instruction || ''}`;
}

/** Один результат — в строку для промпта супервизора. */
function formatResult(value) {
	if (!value || typeof value !== 'object') {
		return String(value == null ? '' : value);
	}
	const commit = value.commit ? ` @${value.commit}` : '';
	return `[${value.status}] ${value.summary || ''}${commit}`;
}

/** Сжатие вывода воркера: не больше SUMMARY_MAX_LINES строк и ограничение длины. */
function summarize(text, maxLines = SUMMARY_MAX_LINES) {
	const lines = String(text == null ? '' : text)
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
	const head = lines.slice(0, maxLines).join('\n');
	const withEllipsis = lines.length > maxLines ? `${head}\n…` : head;
	return withEllipsis.length > SUMMARY_MAX_CHARS
		? `${withEllipsis.slice(0, SUMMARY_MAX_CHARS - 1)}…`
		: withEllipsis;
}

/** Строка-инструкция на ретрай планировщика после невалидного JSON. */
function plannerRetryPrompt(language) {
	return language === 'English'
		? 'Your previous answer was not valid JSON matching the schema. Answer with ONE JSON object only, no prose, no code fences: {"nodes":[{"id":"string","goal":"string","deps":["id"],"tier":"low|mid|high","kind":"search|boilerplate|code|test|review|security","files_hint":["path"]}]} or {"finish":"<final summary>"}.'
		: 'Твой предыдущий ответ — не валидный JSON по схеме. Ответь ОДНИМ JSON-объектом, без прозы и без блоков кода: {"nodes":[{"id":"строка","goal":"строка","deps":["id"],"tier":"low|mid|high","kind":"search|boilerplate|code|test|review|security","files_hint":["путь"]}]} либо {"finish":"<итоговое резюме>"}.';
}

/**
 * Разбор ответа планировщика. Возвращает {nodes, finish, invalid}:
 * invalid=true — ответ не соответствует схеме, вызывающий делает один ретрай.
 * Лимит раундов превращает план в принудительный finish.
 */
function parseDecision(text, state, language = 'Russian') {
	const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
	let parsed = null;
	if (jsonMatch) {
		try {
			parsed = JSON.parse(jsonMatch[0]);
		} catch {
			parsed = null;
		}
	}
	if (parsed) {
		if (typeof parsed.finish === 'string' && parsed.finish.trim()) {
			return { nodes: [], finish: parsed.finish, invalid: false };
		}
		const items = Array.isArray(parsed.nodes) ? parsed.nodes : (Array.isArray(parsed.delegates) ? parsed.delegates : []);
		const nodes = normalizePlan(items, (state.round || 0) + 1);
		if (nodes.length) {
			if ((state.round || 0) + 1 >= MAX_SUPERVISOR_ROUNDS) {
				return {
					nodes: [],
					finish: language === 'English'
						? 'Supervisor round limit reached: finishing with the results at hand.'
						: 'Лимит раундов супервизора: завершаю с текущими результатами.',
					invalid: false,
				};
			}
			return { nodes, finish: '', invalid: false };
		}
	}
	return { nodes: [], finish: '', invalid: true };
}

/** Что делать, если планировщик так и не выдал валидный план (после ретрая). */
function fallbackDecision(text, state, language = 'Russian') {
	if (!state.results || Object.keys(state.results).length === 0) {
		return {
			nodes: normalizePlan([{ agent: 'coder', goal: state.task, kind: 'code' }], (state.round || 0) + 1),
			finish: '',
			invalid: true,
		};
	}
	const head = language === 'English'
		? 'The supervisor could not produce a decision. Model answer: '
		: 'Супервизор не смог сформировать решение. Ответ модели: ';
	return { nodes: [], finish: `${head}${String(text || '').slice(0, 500)}`, invalid: true };
}

/**
 * Граф оркестратора: планировщик строит DAG-раунд, router делает fan-out
 * готовых узлов через Send, worker выполняет один узел, reducer сжимает его
 * сырой вывод в структурированный результат, verify самозалечивает провалы,
 * join решает — продолжить router'ом или вернуться к планировщику (merge).
 *
 * Барьерная семантика суперстепов здесь принципиальна: reducer/verify/join
 * вызываются только после завершения всех веток предыдущей пачки, поэтому
 * решения принимаются по полным результатам, а не по в полёте.
 */
function buildOrchestratorGraph(deps, compileOptions) {
	const { llm, tools, invokeTool, emit, gate, maxParallelWorkers, maxVerifyRetries, language, verifyCommand } = deps;
	// Изоляция воркеров (Этап 4.1): runId/workspaceRoot/baseCommit приходят из start().
	const runId = deps.runId || '';
	const workspaceRoot = deps.workspaceRoot || '';
	const baseCommit = deps.baseCommit || '';
	// Петля самолечения (Этап 4.2): команды проверок и жёсткий лимит итераций.
	const checks = Array.isArray(deps.checks) ? deps.checks : [];
	const fixIterations = Math.max(1, Number(deps.maxFixIterations) || DEFAULT_MAX_FIX);
	const collectDiff = typeof deps.collectDiff === 'function' ? deps.collectDiff : async () => ({});
	const inLanguage = language === 'en' ? 'English' : 'Russian';
	// Бюджет (Этап 5.1): лимиты узла/запуска. Цены и стоимость считает host.
	const budgetLimits = normalizeLimits(deps.budget);
	// Трейсинг (Этап 5.2): спаны нод и вызовов модели. Без tracer граф работает как прежде.
	const tracer = deps.tracer || null;
	const maxWorkers = Math.max(1, maxParallelWorkers || DEFAULT_MAX_WORKERS);
	const retriesLimit = Math.max(0, maxVerifyRetries === undefined ? DEFAULT_MAX_RETRIES : maxVerifyRetries);

	/** planner (tier high): DAG со строгой JSON-схемой и одним ретраем. */
	const supervisor = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const round = (state.round || 0) + 1;
		emit({ type: 'node.started', node: { id: 'supervisor', role: 'supervisor', status: 'running', tier: 'high', round, startedAt: Date.now() } });
		const supervisorSpan = tracer ? tracer.start('supervisor', { kind: 'node', node: 'supervisor', role: 'supervisor', tier: 'high', round }) : null;

		const resultsText = Object.entries(state.results || {})
			.map(([id, value]) => `## ${id}\n${formatResult(value)}`)
			.join('\n\n') || '(пока нет результатов)';
		const messages = [
			{
				role: 'system',
				content: [
					'You are the SUPERVISOR (planner) of a coding agent team in an IDE.',
					'Build a dependency DAG of subtasks and answer STRICTLY with one JSON object, no prose:',
					'{"nodes":[{"id":"string","goal":"<what to do>","deps":["<id of a node that must finish first>"],"tier":"low|mid|high","kind":"search|boilerplate|code|test|review|security","files_hint":["path"]}]}',
					`or {"finish":"<final summary in ${inLanguage}>"} when the task is complete.`,
					'kind drives the agent: code→coder, test→tester, review→reviewer, security→security-auditor; search/boilerplate are forced onto the cheap tier.',
					'deps are ids of nodes of THIS round. Nodes without deps run in parallel.',
					'Give stable short ids (e.g. "coder#1.0") so results stay traceable.',
					'summaries you write must stay short and in the user language.',
					'Do not re-delegate what already has results.',
				].join('\n'),
			},
			{ role: 'user', content: `Task: ${state.task}\n\nRound: ${round}/${MAX_SUPERVISOR_ROUNDS}\n\nResults so far:\n${resultsText}` },
		];

		let response = await llm.complete('supervisor', messages, []);
		let decision = parseDecision(response.text, state, inLanguage);
		if (decision.invalid) {
			// Валидация схемы + ровно один ретрай: чиним формат, а не задачу.
			emit({ type: 'log', message: 'planner: невалидный JSON плана — один ретрай' });
			messages.push({ role: 'assistant', content: String(response.text || '') });
			messages.push({ role: 'user', content: plannerRetryPrompt(inLanguage) });
			response = await llm.complete('supervisor', messages, []);
			decision = parseDecision(response.text, state, inLanguage);
		}
		if (decision.invalid) {
			decision = fallbackDecision(response.text, state, inLanguage);
		}
		const plan = decision.nodes;
		for (const item of plan) {
			emit({
				type: 'node.queued',
				node: {
					id: item.id, role: item.agent, status: 'idle', tier: tierForNode(item),
					round, kind: item.kind, note: shorten(item.goal),
					filesHint: item.files_hint,
				},
			});
		}
		emit({
			type: 'node.finished',
			node: { id: 'supervisor', role: 'supervisor', status: 'done', tier: 'high', keyName: response.usedKeyName, round, finishedAt: Date.now() },
			run: { round, planned: plan.length },
			message: decision.finish
				? 'supervisor: финальное решение'
				: `supervisor: раунд ${round} — план из ${plan.length} задач (DAG)`,
		});
		if (supervisorSpan) {
			supervisorSpan.end({ status: 'ok' });
		}
		// План не стираем на финальном решении: панели нужен последний непустой DAG.
		// Маршрут при этом зависит от planDone, а не от пустоты плана.
		return {
			round,
			plan: plan.length > 0 ? plan : (state.plan || []),
			planDone: decision.finish || '',
			queue: plan,
			summary: decision.finish || state.summary || '',
		};
	};

	const routeFromSupervisor = (state) => {
		if (state.planDone) {
			return 'deliver';
		}
		return Array.isArray(state.plan) && state.plan.length > 0 ? 'router' : 'deliver';
	};

	/**
	 * router: собирает пачку готовых узлов (deps закрыты, лимит параллелизма)
	 * и делает fan-out через Send. Рискованных узлов в пачке не больше одного:
	 * каждый останавливает граф своим interrupt, и две паузы запутали бы
	 * подтверждения. Если готовых нет, а очередь не пуста — deps закольцованы
	 * планом: снимаем блокировку, запуская очередь без ожидания.
	 */
	const router = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const queue = Array.isArray(state.queue) ? state.queue : [];
		if (queue.length === 0) {
			return { batch: [] };
		}
		const results = state.results || {};
		let ready = readyItems(queue, results);
		// Узлы с незакрытыми deps остаются в очереди — они не теряются,
		// а ждут следующего прохода router'а после fan-in барьера.
		let blocked = queue.filter(item => !ready.includes(item));
		if (ready.length === 0) {
			emit({ type: 'log', message: 'зависимости плана закольцованы — запускаю очередь без ожидания' });
			ready = queue.slice();
			blocked = [];
		}
		const batch = [];
		const deferred = [];
		let riskyTaken = false;
		for (const item of ready) {
			if (item.confirm && !riskyTaken) {
				riskyTaken = true;
				batch.push(item);
			} else if (item.confirm) {
				deferred.push(item);
			} else if (batch.length < maxWorkers) {
				batch.push(item);
			} else {
				deferred.push(item);
			}
		}
		const queued = [...deferred, ...blocked];
		if (queued.length) {
			emit({ type: 'log', message: `в очереди осталось ${queued.length}` });
		}
		return {
			batch,
			queue: queued,
			itemState: Object.fromEntries(batch.map(item => [item.id, 'dispatched'])),
		};
	};

	const routeFromRouter = (state) => {
		const batch = Array.isArray(state.batch) ? state.batch : [];
		if (batch.length === 0) {
			return 'join';
		}
		return batch.map(item => new Send('worker', { ...state, assignment: item }));
	};

	const worker = async (state) => {
		const assignment = state.assignment;
		const role = assignment.agent;
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const tier = tierForNode(assignment);
		if (gate.nodeAborted(assignment.id)) {
			emit({ type: 'node.error', node: { id: assignment.id, role, status: 'skipped', note: 'отменён вручную', finishedAt: Date.now() } });
			return { raw: { [assignment.id]: { text: 'SKIPPED: отменён вручную', status: 'skipped' } }, itemState: { [assignment.id]: 'skipped' } };
		}

		// Рискованная подзадача: граф останавливается до решения пользователя.
		// На resume нода продолжится с этого места с ответом в answer.
		if (assignment.confirm) {
			emit({
				type: 'node.started',
				node: {
					id: assignment.id, role, status: 'waiting-approval', tier,
					round: assignment.round, startedAt: Date.now(), note: shorten(assignment.goal),
				},
			});
			// Событие наружу до заморозки: воркер на interrupt не может ничего послать.
			emit({
				type: 'interrupt.requested',
				message: `требуется подтверждение: ${shorten(assignment.goal, 80)}`,
				interrupt: { node: assignment.id, role, title: formatConfirmPrompt(assignment, language) },
			});
			const answer = interrupt({
				node: assignment.id,
				role,
				instruction: assignment.goal,
				title: formatConfirmPrompt(assignment, language),
			});
			if (!answer || answer.approved !== true) {
				emit({ type: 'log', message: `отклонено пользователем: ${assignment.id}` });
				emit({ type: 'node.error', node: { id: assignment.id, role, status: 'skipped', note: 'отклонено пользователем', finishedAt: Date.now() } });
				return { raw: { [assignment.id]: { text: 'DENIED: пользователь отклонил выполнение подзадачи', status: 'denied' } }, itemState: { [assignment.id]: 'denied' } };
			}
			emit({ type: 'log', message: `подтверждено пользователем: ${assignment.id}` });
		}

		// Изоляция (Этап 4.1): узел работает в своём worktree на своей ветке.
		// Без git/для read-only kind — откат к корню workspace, запуск не падает.
		const iso = await prepareIsolation(assignment);
		if (iso.isolated) {
			emit({ type: 'node.note', node: { id: assignment.id, role, status: 'running', note: `worktree: ${iso.branch}` } });
		}

		emit({
			type: 'node.started',
			node: {
				id: assignment.id, role, status: 'running', tier,
				round: assignment.round, startedAt: Date.now(),
				note: assignment.isRetry ? `ретрай: ${shorten(assignment.goal)}` : shorten(assignment.goal),
			},
		});
		// Спан узла (Этап 5.2): открывается перед работой, закрывается с расходом.
		const nodeSpan = tracer ? tracer.start('worker', { kind: 'node', node: assignment.id, role, tier, round: assignment.round }) : null;
		try {
			// Базовые инструкции узла: правка и — при провале проверок — ретраи.
			const baseInstruction = `${assignment.goal}\n\nКонтекст задачи: ${state.task}`;
			const runOnce = (instruction) => runAgentLoop({
				role,
				instruction,
				tools,
				llm,
				// Инструменты узла исполняются в его worktree: fs/terminal видят изоляцию.
				// Предохранитель (Этап 4.4): опасные действия — только через interrupt.
				invokeTool: async (name, input, nodeId) => {
					const risk = classifyAction(name, input);
					if (risk.risky) {
						const title = shorten(guardTitle(risk, language), 300);
						emit({ type: 'interrupt.requested', message: `предохранитель: ${risk.reason}`, interrupt: { node: assignment.id, role, title } });
						const answer = interrupt({ node: assignment.id, role, action: name, target: risk.target, reason: risk.reason, title });
						if (!answer || answer.approved !== true) {
							emit({ type: 'log', message: `предохранитель отклонил ${name}: ${risk.reason}` });
							return { ok: false, denied: true, output: `denied by guardrail: ${risk.reason}` };
						}
						emit({ type: 'log', message: `предохранитель разрешил ${name}${answer.note ? ` (заметка: ${answer.note})` : ''}` });
					}
					return invokeTool(name, { ...input, cwd: iso.cwd }, nodeId);
				},
				nodeId: assignment.id,
				tierOverride: assignment.tier,
				// Бюджет узла: лимит проверяется после каждого ответа модели.
				tokenLimit: budgetLimits.nodeTokens,
				costLimit: budgetLimits.nodeCost,
				shouldAbort: () => gate.aborted() || gate.nodeAborted(assignment.id),
				onText: () => {},
				onNote: note => emit({ type: 'node.note', node: { id: assignment.id, role, status: 'running', note } }),
				onKey: info => emit({
					type: 'node.note',
					node: { id: assignment.id, role, keyName: info.usedKeyName, tier: safeTier(info.usedTier, role) },
				}),
				tracer,
			});

			let result = await runOnce(baseInstruction);
			// Петля самолечения (Этап 4.2): правка → проверки → ретрай, с жёстким лимитом.
			const fix = await selfHeal(assignment, iso, baseInstruction, runOnce, result);
			result = fix.result;
			// Бюджет узла (Этап 5.1): перерасход останавливает узел и уходит человеку.
			const overBudget = Boolean(result.budgetExceeded);
			const committed = await commitIsolation(iso, assignment);
			const needsHuman = fix.needsHuman || overBudget;
			const status = needsHuman ? 'needs_human' : 'done';
			const note = overBudget
				? `лимит бюджета узла (${nodeBudgetNote(budgetLimits, { tokens: result.tokens, cost: result.costUsd })})`
				: fix.needsHuman
					? `нужен человек (${fix.attempts} попыток)`
					: (iso.isolated ? `готово · ${iso.branch}` : 'готово');
			emit({
				type: needsHuman ? 'node.error' : 'node.finished',
				node: {
					id: assignment.id, role, status, finishedAt: Date.now(),
					note,
					error: overBudget
						? `израсходовано ${result.tokens || 0} токенов / $${Number(result.costUsd || 0).toFixed(4)}`
						: fix.needsHuman ? shorten(fix.excerpt, 200) : undefined,
				},
				message: overBudget
					? `${role}: остановлен лимитом бюджета узла`
					: fix.needsHuman
						? `${role}: проверки не прошли за ${fix.attempts} попыток`
						: `${role}: готово`,
			});
			if (nodeSpan) {
				nodeSpan.end({
					status, tokens: result.tokens || 0,
					tokensIn: result.inputTokens || 0, tokensOut: result.outputTokens || 0,
					cost: result.costUsd || 0,
					// Число повторных попыток самолечения — для колонки retries в Trace.
					retries: Math.max(0, (fix.attempts || 1) - 1),
				});
			}
			return {
				raw: {
					[assignment.id]: {
						// При провале проверок в резюме идёт выжимка ошибок, а не текст модели;
						// при перерасходе — сколько именно истрачено.
						text: overBudget
							? `ЛИМИТ БЮДЖЕТА УЗЛА: израсходовано ${result.tokens || 0} токенов / $${Number(result.costUsd || 0).toFixed(4)}`
							: fix.needsHuman ? `ПРОВЕРКИ НЕ ПРОШЛИ:\n${fix.excerpt}` : limitedRaw(result.text),
						status,
						reason: overBudget ? 'budget' : (fix.needsHuman ? 'checks' : ''),
						tokens: result.tokens || 0,
						inputTokens: result.inputTokens || 0,
						outputTokens: result.outputTokens || 0,
						cost: result.costUsd || 0,
						branch: committed.branch, commit: committed.commit, diff_stat: committed.diffStat,
						worktree: iso.worktree, isolated: iso.isolated,
					},
				},
				itemState: { [assignment.id]: status },
				isolations: iso.isolated ? { [assignment.id]: { worktree: iso.worktree, branch: iso.branch } } : {},
			};
		} catch (err) {
			// interrupt() из воркера/предохранителя — не провал узла: пробрасываем,
			// чтобы граф замер на чекпоинте, а resume продолжил с этого места.
			if (isInterruptError(err)) {
				if (nodeSpan) {
					nodeSpan.end({ status: 'interrupted' });
				}
				throw err;
			}
			const message = err instanceof Error ? err.message : String(err);
			const cancelled = gate.nodeAborted(assignment.id) || /aborted|cancelled/i.test(message);
			emit({
				type: 'node.error',
				node: {
					id: assignment.id, role, finishedAt: Date.now(),
					status: cancelled ? 'skipped' : 'error',
					error: cancelled ? undefined : message,
					note: cancelled ? 'остановлен' : undefined,
				},
			});
			if (nodeSpan) {
				nodeSpan.end({ status: cancelled ? 'skipped' : 'error', error: cancelled ? '' : message });
			}
			return {
				raw: {
					[assignment.id]: {
						text: `${cancelled ? 'CANCELLED' : 'ERROR'}: ${message}`,
						status: cancelled ? 'skipped' : 'failed',
						error: message,
						branch: iso.branch, worktree: iso.worktree, isolated: iso.isolated,
					},
				},
				itemState: { [assignment.id]: cancelled ? 'skipped' : 'failed' },
				isolations: iso.isolated ? { [assignment.id]: { worktree: iso.worktree, branch: iso.branch } } : {},
			};
		}
	};

	/**
	 * reducer: единственное место, где воркерский вывод попадает в results.
	 * Превращает сырой текст в {status, summary, diff_stat, commit, tokens, cost},
	 * копит budget/errors и — главное — стирает сырой канал, чтобы в state
	 * не оставалось логов и полных файлов. Партия сжимается разом: diff --stat
	 * и коммит одного прохода одинаковы для всех её узлов.
	 */
	const reducer = async (state) => {
		const raw = state.raw || {};
		const ids = Object.keys(raw);
		if (ids.length === 0) {
			return {};
		}
		let diff = {};
		try {
			diff = (await collectDiff()) || {};
		} catch (err) {
			emit({ type: 'log', message: `reducer: git-инфо недоступна — ${err instanceof Error ? err.message : String(err)}` });
		}
		const diffStat = typeof diff.diff_stat === 'string' ? diff.diff_stat : '';
		const commit = typeof diff.commit === 'string' ? diff.commit : '';
		const results = { ...(state.results || {}) };
		const itemState = { ...(state.itemState || {}) };
		const errors = [];
		const clear = {};
		let tokens = 0;
		let cost = 0;
		for (const id of ids) {
			const entry = raw[id] && typeof raw[id] === 'object' ? raw[id] : { text: raw[id], status: 'done' };
			const status = entry.status || 'done';
			const summary = summarize(entry.text);
			const entryTokens = Number(entry.tokens) || 0;
			const entryCost = Number(entry.cost) || 0;
			tokens += entryTokens;
			cost += entryCost;
			results[id] = {
				status: status === 'done' ? 'ok' : status,
				summary,
				// Ссылки узла (из его worktree) важнее общей git-инфо документа:
				// без изоляции entry.* пусты и берётся diffStat/commit хоста.
				diff_stat: entry.diff_stat || diffStat,
				commit: entry.commit || commit,
				branch: entry.branch || '',
				worktree: entry.worktree || '',
				tokens: entryTokens,
				inputTokens: Number(entry.inputTokens) || 0,
				outputTokens: Number(entry.outputTokens) || 0,
				cost: entryCost,
				// Причина остановки: budget | checks — нужна escalate для точного заголовка.
				reason: entry.reason || '',
			};
			itemState[id] = status;
			if (status !== 'done') {
				errors.push({ node: id, message: entry.error ? String(entry.error) : summary });
			}
			clear[id] = null;
		}
		emit({ type: 'log', message: `reducer: сжал ${ids.length} результат(ов)` });
		return { results, itemState, errors, raw: clear, budget: { tokens, cost } };
	};

	/**
	 * Evaluator-optimizer после каждой пачки. Без verifyCommand — прежняя
	 * эвристика по статусу результата. С verifyCommand — реальная проверка:
	 * команда гоняется в терминале расширения один раз на пачку, и её вывод
	 * подмешивается в ретрай-инструкцию воркера — он чинит по фактической ошибке,
	 * а не вслепую. Проверяется вся пачка разом: worker → reducer → verify стоит
	 * за fan-in барьером и видит все результаты суперстепа.
	 */
	const verify = async (state) => {
		const results = { ...(state.results || {}) };
		const attempts = { ...(state.attempts || {}) };
		const itemState = { ...(state.itemState || {}) };
		const requeued = [];
		let checkOutput;
		for (const item of state.plan || []) {
			const result = results[item.id];
			if (!result || result.status !== 'failed') {
				continue;
			}
			const tried = attempts[item.id] || 0;
			if (tried >= retriesLimit) {
				emit({
					type: 'node.error',
					node: { id: `verify:${item.id}`, role: 'verify', status: 'error', error: 'лимит ретраев исчерпан', finishedAt: Date.now() },
					message: `verify: ${item.id} не починился за ${tried} из ${retriesLimit} попыток`,
				});
				continue;
			}
			// Реальная проверка — один раз на пачку, перед первым ретраем: все
			// воркеры пачки получают один и тот же свежий вывод проверки.
			if (verifyCommand && checkOutput === undefined) {
				checkOutput = await runVerifyCommand();
			}
			attempts[item.id] = tried + 1;
			delete results[item.id];
			itemState[item.id] = 'queued';
			const failNote = shorten(result.summary, 120);
			const checkNote = checkOutput ? shorten(checkOutput, 200) : '';
			requeued.push({
				...item,
				isRetry: true,
				goal: [
					item.goal,
					`ПРЕДЫДУЩАЯ ПОПЫТКА ПРОВАЛИЛАСЬ: ${failNote}`,
					checkNote ? `Вывод проверки («${verifyCommand}»):\n${checkNote}` : '',
					'Исправь причину провала и повтори задачу целиком.',
				].filter(Boolean).join('\n'),
			});
			emit({
				type: 'node.note',
				node: { id: `verify:${item.id}`, role: 'verify', status: 'running', note: `ретрай ${tried + 1}/${retriesLimit}: ${shorten(result.summary, 60)}` },
				message: `verify: перезапускаю ${item.id} (${tried + 1}/${retriesLimit})`,
			});
		}
		if (requeued.length === 0) {
			return {};
		}
		return { results, attempts, itemState, queue: [...requeued, ...(state.queue || [])] };
	};

	/** Прогон проверки верификации: ошибка не роняет граф — отсутствие
	 * проверяющей команды лишь лишает ретрай контекста. */
	async function runVerifyCommand() {
		emit({ type: 'log', message: `verify: запускаю проверку «${verifyCommand}»` });
		try {
			const res = await invokeTool('terminal.run', { command: verifyCommand }, 'verify');
			return res && res.output !== undefined ? String(res.output) : String(res ?? '');
		} catch (err) {
			emit({ type: 'log', message: `verify: проверка не выполнилась — ${err instanceof Error ? err.message : String(err)}` });
			return '';
		}
	}

	/**
	 * Изоляция узла (Этап 4.1): готовит своё рабочее дерево на своей ветке.
	 * read-only kind (search/review/security) в изоляции не нуждается — они
	 * ничего не пишут. Нет git/workspaceRoot — тихо работаем в корне.
	 */
	async function prepareIsolation(assignment) {
		if (!workspaceRoot || !runId || !needsIsolation(assignment)) {
			return { cwd: workspaceRoot, branch: '', worktree: '', isolated: false };
		}
		const plannedWorktree = worktreePath(workspaceRoot, runId, assignment.id);
		const plannedBranch = nodeBranch(runId, assignment.id);
		try {
			// Путь/ветку считает сайдкар (worktrees.js): расширение только исполняет git.
			const res = await invokeTool('git.worktreeAdd', { worktree: plannedWorktree, branch: plannedBranch, baseCommit }, assignment.id);
			if (!res || res.isolated === false) {
				return { cwd: workspaceRoot, branch: '', worktree: '', isolated: false };
			}
			return { cwd: plannedWorktree, branch: plannedBranch, worktree: plannedWorktree, isolated: true };
		} catch (err) {
			emit({ type: 'log', message: `изоляция недоступна (${assignment.id}): ${err instanceof Error ? err.message : String(err)}` });
			return { cwd: workspaceRoot, branch: '', worktree: '', isolated: false };
		}
	}

	/**
	 * Фиксация правок узла на его ветке: без коммита merge-фазе нечего вливать.
	 * Ссылки (branch/commit/diff_stat) возвращаются в raw — их сжимает reducer.
	 */
	async function commitIsolation(iso, assignment) {
		if (!iso.isolated) {
			return { branch: '', commit: '', diffStat: '' };
		}
		let commit = '';
		try {
			const res = await invokeTool('git.commitWorktree', { cwd: iso.cwd, message: `${assignment.id}: ${shorten(assignment.goal, 100)}` }, assignment.id);
			commit = (res && res.commit) || '';
		} catch (err) {
			emit({ type: 'log', message: `коммит узла не удался (${assignment.id}): ${err instanceof Error ? err.message : String(err)}` });
		}
		let diffStat = '';
		try {
			const res = await invokeTool('git.diffStat', { cwd: iso.cwd, from: baseCommit, to: iso.branch }, assignment.id);
			diffStat = (res && res.diffStat) || '';
		} catch {
			// Ссылка на дифф необязательна: без git останется пустой строкой.
		}
		return { branch: iso.branch, commit, diffStat };
	}

	/**
	 * Петля самолечения (Этап 4.2): прогоняет проверки проекта в worktree узла
	 * и, пока они падают, возвращает воркеру ТОЛЬКО первые строки ошибок и имена
	 * упавших тестов. Жёсткий лимит fixIterations: после него — needs_human.
	 */
	async function selfHeal(assignment, iso, baseInstruction, runOnce, firstResult) {
		// Перерасход бюджета отменяет и проверки, и дальнейшие правки: узел уже
		// остановлен, тратить ещё нельзя — выходим сразу, не гоняя команды проверок.
		if (firstResult.budgetExceeded) {
			return { needsHuman: false, excerpt: '', tests: [], attempts: 1, result: firstResult };
		}
		if (checks.length === 0) {
			return { needsHuman: false, excerpt: '', tests: [], attempts: 1, result: firstResult };
		}
		let result = firstResult;
		let failure = await runChecks(assignment, iso);
		let attempt = 1;
		while (failure && attempt < fixIterations) {
			attempt += 1;
			emit({
				type: 'node.note',
				node: { id: assignment.id, role: assignment.agent, status: 'running', note: `проверки упали — правка ${attempt}/${fixIterations}` },
			});
			result = await runOnce(fixInstruction(baseInstruction, failure, attempt, fixIterations));
			if (result.budgetExceeded) {
				return { needsHuman: false, excerpt: '', tests: [], attempts: attempt, result };
			}
			failure = await runChecks(assignment, iso);
		}
		return {
			needsHuman: Boolean(failure),
			excerpt: failure ? failure.excerpt : '',
			tests: failure ? failure.tests : [],
			attempts: attempt,
			result,
		};
	}

	/** Прогон команд проверок по порядку; падаем на первой неудаче. */
	async function runChecks(assignment, iso) {
		for (const check of checks) {
			let output = '';
			let failed = false;
			try {
				const res = await invokeTool('terminal.run', { command: check.command, cwd: iso.cwd, timeoutMs: check.timeoutMs }, assignment.id);
				output = res && res.output !== undefined ? String(res.output) : JSON.stringify(res ?? '');
				failed = (res && res.ok === false) || checkFailed(output);
			} catch (err) {
				// Команда не запустилась — это тоже провал проверки, но граф не падает.
				output = err instanceof Error ? err.message : String(err);
				failed = true;
			}
			if (failed) {
				const parsed = parseFailures(output);
				return { command: check.command, excerpt: parsed.excerpt, tests: parsed.tests };
			}
		}
		return null;
	}

	/**
	 * Человек в петле (Этап 4.2): узел сдался после лимита проверок — граф
	 * поднимает interrupt с резюме ошибки. По одному узлу за проход; на resume
	 * помечаем узел подтверждённым, чтобы не поднимать interrupt повторно.
	 */
	const escalate = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const itemState = state.itemState || {};
		const id = Object.keys(itemState).find(key => itemState[key] === 'needs_human');
		if (!id) {
			return {};
		}
		const result = (state.results && state.results[id]) || {};
		// Бюджет (Этап 5.1) и исчерпание проверок — разные причины остановки:
		// заголовок interrupt'а должен говорить правду, а не про проверки всегда.
		const title = result.reason === 'budget'
			? (language === 'en'
				? `Subtask ${id} was stopped by the node budget limit (${result.tokens || 0} tokens / $${Number(result.cost || 0).toFixed(4)}). Continue?`
				: `Подзадача ${id} остановлена лимитом бюджета узла (${result.tokens || 0} токенов / $${Number(result.cost || 0).toFixed(4)}). Продолжать?`)
			: language === 'en'
				? `Subtask ${id} needs a human: checks failed ${fixIterations} times.`
				: `Подзадача ${id} требует человека: проверки не прошли за ${fixIterations} попыток.`;
		emit({
			type: 'interrupt.requested',
			message: `нужен человек: ${id}`,
			interrupt: { node: id, role: 'human', title: shorten(`${title} ${result.summary || ''}`, 300) },
		});
		const answer = interrupt({ node: id, role: 'human', title, summary: result.summary || '' });
		emit({ type: 'log', message: `человек по ${id}: ${answer && answer.approved ? 'продолжаю' : 'принято к сведению'}` });
		return { itemState: { [id]: 'human-ack' } };
	};

	/**
	 * Бюджетный гейт (Этап 5.1): чистая проверка после reducer'а, когда расход
	 * пачки уже сведён в budget. Если лимит запуска исчерпан — interrupt и пауза
	 * всего графа. Согласие человека фиксируется budgetAck: повторно не спрашиваем.
	 * Отказ останавливает запуск (budgetHalt → deliver), не продолжая тратить.
	 */
	const budgetGate = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		if (!hasRunLimit(budgetLimits) || state.budgetAck) {
			return {};
		}
		const budget = state.budget || { tokens: 0, cost: 0 };
		if (!runOverLimit(budgetLimits, budget).any) {
			return {};
		}
		const title = runBudgetTitle(language, budget, budgetLimits);
		emit({
			type: 'interrupt.requested',
			message: `бюджет запуска исчерпан: ${budget.tokens || 0} токенов / $${Number(budget.cost || 0).toFixed(4)}`,
			interrupt: { node: 'budget', role: 'human', title: shorten(title, 300) },
		});
		const answer = interrupt({ node: 'budget', role: 'human', budget, limits: budgetLimits, title });
		const approved = Boolean(answer && answer.approved);
		emit({
			type: 'log',
			message: approved ? 'бюджет: человек разрешил продолжить' : 'бюджет: запуск остановлен по решению человека',
		});
		return {
			budgetAck: true,
			budgetHalt: !approved,
			summary: approved
				? (state.summary || '')
				: `${language === 'en' ? 'Stopped: run budget exhausted' : 'Остановлено: бюджет запуска исчерпан'}`,
		};
	};

	/** Маршрут после бюджетного гейта: отказ человека — на deliver (конец запуска). */
	const routeFromBudget = (state) => (state.budgetHalt ? 'deliver' : 'escalate');

	/**
	 * Merge (Этап 4.3): супервизор по очереди вливает ветки узлов в run-ветку.
	 * Конфликт — interrupt со списком файлов, без авто-резолва моделью. После
	 * успешного merge — финальный прогон проверок.
	 */
	const merge = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const isolations = state.isolations || {};
		const merged = { ...(state.merged || {}) };
		const conflicts = {};
		const pending = Object.keys(isolations).filter(id => !merged[id]);
		if (pending.length === 0 || !workspaceRoot || !runId) {
			return {};
		}
		const runWt = runWorktreePath(workspaceRoot, runId);
		const runBr = runBranch(runId);
		if (!state.runWorktree) {
			try {
				// Run-ветка заводится от базы один раз — дальше только влива́ем узлы.
				await invokeTool('git.worktreeAdd', { worktree: runWt, branch: runBr, baseCommit }, 'merge');
			} catch (err) {
				emit({ type: 'log', message: `merge-дерево не создалось: ${err instanceof Error ? err.message : String(err)}` });
				return {};
			}
		}
		for (const id of pending) {
			// Отмечаем сразу: повторный проход не должен пытаться снова.
			merged[id] = true;
			const info = isolations[id] || {};
			if (!info.branch) {
				continue;
			}
			const res = await invokeTool('git.mergeNode', { cwd: runWt, sourceBranch: info.branch, message: `aura: merge ${id}` }, 'merge');
			if (res && res.ok) {
				emit({ type: 'log', message: `merge ${id}: влито` });
				continue;
			}
			// Конфликт НЕ авторезолвится: откатываем merge, файлы уходят человеку
			// через чистую ноду mergeGate (никаких эффектов до interrupt).
			await invokeTool('git.mergeAbort', { cwd: runWt }, 'merge');
			const files = (res && res.conflicts) || [];
			conflicts[id] = files;
			emit({
				type: 'node.error',
				node: { id: `merge:${id}`, role: 'merge', status: 'error', error: 'конфликт merge', finishedAt: Date.now() },
				message: `merge ${id}: конфликт (${files.length} файл(ов))`,
			});
		}
		await runFinalChecks(runWt);
		return { merged, runWorktree: runWt, mergeConflicts: conflicts };
	};

	/**
	 * mergeGate: чистая нода-предохранитель. Побочных эффектов до interrupt нет,
	 * поэтому resume не переигрывает merge. Показывает конфликты по одному и
	 * после решения человека очищает канал.
	 */
	const mergeGate = async (state) => {
		await gate.waitIfPaused();
		gate.throwIfAborted();
		const conflicts = state.mergeConflicts || {};
		const id = Object.keys(conflicts)[0];
		if (!id) {
			return {};
		}
		const files = conflicts[id] || [];
		const title = language === 'en'
			? `Merge conflict in ${id}. Resolve these files in the run worktree:\n${files.join('\n') || '(unknown)'}`
			: `Конфликт merge в ${id}. Разрешите эти файлы в run-рабочем дереве:\n${files.join('\n') || '(неизвестно)'}`;
		emit({ type: 'interrupt.requested', message: `конфликт merge: ${id}`, interrupt: { node: id, role: 'merge', title: shorten(title, 300) } });
		const answer = interrupt({ node: id, role: 'merge', files, title });
		emit({ type: 'log', message: `merge по ${id}: ${answer && answer.approved ? 'подтверждено' : 'отклонено'} человеком` });
		return { mergeConflicts: {} };
	};

	/** Финальный прогон проверок в run-ветке после merge: результат — только в лог. */
	async function runFinalChecks(runWt) {
		if (checks.length === 0 || !runWt) {
			return;
		}
		const failure = await runChecks({ id: 'merge' }, { cwd: runWt });
		if (failure) {
			emit({ type: 'node.error', node: { id: 'merge:checks', role: 'merge', status: 'error', error: shorten(failure.excerpt, 200), finishedAt: Date.now() } });
		} else {
			emit({ type: 'log', message: 'финальные проверки после merge пройдены' });
		}
	}

	/**
	 * Deliver (Этап 4.5): считает единый патч run-ветки от базы и отдаёт его
	 * в панель (файлы + diffstat). Сырой diff в state/чекпоинт не кладём.
	 */
	const deliver = async (state) => {
		if (!state.runWorktree || !workspaceRoot || !runId) {
			return {};
		}
		const runBr = runBranch(runId);
		try {
				const res = await invokeTool('git.finalPatch', { cwd: state.runWorktree, base: baseCommit, runBranch: runBr }, 'deliver');
			const files = (res && res.files) || [];
			const stat = (res && res.stat) || '';
			emit({
				type: 'patch.ready',
				message: files.length ? `патч готов: ${files.length} файл(ов)` : 'патч пуст',
				patch: { runBranch: runBr, base: baseCommit, worktree: state.runWorktree, files, stat },
			});
		} catch (err) {
			emit({ type: 'log', message: `патч не собрался: ${err instanceof Error ? err.message : String(err)}` });
		}
		return {};
	};

	/** join: когда очередь исчерпана — мержим узлы, иначе снова router.
	 * иначе снова router. Явная точка принятия решения о продолжении. */
	const join = async () => ({});

	const routeFromJoin = (state) => {
		const queue = Array.isArray(state.queue) ? state.queue : [];
		return queue.length > 0 ? 'router' : 'merge';
	};

	return new StateGraph(OrchestratorState)
		.addNode('supervisor', supervisor)
		.addNode('router', router)
		.addNode('worker', worker)
		.addNode('reducer', reducer)
		.addNode('verify', verify)
		.addNode('budgetGate', budgetGate)
		.addNode('escalate', escalate)
		.addNode('merge', merge)
		.addNode('mergeGate', mergeGate)
		.addNode('deliver', deliver)
		.addNode('join', join)
		.addEdge(START, 'supervisor')
		.addConditionalEdges('supervisor', routeFromSupervisor)
		.addConditionalEdges('router', routeFromRouter)
		.addEdge('worker', 'reducer')
		.addEdge('reducer', 'budgetGate')
		.addConditionalEdges('budgetGate', routeFromBudget)
		.addEdge('escalate', 'verify')
		.addEdge('verify', 'join')
		.addConditionalEdges('join', routeFromJoin)
		.addEdge('merge', 'mergeGate')
		.addEdge('mergeGate', 'supervisor')
		.addEdge('deliver', END)
		.compile(compileOptions);
}

/** Тир модели в панели — только настоящие: mock-режим отдаёт свою строку. */
function safeTier(tier, role) {
	return TIERS.includes(tier) ? tier : tierFor(role);
}

/** Ограничение сырого вывода воркера до попадания в транзитный канал. */
function limitedRaw(text) {
	const flat = String(text == null ? '' : text);
	return flat.length > RAW_MAX_CHARS ? `${flat.slice(0, RAW_MAX_CHARS - 1)}…` : flat;
}

module.exports = {
	buildOrchestratorGraph,
	OrchestratorState,
	parseDecision,
	fallbackDecision,
	normalizePlan,
	summarize,
	tierForNode,
	roleForKind,
	MAX_SUPERVISOR_ROUNDS,
	SUMMARY_MAX_LINES,
	formatConfirmPrompt,
	DEFAULT_VERIFY_COMMAND,
};
