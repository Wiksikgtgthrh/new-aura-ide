/*---------------------------------------------------------------------------------------------
 *  Кэш read-only инструментов (Этап 5.3).
 *
 *  Ключ = (инструмент, каноничные аргументы, commit_sha, worktree_dirty_hash).
 *  TTL не нужен: ключ сам инвалидируется — новый коммит или грязное дерево
 *  дают другую строку, и старый ответ просто не находится.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logInfo, logWarn } from '../util/log';

/** Инструменты, чей результат зависит только от содержимого репозитория. */
export const CACHEABLE_TOOLS = new Set([
	'fs.readFile',
	'fs.listFiles',
	'fs.search',
	'grep',
	'symbols.list',
]);

export class ToolCache {
	private db?: DatabaseSync;
	private disabled = false;

	constructor(private readonly file: string) {}

	/** Ключ кэша: детерминированный sha256 по инструменту, аргументам и состоянию репо. */
	static key(tool: string, args: Record<string, unknown>, commit: string, dirty: string): string {
		const hash = createHash('sha256');
		hash.update(tool);
		hash.update('\n');
		hash.update(canonicalJson(args));
		hash.update('\n');
		hash.update(commit || '');
		hash.update('\n');
		hash.update(dirty || '');
		return hash.digest('hex');
	}

	private open(): DatabaseSync | undefined {
		if (this.db) {
			return this.db;
		}
		if (this.disabled) {
			return undefined;
		}
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const db = new DatabaseSync(this.file);
			db.exec('CREATE TABLE IF NOT EXISTS tool_cache (key TEXT PRIMARY KEY, tool TEXT NOT NULL, output TEXT NOT NULL, created_at INTEGER NOT NULL)');
			this.db = db;
			return db;
		} catch (err) {
			// Без SQLite (старый Node) кэш просто выключен — граф работает как прежде.
			this.disabled = true;
			logWarn(`tool cache disabled: ${err instanceof Error ? err.message : err}`);
			return undefined;
		}
	}

	get(key: string): string | undefined {
		const db = this.open();
		if (!db) {
			return undefined;
		}
		try {
			const row = db.prepare('SELECT output FROM tool_cache WHERE key = ?').get(key) as { output?: string } | undefined;
			return row?.output;
		} catch (err) {
			logWarn(`tool cache read failed: ${err instanceof Error ? err.message : err}`);
			return undefined;
		}
	}

	set(key: string, tool: string, output: string): void {
		const db = this.open();
		if (!db) {
			return;
		}
		try {
			db.prepare('INSERT OR REPLACE INTO tool_cache (key, tool, output, created_at) VALUES (?, ?, ?, ?)')
				.run(key, tool, output, Date.now());
		} catch (err) {
			logWarn(`tool cache write failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** Сколько записей в кэше — для диагностики и тестов. */
	size(): number {
		const db = this.open();
		if (!db) {
			return 0;
		}
		try {
			const row = db.prepare('SELECT COUNT(*) AS count FROM tool_cache').get() as { count?: number } | undefined;
			return Number(row?.count) || 0;
		} catch {
			return 0;
		}
	}

	clear(): void {
		const db = this.open();
		if (!db) {
			return;
		}
		try {
			db.exec('DELETE FROM tool_cache');
			logInfo('tool cache cleared');
		} catch (err) {
			logWarn(`tool cache clear failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	dispose(): void {
		try {
			this.db?.close();
		} catch {
			// Закрытие best-effort.
		}
		this.db = undefined;
	}
}

/** Каноничный JSON: ключи отсортированы, чтобы порядок свойств не менял ключ. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value ?? null);
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => canonicalJson(item)).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}
