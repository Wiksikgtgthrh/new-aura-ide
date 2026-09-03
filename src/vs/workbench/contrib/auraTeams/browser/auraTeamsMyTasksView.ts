/*---------------------------------------------------------------------------------------------
 *  Aura Teams — «Мои задачи» в сайдбаре: незакрытые задачи текущего участника.
 *--------------------------------------------------------------------------------------------*/

import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { IAuraTeamsService, AURA_TEAMS_MEMBER_SETTING } from '../common/auraTeamsService.js';
import { AURA_TASK_PRIORITY_LABEL, AURA_TASK_STATUS_LABEL, AuraTaskStatus } from '../common/auraTeamsModel.js';

export const AURA_TEAMS_OPEN_BOARD_COMMAND_ID = 'auraTeams.openBoard';

const NEXT_STATUS: Partial<Record<AuraTaskStatus, AuraTaskStatus>> = { backlog: 'inProgress', inProgress: 'review', review: 'done' };

export class AuraTeamsMyTasksView extends ViewPane {

	private listEl!: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAuraTeamsService private readonly teams: IAuraTeamsService,
		@ICommandService private readonly commandService: ICommandService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.teams.onDidChange(() => this.renderTasks()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aura-teams-my'));
		this.listEl = append(root, $('.aura-teams-my-list'));
		this.renderTasks();
	}

	private renderTasks(): void {
		if (!this.listEl) { return; }
		this.renderDisposables.clear();
		this.listEl.textContent = '';

		if (!this.teams.memberName) {
			const empty = append(this.listEl, $('.aura-teams-my-empty'));
			append(empty, $('p')).textContent = 'Укажите своё имя, чтобы видеть здесь свои задачи.';
			const btn = append(empty, $('button.aura-teams-btn')) as HTMLButtonElement;
			btn.textContent = 'Указать имя';
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => {
				void this.preferencesService.openSettings({ query: AURA_TEAMS_MEMBER_SETTING });
			}));
			return;
		}

		const tasks = this.teams.myTasks();
		if (tasks.length === 0) {
			const empty = append(this.listEl, $('.aura-teams-my-empty'));
			append(empty, $('p')).textContent = `У ${this.teams.memberName} нет открытых задач.`;
			const btn = append(empty, $('button.aura-teams-btn.secondary')) as HTMLButtonElement;
			btn.textContent = 'Открыть доску';
			this.renderDisposables.add(addDisposableListener(btn, EventType.CLICK, () => void this.commandService.executeCommand(AURA_TEAMS_OPEN_BOARD_COMMAND_ID)));
			return;
		}

		for (const task of tasks) {
			const row = append(this.listEl, $('.aura-teams-my-row'));
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			row.title = task.description || task.title;
			append(row, $(`span.aura-teams-priority.priority-${task.priority}`)).title = AURA_TASK_PRIORITY_LABEL[task.priority];
			const text = append(row, $('.aura-teams-my-text'));
			append(text, $('span.aura-teams-my-title')).textContent = task.title;
			append(text, $('span.aura-teams-my-status')).textContent = AURA_TASK_STATUS_LABEL[task.status];

			const next = NEXT_STATUS[task.status];
			if (next) {
				const advance = append(row, $('button.aura-teams-icon-btn.codicon.codicon-arrow-right')) as HTMLButtonElement;
				advance.title = `В «${AURA_TASK_STATUS_LABEL[next]}»`;
				advance.setAttribute('aria-label', advance.title);
				this.renderDisposables.add(addDisposableListener(advance, EventType.CLICK, e => {
					e.stopPropagation();
					this.teams.moveTask(task.id, next);
				}));
			}

			const open = () => void this.commandService.executeCommand(AURA_TEAMS_OPEN_BOARD_COMMAND_ID);
			this.renderDisposables.add(addDisposableListener(row, EventType.CLICK, open));
			this.renderDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					open();
				}
			}));
		}
	}
}
