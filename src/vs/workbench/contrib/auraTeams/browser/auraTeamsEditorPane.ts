/*---------------------------------------------------------------------------------------------
 *  Aura Teams — канбан-доска: колонки по статусу, карточки, drag-and-drop, быстрое создание.
 *--------------------------------------------------------------------------------------------*/

import './media/auraTeams.css';
import { $, append, addDisposableListener, EventType, Dimension, isHTMLElement } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { AuraTeamsEditorInput } from './auraTeamsEditorInput.js';
import { IAuraTeamsService } from '../common/auraTeamsService.js';
import { IAuraTeamsGitService } from './auraTeamsGitService.js';
import { commitSubject } from '../common/auraTeamsGit.js';
import {
	AURA_TASK_PRIORITY_LABEL, AURA_TASK_STATUS_LABEL, AURA_TASK_STATUSES, AuraTaskPriority, AuraTaskStatus, IAuraTask, branchNameForTask,
} from '../common/auraTeamsModel.js';

const DRAG_MIME = 'application/x-aura-task-id';

export class AuraTeamsEditorPane extends EditorPane {

	static readonly ID = AuraTeamsEditorInput.ID;

	private rootEl!: HTMLElement;
	private boardEl!: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAuraTeamsService private readonly teams: IAuraTeamsService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IAuraTeamsGitService private readonly gitService: IAuraTeamsGitService,
	) {
		super(AuraTeamsEditorPane.ID, group, telemetryService, themeService, storageService);
		this._register(this.teams.onDidChange(() => this.render()));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.rootEl = append(parent, $('.aura-teams'));

		const header = append(this.rootEl, $('.aura-teams-header'));
		const titles = append(header, $('.aura-teams-titles'));
		append(titles, $('h2.aura-teams-title')).textContent = 'Aura Teams';
		append(titles, $('p.aura-teams-subtitle')).textContent = 'Канбан-доска проекта. Перетаскивайте карточки между колонками.';

		const actions = append(header, $('.aura-teams-header-actions'));
		this.mkButton(actions, '+ Задача', () => void this.createTaskFlow());
		this.mkButton(actions, 'Мои задачи', () => void this.commandService.executeCommand('auraTeams.showMyTasks'), true);

		this.boardEl = append(this.rootEl, $('.aura-teams-board'));
		this.render();
	}

	private mkButton(parent: HTMLElement, label: string, run: () => void, secondary = false): HTMLButtonElement {
		const b = append(parent, $(secondary ? 'button.aura-teams-btn.secondary' : 'button.aura-teams-btn')) as HTMLButtonElement;
		b.textContent = label;
		this._register(addDisposableListener(b, EventType.CLICK, run));
		return b;
	}

	private render(): void {
		if (!this.boardEl) { return; }
		this.renderDisposables.clear();
		this.boardEl.textContent = '';

		for (const status of AURA_TASK_STATUSES) {
			const tasks = this.teams.tasksInColumn(status);
			const column = append(this.boardEl, $('.aura-teams-column'));
			column.dataset.status = status;

			const head = append(column, $('.aura-teams-column-head'));
			append(head, $('span.aura-teams-column-title')).textContent = AURA_TASK_STATUS_LABEL[status];
			append(head, $('span.aura-teams-column-count')).textContent = String(tasks.length);
			const addBtn = append(head, $('button.aura-teams-icon-btn.codicon.codicon-add')) as HTMLButtonElement;
			addBtn.title = `Добавить в «${AURA_TASK_STATUS_LABEL[status]}»`;
			addBtn.setAttribute('aria-label', addBtn.title);
			this.renderDisposables.add(addDisposableListener(addBtn, EventType.CLICK, () => void this.createTaskFlow(status)));

			const list = append(column, $('.aura-teams-column-list'));
			this.wireDropZone(list, status);

			if (tasks.length === 0) {
				append(list, $('.aura-teams-column-empty')).textContent = status === 'backlog'
					? 'Пока пусто. Нажмите «+ Задача».'
					: 'Перетащите карточку сюда.';
			}
			for (const task of tasks) {
				this.renderCard(list, task);
			}
		}
	}

	private renderCard(parent: HTMLElement, task: IAuraTask): void {
		const card = append(parent, $('.aura-teams-card'));
		card.draggable = true;
		card.dataset.taskId = task.id;
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.setAttribute('aria-label', `${task.title}, ${AURA_TASK_PRIORITY_LABEL[task.priority]} приоритет${task.assignee ? `, исполнитель ${task.assignee}` : ''}`);

		const top = append(card, $('.aura-teams-card-top'));
		append(top, $(`span.aura-teams-priority.priority-${task.priority}`)).title = `Приоритет: ${AURA_TASK_PRIORITY_LABEL[task.priority]}`;
		append(top, $('span.aura-teams-card-title')).textContent = task.title;

		if (task.description) {
			append(card, $('.aura-teams-card-desc')).textContent = task.description;
		}

		const meta = append(card, $('.aura-teams-card-meta'));
		if (task.assignee) {
			const who = append(meta, $('span.aura-teams-chip'));
			append(who, $('span.codicon.codicon-account'));
			append(who, $('span')).textContent = task.assignee;
		}
		if (task.branch) {
			const br = append(meta, $('span.aura-teams-chip.branch'));
			append(br, $('span.codicon.codicon-git-branch'));
			append(br, $('span')).textContent = task.branch;
			br.title = 'Переключиться на ветку задачи';
			this.renderDisposables.add(addDisposableListener(br, EventType.CLICK, e => {
				e.stopPropagation();
				void this.checkoutBranch(task);
			}));
		}

		const open = () => void this.editTaskFlow(task);
		this.renderDisposables.add(addDisposableListener(card, EventType.CLICK, open));
		this.renderDisposables.add(addDisposableListener(card, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				open();
			}
		}));
		this.renderDisposables.add(addDisposableListener(card, EventType.DRAG_START, (e: DragEvent) => {
			e.dataTransfer?.setData(DRAG_MIME, task.id);
			if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; }
			card.classList.add('dragging');
		}));
		this.renderDisposables.add(addDisposableListener(card, EventType.DRAG_END, () => card.classList.remove('dragging')));
	}

	private wireDropZone(list: HTMLElement, status: AuraTaskStatus): void {
		this.renderDisposables.add(addDisposableListener(list, EventType.DRAG_OVER, (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes(DRAG_MIME)) { return; }
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
			list.classList.add('drop-target');
		}));
		this.renderDisposables.add(addDisposableListener(list, EventType.DRAG_LEAVE, () => list.classList.remove('drop-target')));
		this.renderDisposables.add(addDisposableListener(list, EventType.DROP, (e: DragEvent) => {
			list.classList.remove('drop-target');
			const id = e.dataTransfer?.getData(DRAG_MIME);
			if (!id) { return; }
			e.preventDefault();
			// позиция вставки — перед первой карточкой, чей центр ниже курсора
			const cards = Array.from(list.children).filter((el): el is HTMLElement => isHTMLElement(el) && !!el.dataset.taskId && el.dataset.taskId !== id);
			let index = cards.length;
			for (let i = 0; i < cards.length; i++) {
				const rect = cards[i].getBoundingClientRect();
				if (e.clientY < rect.top + rect.height / 2) { index = i; break; }
			}
			this.teams.moveTask(id, status, index);
		}));
	}

	// --- Потоки создания/редактирования через QuickInput ---

	private async createTaskFlow(status: AuraTaskStatus = 'backlog'): Promise<void> {
		const title = await this.quickInputService.input({ prompt: 'Название задачи', placeHolder: 'Что нужно сделать?' });
		if (!title?.trim()) { return; }
		const priority = await this.pickPriority('medium');
		if (!priority) { return; }
		const assignee = await this.quickInputService.input({ prompt: 'Исполнитель (опц.)', value: this.teams.memberName });
		if (assignee === undefined) { return; }
		this.teams.createTask({ title, status, priority, assignee });
	}

	private async editTaskFlow(task: IAuraTask): Promise<void> {
		type Action = 'title' | 'desc' | 'priority' | 'assignee' | 'status' | 'branch' | 'commit' | 'history' | 'revert' | 'delete';
		const picked = await this.quickInputService.pick<{ label: string; description?: string; id: Action }>([
			{ label: '$(edit) Переименовать', description: task.title, id: 'title' },
			{ label: '$(note) Описание', description: task.description || '—', id: 'desc' },
			{ label: '$(flame) Приоритет', description: AURA_TASK_PRIORITY_LABEL[task.priority], id: 'priority' },
			{ label: '$(account) Исполнитель', description: task.assignee || '—', id: 'assignee' },
			{ label: '$(arrow-right) Переместить в колонку', description: AURA_TASK_STATUS_LABEL[task.status], id: 'status' },
			{ label: '$(git-branch) Ветка задачи', description: task.branch || 'создать и переключиться', id: 'branch' },
			{ label: '$(sparkle) Умный коммит по задаче', description: 'сообщение по diff + трейлер Aura-Task', id: 'commit' },
			{ label: '$(history) История задачи', description: 'коммиты с трейлером Aura-Task', id: 'history' },
			{ label: '$(discard) Откатить задачу', description: 'обратные коммиты на всю историю задачи', id: 'revert' },
			{ label: '$(trash) Удалить', id: 'delete' },
		], { title: task.title, placeHolder: 'Что изменить?' });
		if (!picked) { return; }
		switch (picked.id) {
			case 'title': {
				const v = await this.quickInputService.input({ prompt: 'Название', value: task.title });
				if (v?.trim()) { this.teams.updateTask(task.id, { title: v.trim() }); }
				break;
			}
			case 'desc': {
				const v = await this.quickInputService.input({ prompt: 'Описание', value: task.description });
				if (v !== undefined) { this.teams.updateTask(task.id, { description: v.trim() }); }
				break;
			}
			case 'priority': {
				const p = await this.pickPriority(task.priority);
				if (p) { this.teams.updateTask(task.id, { priority: p }); }
				break;
			}
			case 'assignee': {
				const v = await this.quickInputService.input({ prompt: 'Исполнитель', value: task.assignee ?? this.teams.memberName });
				if (v !== undefined) { this.teams.updateTask(task.id, { assignee: v.trim() || undefined }); }
				break;
			}
			case 'status': {
				const s = await this.quickInputService.pick(
					AURA_TASK_STATUSES.map(st => ({ label: AURA_TASK_STATUS_LABEL[st], id: st, picked: st === task.status })),
					{ placeHolder: 'Колонка' },
				);
				if (s) { this.teams.moveTask(task.id, s.id as AuraTaskStatus); }
				break;
			}
			case 'branch':
				await this.checkoutBranch(task);
				break;
			case 'commit':
				await this.gitService.smartCommit(task.id);
				break;
			case 'history':
				await this.showTaskHistory(task);
				break;
			case 'revert':
				await this.gitService.revertTask(task.id);
				break;
			case 'delete': {
				const { confirmed } = await this.dialogService.confirm({ message: `Удалить задачу «${task.title}»?`, primaryButton: 'Удалить', type: 'warning' });
				if (confirmed) { this.teams.removeTask(task.id); }
				break;
			}
		}
	}

	private async pickPriority(current: AuraTaskPriority): Promise<AuraTaskPriority | undefined> {
		const p = await this.quickInputService.pick(
			(['high', 'medium', 'low'] as AuraTaskPriority[]).map(v => ({ label: AURA_TASK_PRIORITY_LABEL[v], id: v, picked: v === current })),
			{ placeHolder: 'Приоритет' },
		);
		return p?.id as AuraTaskPriority | undefined;
	}

	private async showTaskHistory(task: IAuraTask): Promise<void> {
		const commits = await this.gitService.taskHistory(task.id);
		if (commits.length === 0) {
			this.notificationService.info(`У задачи «${task.title}» пока нет коммитов. Сделайте «Умный коммит по задаче» — он добавит трейлер Aura-Task.`);
			return;
		}
		const picked = await this.quickInputService.pick(
			commits.map(c => ({
				label: commitSubject(c.message),
				description: c.hash.slice(0, 7),
				detail: [c.authorName, c.authorDate ? new Date(c.authorDate).toLocaleString() : undefined].filter(Boolean).join(' · '),
				hash: c.hash,
			})),
			{ title: `История: ${task.title}`, placeHolder: 'Открыть коммит в Git Graph', matchOnDescription: true },
		);
		if (picked) {
			await this.commandService.executeCommand('git.viewCommit', undefined, picked.hash).then(undefined, () => undefined);
		}
	}

	/** Ветка задачи: если есть — переключаемся штатной командой git; иначе создаём через терминал. */
	private async checkoutBranch(task: IAuraTask): Promise<void> {
		const branch = task.branch ?? branchNameForTask(task.title, task.id);
		try {
			const ok = await this.commandService.executeCommand<boolean>('git.checkout', undefined, branch);
			if (ok !== false) {
				this.teams.updateTask(task.id, { branch });
				return;
			}
		} catch {
			// ветки ещё нет — создаём ниже
		}
		try {
			await this.commandService.executeCommand('workbench.action.terminal.sendSequence', { text: `git checkout -b ${branch}\n` });
			this.teams.updateTask(task.id, { branch });
			this.notificationService.info(`Создаю ветку ${branch} в терминале.`);
		} catch (e) {
			this.notificationService.warn(`Не удалось создать ветку: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	override layout(_dimension: Dimension): void {
		// Колонки резиновые (flex), перерисовка по размеру не требуется.
	}
}
