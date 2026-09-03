/*---------------------------------------------------------------------------------------------
 *  Aura Market — регистрация: иконка магазина слева, вкладка по центру.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { $, append, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { AuraMarketEditorPane } from './auraMarketEditorPane.js';
import { AuraMarketEditorInput, AuraMarketEditorInputSerializer } from './auraMarketEditorInput.js';

export const AURA_MARKET_OPEN_COMMAND_ID = 'auraMarket.open';
const AURA_MARKET_VIEW_CONTAINER_ID = 'workbench.view.auraMarket';
const AURA_MARKET_LAUNCHER_VIEW_ID = 'auraMarket.launcher';

// Иконка магазина (упаковка/витрина)
const auraMarketViewIcon = registerIcon('aura-market-view-icon', Codicon.package, localize('auraMarketViewIcon', 'View icon of the Aura Market view container.'));

// --- Центральная вкладка ---
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AuraMarketEditorPane, AuraMarketEditorPane.ID, localize('auraMarketEditor', "Aura Market")),
	[new SyncDescriptor(AuraMarketEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraMarketEditorInput.ID, AuraMarketEditorInputSerializer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AURA_MARKET_OPEN_COMMAND_ID,
			title: localize2('auraMarket.open', "Aura Market: Открыть маркет"),
			category: localize2('auraMarket.category', "Aura Market"),
			f1: true,
		});
	}
	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		void editorService.openEditor(instantiationService.createInstance(AuraMarketEditorInput), { pinned: true });
	}
});

// --- Иконка слева: лаунчер ---
class AuraMarketLauncherViewPane extends ViewPane {
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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		const root = append(container, $('.aura-market-launcher'));
		append(root, $('p')).textContent = 'Маркет плагинов и наборов скилов Aura IDE.';
		const btn = append(root, $('button.aura-api-btn')) as HTMLButtonElement;
		btn.textContent = 'Открыть Aura Market';
		this._register(addDisposableListener(btn, EventType.CLICK, () => {
			void this.commandService.executeCommand(AURA_MARKET_OPEN_COMMAND_ID);
		}));
	}
}

const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AURA_MARKET_VIEW_CONTAINER_ID,
	title: localize2('auraMarket', "Aura Market"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_MARKET_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: auraMarketViewIcon,
	hideIfEmpty: false,
	order: 6,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: AURA_MARKET_LAUNCHER_VIEW_ID,
	name: localize2('auraMarket.launcher', "Aura Market"),
	containerIcon: auraMarketViewIcon,
	ctorDescriptor: new SyncDescriptor(AuraMarketLauncherViewPane),
	canToggleVisibility: true,
	canMoveView: true,
}], viewContainer);

import './media/auraMarket.css';
