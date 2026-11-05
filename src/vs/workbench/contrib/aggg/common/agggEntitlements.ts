/*---------------------------------------------------------------------------------------------
 *  AGGG — версии ядра буста.
 *
 *  Версия 5.2 открыта всем: файлы обвязки (harness) едут с сервера Team, а не лежат
 *  в поставке IDE, поэтому обновлять её можно без выпуска новой сборки. Право
 *  `aggg52` больше ничего не блокирует — сервер отдаёт ядро любому вошедшему аккаунту.
 *
 *  Раньше 5.2 была платной: право выдавалось аккаунту на стороне Team. Логику
 *  оставили прежней по форме (решение, вид пункта), чтобы интерфейс и виджет версии
 *  не переписывать, но доступ теперь не зависит от списка возможностей.
 *
 *  Файл чистый (без vscode), поэтому его покрывают обычные mocha-тесты.
 *--------------------------------------------------------------------------------------------*/

export const AGGG_BUILTIN_VERSION = '2.0.0';
export const AGGG_EXTERNAL_VERSION = '5.2';

/** Возможность аккаунта, когда-то открывавшая внешнее ядро 5.2. Право больше не требуется. */
export const AGGG_52_FEATURE = 'aggg52';

export type AgggVersion = typeof AGGG_BUILTIN_VERSION | typeof AGGG_EXTERNAL_VERSION;

/** Почему версия недоступна. Гейта больше нет — тип оставлен для совместимости вызывающих. */
export type AgggVersionBlock = 'license' | undefined;

export interface IAgggVersionDecision {
	/** Версия, которую реально можно использовать. */
	readonly version: AgggVersion;
	/** Была ли выбранная версия заблокирована. */
	readonly blocked: boolean;
	readonly reason: AgggVersionBlock;
}

/** Доступна ли версия. Все версии открыты: ядро 5.2 приходит с сервера по запросу. */
export function agggVersionAvailable(_version: string, _features: readonly string[] = []): boolean {
	return true;
}

/** Выбранная версия всегда играбельна: откатываться на встроенное ядро больше не за что. */
export function resolveAgggVersion(setting: string | undefined, _features: readonly string[] = []): IAgggVersionDecision {
	const requested: AgggVersion = String(setting ?? '').trim() === AGGG_EXTERNAL_VERSION ? AGGG_EXTERNAL_VERSION : AGGG_BUILTIN_VERSION;
	return { version: requested, blocked: false, reason: undefined };
}

/**
 * Вид пункта в списке версий. Закрытых пунктов больше нет: внешняя версия
 * всегда выбирается, а её файлы приходят с сервера.
 */
export type AgggVersionOptionKind = 'builtin' | 'external' | 'external-locked';

export function agggVersionOptionKind(version: string, _features: readonly string[] = []): AgggVersionOptionKind {
	return version !== AGGG_EXTERNAL_VERSION ? 'builtin' : 'external';
}
