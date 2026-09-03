/*---------------------------------------------------------------------------------------------
 *  Aura Teams — сервис доски: локальное хранение (workspace-scope) и события изменения.
 *  Этап «соло»: один участник, данные в IStorageService. Supabase Realtime подключится
 *  как второй источник поверх тех же операций.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	AuraTaskStatus, IAuraTask, IAuraTaskDraft, IAuraTeamsBoard,
	createTask, moveTask, myTasks, parseBoard, removeTask, tasksInColumn, updateTask,
} from './auraTeamsModel.js';

export const IAuraTeamsService = createDecorator<IAuraTeamsService>('auraTeamsService');

export const AURA_TEAMS_MEMBER_SETTING = 'auraTeams.memberName';

const STORAGE_BOARD = 'auraTeams.board';

/** Локальное изменение доски — для отправки на сервер синхронизации. */
export type AuraTeamsLocalChange =
	| { kind: 'upsert'; tasks: readonly IAuraTask[] }
	| { kind: 'remove'; id: string };

export interface IAuraTeamsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** Только локальные правки пользователя (не applyRemote) — источник для синхронизации. */
	readonly onDidChangeLocally: Event<AuraTeamsLocalChange>;
	/** Имя текущего участника из настройки auraTeams.memberName. */
	readonly memberName: string;
	getTasks(): readonly IAuraTask[];
	getTask(id: string): IAuraTask | undefined;
	tasksInColumn(status: AuraTaskStatus): IAuraTask[];
	myTasks(): IAuraTask[];
	createTask(draft: IAuraTaskDraft): IAuraTask;
	updateTask(id: string, patch: Partial<Omit<IAuraTask, 'id' | 'createdAt'>>): IAuraTask | undefined;
	moveTask(id: string, status: AuraTaskStatus, index?: number): IAuraTask | undefined;
	removeTask(id: string): boolean;
	/** Применить состояние с сервера: заменить доску целиком, не порождая onDidChangeLocally. */
	applyRemote(tasks: readonly IAuraTask[]): void;
	/** Точечное серверное событие. */
	applyRemoteUpsert(task: IAuraTask): void;
	applyRemoteRemove(id: string): void;
}

export class AuraTeamsService extends Disposable implements IAuraTeamsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeLocally = this._register(new Emitter<AuraTeamsLocalChange>());
	readonly onDidChangeLocally = this._onDidChangeLocally.event;

	private board: IAuraTeamsBoard;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.board = parseBoard(this.storageService.get(STORAGE_BOARD, StorageScope.WORKSPACE));
		this._register(this.storageService.onDidChangeValue(StorageScope.WORKSPACE, STORAGE_BOARD, this._store)(() => {
			// другое окно того же workspace изменило доску
			this.board = parseBoard(this.storageService.get(STORAGE_BOARD, StorageScope.WORKSPACE));
			this._onDidChange.fire();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AURA_TEAMS_MEMBER_SETTING)) {
				this._onDidChange.fire();
			}
		}));
	}

	get memberName(): string {
		return (this.configurationService.getValue<string>(AURA_TEAMS_MEMBER_SETTING) ?? '').trim();
	}

	getTasks(): readonly IAuraTask[] {
		return this.board.tasks;
	}

	getTask(id: string): IAuraTask | undefined {
		return this.board.tasks.find(t => t.id === id);
	}

	tasksInColumn(status: AuraTaskStatus): IAuraTask[] {
		return tasksInColumn(this.board, status);
	}

	myTasks(): IAuraTask[] {
		return myTasks(this.board, this.memberName);
	}

	createTask(draft: IAuraTaskDraft): IAuraTask {
		const task = createTask(this.board, draft, generateUuid(), Date.now());
		this.save({ kind: 'upsert', tasks: [task] });
		return task;
	}

	updateTask(id: string, patch: Partial<Omit<IAuraTask, 'id' | 'createdAt'>>): IAuraTask | undefined {
		const task = updateTask(this.board, id, patch, Date.now());
		if (task) {
			this.save({ kind: 'upsert', tasks: [task] });
		}
		return task;
	}

	moveTask(id: string, status: AuraTaskStatus, index?: number): IAuraTask | undefined {
		const before = new Map(this.board.tasks.map(t => [t.id, `${t.status}:${t.order}`]));
		const task = moveTask(this.board, id, status, index, Date.now());
		if (task) {
			// переиндексация задевает соседей — отправляем все задачи, у которых сменились колонка/порядок
			const touched = this.board.tasks.filter(t => before.get(t.id) !== `${t.status}:${t.order}`);
			this.save({ kind: 'upsert', tasks: touched });
		}
		return task;
	}

	removeTask(id: string): boolean {
		const removed = removeTask(this.board, id);
		if (removed) {
			this.save({ kind: 'remove', id });
		}
		return removed;
	}

	applyRemote(tasks: readonly IAuraTask[]): void {
		this.board = { version: 1, tasks: [...tasks] };
		this.persist();
	}

	applyRemoteUpsert(task: IAuraTask): void {
		const local = this.board.tasks.find(t => t.id === task.id);
		if (local && local.updatedAt > task.updatedAt) {
			return; // локальная правка свежее — сервер догонит нашим upsert
		}
		this.board.tasks = [...this.board.tasks.filter(t => t.id !== task.id), task];
		this.persist();
	}

	applyRemoteRemove(id: string): void {
		if (removeTask(this.board, id)) {
			this.persist();
		}
	}

	private save(change: AuraTeamsLocalChange): void {
		this.persist();
		this._onDidChangeLocally.fire(change);
	}

	private persist(): void {
		this.storageService.store(STORAGE_BOARD, JSON.stringify(this.board), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(IAuraTeamsService, AuraTeamsService, InstantiationType.Delayed);
