/*---------------------------------------------------------------------------------------------
 *  Импорт ключей из плагина Aura API в банк команды: чистые правила маппинга.
 *  Вынесено без зависимости от vscode, чтобы покрыть тестами (см. test/keys-import.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** Провайдер команды, как его отдаёт сервер. */
export interface TeamProvider {
	readonly id: string;
	readonly name: string;
	readonly origin?: string;
	readonly builtin?: boolean;
}

/** Ключ из банка плагина Aura API (без секрета). */
export interface AuraApiKey {
	readonly id: string;
	readonly name?: string;
	readonly baseUrl?: string;
	readonly model?: string;
	readonly priority?: string;
}

/** Секрет и параметры одного ключа API Keys (ответ apiKeys.exportKey). */
export interface AuraApiKeyExport {
	readonly value?: string;
	readonly provider?: string;
	readonly baseUrl?: string;
	readonly model?: string;
}

/** Приоритет Aura API — строка; в банке команды это целое 0..1000, меньше — выше. */
export function mapAuraPriority(priority: unknown): number {
	const value = String(priority ?? '').toLowerCase();
	if (value === 'high') { return 10; }
	if (value === 'low') { return 500; }
	const asNumber = Number(priority);
	if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= 1000) { return asNumber; }
	return 100;
}

/** Хост адреса — по нему узнаём уже зарегистрированный провайдер с тем же origin. */
export function originOf(url: unknown): string {
	try {
		const parsed = new URL(String(url ?? ''));
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return '';
	}
}

/**
 * Провайдер команды для импортируемого ключа: сначала точное совпадение по id,
 * затем по origin базового адреса, затем по имени. Undefined — провайдера нет,
 * и его нужно зарегистрировать (openai-совместимый шлюз).
 */
export function matchTeamProvider(providers: readonly TeamProvider[], input: { provider?: string; baseUrl?: string; name?: string }): TeamProvider | undefined {
	const wantedId = String(input.provider ?? '').toLowerCase();
	if (wantedId) {
		const byId = providers.find(candidate => candidate.id.toLowerCase() === wantedId);
		if (byId) { return byId; }
	}
	const wantedOrigin = originOf(input.baseUrl);
	if (wantedOrigin) {
		const byOrigin = providers.find(candidate => originOf(candidate.origin) === wantedOrigin);
		if (byOrigin) { return byOrigin; }
	}
	const wantedName = String(input.name ?? '').trim().toLowerCase();
	if (wantedName) {
		const byName = providers.find(candidate => candidate.name.trim().toLowerCase() === wantedName);
		if (byName) { return byName; }
	}
	return undefined;
}

/** Черновик провайдера команды для шлюза, совместимого с OpenAI. */
export function providerDraftFrom(input: { name?: string; baseUrl?: string }): { name: string; origin: string; authScheme: 'bearer'; allowedPaths: Array<{ method: string; path: string }>; probePath: string } {
	return {
		name: String(input.name ?? '').trim().slice(0, 60) || 'Aura API',
		origin: originOf(input.baseUrl),
		authScheme: 'bearer',
		allowedPaths: [
			{ method: 'GET', path: '/v1/models' },
			{ method: 'POST', path: '/v1/chat/completions' },
		],
		probePath: '/v1/models',
	};
}

/** Человекочитаемое имя ключа в банке команды. */
export function importLabelOf(key: AuraApiKey): string {
	return String(key.name ?? '').trim().slice(0, 80) || String(key.model ?? '').trim().slice(0, 80) || 'API key';
}

/** Итог импорта: сколько прошло и почему остальные нет (для тоста и лога). */
export interface ImportOutcome {
	imported: number;
	skipped: Array<{ name: string; reason: 'no-secret' | 'no-provider' | 'error'; detail?: string }>;
}

export function summarizeImport(outcome: ImportOutcome): string {
	const total = outcome.imported + outcome.skipped.length;
	const parts = [`${outcome.imported}/${total}`];
	const reasons = new Map<string, number>();
	for (const item of outcome.skipped) { reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1); }
	for (const [reason, count] of reasons) { parts.push(`${reason}:${count}`); }
	return parts.join(' ');
}
