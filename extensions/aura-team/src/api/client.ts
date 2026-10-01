/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AdminOverview, AdminTeamRow, AdminUserRow, AgggAgentBundle, BoardSnapshot, DeviceAuthorization, GatedFeature, KeyGroup, Session, TaskStatus, TeamActivityEvent, TeamApiKey, TeamApiKeyChanges, TeamSummary, TeamTask, TeamRole, Tokens } from '../types';
import { contentTypeHeader } from './headers';
import { fileNameFromDisposition } from './disposition';

interface ApiErrorBody { error?: string; message?: string; }

export class AuraApiClient implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private socket: WebSocket | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private reconnectDelay = 1_000;
	private connectedTeamId: string | undefined;
	private disposed = false;
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) { }

	dispose(): void {
		this.disposed = true;
		this.connectedTeamId = undefined;
		this.socket?.close();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		this.changeEmitter.dispose();
	}

	private get baseUrl(): string {
		const value = vscode.workspace.getConfiguration('auraTeam').get<string>('serverUrl', 'https://auraide.xyz').replace(/\/$/, '');
		const url = new URL(value);
		// Разрешаем HTTP для localhost и IP-адресов (частные серверы в разработке); для доменов
		// требуем HTTPS. Предупреждаем, но не блокируем — иначе нельзя работать по `http://ip:port`.
		const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
		if (url.protocol !== 'https:' && !isLocal) {
			this.output.appendLine(`[api] Warning: ${value} uses plain HTTP; tokens travel unencrypted.`);
		}
		return value;
	}

	private async request<T>(path: string, init: RequestInit = {}, authenticated = true, retry = true): Promise<T> {
		const token = authenticated ? await this.context.secrets.get('auraTeam.accessToken') : undefined;
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: { ...contentTypeHeader(init.body), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers }
			});
		} catch (error) {
			// «fetch failed» = сервер не отвечает. Пробуем поднять локальный и повторяем один раз.
			if (retry && await this.wakeLocalServer()) {
				return this.request(path, init, authenticated, false);
			}
			throw new Error(vscode.l10n.t('Team server is not reachable at {0}. Start it with: node scripts/start-local.mjs (in aura-team-server).', this.baseUrl));
		}
		if (response.status === 401 && authenticated && retry && await this.refreshTokens()) {
			return this.request(path, init, authenticated, false);
		}
		if (!response.ok) {
			const body = await response.json().catch(() => ({})) as ApiErrorBody;
			throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
		}
		if (response.status === 204) { return undefined as T; }
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** Локальный сервер не отвечает — пробуем поднять его скриптом start-local.mjs. */
	private async wakeLocalServer(): Promise<boolean> {
		const url = new URL(this.baseUrl);
		if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { return false; }
		// Ищем aura-team-server вверх по дереву каталогов от расширения.
		let dir = this.context.extensionPath;
		let serverRoot: string | undefined;
		for (let i = 0; i < 6 && dir; i++) {
			const candidate = join(dir, 'aura-team-server');
			if (existsSync(join(candidate, 'scripts', 'start-local.mjs'))) { serverRoot = candidate; break; }
			const parent = dirname(dir);
			if (parent === dir) { break; }
			dir = parent;
		}
		if (!serverRoot) { return false; }
		const child = spawn(process.execPath, [join(serverRoot, 'scripts', 'start-local.mjs')], { cwd: serverRoot, stdio: 'ignore', detached: true });
		child.unref();
		// Ждём до 10 секунд готовности.
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 500));
			const ok = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false);
			if (ok) { return true; }
		}
		return false;
	}

	private async refreshTokens(): Promise<boolean> {
		const refreshToken = await this.context.secrets.get('auraTeam.refreshToken');
		if (!refreshToken) { return false; }
		try {
			const tokens = await this.request<Tokens>('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false, false);
			await this.storeTokens(tokens);
			return true;
		} catch {
			await this.signOut();
			return false;
		}
	}

	startDeviceAuthorization(): Promise<DeviceAuthorization> {
		return this.request('/v1/auth/device', { method: 'POST', body: '{}' }, false);
	}

	pollDeviceAuthorization(deviceCode: string): Promise<Tokens | { pending: true }> {
		return this.request('/v1/auth/device/token', { method: 'POST', body: JSON.stringify({ deviceCode }) }, false);
	}

	async storeTokens(tokens: Tokens): Promise<void> {
		await Promise.all([
			this.context.secrets.store('auraTeam.accessToken', tokens.accessToken),
			this.context.secrets.store('auraTeam.refreshToken', tokens.refreshToken)
		]);
	}

	/** Вход по email и паролю: сервер проверяет пароль (argon2) и выдаёт токены. */
	async login(email: string, password: string): Promise<void> {
		const tokens = await this.request<Tokens>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
		await this.storeTokens(tokens);
	}

	/** Регистрация аккаунта на сервере. Пользователь должен верифицировать email до первого входа. */
	async register(email: string, password: string, displayName: string): Promise<{ ok: boolean; message: string }> {
		return this.request('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) }, false);
	}

	async changePassword(currentPassword: string, newPassword: string): Promise<void> {
		await this.request('/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
		await this.signOut();
	}

	async signOut(): Promise<void> {
		await Promise.all([
			this.context.secrets.delete('auraTeam.accessToken'),
			this.context.secrets.delete('auraTeam.refreshToken')
		]);
		this.connectedTeamId = undefined;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
		this.socket?.close();
	}

	/** Скачивание архива: отдаём и байты, и имя файла из заголовка — иначе диалог сохранения
	 *  предлагал имя проекта без расширения, а серверный RFC 5987-заголовок игнорировался. */
	async downloadArchive(teamId: string, archiveId: string, retry = true): Promise<{ bytes: Uint8Array; filename: string }> {
		const token = await this.context.secrets.get('auraTeam.accessToken');
		const response = await fetch(`${this.baseUrl}/v1/teams/${teamId}/archives/${archiveId}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
		if (response.status === 401 && retry && await this.refreshTokens()) { return this.downloadArchive(teamId, archiveId, false); }
		if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
		const filename = fileNameFromDisposition(response.headers.get('content-disposition'), 'archive.zip');
		return { bytes: new Uint8Array(await response.arrayBuffer()), filename };
	}

	getSession(): Promise<Session> { return this.request('/v1/me'); }

	/* ---------- Админ-панель: закрытые возможности ---------- */

	adminFeatures(): Promise<{ features: GatedFeature[]; roles: TeamRole[]; admins: AdminOverview['admins'] }> { return this.request('/v1/admin/features'); }

	adminDirectory(q = ''): Promise<{ users: AdminUserRow[]; teams: AdminTeamRow[]; features: GatedFeature[]; roles: TeamRole[] }> { return this.request(`/v1/admin/directory?q=${encodeURIComponent(q)}`); }

	adminGrants(): Promise<{ account: AdminOverview['account']; team: AdminOverview['team'] }> { return this.request('/v1/admin/grants'); }

	/** Погасить одноразовый код администратора. */
	adminRedeem(code: string): Promise<{ admin: boolean; features: string[] }> { return this.request('/v1/admin/redeem', { method: 'POST', body: JSON.stringify({ code }) }); }

	/** Выдать или отозвать право аккаунту либо команде (команда — с порогом роли). */
	adminGrant(input: { feature: string; kind: 'account' | 'team'; targetId: string; minRole?: TeamRole; note?: string; revoke?: boolean }): Promise<{ ok: boolean }> {
		return this.request('/v1/admin/grants', { method: 'POST', body: JSON.stringify(input) });
	}

	adminSetAdmin(email: string, revoke = false): Promise<{ ok: boolean; admin: boolean; email: string }> {
		return this.request('/v1/admin/admins', { method: 'POST', body: JSON.stringify({ email, revoke }) });
	}

	/** Внешнее ядро AGGG 5.2: отдаётся сервером только при выданном праве. */
	agggAgent(): Promise<AgggAgentBundle> { return this.request('/v1/aggg/agent'); }
	getBoard(teamId: string): Promise<BoardSnapshot> { return this.request(`/v1/teams/${teamId}/board`); }
	getActivity(teamId: string, limit = 12): Promise<TeamActivityEvent[]> { return this.request(`/v1/teams/${teamId}/activity?limit=${limit}`); }
	/** Удалить событие из ленты команды: сервер разрешает только owner/maintainer. */
	deleteActivity(teamId: string, eventId: number): Promise<void> { return this.request(`/v1/teams/${teamId}/activity/${eventId}`, { method: 'DELETE' }); }
	getSummary(teamId: string): Promise<TeamSummary> { return this.request(`/v1/teams/${teamId}/summary`); }
	createTeam(name: string): Promise<void> { return this.request('/v1/teams', { method: 'POST', body: JSON.stringify({ name }) }); }
	joinTeam(code: string): Promise<void> { return this.request('/v1/invites/accept', { method: 'POST', body: JSON.stringify({ code }) }); }
	/** role — с какой ролью вступят по коду (по умолчанию dev; maintainer выдаёт только владелец). */
	createInvite(teamId: string, role?: TeamRole): Promise<{ code: string; expiresAt?: string; role?: TeamRole }> { return this.request(`/v1/teams/${teamId}/invites`, { method: 'POST', body: JSON.stringify(role ? { role } : {}) }); }
	getCurrentInvite(teamId: string): Promise<{ code: string | null; expiresAt?: string | null; role?: TeamRole | null }> { return this.request(`/v1/teams/${teamId}/invite`); }
	revokeInvite(teamId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/invite`, { method: 'DELETE' }); }
	/** Персональное приглашение: роль по умолчанию dev. */
	sendInvite(teamId: string, userId: string, role?: TeamRole): Promise<{ ok: boolean }> { return this.request(`/v1/teams/${teamId}/invites/send`, { method: 'POST', body: JSON.stringify(role ? { userId, role } : { userId }) }); }
	directory(teamId: string, q = ''): Promise<Array<{ id: string; displayName: string; email: string | null; inTeam: number }>> { return this.request(`/v1/teams/${teamId}/directory?q=${encodeURIComponent(q)}`); }
	reorderTasks(teamId: string, status: TaskStatus, orderedIds: string[]): Promise<void> { return this.request(`/v1/teams/${teamId}/tasks/reorder`, { method: 'POST', body: JSON.stringify({ status, orderedIds }) }); }
	deleteTask(teamId: string, taskId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/tasks/${taskId}`, { method: 'DELETE' }); }
	restoreTask(teamId: string, taskId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/tasks/${taskId}/restore`, { method: 'PATCH', body: '{}' }); }
	/** Корзина: мягко удалённые задачи команды (для восстановления из канбана). */
	listDeletedTasks(teamId: string): Promise<Array<{ id: string; title: string; status: TaskStatus; deletedAt: string }>> { return this.request(`/v1/teams/${teamId}/tasks/trash`); }
	listArchives(teamId: string): Promise<Array<{ id: string; projectId?: string; projectName?: string; bytes: number; createdAt: string; expiresAt: string; createdBy?: string }>> { return this.request(`/v1/teams/${teamId}/archives`); }
	deleteArchive(teamId: string, archiveId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/archives/${archiveId}`, { method: 'DELETE' }); }
	changeRole(teamId: string, memberId: string, role: string): Promise<void> { return this.request(`/v1/teams/${teamId}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify({ role }) }); }
	removeMember(teamId: string, memberId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/members/${memberId}`, { method: 'DELETE' }); }
	fetchLimits(teamId: string): Promise<{ archiveMaxBytes: number; archiveTtlDays: number; proxyRequestsPerDay: number }> { return this.request(`/v1/teams/${teamId}/limits`); }
	checkAllKeys(teamId: string): Promise<Array<{ keyId: string; ok: boolean; status: number; pingMs: number; error?: string; limited?: boolean }>> { return this.request(`/v1/teams/${teamId}/keys/check`, { method: 'POST', body: '{}' }); }
	listProviders(teamId: string): Promise<Array<{ id: string; name: string; origin: string; builtin: boolean }>> { return this.request(`/v1/teams/${teamId}/providers`); }
	/** Регистрация openai-совместимого шлюза: нужна при импорте ключей со своим baseUrl. */
	createProvider(teamId: string, draft: { name: string; origin: string; authScheme: 'bearer'; allowedPaths: Array<{ method: string; path: string }>; probePath?: string }): Promise<{ id: string }> { return this.request(`/v1/teams/${teamId}/providers`, { method: 'POST', body: JSON.stringify(draft) }); }
	fetchUsage(teamId: string): Promise<{ limitPerUserPerDay: number; usedToday: number; remainingToday: number; perDay: Array<{ day: string; requests: number }>; perUser: Array<{ userId: string; name: string; requests: number }>; perKey: Array<{ keyId: string; label: string; provider: string; requests: number }> }> { return this.request(`/v1/teams/${teamId}/usage`); }
	createProject(teamId: string, name: string, gitUrl: string, defaultBranch: string): Promise<void> { return this.request(`/v1/teams/${teamId}/projects`, { method: 'POST', body: JSON.stringify({ name, gitUrl, defaultBranch }) }); }
	createTask(teamId: string, title: string, status: TaskStatus = 'todo', assigneeId?: string): Promise<TeamTask> { return this.request(`/v1/teams/${teamId}/tasks`, { method: 'POST', body: JSON.stringify({ title, status, ...(assigneeId ? { assigneeId } : {}) }) }); }
	storeApiKey(teamId: string, provider: string, value: string, accessRole: string, label: string, priority: number, groupId?: string, extra?: { baseUrl?: string; model?: string }): Promise<void> { return this.request(`/v1/teams/${teamId}/keys`, { method: 'POST', body: JSON.stringify({ provider, value, accessRole, label, priority, groupId, baseUrl: extra?.baseUrl, model: extra?.model }) }); }
	listApiKeys(teamId: string): Promise<TeamApiKey[]> { return this.request(`/v1/teams/${teamId}/keys`); }
	disableApiKey(teamId: string, keyId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/keys/${keyId}`, { method: 'DELETE' }); }
	enableApiKey(teamId: string, keyId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/keys/${keyId}/enable`, { method: 'POST', body: '{}' }); }
	deleteApiKey(teamId: string, keyId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/keys/${keyId}/remove`, { method: 'DELETE' }); }
	updateApiKey(teamId: string, keyId: string, changes: TeamApiKeyChanges): Promise<void> { return this.request(`/v1/teams/${teamId}/keys/${keyId}`, { method: 'PATCH', body: JSON.stringify(changes) }); }
	listKeyGroups(teamId: string): Promise<KeyGroup[]> { return this.request(`/v1/teams/${teamId}/key-groups`); }
	createKeyGroup(teamId: string, name: string, priority: number): Promise<KeyGroup> { return this.request(`/v1/teams/${teamId}/key-groups`, { method: 'POST', body: JSON.stringify({ name, priority }) }); }
	pingKey(teamId: string, keyId: string): Promise<{ ok: boolean; status: number; pingMs: number; error?: string; limited?: boolean }> { return this.request(`/v1/teams/${teamId}/keys/${keyId}/ping`, { method: 'POST', body: '{}' }); }
	uploadArchive(teamId: string, name: string, projectName: string, bytes: Uint8Array, projectId?: string): Promise<{ id: string; projectId: string; expiresAt: string }> {
		const form = new FormData();
		form.append('file', new Blob([bytes]), name);
		const qs = projectId ? `projectId=${encodeURIComponent(projectId)}` : `projectName=${encodeURIComponent(projectName)}`;
		return this.request(`/v1/teams/${teamId}/archives?${qs}`, { method: 'POST', body: form });
	}

	/**
	 * Стриминговая загрузка архива: файл не читается целиком в память (иначе большой
	 * архив положит extension host). Multipart собирается вручную поверх fs stream,
	 * прогресс — через onProgress(sentBytes, totalBytes).
	 */
	async uploadArchiveStream(teamId: string, filePath: string, projectName: string, projectId?: string, onProgress?: (sent: number, total: number) => void): Promise<{ id: string; projectId: string; expiresAt: string }> {
		const stat = statSync(filePath);
		const fileName = basename(filePath);
		const boundary = `----aura${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const qs = projectId ? `projectId=${encodeURIComponent(projectId)}` : `projectName=${encodeURIComponent(projectName)}`;
		const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/["\\]/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
		const tail = `\r\n--${boundary}--\r\n`;
		const pass = new PassThrough();
		let sent = 0;
		pass.write(head);
		const fileStream = createReadStream(filePath);
		fileStream.on('data', chunk => { sent += chunk.length; onProgress?.(sent, stat.size); });
		fileStream.on('error', error => pass.destroy(error));
		fileStream.on('end', () => { pass.end(tail); });
		fileStream.pipe(pass, { end: false });
		const webBody = (await import('node:stream')).Readable.toWeb(pass) as unknown as ReadableStream<Uint8Array>;
		return this.request(`/v1/teams/${teamId}/archives?${qs}`, {
			method: 'POST',
			body: webBody,
			duplex: 'half',
			// Multipart собирается вручную, поэтому boundary объявляем сами: без него
			// сервер разбирал поток как JSON.
			headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
		} as unknown as RequestInit);
	}
	createProxyToken(teamId: string, provider: string, model: string): Promise<{ id: string; token: string }> { return this.request(`/v1/teams/${teamId}/proxy-tokens`, { method: 'POST', body: JSON.stringify({ provider, model }) }); }
	revokeProxyToken(teamId: string, tokenId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/proxy-tokens/${tokenId}`, { method: 'DELETE' }); }
	reportCommit(teamId: string, commitHash: string, repositoryUrl: string, message: string): Promise<void> { return this.request(`/v1/teams/${teamId}/commits`, { method: 'POST', body: JSON.stringify({ commitHash, repositoryUrl, message }) }); }
	taskCommits(teamId: string, taskId: string): Promise<Array<{ hash: string; repositoryUrl: string; createdAt: string; author?: string }>> { return this.request(`/v1/teams/${teamId}/tasks/${taskId}/commits`); }
	taskHistory(teamId: string, taskId: string): Promise<Array<{ action: string; details: Record<string, unknown>; createdAt: string; userName: string }>> { return this.request(`/v1/teams/${teamId}/tasks/${taskId}/history`); }
	getServerUrl(): string { return this.baseUrl; }
	transferProject(teamId: string, projectId: string, ownerMemberId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ ownerMemberId }) }); }
	updateTask(teamId: string, taskId: string, changes: { status?: TaskStatus; position?: number; assigneeId?: string | null; title?: string; description?: string; dueAt?: string | null }): Promise<TeamTask> {
		// dueAt: undefined = «не менять», null = «очистить дедлайн» — важно для quick actions.
		const body: Record<string, unknown> = { ...changes };
		if (changes.dueAt === undefined) { delete body.dueAt; }
		return this.request(`/v1/teams/${teamId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(body) });
	}

	connect(teamId: string): void {
		if (this.connectedTeamId === teamId && this.socket && this.socket.readyState <= WebSocket.OPEN) { return; }
		this.connectedTeamId = teamId;
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
		this.socket?.close();
		void this.request<{ ticket: string }>(`/v1/teams/${teamId}/events-ticket`, { method: 'POST', body: '{}' }).then(({ ticket }) => {
			if (this.disposed || this.connectedTeamId !== teamId) { return; }
			const url = new URL(`/v1/teams/${teamId}/events`, this.baseUrl);
			url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
			url.searchParams.set('ticket', ticket);
			const socket = new WebSocket(url);
			this.socket = socket;
			socket.onopen = () => this.reconnectDelay = 1_000;
			socket.onmessage = () => this.changeEmitter.fire();
			socket.onclose = () => {
				if (this.socket !== socket || this.disposed || this.connectedTeamId !== teamId) { return; }
				this.socket = undefined;
				const delay = this.reconnectDelay;
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
				this.reconnectTimer = setTimeout(() => { this.connectedTeamId = undefined; this.connect(teamId); }, delay);
			};
			socket.onerror = event => this.output.appendLine(`[api] WebSocket error: ${String(event)}`);
		}).catch(error => {
			this.output.appendLine(`[api] WebSocket ticket failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!this.disposed && this.connectedTeamId === teamId) {
				this.changeEmitter.fire();
				const delay = this.reconnectDelay;
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
				this.reconnectTimer = setTimeout(() => { this.connectedTeamId = undefined; this.connect(teamId); }, delay);
			}
		});
	}
}
