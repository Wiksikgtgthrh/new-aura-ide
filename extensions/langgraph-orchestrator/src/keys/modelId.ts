/*---------------------------------------------------------------------------------------------
 *  Идентификаторы моделей плагина API Keys.
 *
 *  Ядро регистрирует модель ключа как `apiKeys/<id ключа>` (auraApiChatProvider,
 *  provideLanguageModelChatInfo). В реестре ключей хранится только `id`, поэтому
 *  сопоставление обязано идти через эти хелперы: при сравнении напрямую
 *  (`models.find(m => m.id === keyId)`) модель не находится, ключ навсегда
 *  остаётся в статусе unknown, а вызов модели падает с «model not usable».
 *
 *  Модуль не импортирует vscode — проверяется node-тестами (test/key-status.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export const API_KEYS_VENDOR_ID = 'apiKeys';

const API_KEYS_PREFIX = `${API_KEYS_VENDOR_ID}/`;

/** Идентификатор модели чата для ключа: `apiKeys/<keyId>`. */
export function modelIdForKey(keyId: string): string {
	return `${API_KEYS_PREFIX}${keyId}`;
}

/**
 * id ключа из идентификатора модели. Чужие идентификаторы возвращаются как есть:
 * реестр умеет работать и с другими вендорами, префикс снимается только у API Keys.
 */
export function keyIdFromModelId(modelId: string | undefined | null): string {
	const raw = String(modelId ?? '');
	if (!raw.startsWith(API_KEYS_PREFIX)) {
		return raw;
	}
	const rest = raw.slice(API_KEYS_PREFIX.length);
	if (!rest) {
		return raw;
	}
	// Вендор с группой отдаёт `apiKeys/<группа>/<id>` — id ключа идёт последним сегментом.
	const slash = rest.lastIndexOf('/');
	return slash >= 0 ? rest.slice(slash + 1) : rest;
}

/** Виден ли ключ в vscode.lm: идентификаторы моделей вендора → множество id ключей. */
export function keyIdsFromModelIds(modelIds: Iterable<string>): Set<string> {
	const ids = new Set<string>();
	for (const modelId of modelIds) {
		if (String(modelId ?? '').startsWith(API_KEYS_PREFIX)) {
			ids.add(keyIdFromModelId(modelId));
		}
	}
	return ids;
}

/** Модель вендора API Keys для ключа (для sendRequest нужен именно объект модели). */
export function modelForKey<T extends { id: string }>(models: readonly T[], keyId: string): T | undefined {
	return models.find(model => keyIdFromModelId(model.id) === keyId);
}
