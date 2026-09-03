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
import { IAuraApiKeysService } from '../common/auraApiKeys.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AuraApiChatProvider, AURA_API_VENDOR, AURA_API_SYSTEM_PROMPT_SETTING } from './auraApiChatProvider.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

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

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		if (storageService.get(auraMarketInstalledKey('aura-api'), StorageScope.APPLICATION, 'false') === 'true') {
			registerAuraApiPlugin();
			registerAuraApiChatBridge(this.instantiationService);
		}
	}
}

registerWorkbenchContribution2(AuraApiPluginContribution.ID, AuraApiPluginContribution, WorkbenchPhase.AfterRestored);

export function registerAuraApiChatBridge(instantiationService: IInstantiationService): void {
	instantiationService.invokeFunction(accessor => {
		const languageModels = accessor.get(ILanguageModelsService);
		const keysService = accessor.get(IAuraApiKeysService);
		const configurationService = accessor.get(IConfigurationService);
		languageModels.registerLanguageModelProvider(AURA_API_VENDOR, new AuraApiChatProvider(keysService, configurationService));
	});
}

// Настройка: системные правила/промпт для моделей Aura API в чате
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'auraApi',
	title: localize('auraApi.config', "Aura API"),
	properties: {
		[AURA_API_SYSTEM_PROMPT_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('auraApi.chat.systemPrompt', "Системные правила для моделей Aura API: как модель должна себя вести в чате (стиль, ограничения, соглашения проекта). Добавляется первым системным сообщением к каждому запросу. Дополнительно работают штатные файлы правил: AGENTS.md и .github/copilot-instructions.md в корне проекта."),
		},
	},
});
