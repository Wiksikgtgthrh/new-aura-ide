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


