/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BoardSnapshot, DeviceAuthorization, Session, TaskStatus, TeamApiKey, TeamTask, Tokens } from '../types';

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
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers }
		});
		if (response.status === 401 && authenticated && retry && await this.refreshTokens()) {
			return this.request(path, init, authenticated, false);
		}
		if (!response.ok) {
			const body = await response.json().catch(() => ({})) as ApiErrorBody;
			throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
		}
		return response.status === 204 ? undefined as T : await response.json() as T;
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

	async downloadArchive(teamId: string, archiveId: string, retry = true): Promise<Uint8Array> {
		const token = await this.context.secrets.get('auraTeam.accessToken');
		const response = await fetch(`${this.baseUrl}/v1/teams/${teamId}/archives/${archiveId}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
		if (response.status === 401 && retry && await this.refreshTokens()) { return this.downloadArchive(teamId, archiveId, false); }
		if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
		return new Uint8Array(await response.arrayBuffer());
	}

	getSession(): Promise<Session> { return this.request('/v1/me'); }
	getBoard(teamId: string): Promise<BoardSnapshot> { return this.request(`/v1/teams/${teamId}/board`); }
	createTeam(name: string): Promise<void> { return this.request('/v1/teams', { method: 'POST', body: JSON.stringify({ name }) }); }
	joinTeam(code: string): Promise<void> { return this.request('/v1/invites/accept', { method: 'POST', body: JSON.stringify({ code }) }); }
	createInvite(teamId: string): Promise<{ code: string }> { return this.request(`/v1/teams/${teamId}/invites`, { method: 'POST', body: '{}' }); }
	changeRole(teamId: string, memberId: string, role: string): Promise<void> { return this.request(`/v1/teams/${teamId}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify({ role }) }); }
	createProject(teamId: string, name: string, gitUrl: string, defaultBranch: string): Promise<void> { return this.request(`/v1/teams/${teamId}/projects`, { method: 'POST', body: JSON.stringify({ name, gitUrl, defaultBranch }) }); }
	createTask(teamId: string, title: string, status: TaskStatus = 'todo'): Promise<TeamTask> { return this.request(`/v1/teams/${teamId}/tasks`, { method: 'POST', body: JSON.stringify({ title, status }) }); }
	storeApiKey(teamId: string, provider: string, value: string, accessRole: string, label: string, priority: number): Promise<void> { return this.request(`/v1/teams/${teamId}/keys`, { method: 'POST', body: JSON.stringify({ provider, value, accessRole, label, priority }) }); }
	listApiKeys(teamId: string): Promise<TeamApiKey[]> { return this.request(`/v1/teams/${teamId}/keys`); }
	disableApiKey(teamId: string, keyId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/keys/${keyId}`, { method: 'DELETE' }); }
	uploadArchive(teamId: string, name: string, projectName: string, bytes: Uint8Array): Promise<{ id: string; projectId: string; expiresAt: string }> {
		const form = new FormData();
		form.append('file', new Blob([bytes]), name);
		return this.request(`/v1/teams/${teamId}/archives?projectName=${encodeURIComponent(projectName)}`, { method: 'POST', body: form });
	}
	createProxyToken(teamId: string, provider: string, model: string): Promise<{ id: string; token: string }> { return this.request(`/v1/teams/${teamId}/proxy-tokens`, { method: 'POST', body: JSON.stringify({ provider, model }) }); }
	revokeProxyToken(teamId: string, tokenId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/proxy-tokens/${tokenId}`, { method: 'DELETE' }); }
	reportCommit(teamId: string, commitHash: string, repositoryUrl: string, message: string): Promise<void> { return this.request(`/v1/teams/${teamId}/commits`, { method: 'POST', body: JSON.stringify({ commitHash, repositoryUrl, message }) }); }
	getServerUrl(): string { return this.baseUrl; }
	transferProject(teamId: string, projectId: string, ownerMemberId: string): Promise<void> { return this.request(`/v1/teams/${teamId}/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ ownerMemberId }) }); }
	updateTask(teamId: string, taskId: string, changes: { status?: TaskStatus; position?: number; assigneeId?: string | null }): Promise<TeamTask> {
		return this.request(`/v1/teams/${teamId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(changes) });
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
