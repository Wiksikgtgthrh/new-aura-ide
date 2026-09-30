/*---------------------------------------------------------------------------------------------
 *  Aura ServerKit — встроенный плагин Aura Market (панель управления сервером).
 *  Иконка в activity bar живёт, пока плагин установлен и не отключён через Aura Market
 *  (IAuraPluginService). Клик по иконке открывает вкладку редактора с приложением
 *  ServerKit (расширение aura-serverkit).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
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
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuraPluginService } from '../../auraMarket/common/auraPluginService.js';
import { managePluginViewContainer } from '../../auraMarket/browser/auraPluginContainers.js';

export const AURA_SERVERKIT_OPEN_COMMAND_ID = 'auraServerkit.openDashboard';
export const AURA_SERVERKIT_VIEW_CONTAINER_ID = 'workbench.view.auraServerkit';
const AURA_SERVERKIT_LAUNCHER_VIEW_ID = 'auraServerkit.launcher';

// Иконка плагина (в activity bar и в заголовке вкладки)
export const auraServerkitViewIcon = registerIcon('aura-serverkit-view-icon', Codicon.server, localize('auraServerkitViewIcon', 'Icon of the ServerKit plugin.'));

// --- Иконка слева: клик = сразу открыть вкладку ServerKit и закрыть пустой сайдбар ---
class AuraServerkitLauncherViewPane extends ViewPane {
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
		@ICommandService private readonly commandService: ICommandService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Сразу открываем вкладку ServerKit и закрываем пустой сайдбар
		void this.commandService.executeCommand(AURA_SERVERKIT_OPEN_COMMAND_ID);
		void this.viewsService.closeViewContainer(AURA_SERVERKIT_VIEW_CONTAINER_ID);
	}
}

/**
 * Иконка плагина управляется состоянием Market: отключение/удаление дерегистрирует
 * контейнер без перезагрузки окна, включение/установка — возвращает.
 */
class AuraServerkitPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraServerkitPlugin';

	constructor(
		@IAuraPluginService pluginService: IAuraPluginService,
		@IPaneCompositePartService paneCompositePartService: IPaneCompositePartService,
		@IViewsService viewsService: IViewsService,
	) {
		super();
		this._register(managePluginViewContainer({
			pluginId: 'aura-serverkit',
			containerId: AURA_SERVERKIT_VIEW_CONTAINER_ID,
			title: localize2('auraServerkit', "ServerKit"),
			icon: auraServerkitViewIcon,
			order: 8,
			views: [{
				id: AURA_SERVERKIT_LAUNCHER_VIEW_ID,
				name: localize2('auraServerkit.launcher', "ServerKit"),
				containerIcon: auraServerkitViewIcon,
				ctorDescriptor: new SyncDescriptor(AuraServerkitLauncherViewPane),
				canToggleVisibility: true,
				canMoveView: true,
			}],
		}, pluginService, paneCompositePartService, viewsService));
	}
}

registerWorkbenchContribution2(AuraServerkitPluginContribution.ID, AuraServerkitPluginContribution, WorkbenchPhase.AfterRestored);
