/*---------------------------------------------------------------------------------------------
 *  Aura Teams — модель задач канбан-доски: чистые функции без DOM и сервисов.
 *  Синхронизация с сервером (Supabase) подключается поверх этой модели.
 *--------------------------------------------------------------------------------------------*/

export type AuraTaskStatus = 'backlog' | 'inProgress' | 'review' | 'done';
export type AuraTaskPriority = 'high' | 'medium' | 'low';

export const AURA_TASK_STATUSES: readonly AuraTaskStatus[] = ['backlog', 'inProgress', 'review', 'done'];

export const AURA_TASK_STATUS_LABEL: Readonly<Record<AuraTaskStatus, string>> = {
	backlog: 'Бэклог',
	inProgress: 'В работе',
	review: 'На ревью',
	done: 'Готово',
};

export const AURA_TASK_PRIORITY_LABEL: Readonly<Record<AuraTaskPriority, string>> = {
	high: 'Высокий',
	medium: 'Средний',
	low: 'Низкий',
};

export interface IAuraTask {
	readonly id: string;
	title: string;
	description: string;
	status: AuraTaskStatus;
	priority: AuraTaskPriority;
	/** Исполнитель — свободное имя; при подключении Supabase станет id участника. */
	assignee?: string;
	/** Git-ветка задачи (создаётся/переключается кнопкой на карточке). */
	branch?: string;
	readonly createdAt: number;
	updatedAt: number;
	/** Порядок внутри колонки (меньше — выше). */
	order: number;
}

export interface IAuraTaskDraft {
	title: string;
	description?: string;
	status?: AuraTaskStatus;
	priority?: AuraTaskPriority;
	assignee?: string;
	branch?: string;
}

export interface IAuraTeamsBoard {
	readonly version: 1;
	tasks: IAuraTask[];
}

export function emptyBoard(): IAuraTeamsBoard {
	return { version: 1, tasks: [] };
}

/** Ветка из названия: кириллица транслитерируется, остальное — в kebab-case, префикс `task/`. */
export function branchNameForTask(title: string, id: string): string {
	const map: Record<string, string> = {
		а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
		н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
		ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
	};
	const slug = title.toLowerCase()
		.split('')
		.map(ch => map[ch] ?? ch)
		.join('')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	return `task/${slug || 'task'}-${id.slice(0, 6)}`;
}

export function createTask(board: IAuraTeamsBoard, draft: IAuraTaskDraft, id: string, now: number): IAuraTask {
	const status = draft.status ?? 'backlog';
	const order = Math.max(-1, ...board.tasks.filter(t => t.status === status).map(t => t.order)) + 1;
	const task: IAuraTask = {
		id,
		title: draft.title.trim(),
		description: (draft.description ?? '').trim(),
		status,
		priority: draft.priority ?? 'medium',
		assignee: draft.assignee?.trim() || undefined,
		branch: draft.branch?.trim() || undefined,
		createdAt: now,
		updatedAt: now,
		order,
	};
	board.tasks.push(task);
	return task;
}

export function updateTask(board: IAuraTeamsBoard, id: string, patch: Partial<Omit<IAuraTask, 'id' | 'createdAt'>>, now: number): IAuraTask | undefined {
	const task = board.tasks.find(t => t.id === id);
	if (!task) {
		return undefined;
	}
	Object.assign(task, patch, { updatedAt: now });
	return task;
}

export function removeTask(board: IAuraTeamsBoard, id: string): boolean {
	const before = board.tasks.length;
	board.tasks = board.tasks.filter(t => t.id !== id);
	return board.tasks.length !== before;
}

/**
 * Перемещение в колонку на позицию `index` (undefined — в конец). Порядок в исходной
 * и целевой колонках перенумеровывается плотно, чтобы drag-and-drop был устойчивым.
 */
export function moveTask(board: IAuraTeamsBoard, id: string, status: AuraTaskStatus, index: number | undefined, now: number): IAuraTask | undefined {
	const task = board.tasks.find(t => t.id === id);
	if (!task) {
		return undefined;
	}
	const target = tasksInColumn(board, status).filter(t => t.id !== id);
	const at = index === undefined ? target.length : Math.max(0, Math.min(index, target.length));
	target.splice(at, 0, task);
	target.forEach((t, i) => { t.order = i; });
	if (task.status !== status) {
		const source = tasksInColumn(board, task.status).filter(t => t.id !== id);
		source.forEach((t, i) => { t.order = i; });
		task.status = status;
	}
	task.updatedAt = now;
	return task;
}

export function tasksInColumn(board: IAuraTeamsBoard, status: AuraTaskStatus): IAuraTask[] {
	return board.tasks.filter(t => t.status === status).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** «Мои задачи»: незакрытые задачи участника, срочные выше. */
export function myTasks(board: IAuraTeamsBoard, assignee: string): IAuraTask[] {
	const weight: Record<AuraTaskPriority, number> = { high: 0, medium: 1, low: 2 };
	const statusWeight: Record<AuraTaskStatus, number> = { inProgress: 0, review: 1, backlog: 2, done: 3 };
	const me = assignee.trim().toLowerCase();
	return board.tasks
		.filter(t => t.status !== 'done' && (t.assignee ?? '').trim().toLowerCase() === me && me !== '')
		.sort((a, b) => statusWeight[a.status] - statusWeight[b.status] || weight[a.priority] - weight[b.priority] || a.order - b.order);
}

/** Разбор сохранённой доски; мусор и чужие версии дают пустую доску, а не падение. */
export function parseBoard(raw: string | undefined): IAuraTeamsBoard {
	if (!raw) {
		return emptyBoard();
	}
	try {
		const parsed = JSON.parse(raw) as Partial<IAuraTeamsBoard>;
		if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) {
			return emptyBoard();
		}
		const tasks = parsed.tasks.filter((t): t is IAuraTask =>
			!!t && typeof t.id === 'string' && typeof t.title === 'string' && AURA_TASK_STATUSES.includes(t.status));
		return { version: 1, tasks };
	} catch {
		return emptyBoard();
	}
}
