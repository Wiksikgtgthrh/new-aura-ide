/*---------------------------------------------------------------------------------------------
 *  Aura API — встроенный плагин Aura Market.
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
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { AuraApiEditorPane } from './auraApiEditorPane.js';
import { AuraApiEditorInput, AuraApiEditorInputSerializer } from './auraApiEditorInput.js';
import { AuraApiChatProvider, AURA_API_VENDOR, AURA_API_SYSTEM_PROMPT_SETTING } from './auraApiChatProvider.js';
import { IAuraApiKeysService, AURA_HEALTH_INTERVAL_SETTING } from '../common/auraApiKeys.js';
import { ChatViewContainerId } from '../../chat/browser/chat.js';

export const AURA_API_OPEN_COMMAND_ID = 'auraApi.openManager';
export const AURA_API_ADD_TEAM_PROXY_COMMAND_ID = 'auraApi.addTeamProxy';
export const AURA_API_EXPORT_KEY_COMMAND_ID = 'auraApi.exportKey';
export const AURA_API_EXPORT_KEYS_LIST_COMMAND_ID = 'auraApi.exportKeysList';
export const AURA_API_VIEW_CONTAINER_ID = 'workbench.view.auraApi';
const AURA_API_LAUNCHER_VIEW_ID = 'auraApi.launcher';
const AURA_API_CHAT_KEYS_VIEW_ID = 'auraApi.chatKeys';

// Иконка плагина (в activity bar и в заголовке вкладки)
export const auraApiViewIcon = registerIcon('aura-api-view-icon', Codicon.key, localize('auraApiViewIcon', 'Icon of the Aura API plugin.'));

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
		// Сразу открываем вкладку менеджера Aura API и закрываем пустой сайдбар
		void this.commandService.executeCommand(AURA_API_OPEN_COMMAND_ID);
		void this.viewsService.closeViewContainer(AURA_API_VIEW_CONTAINER_ID);
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
		this.keysBody = append(container, $('.aura-api-chat-keys'));
		this.renderKeys();
	}

	private renderKeys(): void {
		if (!this.keysBody) { return; }
		this.keysBody.textContent = '';
		const keys = this.keysService.getKeys();
		if (keys.length === 0) {
			const empty = append(this.keysBody, $('.aura-api-chat-empty'));
			empty.textContent = localize('auraApi.chatKeys.empty', "No API keys configured");
			const open = append(empty, $('button.aura-api-chat-empty-open'));
			open.textContent = localize('auraApi.chatKeys.openManager', "Add key");
			this._register(addDisposableListener(open, 'click', () => { void this.commandService.executeCommand(AURA_API_OPEN_COMMAND_ID); }));
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
			detail.textContent = `${key.model} · ${key.priority} · ${status.ok === true ? localize('auraApi.chatKeys.ready', "ready") : localize('auraApi.chatKeys.unavailable', "not ready")}`;
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
	Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
		EditorPaneDescriptor.create(AuraApiEditorPane, AuraApiEditorPane.ID, localize('auraApiEditor', "API Keys")),
		[new SyncDescriptor(AuraApiEditorInput)]
	);
	Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(AuraApiEditorInput.ID, AuraApiEditorInputSerializer);

	// Иконка слева: клик по ней сразу открывает вкладку
	const auraApiContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
		id: AURA_API_VIEW_CONTAINER_ID,
		title: localize2('auraApi', "API Keys"),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AURA_API_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		icon: auraApiViewIcon,
		hideIfEmpty: false,
		order: 7,
	}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: true });

	Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
		id: AURA_API_LAUNCHER_VIEW_ID,
		name: localize2('auraApi.launcher', "API Keys"),
		containerIcon: auraApiViewIcon,
		ctorDescriptor: new SyncDescriptor(AuraApiLauncherViewPane),
		canToggleVisibility: true,
		canMoveView: true,
	}], auraApiContainer);

	const chatContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).get(ChatViewContainerId);
	if (chatContainer) {
		Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
			id: AURA_API_CHAT_KEYS_VIEW_ID,
			name: localize2('auraApi.chatKeys', "API Keys"),
			containerIcon: auraApiViewIcon,
			ctorDescriptor: new SyncDescriptor(AuraApiChatKeysViewPane),
			order: 1,
			collapsed: false,
			canToggleVisibility: true,
			canMoveView: true,
		}], chatContainer);
	}

	// Команда: открыть менеджер
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: AURA_API_OPEN_COMMAND_ID,
				title: localize2('auraApi.openManager', "API Keys: Открыть менеджер ключей"),
				category: localize2('auraApi.category', "API Keys"),
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
		constructor() {
			super({ id: AURA_API_ADD_TEAM_PROXY_COMMAND_ID, title: localize2('auraApi.addTeamProxy', "API Keys: Add Team Proxy"), f1: false });
		}
		override async run(accessor: ServicesAccessor, input?: { name?: string; baseUrl?: string; model?: string; token?: string; provider?: 'openai-compatible' | 'anthropic' }): Promise<void> {
			if (!input?.name || !input.baseUrl || !input.model || !input.token) { throw new Error(localize('auraApi.addTeamProxy.invalid', "Team proxy configuration is incomplete.")); }
			const keysService = accessor.get(IAuraApiKeysService);
			await keysService.addKey({ name: input.name, baseUrl: input.baseUrl, model: input.model, priority: 'high', provider: input.provider ?? 'openai-compatible', weight: 1 }, input.token);
		}
	});

	registerAction2(class extends Action2 {
		constructor() {
			super({ id: AURA_API_EXPORT_KEY_COMMAND_ID, title: localize2('auraApi.exportKey', "API Keys: Export Key (for Team bank)"), f1: false });
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
			super({ id: AURA_API_EXPORT_KEYS_LIST_COMMAND_ID, title: localize2('auraApi.exportKeysList', "API Keys: List Keys (for Team import)"), f1: false });
		}
		/** Список ключей без секретов — для выбора при импорте. */
		override async run(accessor: ServicesAccessor): Promise<Array<{ id: string; name?: string; baseUrl?: string; model?: string; priority?: string }>> {
			const keysService = accessor.get(IAuraApiKeysService);
			return keysService.getKeys().map(k => ({ id: k.id, name: k.name, baseUrl: k.baseUrl, model: k.model, priority: k.priority }));
		}
	});

	// Провайдер моделей чата: здоровые ключи Aura API доступны в чате справа.
	// ВАЖНО: vendor 'auraApi' должен быть зарегистрирован ДО registerLanguageModelProvider,
	// иначе сервис кидает "Chat model provider uses UNKNOWN vendor auraApi" и вкладка падает.
	instantiationService.invokeFunction(accessor => {
		const languageModels = accessor.get(ILanguageModelsService);
		if (!languageModels.getVendors().some(v => v.vendor === AURA_API_VENDOR)) {
			languageModels.deltaLanguageModelChatProviderDescriptors([{
				vendor: AURA_API_VENDOR,
				displayName: localize('auraApi.vendorName', "Aura API"),
				configuration: undefined,
				managementCommand: AURA_API_OPEN_COMMAND_ID,
				when: undefined,
			}], []);
		}
		const keysService = accessor.get(IAuraApiKeysService);
		const configurationService = accessor.get(IConfigurationService);
		languageModels.registerLanguageModelProvider(
			AURA_API_VENDOR,
			new AuraApiChatProvider(keysService, configurationService)
		);
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

	static readonly ID = 'workbench.contrib.auraApiPlugin';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		// Aura: API Keys — встроенный плагин, регистрируется всегда (не только после
		// установки через Market). Так BYOK-модели появляются без Copilot-входа.
		registerAuraApiPlugin(instantiationService);
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
		[AURA_HEALTH_INTERVAL_SETTING]: {
			type: 'number',
			default: 0,
			minimum: 0,
			markdownDescription: localize('auraApi.health.intervalMinutes', "Интервал автоматической проверки ключей Aura API в минутах. `0` — автопроверка выключена, ключи проверяются только вручную."),
		},
	},
});
