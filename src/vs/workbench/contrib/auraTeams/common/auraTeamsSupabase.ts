/*---------------------------------------------------------------------------------------------
 *  Aura Teams — Supabase: маппинг задач ↔ строки таблицы и разбор событий Realtime.
 *  Чистые функции без сети; сетевой клиент — в browser/auraTeamsSupabaseClient.ts.
 *--------------------------------------------------------------------------------------------*/

import { AURA_TASK_STATUSES, AuraTaskPriority, AuraTaskStatus, IAuraTask } from './auraTeamsModel.js';

export const SUPABASE_TASKS_TABLE = 'aura_tasks';

/** Строка таблицы aura_tasks (snake_case, как в Postgres). См. resources/aura/supabase/*.sql. */
export interface ISupabaseTaskRow {
	id: string;
	project: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	assignee: string | null;
	branch: string | null;
	sort_order: number;
	created_at: string;
	updated_at: string;
}

export interface ISupabaseConfig {
	readonly url: string;
	readonly anonKey: string;
	/** Идентификатор проекта — по нему изолируются доски разных репозиториев в одной базе. */
	readonly project: string;
}

const PRIORITIES: readonly AuraTaskPriority[] = ['high', 'medium', 'low'];

export function taskToRow(task: IAuraTask, project: string): ISupabaseTaskRow {
	return {
		id: task.id,
		project,
		title: task.title,
		description: task.description,
		status: task.status,
		priority: task.priority,
		assignee: task.assignee ?? null,
		branch: task.branch ?? null,
		sort_order: task.order,
		created_at: new Date(task.createdAt).toISOString(),
		updated_at: new Date(task.updatedAt).toISOString(),
	};
}

/** Строка → задача; битые статусы/приоритеты нормализуются, мусор без id/title отбрасывается. */
export function rowToTask(row: Partial<ISupabaseTaskRow> | null | undefined): IAuraTask | undefined {
	if (!row || typeof row.id !== 'string' || typeof row.title !== 'string') {
		return undefined;
	}
	const status = AURA_TASK_STATUSES.includes(row.status as AuraTaskStatus) ? row.status as AuraTaskStatus : 'backlog';
	const priority = PRIORITIES.includes(row.priority as AuraTaskPriority) ? row.priority as AuraTaskPriority : 'medium';
	const createdAt = row.created_at ? Date.parse(row.created_at) : NaN;
	const updatedAt = row.updated_at ? Date.parse(row.updated_at) : NaN;
	return {
		id: row.id,
		title: row.title,
		description: typeof row.description === 'string' ? row.description : '',
		status,
		priority,
		assignee: row.assignee ?? undefined,
		branch: row.branch ?? undefined,
		order: typeof row.sort_order === 'number' ? row.sort_order : 0,
		createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
		updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
	};
}

/**
 * Слияние локальных и серверных задач: побеждает более поздний updatedAt.
 * Удаления на сервере отражены отсутствием строки — такие локальные задачи считаются удалёнными,
 * только если они были известны серверу раньше (см. knownRemoteIds).
 */
export function mergeTasks(local: readonly IAuraTask[], remote: readonly IAuraTask[], knownRemoteIds: ReadonlySet<string>): IAuraTask[] {
	const byId = new Map<string, IAuraTask>();
	for (const t of remote) {
		byId.set(t.id, t);
	}
	for (const t of local) {
		const r = byId.get(t.id);
		if (!r) {
			if (!knownRemoteIds.has(t.id)) {
				byId.set(t.id, t); // локальная новая — ещё не отправлена
			}
			continue;
		}
		if (t.updatedAt > r.updatedAt) {
			byId.set(t.id, t);
		}
	}
	return [...byId.values()];
}

export type SupabaseRealtimeEvent =
	| { type: 'upsert'; task: IAuraTask }
	| { type: 'delete'; id: string };

/** Разбор сообщения канала postgres_changes; чужие таблицы и мусор дают undefined. */
export function parseRealtimeMessage(raw: string): SupabaseRealtimeEvent | undefined {
	let msg: { event?: unknown; payload?: { data?: { table?: unknown; type?: unknown; record?: unknown; old_record?: unknown } } };
	try {
		msg = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (msg.event !== 'postgres_changes') {
		return undefined;
	}
	const data = msg.payload?.data;
	if (data?.table !== SUPABASE_TASKS_TABLE) {
		return undefined;
	}
	if (data.type === 'DELETE') {
		const old = data.old_record as { id?: unknown } | undefined;
		return typeof old?.id === 'string' ? { type: 'delete', id: old.id } : undefined;
	}
	if (data.type === 'INSERT' || data.type === 'UPDATE') {
		const task = rowToTask(data.record as Partial<ISupabaseTaskRow>);
		return task ? { type: 'upsert', task } : undefined;
	}
	return undefined;
}

/** Realtime-подписка на таблицу проекта (формат phoenix-канала Supabase). */
export function realtimeJoinMessage(project: string, ref: number): string {
	return JSON.stringify({
		topic: `realtime:aura:${project}`,
		event: 'phx_join',
		payload: {
			config: {
				postgres_changes: [{ event: '*', schema: 'public', table: SUPABASE_TASKS_TABLE, filter: `project=eq.${project}` }],
			},
		},
		ref: String(ref),
	});
}

export function realtimeHeartbeat(ref: number): string {
	return JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(ref) });
}

/** REST-адрес таблицы с фильтром по проекту. */
export function restTasksUrl(config: ISupabaseConfig): string {
	return `${config.url.replace(/\/+$/, '')}/rest/v1/${SUPABASE_TASKS_TABLE}?project=eq.${encodeURIComponent(config.project)}&select=*`;
}

export function realtimeUrl(config: ISupabaseConfig): string {
	const base = config.url.replace(/\/+$/, '').replace(/^http/, 'ws');
	return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(config.anonKey)}&vsn=1.0.0`;
}

export function restHeaders(config: ISupabaseConfig): Record<string, string> {
	return {
		'apikey': config.anonKey,
		'Authorization': `Bearer ${config.anonKey}`,
		'Content-Type': 'application/json',
		'Prefer': 'resolution=merge-duplicates,return=minimal',
	};
}
