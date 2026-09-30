/*---------------------------------------------------------------------------------------------
 *  AGGG — встроенный плагин Aura Market (обвязка-бустер моделей).
 *  Настройки зарегистрированы всегда; панель, статус-бар и команды живут, пока плагин
 *  установлен и не отключён через Aura Market (IAuraPluginService) — без перезагрузки окна.
 *--------------------------------------------------------------------------------------------*/

import './media/aggg.css';
import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAuraPluginService, auraPluginEnabledContextKey } from '../../auraMarket/common/auraPluginService.js';
import { AGGG_ENABLED_SETTING, AGGG_PROJECT_BOOST_SETTING, AGGG_VERSION_SETTING, AGGG_EXTERNAL_AGENT_PATH_SETTING, AGGG_BOOST_PROMPT, agggBoostActive, agggBoostPrompt, normalizeAgggVersion } from '../common/agggBoost.js';
import { resolveAgggVersion } from '../common/agggEntitlements.js';
import { queryAgggAgentPath, queryAgggFeatures, resetAgggFeaturesCache } from './agggVersionGate.js';

export const AGGG_TOGGLE_COMMAND_ID = 'aggg.toggleBoost';

const AGGG_STATUSBAR_ID = 'status.agggBoost';

// Настройки AGGG доступны всегда (карточка в Market пишет aggg.version и до активации плагина).
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'aggg',
	title: localize('aggg.config', "AGGG Boost"),
	properties: {
		[AGGG_ENABLED_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('aggg.enabled', "Включить буст AGGG глобально: ядро правил AGGG2.0 добавляется первым системным сообщением к каждому запросу моделей во всех проектах."),
		},
		[AGGG_PROJECT_BOOST_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.RESOURCE,
			markdownDescription: localize('aggg.projectBoost', "Включить буст AGGG только для текущего проекта (задаётся в настройках workspace). Имеет смысл, когда глобальный #aggg.enabled# выключен."),
		},
		[AGGG_VERSION_SETTING]: {
			type: 'string',
			default: '2.0.0',
			enum: ['2.0.0', '5.2'],
			enumDescriptions: [
				localize('aggg.version.20.desc', "Встроенное ядро AGGG2.0"),
				localize('aggg.version.52.desc', "Внешний агент AGGG 5.2"),
			],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('aggg.version', "Версия ядра AGGG: встроенное ядро AGGG2.0 или внешний агент AGGG 5.2 из каталога #aggg.externalAgentPath#."),
		},
		[AGGG_EXTERNAL_AGENT_PATH_SETTING]: {
			type: 'string',
			default: '',
			// Scope по умолчанию (window): значение можно задать и в workspace-настройках —
			// так dev-профиль репозитория получает свой дефолт без хардкода в коде.
			markdownDescription: localize('aggg.externalAgentPath', "Путь к каталогу внешнего агента AGGG 5.2 (каталог с манифестом VERSION и harness/core.txt)."),
		},
	},
});

class AgggPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.agggPlugin';

	private statusAccessor: IStatusbarEntryAccessor | undefined;
	private pluginActive = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAuraPluginService pluginService: IAuraPluginService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		// Иконки в activity bar у AGGG нет: буст — это переключатель в статус-баре
		// и карточка в Aura Market, отдельная колонка слева только занимала место.
		this.syncPluginState(pluginService.isEnabled('aggg'));
		this._register(pluginService.onDidChangeEnablement(id => {
			if (id === 'aggg') { this.syncPluginState(pluginService.isEnabled('aggg')); }
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGGG_VERSION_SETTING) || e.affectsConfiguration(AGGG_EXTERNAL_AGENT_PATH_SETTING)) {
				// Правку настройки проверяем заново, не дожидаясь истечения кэша прав:
				// право могли выдать только что, и пользователь сразу переключает версию.
				resetAgggFeaturesCache();
				void this.restartKernel();
			}
			if (e.affectsConfiguration(AGGG_ENABLED_SETTING) || e.affectsConfiguration(AGGG_PROJECT_BOOST_SETTING)) {
				this.updateStatus();
			}
		}));
		void this.restartKernel();
	}

	/** Включить/погасить функции плагина без перезагрузки окна. */
	private syncPluginState(active: boolean): void {
		if (active === this.pluginActive) { return; }
		this.pluginActive = active;
		if (active) {
			this.updateStatus();
		} else {
			this.statusAccessor?.dispose();
			this.statusAccessor = undefined;
		}
	}

	/**
	 * «Перезапуск ядра»: для 5.2 читаем harness/core.txt внешнего агента из
	 * aggg.externalAgentPath, для 2.0.0 — возвращаем встроенное ядро.
	 * Внешнее ядро грузится только при выданном праве аккаунта: настройка сама
	 * по себе доступа не даёт — версия 5.2 закрыта на стороне Team.
	 */
	private async restartKernel(): Promise<void> {
		const features = await queryAgggFeatures(this.commandService);
		const decision = resolveAgggVersion(this.configurationService.getValue<string>(AGGG_VERSION_SETTING), features);
		if (decision.blocked) {
			agggBoostPrompt.current = AGGG_BOOST_PROMPT;
			if (this.pluginActive) {
				this.notificationService.notify({
					severity: Severity.Warning,
					message: localize('aggg.license.missing', "AGGG 5.2 доступна по лицензии: право не выдано аккаунту. Используется встроенное ядро 2.0.0."),
				});
			}
			this.updateStatus();
			return;
		}
		const version = normalizeAgggVersion(decision.version);
		if (version === '2.0.0') {
			agggBoostPrompt.current = AGGG_BOOST_PROMPT;
			this.updateStatus();
			return;
		}
		// Ядро можно вообще не хранить локально: расширение Team скачивает поставку
		// с сервера и отдаёт путь. Решает сервер — файлы не попадают к тому, у кого
		// нет права, поэтому убрать проверку в интерфейсе недостаточно.
		let path = (this.configurationService.getValue<string>(AGGG_EXTERNAL_AGENT_PATH_SETTING) ?? '').trim();
		let fromServer = false;
		if (!path) {
			const bundled = await queryAgggAgentPath(this.commandService);
			if (bundled) { path = bundled; fromServer = true; }
		}
		const root = path;
		let loaded = false;
		if (root) {
			try {
				const core = await this.fileService.readFile(joinPath(URI.file(root), 'harness', 'core.txt'));
				agggBoostPrompt.current = core.value.toString();
				loaded = true;
			} catch {
				loaded = false;
			}
		}
		if (!loaded) {
			// Ядра нет — остаёмся на встроенном и говорим причину словами: путь задан
			// вручную или поставку не отдал сервер (нет права / нет каталога на сервере).
			agggBoostPrompt.current = AGGG_BOOST_PROMPT;
			if (this.pluginActive) {
				this.notificationService.notify({
					severity: Severity.Warning,
					message: fromServer
						? localize('aggg.external.incomplete', "AGGG 5.2: сервер отдал неполную поставку ядра. Используется встроенное ядро 2.0.0.")
						: root
							? localize('aggg.external.missing', "AGGG 5.2: каталог агента не найден ({0}) — проверьте aggg.externalAgentPath. Используется встроенное ядро 2.0.0.", root)
							: localize('aggg.external.license', "AGGG 5.2: ядро не доступно — право не выдано аккаунту или команде (или сервер не поставляет ядро). Используется встроенное ядро 2.0.0."),
				});
			}
		}
		this.updateStatus();
	}

	private updateStatus(): void {
		if (!this.pluginActive) { return; }
		const version = normalizeAgggVersion(this.configurationService.getValue<string>(AGGG_VERSION_SETTING));
		const versionLabel = version === '5.2' ? 'AGGG 5.2' : 'AGGG 2.0';
		const active = agggBoostActive(this.configurationService);
		const entry = {
			name: localize('aggg.status.name', "AGGG Boost"),
			text: active ? `$(rocket) ${versionLabel}` : `$(rocket) ${versionLabel} off`,
			tooltip: active
				? localize('aggg.status.on', "AGGG Boost включён ({0}) — ядро правил добавляется в системный промпт", versionLabel)
				: localize('aggg.status.off', "AGGG Boost выключен ({0}) — нажмите, чтобы включить", versionLabel),
			ariaLabel: 'AGGG Boost',
			command: AGGG_TOGGLE_COMMAND_ID,
			kind: 'standard' as const,
			showInAllWindows: true,
		};
		if (this.statusAccessor) {
			this.statusAccessor.update(entry);
		} else {
			this.statusAccessor = this._register(this.statusbarService.addEntry(entry, AGGG_STATUSBAR_ID, StatusbarAlignment.RIGHT, 100));
		}
		// Кроссфейд текста индикатора при смене версии/состояния.
		const el = mainWindow.document.querySelector<HTMLElement>(`.statusbar-item#${CSS.escape(AGGG_STATUSBAR_ID)}`);
		if (el) {
			el.classList.remove('aggg-xfade');
			void el.offsetWidth; // перезапуск анимации
			el.classList.add('aggg-xfade');
		}
	}
}

registerWorkbenchContribution2(AgggPluginContribution.ID, AgggPluginContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AGGG_TOGGLE_COMMAND_ID,
			title: localize2('aggg.toggleBoost', "AGGG: Переключить буст моделей"),
			category: localize2('aggg.category', "AGGG"),
			f1: true,
			// Гасим команду вместе с плагином: без precondition она осталась бы в палитре
			// и в меню после отключения AGGG в маркете.
			precondition: ContextKeyExpr.equals(auraPluginEnabledContextKey('aggg'), true),
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const quickInput = accessor.get(IQuickInputService);
		const globalOn = configurationService.getValue<boolean>(AGGG_ENABLED_SETTING) === true;
		const projectOn = configurationService.getValue<boolean>(AGGG_PROJECT_BOOST_SETTING) === true;
		const pick = await quickInput.pick([
			{ label: `$(globe) Глобально`, description: globalOn ? 'включён' : 'выключен', id: 'global' as const },
			{ label: `$(folder) Только этот проект`, description: projectOn ? 'включён' : 'выключен', id: 'project' as const },
		], { placeHolder: localize('aggg.toggle.placeholder', "Где включать буст AGGG?") });
		if (!pick) { return; }
		if (pick.id === 'global') {
			await configurationService.updateValue(AGGG_ENABLED_SETTING, !globalOn, ConfigurationTarget.USER);
		} else {
			await configurationService.updateValue(AGGG_PROJECT_BOOST_SETTING, !projectOn, ConfigurationTarget.WORKSPACE);
		}
	}
});
