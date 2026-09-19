/*---------------------------------------------------------------------------------------------
 *  Aura Teams — регистрация: вкладка доски, «Мои задачи» в сайдбаре, команды, настройки.
 *  Как и Aura API, активируется только после установки через Aura Market.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AuraTeamsEditorPane } from './auraTeamsEditorPane.js';
import { AuraTeamsEditorInput, AuraTeamsEditorInputSerializer } from './auraTeamsEditorInput.js';
import { AuraTeamsMyTasksView, AURA_TEAMS_OPEN_BOARD_COMMAND_ID } from './auraTeamsMyTasksView.js';
import { AURA_TEAMS_MEMBER_SETTING } from '../common/auraTeamsService.js';
import { IAuraTeamsGitService } from './auraTeamsGitService.js';
import { AuraTeamsSyncContribution, AURA_TEAMS_SUPABASE_URL_SETTING, AURA_TEAMS_SUPABASE_KEY_SETTING, AURA_TEAMS_SUPABASE_PROJECT_SETTING } from './auraTeamsSync.js';
import { auraMarketInstalledKey } from '../../auraMarket/common/auraMarketCatalog.js';

export const AURA_TEAMS_VIEW_CONTAINER_ID = 'workbench.view.auraTeams';
const AURA_TEAMS_MY_TASKS_VIEW_ID = 'auraTeams.myTasks';
const AURA_TEAMS_SHOW_MY_TASKS_COMMAND_ID = 'auraTeams.showMyTasks';
export const AURA_TEAMS_SMART_COMMIT_COMMAND_ID = 'auraTeams.smartCommit';
const AURA_TEAMS_CHECKPOINT_COMMAND_ID = 'auraTeams.createCheckpoint';
const AURA_TEAMS_RESTORE_COMMAND_ID = 'auraTeams.restoreCheckpoint';

export const auraTeamsViewIcon = registerIcon('aura-teams-view-icon', Codicon.organization, localize('auraTeamsViewIcon', 'Icon of the Aura Teams plugin.'));

let registered = false;

function registerAuraTeamsPlugin(): void {
	if (registered) { return; }
	registered = true;

	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(AuraTeamsEditorPane, AuraTeamsEditorPane.ID, localize('auraTeamsEditor', "Aura Teams")),
		[new SyncDescriptor(AuraTeamsEditorInput)]
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraTeamsEditorInput.ID, AuraTeamsEditorInputSerializer);

	const container = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
		id: AURA_TEAMS_VIEW_CONTAINER_ID,
		title: localize2('auraTeams', "Aura Teams"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_TEAMS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: auraTeamsViewIcon,
		hideIfEmpty: false,
		order: 8,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

	Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
		id: AURA_TEAMS_MY_TASKS_VIEW_ID,
		name: localize2('auraTeams.myTasks', "Мои задачи"),
		containerIcon: auraTeamsViewIcon,
		ctorDescriptor: new SyncDescriptor(AuraTeamsMyTasksView),
		canToggleVisibility: true,
		canMoveView: true,
	}], container);

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_TEAMS_OPEN_BOARD_COMMAND_ID,
				title: localize2('auraTeams.openBoard', "Aura Teams: Открыть канбан-доску"),
				category: localize2('auraTeams.category', "Aura Teams"),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const editorService = accessor.get(IEditorService);
			const instantiation = accessor.get(IInstantiationService);
			void editorService.openEditor(instantiation.createInstance(AuraTeamsEditorInput), { pinned: true });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_TEAMS_SHOW_MY_TASKS_COMMAND_ID,
				title: localize2('auraTeams.showMyTasks', "Aura Teams: Мои задачи"),
				category: localize2('auraTeams.category', "Aura Teams"),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			void accessor.get(IViewsService).openView(AURA_TEAMS_MY_TASKS_VIEW_ID, true);
		}
	});

	// --- Git: умный коммит, контрольные точки ---
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_TEAMS_SMART_COMMIT_COMMAND_ID,
				title: localize2('auraTeams.smartCommit', "Aura Teams: Умный коммит (сообщение по diff)"),
				category: localize2('auraTeams.category', "Aura Teams"),
				icon: Codicon.sparkle,
				f1: true,
				menu: [{ id: MenuId.SCMTitle, group: 'navigation', order: 1, when: ContextKeyExpr.equals('scmProvider', 'git') }],
			});
		}
		override run(accessor: ServicesAccessor, taskId?: string): Promise<void> {
			return accessor.get(IAuraTeamsGitService).smartCommit(typeof taskId === 'string' ? taskId : undefined);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_TEAMS_CHECKPOINT_COMMAND_ID,
				title: localize2('auraTeams.checkpoint', "Aura Teams: Контрольная точка"),
				category: localize2('auraTeams.category', "Aura Teams"),
				icon: Codicon.bookmark,
				f1: true,
				menu: [{ id: MenuId.SCMTitle, group: 'navigation', order: 2, when: ContextKeyExpr.equals('scmProvider', 'git') }],
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IAuraTeamsGitService).createCheckpoint();
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_TEAMS_RESTORE_COMMAND_ID,
				title: localize2('auraTeams.restoreCheckpoint', "Aura Teams: Откатиться к контрольной точке"),
				category: localize2('auraTeams.category', "Aura Teams"),
				icon: Codicon.history,
				f1: true,
				menu: [{ id: MenuId.SCMTitle, group: 'navigation', order: 3, when: ContextKeyExpr.equals('scmProvider', 'git') }],
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IAuraTeamsGitService).restoreCheckpoint();
		}
	});
}

class AuraTeamsPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraTeamsPlugin';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (storageService.get(auraMarketInstalledKey('aura-teams'), StorageScope.APPLICATION, 'false') === 'true') {
			registerAuraTeamsPlugin();
			this._register(instantiationService.createInstance(AuraTeamsSyncContribution));
		}
	}
}

registerWorkbenchContribution2(AuraTeamsPluginContribution.ID, AuraTeamsPluginContribution, WorkbenchPhase.AfterRestored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'auraTeams',
	title: localize('auraTeams.config', "Aura Teams"),
	properties: {
		[AURA_TEAMS_MEMBER_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraTeams.memberName', "Ваше имя в команде. По нему собирается раздел «Мои задачи» и подставляется исполнитель при создании задачи."),
		},
		[AURA_TEAMS_SUPABASE_URL_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraTeams.supabase.url', "URL проекта Supabase (например `https://xyz.supabase.co` или адрес self-hosted). Вместе с `#auraTeams.supabase.anonKey#` включает синхронизацию доски между участниками. Схема таблицы — `resources/aura/supabase/001_aura_tasks.sql`."),
		},
		[AURA_TEAMS_SUPABASE_KEY_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraTeams.supabase.anonKey', "Публичный anon-ключ Supabase. Это не секрет уровня service_role: доступ ограничивают политики RLS из миграции."),
		},
		[AURA_TEAMS_SUPABASE_PROJECT_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraTeams.supabase.project', "Идентификатор доски в общей базе. По умолчанию — имя первой папки workspace; задайте явно, если участники открывают репозиторий под разными именами папок."),
		},
	},
});
