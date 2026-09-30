/*---------------------------------------------------------------------------------------------
 *  Отчёт команды агентов для чата: строки прогресса, сводка запуска, разбор входа инструмента.
 *  Модуль намеренно не импортирует vscode — только типы, — чтобы его логика
 *  проверялась обычными node-тестами (test/team-tool.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import type { GraphNodeState } from '../host';

export type RunStatus = 'done' | 'error' | 'cancelled';
export type NodeStatus = GraphNodeState['status'];

/** Человекочитаемые роли: агент в отчёте виден как «Кодер», а не как `coder`. */
const ROLE_TITLES: Record<string, string> = {
	'supervisor': 'Супервизор',
	'coder': 'Кодер',
	'tester': 'Тестировщик',
	'security-auditor': 'Аудит безопасности',
	'reviewer': 'Ревьюер',
};

const STATUS_TITLES: Record<NodeStatus, string> = {
	'idle': 'в очереди',
	'running': 'работает',
	'waiting-approval': 'ждёт подтверждения',
	'done': 'готово',
	'error': 'ошибка',
	'skipped': 'пропущено',
	'needs_human': 'нужен человек',
};

const RUN_STATUS_TITLES: Record<RunStatus, string> = {
	'done': 'задача выполнена',
	'error': 'задача завершилась с ошибкой',
	'cancelled': 'запуск отменён',
};

/** Сколько строк лога попадает в сводку и как долго живёт одна строка. */
const SUMMARY_LOG_LINES = 6;
const SUMMARY_LINE_LIMIT = 240;
/** Заметки и ошибки агентов бывают длинными — в строке прогресса им столько не нужно. */
const NOTE_LIMIT = 160;
const MAX_TASK_LENGTH = 8000;
const DEFAULT_MAX_WORKERS = 3;
const MAX_WORKERS_LIMIT = 8;

export function roleTitle(role: string): string {
	return ROLE_TITLES[role] ?? role;
}

export function statusTitle(status: NodeStatus): string {
	return STATUS_TITLES[status] ?? status;
}

export function runStatusTitle(status: RunStatus): string {
	return RUN_STATUS_TITLES[status] ?? status;
}

/**
 * Одна строка прогресса по узлу графа — ровно то, что видно в виджете инструмента
 * в чате. Узла без состояния не бывает, поэтому undefined отдаём только на мусор.
 */
export function progressLine(node: GraphNodeState | undefined | null): string | undefined {
	if (!node || !node.id || !node.status) {
		return undefined;
	}
	const head = node.tier ? `${roleTitle(node.role)} (${node.tier})` : roleTitle(node.role);
	const parts = [head, statusTitle(node.status)];
	if (node.keyName) {
		parts.push(`ключ ${node.keyName}`);
	}
	if (node.error) {
		parts.push(truncate(node.error, NOTE_LIMIT));
	} else if (node.note) {
		parts.push(truncate(node.note, NOTE_LIMIT));
	}
	return parts.join(' · ');
}

/**
 * Отпечаток состояния узла: пока он не меняется, прогресс повторять не нужно.
 * Нужен, потому что состояние панели пушится и по чужим событиям (ключи, аппрувы).
 */
export function nodeSignature(node: GraphNodeState): string {
	return [node.status, node.tier ?? '', node.keyName ?? '', node.error ?? '', node.note ?? ''].join('|');
}

/** Лог хоста пишет время в начале строки — в чате оно лишнее. */
export function stripLogTimestamp(line: string): string {
	return String(line ?? '').replace(/^\[\d{1,2}:\d{2}:\d{2}(?:\s*(?:AM|PM))?]\s*/i, '').trim();
}

export interface NodeCounts {
	total: number;
	done: number;
	running: number;
	failed: number;
}

export function countNodes(nodes: readonly GraphNodeState[]): NodeCounts {
	return {
		total: nodes.length,
		done: nodes.filter(n => n.status === 'done').length,
		running: nodes.filter(n => n.status === 'running' || n.status === 'waiting-approval').length,
		failed: nodes.filter(n => n.status === 'error').length,
	};
}

function counterLine(nodes: readonly GraphNodeState[]): string {
	const { total, done, failed } = countNodes(nodes);
	const parts = [`${done} из ${total} готово`];
	if (failed) {
		parts.push(`${failed} с ошибкой`);
	}
	return parts.join(' · ');
}

export interface ProgressState {
	nodes: GraphNodeState[];
	log: string[];
}

/**
 * Превращает снапшоты состояния панели в последовательность строк прогресса:
 * по строке на изменившийся узел + счётчик, и одну свежую строку лога как контекст.
 * Возвращает выданные строки, чтобы это можно было проверить тестом.
 */
