/*---------------------------------------------------------------------------------------------
 *  Aura — язык интерфейса: настройка aura.language, команда выбора и индикатор
 *  в статус-баре. Индикатор — тот самый «переключатель для всей IDE»: он виден в
 *  любом окне, показывает текущий язык и по клику открывает быстрый выбор.
 *
 *  Настройка APPLICATION-scope (как aggg.enabled): язык — свойство пользователя,
 *  а не проекта, иначе одна и та же IDE выглядела бы по-разному в разных папках.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AURA_LANGUAGES, AURA_LANGUAGE_DEFAULT, AURA_LANGUAGE_DESCRIPTIONS, AURA_LANGUAGE_LABELS, AURA_LANGUAGE_SETTING, AuraLanguage, IAuraLanguageService } from '../common/auraLanguage.js';

export const AURA_LANGUAGE_PICK_COMMAND_ID = 'aura.language.pick';

const AURA_LANGUAGE_STATUSBAR_ID = 'status.auraLanguage';

// Настройка регистрируется всегда: и переключатель, и расширения читают её
// независимо от того, включён ли маркет.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'aura',
	title: localize('aura.config', "Aura"),
	properties: {
		[AURA_LANGUAGE_SETTING]: {
			type: 'string',
			default: AURA_LANGUAGE_DEFAULT,
			enum: [...AURA_LANGUAGES],
			enumDescriptions: [
				localize('aura.language.auto', "Follow the language of the IDE (--locale or the OS locale)."),
				localize('aura.language.ru', "Russian interface of Aura: market, plugin cards, panels."),
				localize('aura.language.en', "English interface of Aura: market, plugin cards, panels."),
			],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('aura.language.description', "Language of the Aura surfaces — market, plugin cards and plugin panels. `auto` follows the IDE language. Core IDE strings come from language packs and are switched by *Configure Display Language*."),
		},
	},
});

/** Индикатор в статус-баре: $(globe) RU / EN, клик — быстрый выбор языка. */
class AuraLanguageStatusContribution extends Disposable {

	static readonly ID = 'workbench.contrib.auraLanguageStatus';

	private accessor: IStatusbarEntryAccessor | undefined;

	constructor(
		@IAuraLanguageService private readonly languageService: IAuraLanguageService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		this.updateStatus();
		this._register(this.languageService.onDidChange(() => this.updateStatus()));
	}

	private updateStatus(): void {
		const language = this.languageService.language;
		const setting = this.languageService.setting;
		const badge = language.toUpperCase();
		const entry = {
			name: localize('aura.language.status.name', "Aura Language"),
			text: `$(globe) ${badge}`,
			tooltip: setting === 'auto'
				? localize('aura.language.status.auto', "Язык Aura: {0} (автоматически, как в IDE) — нажмите, чтобы выбрать", badge)
				: localize('aura.language.status.fixed', "Язык Aura: {0} — нажмите, чтобы выбрать", badge),
			ariaLabel: `Aura ${badge}`,
			command: AURA_LANGUAGE_PICK_COMMAND_ID,
			kind: 'standard' as const,
			showInAllWindows: true,
		};
		if (this.accessor) {
			this.accessor.update(entry);
		} else {
			this.accessor = this._register(this.statusbarService.addEntry(entry, AURA_LANGUAGE_STATUSBAR_ID, StatusbarAlignment.RIGHT, 99));
		}
	}
}

registerWorkbenchContribution2(AuraLanguageStatusContribution.ID, AuraLanguageStatusContribution, WorkbenchPhase.AfterRestored);

interface IAuraLanguagePickItem extends IQuickPickItem {
	/** Вариант языка Aura; отсутствует у пункта про язык самого IDE. */
	readonly language?: AuraLanguage;
	/** Пункт-переход к штатному выбору языка IDE (языковые пакеты VS Code). */
	readonly ideLocale?: true;
}

/**
 * Язык строк самого VS Code — это не aura.language, а локаль ядра и языковые пакеты.
 * Учим об этом прямо в переключателе: иначе пользователь ищет русское меню и не находит.
 */
const IDE_LOCALE_COMMAND_ID = 'workbench.action.configureLocale';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: AURA_LANGUAGE_PICK_COMMAND_ID,
			title: localize2('aura.language.pick', "Aura: Change Language"),
			category: localize2('aura.category', "Aura"),
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const languageService = accessor.get(IAuraLanguageService);
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		// Подписи — на текущем языке, названия языков — на них самих.
		const current = languageService.language;
		const items: IAuraLanguagePickItem[] = [
			...AURA_LANGUAGES.map((language): IAuraLanguagePickItem => ({
				label: AURA_LANGUAGE_LABELS[language][current],
				description: language === languageService.setting ? localize('aura.language.current', "текущий") : language,
				detail: AURA_LANGUAGE_DESCRIPTIONS[language][current],
				language,
			})),
			// Отдельного разделителя в быстром выборе нет: пункт помечен иконкой.
			{
				label: `$(globe) ${localize('aura.language.ideLocale', "Язык интерфейса самого IDE…")}`,
				detail: localize('aura.language.ideLocale.detail', "Строки VS Code переводятся языковыми пакетами: откроется штатный выбор языка IDE (нужна перезагрузка окна)."),
				ideLocale: true,
			},
		];
		const picked = await quickInputService.pick(items, {
			placeHolder: current === 'ru' ? 'Язык интерфейса Aura' : 'Language of the Aura interface',
		});
		if (!picked) {
			return;
		}
		if (picked.ideLocale) {
			await accessor.get(ICommandService).executeCommand(IDE_LOCALE_COMMAND_ID);
			return;
		}
		if (!picked.language || picked.language === languageService.setting) {
			return;
		}
		await configurationService.updateValue(AURA_LANGUAGE_SETTING, picked.language, ConfigurationTarget.USER);
		notificationService.notify({
			severity: Severity.Info,
			message: languageService.t(
				'Язык Aura: русский — маркет и панели плагинов перерисованы.',
				'Aura language: English — market and plugin panels have been redrawn.',
			),
		});
	}
});
