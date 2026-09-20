/*---------------------------------------------------------------------------------------------
 *  AGGG — встроенный плагин Aura Market (обвязка-бустер моделей).
 *  Регистрация настроек и индикатора в статус-баре — только если плагин установлен
 *  через Aura Market (флаг auraMarket.installed.aggg).
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { auraMarketInstalledKey, auraMarketDisabledKey } from '../../auraMarket/common/auraMarketCatalog.js';
import { AGGG_ENABLED_SETTING, AGGG_PROJECT_BOOST_SETTING, agggBoostActive } from '../common/agggBoost.js';

export const AGGG_TOGGLE_COMMAND_ID = 'aggg.toggleBoost';

export const agggViewIcon = registerIcon('aggg-view-icon', Codicon.rocket, localize('agggViewIcon', 'Icon of the AGGG boost plugin.'));

const AGGG_STATUSBAR_ID = 'status.agggBoost';

/**
 * Плагин активируется только если он установлен через Aura Market.
 * После установки маркет предлагает перезагрузить окно — и плагин регистрируется.
 */
class AgggPluginContribution extends Disposable {

	static readonly ID = 'workbench.contrib.agggPlugin';

	constructor(
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		// Плагин отключён через Market — статус-бар и команды не регистрируются.
		if (storageService.get(auraMarketInstalledKey('aggg'), StorageScope.APPLICATION, 'false') !== 'true'
			|| storageService.get(auraMarketDisabledKey('aggg'), StorageScope.APPLICATION, 'false') === 'true') {
			return;
		}
		this.registerSettings();
		this.registerCommands();
		this.updateStatus();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGGG_ENABLED_SETTING) || e.affectsConfiguration(AGGG_PROJECT_BOOST_SETTING)) {
				this.updateStatus();
			}
		}));
	}

	private registerSettings(): void {
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
			},
		});
	}

	private registerCommands(): void {
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: AGGG_TOGGLE_COMMAND_ID,
					title: localize2('aggg.toggleBoost', "AGGG: Переключить буст моделей"),
					category: localize2('aggg.category', "AGGG"),
					f1: true,
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
		}));
	}

	private statusAccessor: IStatusbarEntryAccessor | undefined;

	private updateStatus(): void {
		const active = agggBoostActive(this.configurationService);
		const entry = {
			name: localize('aggg.status.name', "AGGG Boost"),
			text: active ? '$(rocket) AGGG' : '$(rocket) AGGG off',
			tooltip: active
				? localize('aggg.status.on', "AGGG Boost включён — правила AGGG2.0 добавляются в системный промпт")
				: localize('aggg.status.off', "AGGG Boost выключен — нажмите, чтобы включить"),
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
	}
}

registerWorkbenchContribution2(AgggPluginContribution.ID, AgggPluginContribution, WorkbenchPhase.AfterRestored);
