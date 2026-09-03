/*---------------------------------------------------------------------------------------------
 *  Aura API — регистрация: центральная вкладка, команда, иконка слева.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { Extensions as EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorExtensions as EditorExt } from '../../../common/editor.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
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

export const AURA_API_OPEN_COMMAND_ID = 'auraApi.openManager';
const AURA_API_VIEW_CONTAINER_ID = 'workbench.view.auraApi';
const AURA_API_LAUNCHER_VIEW_ID = 'auraApi.launcher';

const auraApiViewIcon = registerIcon('aura-api-view-icon', Codicon.key, localize('auraApiViewIcon', 'View icon of the Aura API view container.'));

// --- Центральная вкладка (editor) ---
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(AuraApiEditorPane, AuraApiEditorPane.ID, localize('auraApiEditor', "Aura API")),
	[new SyncDescriptor(AuraApiEditorInput)]
);
Registry.as<IEditorFactoryRegistry>(EditorExt.EditorFactory).registerEditorSerializer(AuraApiEditorInput.ID, AuraApiEditorInputSerializer);

// --- Команда открытия ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AURA_API_OPEN_COMMAND_ID,
			title: localize2('auraApi.openManager', "Aura API: Открыть менеджер ключей"),
			category: localize2('auraApi.category', "Aura API"),
			f1: true,
		});
	}
	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		void editorService.openEditor(instantiationService.createInstance(AuraApiEditorInput), { pinned: true });
	}
});

// --- Иконка слева: view container с кнопкой-запускалкой ---
class AuraApiLauncherViewPane extends ViewPane {
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
		const root = append(container, $('.aura-api-launcher'));
		const desc = append(root, $('p'));
		desc.textContent = 'Управление API-ключами: пинг, ошибки, подлинность модели, безопасность.';
		const btn = append(root, $('button.aura-api-btn')) as HTMLButtonElement;
		btn.textContent = 'Открыть Aura API';
		this._register(addDisposableListener(btn, EventType.CLICK, () => {
			void this.commandService.executeCommand(AURA_API_OPEN_COMMAND_ID);
		}));
	}
}

const viewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: AURA_API_VIEW_CONTAINER_ID,
	title: localize2('auraApi', "Aura API"),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_API_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: auraApiViewIcon,
	hideIfEmpty: false,
	order: 7,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: AURA_API_LAUNCHER_VIEW_ID,
	name: localize2('auraApi.launcher', "Aura API"),
	containerIcon: auraApiViewIcon,
	ctorDescriptor: new SyncDescriptor(AuraApiLauncherViewPane),
	canToggleVisibility: true,
	canMoveView: true,
}], viewContainer);

// CSS лаунчера тянем из стилей редактора
import './media/auraApiEditor.css';

export class AuraApiContribution extends Disposable { }
