/*---------------------------------------------------------------------------------------------
 *  Aura Market — тексты интерфейса и локализация каталога.
 *
 *  Два разных перевода живут рядом, потому что у них разная природа:
 *  — строки самого интерфейса (кнопки, фильтры, диалоги) — IAuraMarketText,
 *    два готовых набора RU/EN, выбирается по IAuraLanguageService;
 *  — содержимое карточек (описания, документация, changelog) — overlay
 *    AURA_MARKET_ITEMS_EN поверх русского каталога: auraMarketItems(language).
 *
 *  Язык приходит разрешённым ('ru' | 'en'): 'auto' разрешает IAuraLanguageService
 *  языком IDE, поэтому здесь никаких повторов логики.
 *--------------------------------------------------------------------------------------------*/

import type { AuraResolvedLanguage } from '../../auraI18n/common/auraLanguage.js';
import { AURA_MARKET_ITEMS, IAuraMarketItem } from './auraMarketCatalog.js';
import { AURA_MARKET_ITEMS_EN } from './auraMarketCatalog.en.js';

/** Перевод карточки поверх русского исходника: переводится только текст. */
export interface IAuraMarketTranslation {
	readonly name?: string;
	readonly description?: string;
	readonly docs?: string;
	readonly size?: string;
	readonly sizeNote?: string;
	/** Changelog по номеру версии: сами версии и даты не переводятся. */
	readonly changelog?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Строки интерфейса маркета. Функции там, где в текст вклеивается имя плагина:
 * имя берётся из уже локализованной карточки, поэтому кавычки и порядок слов
 * остаются на языке перевода.
 */
export interface IAuraMarketText {
	readonly title: string;
	readonly subtitle: string;
	readonly searchAriaLabel: string;
	readonly searchPlaceholder: string;
	readonly segmentAll: string;
	readonly segmentPlugins: string;
	readonly segmentSkillsets: string;
	readonly skillsetBadge: string;
	readonly empty: string;
	readonly install: string;
	readonly enable: string;
	readonly disable: string;
	readonly uninstall: string;
	readonly docs: string;
	readonly close: string;
	readonly undo: string;
	readonly cancel: string;
	readonly latest: string;
	readonly busyInstalling: string;
	readonly hideVersions: string;
	readonly languageLabel: string;
	readonly versions: (count: number) => string;
	readonly confirmInstall: (name: string, sizeNote: string) => string;
	readonly notBundled: (name: string) => string;
	readonly installed: (name: string) => string;
	readonly confirmUninstall: (name: string) => string;
	readonly removed: (name: string) => string;
	readonly docsReaderLabel: (name: string) => string;
}

const MARKET_TEXT_RU: IAuraMarketText = {
	title: 'Market',
	subtitle: 'Плагины, инструменты и наборы скилов',
	searchAriaLabel: 'Поиск по маркету',
	searchPlaceholder: 'Поиск...',
	segmentAll: 'Все',
	segmentPlugins: 'Плагины',
	segmentSkillsets: 'Наборы скилов',
	skillsetBadge: 'Набор скилов',
	empty: 'Ничего не найдено.',
	install: 'Установить',
	enable: 'Включить',
	disable: 'Отключить',
	uninstall: 'Удалить',
	docs: 'Документация',
	close: 'Закрыть',
	undo: 'Отменить',
	cancel: 'Отмена',
	latest: 'последняя',
	busyInstalling: 'Установка…',
	hideVersions: 'Скрыть версии',
	languageLabel: 'Язык',
	versions: count => `Версии (${count})`,
	confirmInstall: (name, sizeNote) => `«${name}» требует загрузки инструментов: ${sizeNote} Продолжить установку?`,
	notBundled: name => `«${name}»: загрузка этого плагина будет подключена следующим шагом.`,
	installed: name => `«${name}» установлен — иконка уже в левой панели.`,
	confirmUninstall: name => `Удалить плагин «${name}»? Действие можно отменить в течение нескольких секунд.`,
	removed: name => `«${name}» удалён.`,
	docsReaderLabel: name => `Документация: ${name}`,
};

const MARKET_TEXT_EN: IAuraMarketText = {
	title: 'Market',
	subtitle: 'Plugins, tools and skill sets',
	searchAriaLabel: 'Search Market',
	searchPlaceholder: 'Search...',
	segmentAll: 'All',
	segmentPlugins: 'Plugins',
	segmentSkillsets: 'Skill sets',
	skillsetBadge: 'Skill set',
	empty: 'Nothing found.',
	install: 'Install',
	enable: 'Enable',
	disable: 'Disable',
	uninstall: 'Uninstall',
	docs: 'Documentation',
	close: 'Close',
	undo: 'Undo',
	cancel: 'Cancel',
	latest: 'latest',
	busyInstalling: 'Installing…',
	hideVersions: 'Hide versions',
	languageLabel: 'Language',
	versions: count => `Versions (${count})`,
	confirmInstall: (name, sizeNote) => `"${name}" needs to download tools: ${sizeNote} Continue with the installation?`,
	notBundled: name => `"${name}": downloading this plugin will be wired up in the next step.`,
	installed: name => `"${name}" is installed — the icon is already in the left panel.`,
	confirmUninstall: name => `Uninstall the plugin "${name}"? You can undo this within a few seconds.`,
	removed: name => `"${name}" was removed.`,
	docsReaderLabel: name => `Documentation: ${name}`,
};

/** Набор строк интерфейса для уже разрешённого языка. */
export function auraMarketText(language: AuraResolvedLanguage): IAuraMarketText {
	return language === 'ru' ? MARKET_TEXT_RU : MARKET_TEXT_EN;
}

/** Английская карточка: перевод поверх оригинала, версии и метаданные не дублируются. */
function translateItem(item: IAuraMarketItem): IAuraMarketItem {
	const translation = AURA_MARKET_ITEMS_EN[item.id];
	if (!translation) {
		return item;
	}
	return {
		...item,
		name: translation.name ?? item.name,
		description: translation.description ?? item.description,
		docs: translation.docs ?? item.docs,
		size: translation.size ?? item.size,
		sizeNote: translation.sizeNote ?? item.sizeNote,
		versions: item.versions?.map(version => ({
			...version,
			changelog: translation.changelog?.[version.version] ?? version.changelog,
		})),
	};
}

const localizedItems = new Map<AuraResolvedLanguage, readonly IAuraMarketItem[]>();

/**
 * Каталог на выбранном языке. Для 'ru' отдаём исходные объекты как есть
 * (переводов не требуется), для 'en' — один раз собранные копии с overlay.
 */
export function auraMarketItems(language: AuraResolvedLanguage): readonly IAuraMarketItem[] {
	const cached = localizedItems.get(language);
	if (cached) {
		return cached;
	}
	const items = language === 'ru' ? AURA_MARKET_ITEMS : AURA_MARKET_ITEMS.map(translateItem);
	localizedItems.set(language, items);
	return items;
}

/** Карточка по id на выбранном языке (для панелей, которые рисуют один плагин). */
export function auraMarketItem(itemId: string, language: AuraResolvedLanguage): IAuraMarketItem | undefined {
	return auraMarketItems(language).find(item => item.id === itemId);
}