export class ProgressTracker {

	private readonly signatures = new Map<string, string>();
	private logSeen = 0;
	private lastCounted = -1;

	constructor(private readonly onLine: (line: string) => void = () => undefined) { }

	update(state: ProgressState | undefined | null): string[] {
		if (!state || !Array.isArray(state.nodes)) {
			return [];
		}
		const lines: string[] = [];
		for (const node of state.nodes) {
			if (!node?.id) {
				continue;
			}
			const signature = nodeSignature(node);
			if (this.signatures.get(node.id) === signature) {
				continue;
			}
			this.signatures.set(node.id, signature);
			const line = progressLine(node);
			if (line) {
				lines.push(line);
			}
		}

		const log = Array.isArray(state.log) ? state.log : [];
		// Хост держит только последние N строк: если лог стал короче, наши индексы
		// больше ничего не значат — начинаем считать заново с его текущего начала.
		if (this.logSeen > log.length) {
			this.logSeen = 0;
		}
		const fresh = log.slice(this.logSeen).map(stripLogTimestamp).filter(Boolean);
		this.logSeen = log.length;
		if (fresh.length) {
			lines.push(fresh[fresh.length - 1]);
		}

		// Счётчик «сколько сделано» — полезен отдельно от смены статуса узла.
		const { done } = countNodes(state.nodes);
		if (done !== this.lastCounted && state.nodes.length) {
			this.lastCounted = done;
			lines.push(counterLine(state.nodes));
		}

		for (const line of lines) {
			this.onLine(line);
		}
		return lines;
	}
}

export interface TeamRunResult {
	task: string;
	status: RunStatus;
	nodes: GraphNodeState[];
	log: string[];
}

function truncate(text: string, limit: number): string {
	const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Markdown-сводка запуска: её читает модель в чате и человек в истории диалога. */
export function buildTeamSummary(result: TeamRunResult): string {
	const lines: string[] = [];
	lines.push(`**Команда агентов: ${runStatusTitle(result.status)}.**`);
	lines.push('');
	lines.push(`Задача: ${truncate(result.task, SUMMARY_LINE_LIMIT)}`);
	lines.push('');

	const nodes = result.nodes ?? [];
	if (nodes.length) {
		for (const node of nodes) {
			lines.push(`- ${progressLine(node) ?? roleTitle(node.role)}`);
		}
	} else {
		lines.push('- Ни один агент не был запущен.');
	}
	const { total, done, failed } = countNodes(nodes);
	if (total) {
		lines.push('');
		lines.push(failed
			? `Итог: ${done} из ${total} агентов завершили работу, ${failed} с ошибкой.`
			: `Итог: ${done} из ${total} агентов завершили работу.`);
	}

	const log = (result.log ?? []).slice(-SUMMARY_LOG_LINES).map(stripLogTimestamp).filter(Boolean);
	if (log.length) {
		lines.push('');
		lines.push('Последние события:');
		for (const entry of log) {
			lines.push(`- ${truncate(entry, SUMMARY_LINE_LIMIT)}`);
		}
	}
	if (result.status === 'cancelled') {
		lines.push('');
		lines.push('Запуск прерван. Чекпоинт сохранён — следующая задача продолжит с него.');
	}
	return lines.join('\n');
}

export type ParsedTeamTask =
	| { ok: true; task: string; maxWorkers: number }
	| { ok: false; error: string };

/**
 * Разбор входа инструмента: модель присылает свободную структуру, поэтому
 * проверяем сами и отвечаем текстом, который модель сможет исправить.
 */
export function parseTeamTaskInput(input: unknown): ParsedTeamTask {
	const record = (input ?? {}) as Record<string, unknown>;
	const raw = record.task ?? record.prompt ?? record.instruction;
	if (typeof raw !== 'string' || !raw.trim()) {
		return { ok: false, error: 'Не передана задача: заполните обязательный параметр task текстом задачи.' };
	}
	const task = raw.trim();
	if (task.length > MAX_TASK_LENGTH) {
		return { ok: false, error: `Задача слишком длинная (${task.length} символов, максимум ${MAX_TASK_LENGTH}). Сократите её до сути.` };
	}
	const requested = Number(record.max_workers ?? record.maxWorkers);
	const maxWorkers = Number.isFinite(requested) && requested > 0
		? Math.min(Math.floor(requested), MAX_WORKERS_LIMIT)
		: DEFAULT_MAX_WORKERS;
	return { ok: true, task, maxWorkers };
}
