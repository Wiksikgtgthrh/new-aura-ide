/*---------------------------------------------------------------------------------------------
 *  API — встроенный плагин Aura Market.
 *  Регистрация (вкладка менеджера, иконка слева, команда, провайдер чата) происходит ТОЛЬКО
 *  если плагин установлен через Aura Market (флаг auraMarket.installed.aura-api).
 *  Клик по иконке слева сразу открывает центральную вкладку.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { $, append, addDisposableListener } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptor } from '../../../common/views.js';
import { ViewPane, IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { ILanguageModelToolsService } from '../../chat/common/tools/languageModelToolsService.js';
import { AuraListFilesTool, AuraReadFileTool, AuraWriteFileTool } from './auraApiTools.js';
import { nullExtensionDescription } from '../../../services/extensions/common/extensions.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
import { AuraApiChatProvider, API_KEYS_VENDOR, API_KEYS_SYSTEM_PROMPT_SETTING } from './auraApiChatProvider.js';
import {
	API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING, API_KEYS_SLOW_FIRST_TOKEN_SETTING, API_KEYS_STREAM_GAP_SETTING,
	API_KEYS_SLOW_KEY_FACTOR_SETTING, API_KEYS_SLOW_FLOOR_SETTING,
	DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_SLOW_FIRST_TOKEN_MS, DEFAULT_STREAM_GAP_MS,
	DEFAULT_SLOW_KEY_FACTOR, DEFAULT_SLOW_FLOOR_MS,
} from '../common/auraApiModel.js';
import { AGENT_TEAM_ENABLED_WHEN, AGENT_TEAM_SLASH_COMMAND } from '../common/auraApiChatTools.js';
import { AURA_CHAT_AGENT_ID, AuraChatAgent } from './auraApiChatAgent.js';
import { IAuraApiKeyStatusExport, IAuraApiKeysService, exportKeyStatus } from '../common/auraApiKeys.js';
import { ChatViewContainerId } from '../../chat/browser/chat.js';
import { IAuraPluginService } from '../../auraMarket/common/auraPluginService.js';
import { managePluginViewContainer } from '../../auraMarket/browser/auraPluginContainers.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export const API_KEYS_OPEN_COMMAND_ID = 'apiKeys.openManager';
export const API_KEYS_ADD_TEAM_PROXY_COMMAND_ID = 'apiKeys.addTeamProxy';
export const API_KEYS_EXPORT_KEY_COMMAND_ID = 'apiKeys.exportKey';
export const API_KEYS_EXPORT_KEYS_LIST_COMMAND_ID = 'apiKeys.exportKeysList';
export const API_KEYS_EXPORT_STATUSES_COMMAND_ID = 'apiKeys.exportStatuses';
export const API_KEYS_CHECK_KEYS_COMMAND_ID = 'apiKeys.checkKeys';
export const API_KEYS_VIEW_CONTAINER_ID = 'workbench.view.apiKeys';
const API_KEYS_LAUNCHER_VIEW_ID = 'apiKeys.launcher';
const API_KEYS_CHAT_KEYS_VIEW_ID = 'apiKeys.chatKeys';

// Иконка плагина (в activity bar и в заголовке вкладки)
export const apiKeysViewIcon = registerIcon('api-keys-view-icon', Codicon.key, localize('apiKeysViewIcon', 'Icon of the API Keys plugin.'));

// --- Иконка слева: клик = сразу открыть вкладку менеджера и закрыть пустой сайдбар ---
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
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		// Сразу открываем вкладку менеджера ключей и закрываем пустой сайдбар
		void this.commandService.executeCommand(API_KEYS_OPEN_COMMAND_ID);
		void this.viewsService.closeViewContainer(API_KEYS_VIEW_CONTAINER_ID);
	}
}

class AuraApiChatKeysViewPane extends ViewPane {
	private keysBody?: HTMLElement;

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
		@IAuraApiKeysService private readonly keysService: IAuraApiKeysService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.keysService.onDidChange(() => this.renderKeys()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.keysBody = append(container, $('.aura-api-chat-keys.aura'));
		this.renderKeys();
	}

	private renderKeys(): void {
		if (!this.keysBody) { return; }
		this.keysBody.textContent = '';
		const keys = this.keysService.getKeys();
		if (keys.length === 0) {
			const empty = append(this.keysBody, $('.aura-api-chat-empty'));
			empty.textContent = localize('apiKeys.chatKeys.empty', "Ключи для чата не настроены");
			const open = append(empty, $('button.aura-api-chat-empty-open'));
			open.textContent = localize('apiKeys.chatKeys.openManager', "Добавить ключ");
			this._register(addDisposableListener(open, 'click', () => { void this.commandService.executeCommand(API_KEYS_OPEN_COMMAND_ID); }));
			return;
		}
		const selectedId = this.keysService.getSelectedKeyId();
		for (const key of keys) {
			const status = this.keysService.getStatus(key.id);
			const row = append(this.keysBody, $('.aura-api-chat-key'));
			if (key.id === selectedId) { row.classList.add('active'); }
			append(row, $('span.aura-api-chat-key-name')).textContent = key.name;
			append(row, $('code')).textContent = this.keysService.maskedSecretLabel(key.id);
			const detail = append(row, $('small'));
			detail.textContent = `${key.model} · ${key.priority} · ${status.ok === true ? localize('apiKeys.chatKeys.ready', "готов") : localize('apiKeys.chatKeys.unavailable', "не готов")}`;
			row.style.cursor = 'pointer';
			this._register(addDisposableListener(row, 'click', () => { void this.keysService.selectForChat(key.id); }));
		}
	}
}

let registered = false;

/** Регистрирует вкладку менеджера, иконку слева, команду и мост в чат. Вызывается один раз. */
function registerAuraApiPlugin(instantiationService: IInstantiationService): void {
	if (registered) { return; }
	registered = true;

	// Центральная вкладка менеджера ключей
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(			EditorPaneDescriptor.create(AuraApiEditorPane, AuraApiEditorPane.ID, localize('apiKeysEditor', "Ключи API")),
		[new SyncDescriptor(AuraApiEditorInput)]
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraApiEditorInput.ID, AuraApiEditorInputSerializer);


	// Команда: открыть менеджер
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: API_KEYS_OPEN_COMMAND_ID,
				title: localize2('apiKeys.openManager', "API Keys: Открыть менеджер ключей"),
				category: localize2('apiKeys.category', "API Keys"),
				f1: true,
			});
		}
		override run(accessor: ServicesAccessor): void {
			const editorService = accessor.get(IEditorService);
			const instantiation = accessor.get(IInstantiationService);
			void editorService.openEditor(instantiation.createInstance(AuraApiEditorInput), { pinned: true });
		}
	});

	registerAction2(class extends Action2 {
		constructor() {			super({ id: API_KEYS_ADD_TEAM_PROXY_COMMAND_ID, title: localize2('apiKeys.addTeamProxy', "API Keys: Добавить прокси команды"), f1: false });
		}
		override async run(accessor: ServicesAccessor, input?: { name?: string; baseUrl?: string; model?: string; token?: string; provider?: 'openai-compatible' | 'anthropic' }): Promise<void> {
			if (!input?.name || !input.baseUrl || !input.model || !input.token) { throw new Error(localize('apiKeys.addTeamProxy.invalid', "Конфигурация прокси команды неполная.")); }
			const keysService = accessor.get(IAuraApiKeysService);
			await keysService.addKey({ name: input.name, baseUrl: input.baseUrl, model: input.model, priority: 'high', provider: input.provider ?? 'openai-compatible', weight: 1 }, input.token);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: API_KEYS_EXPORT_KEY_COMMAND_ID, title: localize2('apiKeys.exportKey', "API Keys: Экспорт ключа (в банк команды)"), f1: false });
		}
		/** Возвращает { value, provider, baseUrl, model } ключа: использует банк Team. */
		override async run(accessor: ServicesAccessor, keyId?: string): Promise<{ value?: string; provider?: string; baseUrl?: string; model?: string; name?: string; id?: string } | undefined> {
			if (!keyId) { return undefined; }
			const keysService = accessor.get(IAuraApiKeysService);
			const key = keysService.getKeys().find(k => k.id === keyId);
			if (!key) { return undefined; }
			const value = await keysService.getSecret(keyId);
			if (!value) { return undefined; }
			return { value, provider: key.provider, baseUrl: key.baseUrl, model: key.model };
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: API_KEYS_EXPORT_KEYS_LIST_COMMAND_ID, title: localize2('apiKeys.exportKeysList', "API Keys: Список ключей (импорт в команду)"), f1: false });
		}
		/** Список ключей без секретов — для выбора при импорте. */
		override async run(accessor: ServicesAccessor): Promise<Array<{ id: string; name?: string; baseUrl?: string; model?: string; priority?: string }>> {
			const keysService = accessor.get(IAuraApiKeysService);
			return keysService.getKeys().map(k => ({ id: k.id, name: k.name, baseUrl: k.baseUrl, model: k.model, priority: k.priority }));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: API_KEYS_EXPORT_STATUSES_COMMAND_ID, title: localize2('apiKeys.exportStatuses', "API Keys: Статусы ключей (для оркестратора)"), f1: false });
		}
		/**
		 * Живость ключей для внешних потребителей (оркестратор): health, ping, cooldown,
		 * медиана первого токена, признаки «медленный». Секретов в статусе нет.
		 */
		override run(accessor: ServicesAccessor): IAuraApiKeyStatusExport[] {
			const keysService = accessor.get(IAuraApiKeysService);
			return keysService.getKeys().map(key => exportKeyStatus(key.id, keysService.getStatus(key.id)));
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: API_KEYS_CHECK_KEYS_COMMAND_ID, title: localize2('apiKeys.checkKeys', "API Keys: Проверить ключи (ping и живость)"), f1: false });
		}
		/**
		 * Перепроверка ключей: со списком id — только они, без списка — все (как «Проверить все»
		 * в менеджере ключей). Возвращает свежие статусы, чтобы вызывающий не гадал, когда они обновятся.
		 */
		override async run(accessor: ServicesAccessor, input?: { ids?: string[] } | string[]): Promise<IAuraApiKeyStatusExport[]> {
			const keysService = accessor.get(IAuraApiKeysService);
			const ids = Array.isArray(input) ? input : Array.isArray(input?.ids) ? input.ids : [];
			if (ids.length) {
				await Promise.all(ids.map(id => keysService.checkKey(id)));
			} else {
				await keysService.checkAllQueued();
			}
			return keysService.getKeys().map(key => exportKeyStatus(key.id, keysService.getStatus(key.id)));
		}
	});

	// Провайдер моделей чата: здоровые ключи API Keys доступны в чате справа.
	// ВАЖНО: vendor 'apiKeys' должен быть зарегистрирован ДО registerLanguageModelProvider,
	// иначе сервис кидает "Chat model provider uses UNKNOWN vendor apiKeys" и вкладка падает.
	instantiationService.invokeFunction(accessor => {
		const languageModels = accessor.get(ILanguageModelsService);
		if (!languageModels.getVendors().some(v => v.vendor === API_KEYS_VENDOR)) {
			languageModels.deltaLanguageModelChatProviderDescriptors([{
				vendor: API_KEYS_VENDOR,
				displayName: localize('apiKeys.vendorName', "API Keys"),
				configuration: undefined,
				managementCommand: API_KEYS_OPEN_COMMAND_ID,
				when: undefined,
			}], []);
		}
		const keysService = accessor.get(IAuraApiKeysService);
		const configurationService = accessor.get(IConfigurationService);
		const logService = accessor.get(ILogService);
		languageModels.registerLanguageModelProvider(
			API_KEYS_VENDOR,
			new AuraApiChatProvider(keysService, configurationService, logService)
		);

		// Файловые инструменты агента: без них BYOK-модель умеет только печатать код в чат.
		const toolsService = accessor.get(ILanguageModelToolsService);
		toolsService.registerTool(AuraReadFileTool.data, new AuraReadFileTool(accessor.get(IFileService), accessor.get(IWorkspaceContextService)));
		toolsService.registerTool(AuraWriteFileTool.data, new AuraWriteFileTool(accessor.get(IFileService), accessor.get(IWorkspaceContextService)));
		toolsService.registerTool(AuraListFilesTool.data, new AuraListFilesTool(accessor.get(IFileService), accessor.get(IWorkspaceContextService)));

		// Дефолтный чат-агент на BYOK-ключах. isCore:false — важно: именно такого агента
		// ждёт SetupAgent (chatSetupProviders.whenAgentReady), иначе панель чата через
		// 20 секунд показывает «Chat took too long to get ready… Copilot».
		const chatAgentService = accessor.get(IChatAgentService);
		chatAgentService.registerAgent(AURA_CHAT_AGENT_ID, {
			id: AURA_CHAT_AGENT_ID,
			name: 'aura',
			fullName: localize('apiKeys.chatAgent.fullName', "Aura (ваши ключи)"),
			description: localize('apiKeys.chatAgent.description', "Отвечает через ваши API-ключи — без Copilot."),
			isDefault: true,
			isCore: false,
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			locations: [ChatAgentLocation.Chat],
			slashCommands: [{
				name: AGENT_TEAM_SLASH_COMMAND,
				description: localize('apiKeys.chatAgent.teamCommand', "Поручить задачу мультиагентной команде агентов (кодер, тестировщик, аудит, ревьюер)"),
				sampleRequest: 'добавь страницу настроек темы и покрой её тестами',
				// Плагин оркестратора отключён в маркете — команда и инструмент не предлагаются.
				when: AGENT_TEAM_ENABLED_WHEN,
			}],
			disambiguation: [],
			metadata: {},
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: 'API Keys',
			extensionPublisherId: 'aura',
		});
		chatAgentService.registerAgentImplementation(AURA_CHAT_AGENT_ID, new AuraChatAgent(languageModels, toolsService));
		// Фоновая проверка ключей при старте окна: статусы живут в памяти, и без
		// этой проверки провайдер чата после перезагрузки не видит ни одного
		// «здорового» ключа — в кнопке Models пусто до ручной проверки в менеджере.
		if (keysService.getKeys().length > 0) {
			setTimeout(() => { void keysService.checkAllQueued(); }, 3000);
		}
	});
}

