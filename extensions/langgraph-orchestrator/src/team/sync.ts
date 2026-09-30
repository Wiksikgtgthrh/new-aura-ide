/*---------------------------------------------------------------------------------------------
 *  Мост «доска тимы ↔ оркестратор»: чистая логика без vscode.
 *  Здесь только то, что можно проверить node-тестом: маппинг taskId→threadId, выбор
 *  задач с меткой [agent], заметки в описании задачи и перевод результата запуска
 *  в статус канбана. Никакой сети и никаких API-ключей.
 *--------------------------------------------------------------------------------------------*/

export type TeamTaskStatus = 'todo' | 'doing' | 'review' | 'done';

/** Задача доски в объёме, который нужен оркестратору (подмножество TeamTask). */
export interface TeamBoardTask {
	id: string;
	title: string;
	description: string;
	status: TeamTaskStatus;
	assigneeId?: string;
	assigneeName?: string;
}

/** Заметка оркестратора, написанная в описании задачи. */
export interface TeamTaskNote {
	/** «в работе» / «патч готов — проверьте ветку» / «остановился: …». */
	text: string;
	/** Ссылка на ветку/коммит, если есть. */
	ref?: string;
	at: number;
}

/** Ключ globalState: taskId → threadId графа (чтобы повторный клик открыл тот же запуск). */
export const TEAM_TASK_THREAD_KEY = 'orchestrator.teamTaskThread';
/** Метка в заголовке: только такие задачи попадают в автозабор. */
export const AGENT_LABEL_RE = /\[agent\]/i;
/** Маркер заметки оркестратора: по нему старая заметка удаляется перед новой. */
export const ORCHESTRATOR_NOTE_MARK = '🤖 Оркестратор';
const NOTE_LIMIT = 400;
/** Предел заголовка задачи: длиннее сервер команды не принимает. */
export const TASK_TITLE_LIMIT = 140;

/**
 * Стабильный id потока графа для задачи доски. Одинаковый при повторных кликах,
 * поэтому LangGraph продолжает существующий запуск, а не создаёт второй.
 */
export function threadIdForTask(taskId: string): string {
	return `team-task-${String(taskId).trim()}`;
}

/**
 * Заголовок новой задачи из панели: схлопываем переводы строк и лишние пробелы,
 * обрезаем по пределу. Пустая строка означает «создавать нечего».
 */
export function normalizeTaskTitle(title: string | undefined): string {
	return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_LIMIT);
}

/** Задача помечена `[agent]` — её можно брать автозабором. */
export function isAgentTask(title: string): boolean {
	return AGENT_LABEL_RE.test(String(title ?? ''));
}

/**
 * Задачи, которые автозабор готов взять прямо сейчас: todo + метка + не занята.
 * Результат детерминирован (порядок исходного списка), обрезан до limit.
 */
export function pickAgentTasks(
	tasks: readonly TeamBoardTask[],
	limit: number,
	busyTaskIds: readonly string[] = [],
): TeamBoardTask[] {
	if (!Array.isArray(tasks) || limit <= 0) {
		return [];
	}
	const busy = new Set(busyTaskIds);
	return tasks
		.filter(task => task && task.status === 'todo' && isAgentTask(task.title) && !busy.has(task.id))
		.slice(0, Math.floor(limit));
}

/** Текст задачи для графа: заголовок + описание (без служебных заметок оркестратора). */
export function taskTextForGraph(task: TeamBoardTask): string {
	const noteFree = stripOrchestratorNotes(task.description);
	const title = String(task.title ?? '').trim();
	return noteFree ? `${title}\n\n${noteFree}` : title;
}

/** Удаляет прежние заметки оркестратора, чтобы они не накапливались в описании. */
export function stripOrchestratorNotes(description: string): string {
	const lines = String(description ?? '').split('\n');
	const kept = lines.filter(line => !line.trimStart().startsWith(ORCHESTRATOR_NOTE_MARK));
	// Схлопываем хвостовые пустые строки, оставшиеся от удалённой заметки.
	while (kept.length && !kept[kept.length - 1].trim()) {
		kept.pop();
	}
	return kept.join('\n').trimEnd();
}

/** Сериализует заметку в одну строку markdown. */
export function formatOrchestratorNote(note: TeamTaskNote): string {
	const parts = [`${ORCHESTRATOR_NOTE_MARK}: ${note.text.trim()}`];
	if (note.ref) {
		parts.push(note.ref.trim());
	}
	return `\n\n${parts.join(' · ')}`;
}

/** Описание с новой заметкой оркестратора (старые заметки вычищены). */
export function withOrchestratorNote(description: string, note: TeamTaskNote): string {
	return `${stripOrchestratorNotes(description)}${formatOrchestratorNote(note)}`.trim();
}

/** Статус канбана по итогу запуска: готовый патч уходит на ревью, остальное — остаётся в работе. */
export function statusForOutcome(outcome: 'done' | 'error' | 'cancelled'): TeamTaskStatus {
	return outcome === 'done' ? 'review' : 'doing';
}

/** Заметка по итогу запуска: короткое резюме, а не лог агентов. */
export function outcomeNote(
	outcome: 'done' | 'error' | 'cancelled',
	summary: string | undefined,
	ref?: string,
	now: number = Date.now(),
): TeamTaskNote {
	const flat = String(summary ?? '').replace(/\s+/g, ' ').trim();
	const trimmed = flat.length > NOTE_LIMIT ? `${flat.slice(0, NOTE_LIMIT - 1)}…` : flat;
	if (outcome === 'done') {
		return { text: trimmed ? `патч готов — ${trimmed}` : 'патч готов — проверьте ветку задачи', ref, at: now };
	}
	if (outcome === 'cancelled') {
		return { text: trimmed ? `запуск отменён — ${trimmed}` : 'запуск отменён пользователем', ref, at: now };
	}
	return { text: trimmed ? `остановился: ${trimmed}` : 'остановился с ошибкой — смотрите панель оркестратора', ref, at: now };
}

/** Обновляет маппинг taskId→threadId, не теряя уже сохранённые записи. */
export function withThreadMapping(
	mapping: Record<string, string> | undefined,
	taskId: string,
	threadId: string,
): Record<string, string> {
	return { ...(mapping ?? {}), [String(taskId).trim()]: String(threadId).trim() };
}
