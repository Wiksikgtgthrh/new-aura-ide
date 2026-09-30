/*---------------------------------------------------------------------------------------------
 *  Язык интерфейса Aura — одна настройка на всю IDE: aura.language.
 *
 *  Зачем: русские тексты в этой сборке живут не в языковых пакетах, а прямо в
 *  коде Aura-контуров (маркет, карточки плагинов, виджеты). Раньше каждый контур
 *  решал язык сам, и переключателя не было вообще: маркет был русским всегда,
 *  а панели расширений читали свои личные настройки. Здесь — единственный
 *  источник правды: настройка aura.language ('auto' | 'ru' | 'en'), сервис
 *  IAuraLanguageService и хелперы разрешения языка.
 *
 *  'auto' — «как в IDE»: язык берётся из base/platform (Language.value()),
 *  то есть из --locale или локали ОС; всё незнакомое считается английским.
 *  Файл чистый (без DOM/сервисов-зависимостей), поэтому проверяется node-тестами.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** Значение настройки: 'auto' — как в IDE, иначе конкретный язык. */
export type AuraLanguage = 'auto' | 'ru' | 'en';

/** Язык, на котором реально рисуется интерфейс: 'auto' уже разрешён. */
export type AuraResolvedLanguage = 'ru' | 'en';

export const AURA_LANGUAGE_SETTING = 'aura.language';
export const AURA_LANGUAGE_DEFAULT: AuraLanguage = 'auto';

/** Порядок вариантов фиксирован: он же порядок в быстром выборе. */
export const AURA_LANGUAGES: readonly AuraLanguage[] = ['auto', 'ru', 'en'];

/** Всё незнакомое (включая undefined/мусор из settings.json) — 'auto', а не пустой язык. */
export function normalizeAuraLanguage(value: unknown): AuraLanguage {
	return value === 'ru' || value === 'en' ? value : 'auto';
}

/**
 * Итоговый язык интерфейса. 'auto' разрешается языком IDE (--locale или локаль ОС),
 * явные 'ru'/'en' его перебивают.
 */
export function resolveAuraLanguage(setting: unknown, ideLanguage: string | undefined): AuraResolvedLanguage {
	const normalized = normalizeAuraLanguage(setting);
	if (normalized !== 'auto') {
		return normalized;
	}
	return String(ideLanguage ?? '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

/**
 * Подписи вариантов переключателя. Держим названия языков на них самих
 * («Русский» и «English» не переводятся), переводится только 'auto'.
 */
export const AURA_LANGUAGE_LABELS: Readonly<Record<AuraLanguage, { ru: string; en: string }>> = {
	auto: { ru: 'Как в IDE', en: 'Follow IDE' },
	ru: { ru: 'Русский', en: 'Русский' },
	en: { ru: 'English', en: 'English' },
};

/** Пояснение к варианту в быстром выборе. */
export const AURA_LANGUAGE_DESCRIPTIONS: Readonly<Record<AuraLanguage, { ru: string; en: string }>> = {
	auto: {
		ru: 'Язык интерфейса определяется языком IDE',
		en: 'Interface language follows the language of the IDE',
	},
	ru: {
		ru: 'Русский язык интерфейса Aura — маркет, карточки плагинов, панели',
		en: 'Russian interface of Aura — market, plugin cards, panels',
	},
	en: {
		ru: 'Английский язык интерфейса Aura — маркет, карточки плагинов, панели',
		en: 'English interface of Aura — market, plugin cards, panels',
	},
};

export const IAuraLanguageService = createDecorator<IAuraLanguageService>('auraLanguageService');

/**
 * Текущий язык Aura-контуров. Все они обязаны рисовать текст через сервис,
 * чтобы переключатель языка работал одним нажатием и без перезагрузки окна.
 */
export interface IAuraLanguageService {
	readonly _serviceBrand: undefined;

	/** Настройка как её задал пользователь: 'auto' | 'ru' | 'en'. */
	readonly setting: AuraLanguage;
	/** Разрешённый язык интерфейса: 'ru' | 'en'. */
	readonly language: AuraResolvedLanguage;

	/** Язык сменился (настройка или язык IDE) — контуры перерисовываются. */
	readonly onDidChange: Event<void>;

	/** Строка на текущем языке интерфейса. */
	t(ru: string, en: string): string;
}
