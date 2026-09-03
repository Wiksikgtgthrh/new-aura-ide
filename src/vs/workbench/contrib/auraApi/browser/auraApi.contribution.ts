/*---------------------------------------------------------------------------------------------
 *  Aura API — встроенный плагин Aura Market.
 *  Регистрация (иконка слева, вкладка, команды) происходит ТОЛЬКО если плагин
 *  установлен через Aura Market (флаг auraMarket.installed.aura-api в хранилище).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
import { auraMarketInstalledKey } from '../../auraMarket/common/auraMarketCatalog.js';

export const AURA_API_OPEN_COMMAND_ID = 'auraApi.openManager';
const AURA_API_VIEW_CONTAINER_ID = 'workbench.view.auraApi';
const AURA_API_LAUNCHER_VIEW_ID = 'auraApi.launcher';

const auraApiViewIcon = registerIcon('aura-api-view-icon', Codicon.key, localize('auraApiViewIcon', 'View icon of the Aura API view container.'));

}

/**
 * Плагин активируется только если он установлен через Aura Market.
 * Состояние читается из хранилища при запуске workbench; после установки
 * маркет предлагает перезагрузить окно — и плагин регистрируется.
 */
class AuraApiPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraApiPlugin';

	constructor(@IStorageService storageService: IStorageService) {
		super();
		if (storageService.get(auraMarketInstalledKey('aura-api'), StorageScope.APPLICATION, 'false') === 'true') {
			registerAuraApiPlugin();
		}
	}
}

registerWorkbenchContribution2(AuraApiPluginContribution.ID, AuraApiPluginContribution, WorkbenchPhase.AfterRestored);