/**
 * Плагин активируется только если он установлен через Aura Market.
 * После установки маркет предлагает перезагрузить окно — и плагин регистрируется.
 */
class AuraApiPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.apiKeysPlugin';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IAuraPluginService pluginService: IAuraPluginService,
		@IPaneCompositePartService paneCompositePartService: IPaneCompositePartService,
		@IViewsService viewsService: IViewsService,
	) {
		super();
		// Aura: API Keys — встроенный плагин, регистрируется всегда (не только после
		// установки через Market). Так BYOK-модели появляются без Copilot-входа.
		registerAuraApiPlugin(instantiationService);

		// Иконка слева и вьюха «Ключи для чата» живут по состоянию плагина:
		// отключение/удаление в Market дерегистрирует их без перезагрузки окна.
		this._register(managePluginViewContainer({
			pluginId: 'api-keys',
			containerId: API_KEYS_VIEW_CONTAINER_ID,
			title: localize2('apiKeys', "Ключи API"),
			icon: apiKeysViewIcon,
			order: 7,
			views: [{
				id: API_KEYS_LAUNCHER_VIEW_ID,
				name: localize2('apiKeys.launcher', "Ключи API"),
				containerIcon: apiKeysViewIcon,
				ctorDescriptor: new SyncDescriptor(AuraApiLauncherViewPane),
				canToggleVisibility: true,
				canMoveView: true,
			}],
		}, pluginService, paneCompositePartService, viewsService));

		const chatKeysView: IViewDescriptor = {
			id: API_KEYS_CHAT_KEYS_VIEW_ID,
			name: localize2('apiKeys.chatKeys', "Ключи для чата"),
			containerIcon: apiKeysViewIcon,
			ctorDescriptor: new SyncDescriptor(AuraApiChatKeysViewPane),
			order: 1,
			collapsed: false,
			canToggleVisibility: true,
			canMoveView: true,
		};
		let chatKeysRegistered = false;
		const syncChatKeysView = (): void => {
			const chatContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).get(ChatViewContainerId);
			if (!chatContainer) { return; }
			const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
			if (pluginService.isEnabled('api-keys') && !chatKeysRegistered) {
				viewsRegistry.registerViews([chatKeysView], chatContainer);
				chatKeysRegistered = true;
			} else if (!pluginService.isEnabled('api-keys') && chatKeysRegistered) {
				viewsRegistry.deregisterViews([chatKeysView], chatContainer);
				chatKeysRegistered = false;
			}
		};
		syncChatKeysView();
		this._register(pluginService.onDidChangeEnablement(id => {
			if (id === 'api-keys') { syncChatKeysView(); }
		}));
	}
}

