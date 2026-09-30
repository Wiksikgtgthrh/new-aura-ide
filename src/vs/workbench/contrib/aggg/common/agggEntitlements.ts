/*---------------------------------------------------------------------------------------------
 *  AGGG — кому доступна версия ядра 5.2.
 *  Внешний агент 5.2 — отдельная поставка: право выдаётся аккаунту на стороне Team
 *  (таблица entitlements, `npm run grant -- --feature aggg52`), а не появляется вместе
 *  с плагином. Здесь только чистая логика решения — её и покрывают тесты.
 *--------------------------------------------------------------------------------------------*/

export const AGGG_BUILTIN_VERSION = '2.0.0';
export const AGGG_EXTERNAL_VERSION = '5.2';

/** Возможность аккаунта, открывающая внешнее ядро 5.2. */
export const AGGG_52_FEATURE = 'aggg52';

export type AgggVersion = typeof AGGG_BUILTIN_VERSION | typeof AGGG_EXTERNAL_VERSION;

/** Почему версия недоступна: право не выдано аккаунту. */
export type AgggVersionBlock = 'license' | undefined;

export interface IAgggVersionDecision {
	/** Версия, которую реально можно использовать. */
	readonly version: AgggVersion;
	/** Была ли выбранная версия заблокирована. */
	readonly blocked: boolean;
	readonly reason: AgggVersionBlock;
}

/** Доступна ли версия при данном списке возможностей аккаунта. */
export function agggVersionAvailable(version: string, features: readonly string[]): boolean {
	if (version !== AGGG_EXTERNAL_VERSION) { return true; }
	return features.includes(AGGG_52_FEATURE);
}

/**
 * Что делать, если в настройке выбрана недоступная версия: молча работать на внешнем
 * ядре нельзя, но и падать в пустой экран — тоже. Откатываемся на встроенное ядро
 * и говорим об этом в интерфейсе.
 */
export function resolveAgggVersion(setting: string | undefined, features: readonly string[]): IAgggVersionDecision {
	const requested: AgggVersion = String(setting ?? '').trim() === AGGG_EXTERNAL_VERSION ? AGGG_EXTERNAL_VERSION : AGGG_BUILTIN_VERSION;
	if (agggVersionAvailable(requested, features)) {
		return { version: requested, blocked: false, reason: undefined };
	}
	return { version: AGGG_BUILTIN_VERSION, blocked: true, reason: 'license' };
}

/**
 * Вид пункта в списке версий: закрытая версия честно помечена, а не спрятана.
 * Возвращаем вид, а не строку, чтобы локализация осталась в виджете.
 */
export type AgggVersionOptionKind = 'builtin' | 'external' | 'external-locked';

export function agggVersionOptionKind(version: string, features: readonly string[]): AgggVersionOptionKind {
	if (version !== AGGG_EXTERNAL_VERSION) { return 'builtin'; }
	return agggVersionAvailable(version, features) ? 'external' : 'external-locked';
}
