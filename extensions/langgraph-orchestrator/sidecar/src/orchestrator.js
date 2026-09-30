'use strict';

const { LlmClient } = require('./llm');
const { buildOrchestratorGraph, MAX_SUPERVISOR_ROUNDS } = require('./graph');
const { MemorySaver, Command } = require('@langchain/langgraph');
const { FileSaver } = require('./fileSaver');
const { Tracer } = require('./trace');
const { runWorktreePath, runBranch } = require('./worktrees');

/**
 * Пауза и отмена между узлами графа. Отмена бывает общей (вся задача)
 * и поимённой: одна залипшая подзадача не должна требовать стопа всего запуска.
 */
class Gate {
	constructor() {
		this.paused = false;
		this.isAborted = false;
		this.abortedNodes = new Set();
	}
	pause() { this.paused = true; }
	resume() { this.paused = false; }
	abort() { this.isAborted = true; this.paused = false; }
	abortNode(nodeId) { if (nodeId) { this.abortedNodes.add(String(nodeId)); } }
	nodeAborted(nodeId) { return this.abortedNodes.has(String(nodeId)); }
	aborted() { return this.isAborted; }
	throwIfAborted() {
		if (this.isAborted) {
			throw new Error('cancelled');
		}
	}
	waitIfPaused() {
		return new Promise(resolve => {
			const tick = () => {
				if (!this.paused || this.isAborted) {
					resolve();
				} else {
					setTimeout(tick, 300);
				}
			};
			tick();
		});
	}
}

/**
 * Сессия оркестратора: запуск/пауза/стоп графа, события наружу, чекпоинты
 * (память потока в MemorySaver — interrupt, time-travel, ручная правка стейта),
 * снапшот после каждого шага в расширение (переживает рестарт IDE).
 *
 * Каждый запуск получает свой thread_id: история чекпоинтов не подмешивается
 * к следующей задаче (каналы-merge-редьюсеры иначе склеили бы результаты).
 */
class Orchestrator {
	constructor(rpc, options) {
		this.rpc = rpc;
		this.mock = !!(options && options.mock);
		this.gate = new Gate();
		this.runPromise = null;
		this.lastSnapshot = null;
		/** Граф и поток живут с первого start до конца сессии сайдкара. */
		this.graphRef = null;
		this.threadId = null;
		/** Корень workspace: нужен git-инструментам и очистке worktree. */
		this.workspaceRoot = '';
		/** Трейсер текущего запуска (Этап 5.2). */
		this.tracer = null;
	}

	get running() {
		return !!this.runPromise;
	}

	get threadConfig() {
		return { configurable: { thread_id: this.threadId } };
	}

	async handleCommand(method, params) {
		switch (method) {
			case 'start': return this.start(params || {});
			case 'pause': this.gate.pause(); return { paused: true };
			case 'resume': this.gate.resume(); return { resumed: true };
			case 'cancel': return this.cancel();
			case 'cancelNode': {
				const nodeId = String((params && params.nodeId) || '');
				if (!nodeId) { throw new Error('nodeId is empty'); }
				this.gate.abortNode(nodeId);
				return { cancelled: true, nodeId };
			}
			case 'status': return { running: this.running, paused: this.gate.paused };
			case 'interrupt.resolve': return this.resolveInterrupt(params || {});
			case 'history': return this.history(params || {});
			case 'rewind': return this.rewind(params || {});
			case 'patchState': return this.patchState(params || {});
			case 'restartNode': return this.restartNode(params || {});
			case 'cleanup': return this.cleanupWorktrees();
			case 'trace.spans': return this.traceSnapshot();
			default: throw new Error(`unknown command: ${method}`);
		}
	}

