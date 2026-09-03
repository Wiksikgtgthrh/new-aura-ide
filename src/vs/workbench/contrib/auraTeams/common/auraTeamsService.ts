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

export interface IAuraTeamsService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
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
}

export class AuraTeamsService extends Disposable implements IAuraTeamsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

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
		this.save();
		return task;
	}

	updateTask(id: string, patch: Partial<Omit<IAuraTask, 'id' | 'createdAt'>>): IAuraTask | undefined {
		const task = updateTask(this.board, id, patch, Date.now());
		if (task) {
			this.save();
		}
		return task;
	}

	moveTask(id: string, status: AuraTaskStatus, index?: number): IAuraTask | undefined {
		const task = moveTask(this.board, id, status, index, Date.now());
		if (task) {
			this.save();
		}
		return task;
	}

	removeTask(id: string): boolean {
		const removed = removeTask(this.board, id);
		if (removed) {
			this.save();
		}
		return removed;
	}

	private save(): void {
		this.storageService.store(STORAGE_BOARD, JSON.stringify(this.board), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}
}

registerSingleton(IAuraTeamsService, AuraTeamsService, InstantiationType.Delayed);
