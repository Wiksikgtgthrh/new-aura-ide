/*---------------------------------------------------------------------------------------------
 *  AGGG — запрос прав аккаунта у расширения Team.
 *  Права живут на сервере команды; расширение отдаёт их командой `auraTeam.hasEntitlement`.
 *  Расширение может быть не установлено или не активировано — тогда прав нет, и это
 *  штатная ситуация: версия 5.2 остаётся закрытой, а встроенное ядро работает как обычно.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AGGG_52_FEATURE } from '../common/agggEntitlements.js';

/** Команда расширения Team, отвечающая на вопрос «выдано ли право аккаунту». */
export const AGGG_ENTITLEMENT_COMMAND = 'auraTeam.hasEntitlement';

/** Кэш на процесс: вопрос задаётся и виджетом версии, и загрузчиком ядра. */
let featureCache: { at: number; features: string[] } | undefined;
const CACHE_TTL = 5_000;

/** Список возможностей аккаунта для AGGG (пустой список — нет ни прав, ни расширения). */
export async function queryAgggFeatures(commandService: ICommandService): Promise<string[]> {
	if (featureCache && Date.now() - featureCache.at < CACHE_TTL) { return featureCache.features; }
	let features: string[] = [];
	try {
		const result = await commandService.executeCommand<{ granted?: boolean }>(AGGG_ENTITLEMENT_COMMAND, AGGG_52_FEATURE);
		features = result?.granted ? [AGGG_52_FEATURE] : [];
	} catch {
		// Команды нет: расширение Team не установлено или ещё не активировано.
		features = [];
	}
	featureCache = { at: Date.now(), features };
	return features;
}

/** Команда расширения Team: поставка ядра 5.2, скачанная с сервера по праву. */
export const AGGG_AGENT_COMMAND = 'auraTeam.agggAgent';

let agentCache: { at: number; path: string | undefined } | undefined;

/**
 * Путь к ядру 5.2, доставленному сервером Team. Пусто — значит права нет, или
 * расширение не установлено, или сервер не поставляет ядро: во всех случаях
 * работаем на встроенном ядре, поэтому пустой ответ — штатная ситуация.
 * Файлы лежат у клиента только после проверки права на сервере.
 */
export async function queryAgggAgentPath(commandService: ICommandService): Promise<string | undefined> {
	if (agentCache && Date.now() - agentCache.at < CACHE_TTL) { return agentCache.path; }
	let path: string | undefined;
	try {
		const result = await commandService.executeCommand<{ path?: string }>(AGGG_AGENT_COMMAND);
		path = typeof result?.path === 'string' && result.path.length > 0 ? result.path : undefined;
	} catch {
		path = undefined;
	}
	agentCache = { at: Date.now(), path };
	return path;
}

/** Сбросить кэш — вызывается при входе/выходе, чтобы право перепроверялось сразу. */
export function resetAgggFeaturesCache(): void {
	featureCache = undefined;
	agentCache = undefined;
}