	async start(params) {
		if (this.runPromise) {
			throw new Error('already running');
		}
		const task = String(params.task || '').trim();
		if (!task) {
			throw new Error('task is empty');
		}
		const llm = new LlmClient(this.rpc, { mock: this.mock, escalationThreshold: params.escalationThreshold });
		const tools = Array.isArray(params.tools) ? params.tools : [];
		const emit = (event) => this.rpc.notify('graph.event', event);
		this.gate = new Gate();
		this.workspaceRoot = String(params.workspaceRoot || '');
		// Стабильный thread_id: resume той же задачи продолжает историю чекпоинтов,
		// а не заводит новый поток — иначе rewind после рестарта сайдкара пуст.
		const resumeMatches = params.resumeState && params.resumeState.task === task ? params.resumeState : null;
		this.threadId = params.threadId
			|| (resumeMatches && resumeMatches.threadId)
			|| `run-${Date.now()}`;
		// Трейсер заводится на поток запуска: спаны уходят в host живым потоком,
		// опционально пишутся в файл и на OTLP-endpoint (Этап 5.2).
		const traceOptions = params.trace && typeof params.trace === 'object' ? params.trace : {};
		this.tracer = new Tracer({
			enabled: traceOptions.enabled !== false,
			file: typeof traceOptions.file === 'string' ? traceOptions.file : '',
			otlpEndpoint: typeof traceOptions.otlpEndpoint === 'string' ? traceOptions.otlpEndpoint : '',
			maxSpans: traceOptions.maxSpans,
			traceId: this.threadId,
			onSpan: span => this.rpc.notify('trace.span', span),
		});
		// Чекпоинтер обязателен: без него interrupt() не работает, а history/rewind пусты.
		// FileSaver персистит историю в файл (машина времени переживает рестарт сайдкара);
		// MemorySaver — фолбэк, когда путь не передан (mock-режим, тесты).
		const checkpointer = params.checkpointFile
			? new FileSaver(String(params.checkpointFile))
			: new MemorySaver();
		const graph = buildOrchestratorGraph({
			llm,
			tools,
			invokeTool: (name, input, nodeId) => this.rpc.request('tool.invoke', { name, input, nodeId }),
			emit,
			gate: this.gate,
			maxParallelWorkers: params.maxParallelWorkers,
			maxVerifyRetries: params.maxVerifyRetries,
			verifyCommand: params.verifyCommand,
			// reducer обогащает результаты ссылкой на дифф/коммит; git может быть
			// недоступен — тогда просто остаются пустые строки.
			collectDiff: () => this.collectDiff(),
			// Изоляция воркеров (Этап 4.1): runId = thread_id, база — коммит запуска.
			runId: this.threadId,
			workspaceRoot: this.workspaceRoot,
			baseCommit: String(params.baseCommit || ''),
			// Бюджет (Этап 5.1): лимиты узла/запуска. Цены остаются в host.
			budget: params.budget,
			// Трейсинг (Этап 5.2): спаны нод и вызовов модели.
			tracer: this.tracer,
			language: params.language === 'en' ? 'en' : 'ru',
		}, { checkpointer });
		this.graphRef = graph;

		const resumed = resumeMatches;
		const initialState = resumed
			? { task, round: resumed.round || 0, results: resumed.results || {}, summary: '' }
			: { task, round: 0, results: {}, summary: '' };
		if (resumed) {
			emit({ type: 'log', message: `resume из чекпоинта: раунд ${resumed.round}, результатов ${Object.keys(resumed.results || {}).length}` });
		}

		emit({ type: 'graph.started', message: `задача запущена: ${task}`, run: { maxRounds: MAX_SUPERVISOR_ROUNDS } });
		// Лимит рекурсии — на весь план целиком: пачка за пачкой, ретраи verify
		// и раунды супервизора живут в одном лимите (шаг на пачку + шаг verify).
		this.runPromise = this.drive(graph, initialState)
			.then(result => {
				this.emitFinish(result);
				return { ok: true, summary: result.summary || '' };
			})
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				if (/cancelled|aborted/i.test(message)) {
					emit({ type: 'graph.cancelled', message: params.language === 'en' ? 'task cancelled' : 'задача отменена' });
					return { ok: false, cancelled: true };
				}
				emit({ type: 'graph.error', message: `ошибка графа: ${message}` });
				return { ok: false, error: message };
			})
			.finally(() => {
				this.runPromise = null;
			});
		return { started: true, resumed: !!resumed };
	}

	/**
	 * Единый драйвер прогресса графа: свежий запуск (input = стейт), продолжение
	 * после interrupt (input = Command({resume})), replay после rewind (input = null
	 * + checkpoint_id в конфиге). Снапшоты и события — в одном месте.
	 */
	async drive(graph, input, configOverrides) {
		const overrides = configOverrides || {};
		const streamConfig = {
			recursionLimit: 200,
			streamMode: 'values',
			...this.threadConfig,
			...overrides,
			configurable: { ...this.threadConfig.configurable, ...(overrides.configurable || {}) },
		};
		const stream = await graph.stream(input, streamConfig);
		let summary = '';
		for await (const values of stream) {
			summary = values.summary || '';
			this.lastSnapshot = {
				task: values.task || '',
				round: values.round || 0,
				results: values.results || {},
				summary: values.summary || '',
				plan: Array.isArray(values.plan) ? values.plan : [],
				itemState: values.itemState || {},
				attempts: values.attempts || {},
				isolations: values.isolations || {},
				budget: values.budget || { tokens: 0, cost: 0 },
				errors: Array.isArray(values.errors) ? values.errors : [],
				// Для resume после рестарта сайдкара: продолжаем тот же поток чекпоинтов.
				threadId: this.threadId || '',
				savedAt: Date.now(),
			};
			this.rpc.notify('checkpoint', this.lastSnapshot);
		}
		return { summary };
	}

	/**
	 * git-инфо для reducer'а: дифф-статистика и короткий коммит одним заходом.
	 * Зонд ограничен коротким дедлайном: без extension host (дымовой тест,
	 * сайдкар вне IDE) ответа не будет, и ждать 10 минут нельзя. Недоступный git
	 * или закрытый allowlist — просто пустые ссылки, запуск не падает.
	 */
	async collectDiff() {
		try {
			const stat = await this.rpc.request('tool.invoke', { name: 'terminal.run', input: { command: 'git diff --stat' }, nodeId: 'reducer' }, undefined, GIT_PROBE_TIMEOUT_MS);
			const head = await this.rpc.request('tool.invoke', { name: 'terminal.run', input: { command: 'git rev-parse --short HEAD' }, nodeId: 'reducer' }, undefined, GIT_PROBE_TIMEOUT_MS);
			return {
				diff_stat: stripExit(String((stat && stat.output) || '')).slice(0, 400),
				commit: shortCommit((head && head.output) || ''),
			};
		} catch {
			return {};
		}
	}

	/** Снапшот трейса для панели: спаны + агрегаты (топ по времени/деньгам). */
	traceSnapshot() {
		if (!this.tracer) {
			return { spans: [], summary: { byTime: [], byCost: [], totalSpans: 0 } };
		}
		return { spans: this.tracer.list(), summary: this.tracer.summary() };
	}

	 emitFinish(result) {
		this.rpc.notify('graph.event', {
			type: 'graph.finished',
			message: `готово: ${result.summary || 'см. результаты узлов'}`,
			run: {
				round: (this.lastSnapshot && this.lastSnapshot.round) || 0,
				summary: result.summary || '',
			},
		});
	}

	/**
	 * Решение по interrupt (подтверждение рискованной подзадачи): граф
	 * продолжается с того же места ноды командой Command({resume}).
	 */
	async resolveInterrupt(params) {
		if (!this.graphRef) {
			throw new Error('no graph instance: start the task first');
		}
		if (this.runPromise) {
			throw new Error('already running');
		}
		const approved = params.approved === true;
		const note = params.note !== undefined && params.note !== null ? String(params.note) : undefined;
		this.runPromise = this.drive(this.graphRef, new Command({ resume: { approved, note } }))
			.then(result => {
				this.emitFinish(result);
				return { ok: true, summary: result.summary || '' };
			})
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.runPromise = null;
			});
		return { resuming: true, approved };
	}

	/** История чекпоинтов (time-travel): от свежего к старому, без тяжёлых полей. */
	async history(params) {
		if (!this.graphRef) {
			return { entries: [] };
		}
		const limit = Math.max(1, Math.min(50, Number(params.limit) || 20));
		const entries = [];
		for await (const snapshot of this.graphRef.getStateHistory(this.threadConfig, { limit })) {
			entries.push({
				checkpointId: snapshot.config?.configurable?.checkpoint_id,
				next: snapshot.next || [],
				step: snapshot.metadata?.step,
				round: snapshot.values?.round,
				summary: snapshot.values?.summary || '',
				resultsCount: snapshot.values?.results ? Object.keys(snapshot.values.results).filter(k => (snapshot.values.results[k] || '') !== '').length : 0,
			});
		}
		return { entries };
	}

	/** Машина времени: откат к чекпоинту и продолжение с него. */
	async rewind(params) {
		if (!this.graphRef) {
			throw new Error('no graph instance: start the task first');
		}
		if (this.runPromise) {
			throw new Error('rewind is only possible on a paused or finished graph');
		}
		const checkpointId = String(params.checkpointId || '');
		if (!checkpointId) {
			throw new Error('checkpointId is required');
		}
		const targetConfig = {
			configurable: { thread_id: this.threadId, checkpoint_id: checkpointId },
		};
		const snapshot = await this.graphRef.getState(targetConfig);
		if (!snapshot || !snapshot.values) {
			throw new Error(`checkpoint not found: ${checkpointId}`);
		}
		this.runPromise = this.drive(this.graphRef, null, targetConfig)
			.then(result => {
				this.emitFinish(result);
				return { ok: true, summary: result.summary || '' };
			})
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.runPromise = null;
			});
		return { rewound: true, checkpointId };
	}

	/**
	 * Ручная правка состояния на чекпоинте (JSON-патч из панели). Нужен
	 * checkpointId из history: патч пишется в ответ ноды next[0], поэтому
	 * на «хвосте» без next патчить просто нечего.
	 */
	async patchState(params) {
		if (!this.graphRef) {
			throw new Error('no graph instance: start the task first');
		}
		if (this.runPromise) {
			throw new Error('patch is only possible on a paused or finished graph');
		}
		const patch = params.patch && typeof params.patch === 'object' ? params.patch : null;
		if (!patch || Object.keys(patch).length === 0) {
			throw new Error('patch is empty');
		}
		const checkpointId = String(params.checkpointId || '');
		if (!checkpointId) {
			throw new Error('checkpointId is required (pick one from history)');
		}
		const targetConfig = {
			configurable: { thread_id: this.threadId, checkpoint_id: checkpointId },
		};
		const snapshot = await this.graphRef.getState(targetConfig);
		if (!snapshot || !snapshot.values) {
			throw new Error(`checkpoint not found: ${checkpointId}`);
		}
		// Чекпоинт посреди графа ждёт next[0] — патч пишем от его имени. На «хвосте»
		// (next пуст, граф завершён) asNode неизвестен: SDK сам выводит автора
		// последнего апдейта, поэтому просто не передаём третий аргумент.
		const asNode = snapshot.next && snapshot.next[0] ? snapshot.next[0] : undefined;
		await this.graphRef.updateState(targetConfig, patch, asNode);
		this.rpc.notify('graph.event', { type: 'log', message: `состояние исправлено вручную (чекпоинт ${checkpointId.slice(0, 8)}…${asNode ? `, узел ${asNode}` : ''})` });
		return { patched: true, asNode: asNode || null };
	}

	/**
	 * Перезапуск одной ноды: возвращаем подзадачу в очередь, стираем её результат
	 * и продолжаем граф с router'а. Работает на остановленном графе (как rewind),
	 * иначе пачка уже идёт и подменить вход нельзя.
	 */
	async restartNode(params) {
		if (!this.graphRef) {
			throw new Error('no graph instance: start the task first');
		}
		if (this.runPromise) {
			throw new Error('restart is only possible on a stopped graph');
		}
		const nodeId = String(params.nodeId || '');
		if (!nodeId) {
			throw new Error('nodeId is required');
		}
		const snapshot = await this.graphRef.getState(this.threadConfig);
		const values = (snapshot && snapshot.values) || {};
		const plan = Array.isArray(values.plan) ? values.plan : [];
		const item = plan.find(entry => entry && entry.id === nodeId);
		if (!item) {
			throw new Error(`node not found in the current plan: ${nodeId}`);
		}
		const state = (values.itemState || {})[nodeId];
		if (state === 'dispatched' || state === 'running') {
			throw new Error(`node is still running: ${nodeId}`);
		}
		const queue = Array.isArray(values.queue) ? values.queue.slice() : [];
		if (!queue.some(entry => entry && entry.id === nodeId)) {
			queue.unshift(item);
		}
		// null в results-редьюсере удаляет прошлый результат (см. graph.js).
		await this.graphRef.updateState(this.threadConfig, {
			queue,
			results: { [nodeId]: null },
			itemState: { [nodeId]: 'queued' },
			attempts: { [nodeId]: 0 },
		}, 'router');
		this.rpc.notify('graph.event', { type: 'log', message: `нода ${nodeId} перезапущена вручную` });
		this.runPromise = this.drive(this.graphRef, null)
			.then(result => {
				this.emitFinish(result);
				return { ok: true, summary: result.summary || '' };
			})
			.catch(err => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.runPromise = null;
			});
		return { restarted: true, nodeId };
	}

	async cancel() {
		this.gate.abort();
		if (this.runPromise) {
			await this.runPromise.catch(() => undefined);
		}
		// Отменённый запуск не оставляет рабочих деревьев (Этап 4.1/4.5).
		await this.cleanupWorktrees();
		return { cancelled: true };
	}

	/**
	 * Убрать рабочие деревья запуска: их пути лежат в последнем снапшоте.
	 * Best-effort: чистка не должна ронять отмену или отклонение патча.
	 */
	async cleanupWorktrees() {
		const isolations = (this.lastSnapshot && this.lastSnapshot.isolations) || {};
		const ids = Object.keys(isolations);
		const targets = ids.map(id => ({
			id,
			worktree: (isolations[id] || {}).worktree,
			branch: (isolations[id] || {}).branch,
		}));
		// Run-дерево/ветку тоже убираем: отказ не должен оставлять следов.
		if (this.workspaceRoot && this.threadId) {
			targets.push({
				id: 'run',
				worktree: runWorktreePath(this.workspaceRoot, this.threadId),
				branch: runBranch(this.threadId),
			});
		}
		if (targets.length === 0) {
			return { cleaned: 0 };
		}
		for (const target of targets) {
			try {
				await this.rpc.request('tool.invoke', {
					name: 'git.worktreeRemove',
					input: { worktree: target.worktree, branch: target.branch, workspaceRoot: this.workspaceRoot },
					nodeId: target.id,
				});
			} catch (err) {
				this.rpc.notify('graph.event', { type: 'log', message: `чистка worktree ${target.id} не удалась: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
		this.rpc.notify('graph.event', { type: 'log', message: `изоляция очищена: ${targets.length} worktree` });
		this.lastSnapshot = this.lastSnapshot ? { ...this.lastSnapshot, isolations: {}, runWorktree: '' } : null;
		return { cleaned: targets.length };
	}
}

/** git может не ответить за разумное время — зонд не должен вешать граф. */
const GIT_PROBE_TIMEOUT_MS = 2500;

/** Короткий коммит принимаем только в hex-виде: иначе это текст отказа, а не ссылка. */
function shortCommit(text) {
	const value = firstLine(stripExit(String(text || '')));
	return /^[0-9a-f]{4,40}$/i.test(value) ? value : '';
}

/** Терминал расширения добавляет к выводу «(exit code N)» — в ссылке это лишнее. */
function stripExit(text) {
	return String(text || '').replace(/\s*\(exit code -?\d+\)\s*$/, '').trim();
}

/** Первая непустая строка вывода терминала — git печатает ссылку целиком. */
function firstLine(text) {
	const lines = String(text == null ? '' : text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	return lines.length ? lines[0] : '';
}

module.exports = { Orchestrator, Gate };
