/*---------------------------------------------------------------------------------------------
 *  Мост к расширению Aura Team. Оркестратор НЕ зависит от него на этапе сборки:
 *  публичный API ищется через vscode.extensions.getExtension и проверяется по apiVersion.
 *  Нет плагина, старая версия, битый exports, упавший activate — мост молча выключен,
 *  всё остальное в оркестраторе работает как раньше.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { logWarn } from '../util/log';
import { normalizeTaskTitle, type TeamBoardTask, type TeamTaskStatus } from './sync';

/** Версия публичного API Aura Team, которую понимает оркестратор. */
export const TEAM_API_VERSION = 1;
const TEAM_EXTENSION_ID = 'aura.aura-team';

/** Снимок доски — только то, что читает оркестратор. */
export interface TeamBoardSnapshot {
	members?: Array<{ id: string; displayName: string }>;
	tasks: TeamBoardTask[];
}

/** Расход команды (Этап 5.1) — только если Team API его отдаёт. */
export interface TeamUsageSnapshot {
	perUser?: Array<{ userId?: string; name?: string; requests?: number }>;
	perDay?: Array<{ day?: string; requests?: number }>;
}

/** Публичный API Team, объявленный структурно: импорт из чужого расширения не нужен. */
export interface TeamPublicApi {
	readonly apiVersion: number;
	getSession(): { user?: { id: string }; teams?: Array<{ id: string; name?: string }> } | undefined;
	getBoard(teamId: string): Promise<TeamBoardSnapshot>;
	updateTask(teamId: string, taskId: string, changes: Record<string, unknown>): Promise<unknown>;
	onDidChangeBoard(listener: (board: TeamBoardSnapshot | undefined) => void): { dispose(): void };
	listApiKeys(teamId: string): Promise<unknown[]>;
	createProxyToken(teamId: string, provider: string, model: string): Promise<{ id: string; token: string }>;
	/** Необязательный метод: старый apiVersion 1 его не имеет — тогда просто нет цифр. */
	getUsage?(teamId: string, days?: number): Promise<TeamUsageSnapshot | undefined>;
	/** Необязательный метод: без него форму «своя задача» панель честно закроет отказом. */
	createTask?(teamId: string, title: string, status?: TeamTaskStatus): Promise<{ id?: string } | undefined>;
}

function looksCompatible(value: unknown): value is TeamPublicApi {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const api = value as Partial<TeamPublicApi>;
	return api.apiVersion === TEAM_API_VERSION
		&& typeof api.getBoard === 'function'
		&& typeof api.updateTask === 'function'
		&& typeof api.onDidChangeBoard === 'function';
}

/**
 * Живой мост к Team. Создаётся один раз; `resolve()` идемпотентен и безопасен
 * при отсутствии плагина.
 */
export class TeamBridge implements vscode.Disposable {
	private api?: TeamPublicApi;
	private teamId?: string;
	private boardSub?: vscode.Disposable;
	private resolved = false;

	private readonly boardEmitter = new vscode.EventEmitter<TeamBoardSnapshot | undefined>();
	/** Шлётся при каждом обновлении доски (в т.ч. чужими правками через сервер). */
	readonly onDidChangeBoard = this.boardEmitter.event;

	private readonly availabilityEmitter = new vscode.EventEmitter<boolean>();
	/** true/false меняется только при resolve() — панель по нему показывает вкладку. */
	readonly onDidChangeAvailability = this.availabilityEmitter.event;

	/** Подключиться к Team (или тихо признать, что его нет). Возвращает доступность. */
	async resolve(): Promise<boolean> {
		if (this.resolved) {
			return this.available;
		}
		this.resolved = true;
		try {
			const extension = vscode.extensions.getExtension(TEAM_EXTENSION_ID);
			if (!extension) {
				this.availabilityEmitter.fire(false);
				return false;
			}
			const exported = extension.isActive ? extension.exports : await extension.activate();
			if (!looksCompatible(exported)) {
				logWarn('aura-team public API is missing or incompatible (apiVersion !== 1)');
				this.availabilityEmitter.fire(false);
				return false;
			}
			this.api = exported;
			this.boardSub = this.api.onDidChangeBoard(board => this.boardEmitter.fire(board));
			this.availabilityEmitter.fire(true);
			return true;
		} catch (err) {
			logWarn(`aura-team bridge failed: ${err instanceof Error ? err.message : err}`);
			this.availabilityEmitter.fire(false);
			return false;
		}
	}

	get available(): boolean {
		return Boolean(this.api);
	}

	/** Активная команда: первая из сессии пользователя. */
	private activeTeamId(): string | undefined {
		if (this.teamId) {
			return this.teamId;
		}
		try {
			this.teamId = this.api?.getSession()?.teams?.[0]?.id;
		} catch {
			this.teamId = undefined;
		}
		return this.teamId;
	}

	/** Доска активной команды. Ошибки сети не валят оркестратор — просто нет данных. */
	async getBoard(): Promise<TeamBoardSnapshot | undefined> {
		const teamId = this.activeTeamId();
		if (!this.api || !teamId) {
			return undefined;
		}
		try {
			return await this.api.getBoard(teamId);
		} catch (err) {
			logWarn(`team getBoard failed: ${err instanceof Error ? err.message : err}`);
			return undefined;
		}
	}

	/**
	 * Расход команды по людям — если Team его отдаёт. Метод необязательный:
	 * без него просто нет командных цифр, оркестратор работает как прежде.
	 */
	async getUsage(days = 14): Promise<TeamUsageSnapshot | undefined> {
		const teamId = this.activeTeamId();
		if (!this.api || !teamId || typeof this.api.getUsage !== 'function') {
			return undefined;
		}
		try {
			return await this.api.getUsage(teamId, days);
		} catch (err) {
			logWarn(`team getUsage failed: ${err instanceof Error ? err.message : err}`);
			return undefined;
		}
	}

	/**
	 * Завести задачу на доске команды (кнопка «Добавить задачу» в канбане панели).
	 * Возвращает id созданной задачи или undefined: нет плагина, нет команды, отказ сервера.
	 */
	async createTask(title: string, status: TeamTaskStatus): Promise<string | undefined> {
		const teamId = this.activeTeamId();
		const clean = normalizeTaskTitle(title);
		if (!this.api || !teamId || !clean || typeof this.api.createTask !== 'function') {
			return undefined;
		}
		try {
			const created = await this.api.createTask(teamId, clean, status);
			return typeof created?.id === 'string' ? created.id : undefined;
		} catch (err) {
			logWarn(`team createTask failed: ${err instanceof Error ? err.message : err}`);
			return undefined;
		}
	}

	/** Правка задачи на сервере команды (статус, описание). Возвращает false при сбое. */
	async updateTask(taskId: string, changes: Record<string, unknown>): Promise<boolean> {
		const teamId = this.activeTeamId();
		if (!this.api || !teamId) {
			return false;
		}
		try {
			await this.api.updateTask(teamId, taskId, changes);
			return true;
		} catch (err) {
			logWarn(`team updateTask ${taskId} failed: ${err instanceof Error ? err.message : err}`);
			return false;
		}
	}

	dispose(): void {
		this.boardSub?.dispose();
		this.boardEmitter.dispose();
		this.availabilityEmitter.dispose();
	}
}
