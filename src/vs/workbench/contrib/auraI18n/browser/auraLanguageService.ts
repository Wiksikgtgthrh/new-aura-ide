/*---------------------------------------------------------------------------------------------
 *  Aura Language Service — реализация IAuraLanguageService.
 *  Читает настройку aura.language, разрешает 'auto' языком IDE и сообщает
 *  подписчикам (маркет, виджеты, панели), когда язык сменился.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Language } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AURA_LANGUAGE_SETTING, AuraLanguage, AuraResolvedLanguage, IAuraLanguageService, normalizeAuraLanguage, resolveAuraLanguage } from '../common/auraLanguage.js';

class AuraLanguageService extends Disposable implements IAuraLanguageService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _setting: AuraLanguage;
	private _language: AuraResolvedLanguage;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._setting = normalizeAuraLanguage(this.configurationService.getValue(AURA_LANGUAGE_SETTING));
		this._language = resolveAuraLanguage(this._setting, Language.value());
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AURA_LANGUAGE_SETTING)) {
				this.update();
			}
		}));
	}

	get setting(): AuraLanguage {
		return this._setting;
	}

	get language(): AuraResolvedLanguage {
		return this._language;
	}

	t(ru: string, en: string): string {
		return this._language === 'ru' ? ru : en;
	}

	/** Смена настройки: пересчитываем и сообщаем только если язык реально изменился. */
	private update(): void {
		const setting = normalizeAuraLanguage(this.configurationService.getValue(AURA_LANGUAGE_SETTING));
		const language = resolveAuraLanguage(setting, Language.value());
		if (setting === this._setting && language === this._language) {
			return;
		}
		this._setting = setting;
		this._language = language;
		this._onDidChange.fire();
	}
}

registerSingleton(IAuraLanguageService, AuraLanguageService, InstantiationType.Delayed);
