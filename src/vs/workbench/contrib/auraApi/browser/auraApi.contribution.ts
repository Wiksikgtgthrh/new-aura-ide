/*---------------------------------------------------------------------------------------------
 *  Aura API — встроенный плагин Aura Market.
 *  Регистрация (вкладка менеджера, команда, провайдер чата) происходит ТОЛЬКО
 *  если плагин установлен через Aura Market (флаг auraMarket.installed.aura-api).
 *  Клик по иконке слева сразу открывает центральную вкладку.
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
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
import { AuraApiChatProvider, AURA_API_VENDOR, AURA_API_SYSTEM_PROMPT_SETTING } from './auraApiChatProvider.js';
import { IAuraApiKeysService } from '../common/auraApiKeys.js';
import { auraMarketInstalledKey } from '../../auraMarket/common/auraMarketCatalog.js';

export const AURA_API_OPEN_COMMAND_ID = 'auraApi.openManager';

// Иконка плагина (используется в заголовке вкладки и палитре)
registerIcon('aura-api-view-icon', Codicon.key, localize('auraApiViewIcon', 'Icon of the Aura API plugin.'));

let registered = false;

/** Регистрирует вкладку менеджера, команду и мост в чат. Вызывается один раз. */
function registerAuraApiPlugin(instantiationService: IInstantiationService): void {
	if (registered) { return; }
	registered = true;

	// Центральная вкладка менеджера ключей
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(AuraApiEditorPane, AuraApiEditorPane.ID, localize('auraApiEditor', "Aura API")),
		[new SyncDescriptor(AuraApiEditorInput)]
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraApiEditorInput.ID, AuraApiEditorInputSerializer);

	// Команда: открыть менеджер (иконка слева вызывает её напрямую)
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
			const instantiation = accessor.get(IInstantiationService);
			void editorService.openEditor(instantiation.createInstance(AuraApiEditorInput), { pinned: true });
		}
	});

	// Провайдер моделей чата: здоровые ключи Aura API доступны в чате справа
	instantiationService.invokeFunction(accessor => {
		const languageModels = accessor.get(ILanguageModelsService);
		const keysService = accessor.get(IAuraApiKeysService);
		const configurationService = accessor.get(IConfigurationService);
		languageModels.registerLanguageModelProvider(
			AURA_API_VENDOR,
			new AuraApiChatProvider(keysService, configurationService)
		);
	});
}

/**
 * Плагин активируется только если он установлен через Aura Market.
 * После установки маркет предлагает перезагрузить окно — и плагин регистрируется.
 */
class AuraApiPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraApiPlugin';

	constructor(
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		if (storageService.get(auraMarketInstalledKey('aura-api'), StorageScope.APPLICATION, 'false') === 'true') {
			registerAuraApiPlugin(instantiationService);
		}
	}
}

registerWorkbenchContribution2(AuraApiPluginContribution.ID, AuraApiPluginContribution, WorkbenchPhase.AfterRestored);

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