registerWorkbenchContribution2(AuraApiPluginContribution.ID, AuraApiPluginContribution, WorkbenchPhase.AfterRestored);	// Настройка: системные правила/промпт для моделей API Keys в чате
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'apiKeys',
	title: localize('apiKeys.config', "API Keys"),
	properties: {
		[API_KEYS_SYSTEM_PROMPT_SETTING]: {
			type: 'string',
			default: '',
			markdownDescription: localize('apiKeys.chat.systemPrompt', "Системные правила для моделей API Keys: как модель должна себя вести в чате (стиль, ограничения, соглашения проекта). Добавляется первым системным сообщением к каждому запросу. Дополнительно работают штатные файлы правил: AGENTS.md и .github/copilot-instructions.md в корне проекта."),
		},
		[API_KEYS_SLOW_FIRST_TOKEN_SETTING]: {
			type: 'number',
			default: DEFAULT_SLOW_FIRST_TOKEN_MS,
			minimum: 0,
			markdownDescription: localize('apiKeys.router.slowFirstTokenMs', "Стартовый порог медленного ключа: работает, пока ни по одному ключу нет живых замеров. Дальше порог считается адаптивно — относительно самого быстрого ключа (см. slowKeyFactor и slowFloorMs). Два медленных ответа подряд выводят ключ из автовыбора (модель остаётся доступной вручную), а быстрый ответ возвращает его. 0 — не наблюдать за скоростью живых ответов вообще."),
		},
		[API_KEYS_SLOW_KEY_FACTOR_SETTING]: {
			type: 'number',
			default: DEFAULT_SLOW_KEY_FACTOR,
			minimum: 1,
			markdownDescription: localize('apiKeys.router.slowKeyFactor', "Адаптивный порог: во сколько раз медленнее лучшего ключа считается медленным. Сравниваются медианы времени до первого токена по каждому ключу, поэтому одинаковые миллисекунды на быстром канале и на медленном прокси оцениваются по-разному."),
		},
		[API_KEYS_SLOW_FLOOR_SETTING]: {
			type: 'number',
			default: DEFAULT_SLOW_FLOOR_MS,
			minimum: 0,
			markdownDescription: localize('apiKeys.router.slowFloorMs', "Нижняя граница адаптивного порога: ответы быстрее этого не считаются медленными, даже если они в разы медленнее лучшего ключа. Защищает от мигания ключей на шуме сети."),
		},
		[API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING]: {
			type: 'number',
			default: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
			minimum: 0,
			markdownDescription: localize('apiKeys.router.firstTokenTimeoutMs', "Сколько ждать первый токен, прежде чем переключиться на другой ключ. Защищает длинную задачу от бесконечного ожидания на задумавшемся эндпоинте. 0 — ждать без ограничения."),
		},
		[API_KEYS_STREAM_GAP_SETTING]: {
			type: 'number',
			default: DEFAULT_STREAM_GAP_MS,
			minimum: 0,
			markdownDescription: localize('apiKeys.router.streamGapMs', "Молчание посреди ответа дольше этого времени прерывает поток с понятным сообщением: повторять ответ (в том числе другим ключом) нельзя — текст уже отправлен в чат."),
		},
	},
});
