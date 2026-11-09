/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — URL панели и проверка её доступности.
 *  Контракт оригинала (jhd3197/ServerKit): GET /api/v1/system/health отвечает
 *  {"service":"serverkit-api","status":"healthy",...} и не требует авторизации.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const DEFAULT_SERVER_URL = 'https://serverkit.auraide.xyz';

export interface ServerStatus {
	ok: boolean;
	/** undefined — запрос не дошёл до сервера (сеть, DNS, TLS). */
	code?: number;
	/** Версия бэкенда, если сервер её сообщает. */
	version?: string;
	error?: string;
}

/** Настроенный адрес панели без хвостового слэша. */
export function serverUrl(): string {
	return vscode.workspace.getConfiguration('auraServerkit').get<string>('serverUrl', DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

/** Отдельный процесс vs iframe — проверяет, можно ли встроить панель во вкладку. */
export function isLoopback(url: string): boolean {
	return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
}

export async function probeServer(url: string, timeoutMs: number): Promise<ServerStatus> {
	const base = url.replace(/\/+$/, '');
	try {
		const response = await fetch(`${base}/api/v1/system/health`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: 'application/json' }
		});
		if (!response.ok) {
			return { ok: false, code: response.status };
		}
		const body = await response.json().catch(() => undefined) as { status?: string; version?: string } | undefined;
		// Бэкенд жив, но может быть в статусе миграции/обслуживания — панель от этого не «мертва».
		return { ok: true, code: response.status, version: typeof body?.version === 'string' ? body.version : undefined };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
