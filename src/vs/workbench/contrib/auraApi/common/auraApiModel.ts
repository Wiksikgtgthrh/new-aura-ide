/*---------------------------------------------------------------------------------------------
 *  API Keys — модель данных «имба-менеджера ключей» (Этап 2).
 *  Только чистые типы и функции: без DI, DOM и сети — покрывается юнит-тестами.
 *  Секреты сюда НЕ попадают в постоянное хранилище: секрет — только ISecretStorageService
 *  (ключ вида `apiKeys.secret.<keyId>`), здесь — метаданные.
 *--------------------------------------------------------------------------------------------*/

export type AuraProvider = 'openai-compatible' | 'anthropic' | 'google' | 'openrouter' | 'litellm';

export interface IAuraApiGroup {
	id: string;
	name: string;
	/** 0 = высший приоритет */
	priority: number;
	color?: string;
	/** baseUrl по умолчанию для ключей группы */
	baseUrl?: string;
}

export type AuraHealthStatus = 'ok' | 'unauthorized' | 'forbidden' | 'ratelimited' | 'notfound' | 'down' | 'unknown';

export interface IAuraApiKeyHealth {
	status: AuraHealthStatus;
	latencyMs?: number;
	checkedAt?: number;
	error?: string;
}

export interface IAuraApiModelEntry {
	id: string;
	available: 'yes' | 'no' | 'unknown';
	verifiedAt?: number;
	source: 'discovered' | 'manual';
	enabledForChat: boolean;
	contextWindow?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
}

export interface IAuraApiKey {
	id: string;
	label: string;
	groupId: string;
	baseUrl: string;
	provider: AuraProvider;
	/** вес для взвешенного round-robin внутри группы */
	weight: number;
	models: IAuraApiModelEntry[];
	health: IAuraApiKeyHealth;
	cooldownUntil?: number;
	/** fingerprint секрета для дедупликации (сам секрет тут не хранится) */
	secretFingerprint: string;
}

/* ---------------------------------- secrets ---------------------------------- */

export function auraSecretStorageKey(keyId: string): string {
	return `apiKeys.secret.${keyId}`;
}

/** Маска для UI/логов: sk-...wxyz */
export function maskSecret(secret: string): string {
	const s = secret.trim();
	if (s.length <= 8) {
		return s.slice(0, 2) + '…';
	}
	return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

/** Синхронный отпечаток для дедупликации повторной вставки (без async-crypto). */
export function secretFingerprint(secret: string): string {
	const s = secret.trim();
	return `${s.slice(0, 4)}:${s.length}:${s.slice(-4)}`;
}

/* -------------------------------- bulk parsing ------------------------------- */

export interface IAuraKeyDraft {
	label: string;
	key: string;
	baseUrl?: string;
	provider: AuraProvider;
	groupName?: string;
	weight?: number;
}

export interface IAuraBulkParseError {
	line: number;
	text: string;
	reason: string;
}

export interface IAuraBulkParseResult {
	keys: IAuraKeyDraft[];
	errors: IAuraBulkParseError[];
}

const PROVIDER_DEFAULT_BASE_URL: Record<AuraProvider, string> = {
	'openai-compatible': 'https://api.openai.com/v1',
	'anthropic': 'https://api.anthropic.com',
	'google': 'https://generativelanguage.googleapis.com',
	'openrouter': 'https://openrouter.ai',
	'litellm': 'http://localhost:4000',
};

export function defaultBaseUrl(provider: AuraProvider): string {
	return PROVIDER_DEFAULT_BASE_URL[provider];
}

/** Определение провайдера по префиксу ключа и/или хосту baseUrl. */
export function detectProvider(key: string, baseUrl?: string): AuraProvider | undefined {
	const k = key.trim();
	const host = (baseUrl ?? '').toLowerCase();
	if (k.startsWith('sk-ant-')) {
		return 'anthropic';
	}
	if (k.startsWith('sk-or-') || host.includes('openrouter.ai')) {
		return 'openrouter';
	}
	if (k.startsWith('AIza') || host.includes('generativelanguage.googleapis.com')) {
		return 'google';
	}
	if (host.includes('anthropic.com')) {
		return 'anthropic';
	}
	if (host.includes(':4000') || host.includes('litellm')) {
		return 'litellm';
	}
	if (k.startsWith('sk-') || host.length > 0) {
		return 'openai-compatible';
	}
	return undefined;
}

function looksLikeApiKey(value: string): boolean {
	const v = value.trim();
	return v.length >= 16 && !/\s/.test(v) && !v.includes('=');
}

function finalizeDraft(label: string, key: string, baseUrl: string | undefined, groupName: string | undefined, weight: number | undefined, line: number, errors: IAuraBulkParseError[]): IAuraKeyDraft | undefined {
	const k = key.trim();
	if (!looksLikeApiKey(k)) {
		errors.push({ line, text: maskSecret(k), reason: 'не похоже на API-ключ (короткий или содержит пробелы/=)' });
		return undefined;
	}
	const provider = detectProvider(k, baseUrl);
	if (!provider) {
		errors.push({ line, text: maskSecret(k), reason: 'не удалось определить провайдера — укажите baseUrl' });
		return undefined;
	}
	return {
		label: label.trim() || maskSecret(k),
		key: k,
		baseUrl: baseUrl?.trim() || defaultBaseUrl(provider),
		provider,
		groupName: groupName?.trim() || undefined,
		weight: weight !== undefined && Number.isFinite(weight) && weight > 0 ? weight : 1,
	};
}

/**
 * Массовый парсер «вставь что угодно»: сырые ключи по строкам, `label | baseUrl | key`,
 * CSV с заголовком, `.env`-строки, JSON-массив объектов.
 */
export function parseKeysBulk(text: string): IAuraBulkParseResult {
	const keys: IAuraKeyDraft[] = [];
	const errors: IAuraBulkParseError[] = [];
	const trimmed = text.trim();
	if (!trimmed) {
		return { keys, errors };
	}

	// 1) JSON-массив
	if (trimmed.startsWith('[')) {
		try {
			const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
			arr.forEach((obj, i) => {
				if (!obj || typeof obj !== 'object') {
					errors.push({ line: i + 1, text: String(obj), reason: 'элемент не является объектом' });
					return;
				}
				const key = String(obj['key'] ?? obj['apiKey'] ?? obj['api_key'] ?? '');
				const draft = finalizeDraft(
					String(obj['label'] ?? obj['name'] ?? ''),
					key,
					obj['baseUrl'] !== undefined ? String(obj['baseUrl']) : (obj['base_url'] !== undefined ? String(obj['base_url']) : undefined),
					obj['group'] !== undefined ? String(obj['group']) : undefined,
					obj['weight'] !== undefined ? Number(obj['weight']) : undefined,
					i + 1, errors);
				if (draft) {
					keys.push(draft);
				}
			});
		} catch {
			errors.push({ line: 1, text: '[JSON скрыт]', reason: 'невалидный JSON' });
		}
		return { keys, errors };
	}

	const lines = trimmed.split(/\r?\n/);

	// 2) CSV с заголовком (первая строка содержит запятую и слово key/apikey)
	const first = lines[0] ?? '';
	if (first.includes(',') && /(^|,)\s*(api_?key|key|token|secret)\s*(,|$)/i.test(first)) {
		const headers = first.split(',').map(h => h.trim().toLowerCase());
		const idx = (names: string[]) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
		const iKey = idx(['key', 'apikey', 'api_key', 'token', 'secret']);
		const iLabel = idx(['label', 'name', 'title']);
		const iBase = idx(['baseurl', 'base_url', 'url', 'endpoint']);
		const iGroup = idx(['group', 'groupname', 'group_name']);
		for (let i = 1; i < lines.length; i++) {
			const row = lines[i];
			if (!row.trim()) {
				continue;
			}
			const cells = row.split(',').map(c => c.trim());
			const draft = finalizeDraft(
				iLabel >= 0 ? (cells[iLabel] ?? '') : '',
				iKey >= 0 ? (cells[iKey] ?? '') : '',
				iBase >= 0 ? cells[iBase] : undefined,
				iGroup >= 0 ? cells[iGroup] : undefined,
				undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
		}
		return { keys, errors };
	}

	// 3) Построчный автодетект: .env / `label | baseUrl | key` / сырой ключ
	lines.forEach((raw, i) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			return;
		}
		// .env: OPENAI_API_KEY=sk-...
		const envMatch = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line);
		if (envMatch && /(API_?KEY|TOKEN|SECRET)/i.test(envMatch[1])) {
			const draft = finalizeDraft(envMatch[1], envMatch[2].replace(/^["']|["']$/g, ''), undefined, undefined, undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
			return;
		}
		// pipe: label | baseUrl | key   (baseUrl может отсутствовать: label | key)
		if (line.includes('|')) {
			const parts = line.split('|').map(p => p.trim());
			const last = parts[parts.length - 1] ?? '';
			const maybeBase = parts.length >= 3 ? parts[parts.length - 2] : undefined;
			const label = parts.slice(0, Math.max(1, parts.length - (parts.length >= 3 ? 2 : 1))).join(' | ');
			const draft = finalizeDraft(parts.length >= 3 ? label : (parts[0] ?? ''), last, maybeBase, undefined, undefined, i + 1, errors);
			if (draft) {
				keys.push(draft);
			}
			return;
		}
		// сырой ключ
		const draft = finalizeDraft('', line, undefined, undefined, undefined, i + 1, errors);
		if (draft) {
			keys.push(draft);
		}
	});
	return { keys, errors };
}

/* ------------------------- HTTP-классификация и cooldown ---------------------- */

/** Классификация ответа probe/discovery по статус-коду (п. 2 плана). */
export function classifyHttpStatus(status: number): AuraHealthStatus {
	if (status >= 200 && status < 300) {
		return 'ok';
	}
	if (status === 401) {
		return 'unauthorized';
	}
	if (status === 403) {
		return 'forbidden';
	}
	if (status === 404) {
		return 'notfound';
	}
	if (status === 429) {
		return 'ratelimited';
	}
	if (status >= 500) {
		return 'down';
	}
	return 'unknown';
}

/** 429 → 60с, 5xx → 30с, 401 → до ручной перепроверки (Infinity). */
export function cooldownMsForStatus(status: number): number {
	if (status === 429) {
		return 60_000;
	}
	if (status === 401) {
		return Number.POSITIVE_INFINITY;
	}
	if (status >= 500) {
		return 30_000;
	}
	return 0;
}

/**
 * Проверка подлинности модели: прокси часто подменяют дорогую модель дешёвой.
 * Основной сигнал — сравнение запрошенного id с полем `model` в ответе.
 */
export function modelAuthenticityPercent(requestedModel: string, returnedModel: string | undefined, heuristicPercent?: number): number {
	if (returnedModel !== undefined) {
		if (returnedModel === requestedModel) {
			return 100;
		}
		const norm = (m: string) => m.toLowerCase().replace(/[-_.]/g, '');
		if (norm(returnedModel).includes(norm(requestedModel)) || norm(requestedModel).includes(norm(returnedModel))) {
			return 70; // семейство совпало (gpt-4o vs gpt-4o-mini)
		}
		return 10; // явная подмена
	}
	return heuristicPercent ?? 50; // fallback: поведенческая эвристика
}

/* -------------------------------- сетевые сбои -------------------------------- */

/** Коды ошибок, означающие «до провайдера не дотянулись» (`net`, `undici`, Chromium). */
const NETWORK_ERROR_CODES = new Set([
	'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
	'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE',
	'ERR_NETWORK', 'ERR_NETWORK_CHANGED', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED',
	'ERR_CONNECTION_RESET', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_ADDRESS_UNREACHABLE',
	'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

const NETWORK_ERROR_NAMES = new Set(['NetworkError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError']);

const NETWORK_MESSAGE_PATTERNS = [
	/fetch failed/i,
	/failed to fetch/i,
	/load failed/i,
	/networkerror/i,
	/network error/i,
	/socket hang up/i,
	/getaddrinfo/i,
	/network is unreachable/i,
	/temporarily unavailable/i,
	/timed? ?out/i,
];

/**
 * Сбой именно связи, а не ответ сервера: такой ключ уходит в короткий cooldown, а чат
 * продолжает с другого ключа. Ошибку отмены пользователем (`AbortError`) сюда не относим —
 * это не признак мёртвого ключа.
 */
export function isNetworkFailure(error: unknown): boolean {
	const seen = new Set<unknown>();
	const pending: unknown[] = [error];

	while (pending.length > 0) {
		const current = pending.shift();
		if (current === null || typeof current !== 'object' || seen.has(current)) {
			continue;
		}
		seen.add(current);

		const { code, name, message, cause, errors } = current as {
			code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown;
		};

		if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
			return true;
		}
		if (typeof name === 'string' && NETWORK_ERROR_NAMES.has(name)) {
			return true;
		}
		if (typeof message === 'string' && NETWORK_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) {
			return true;
		}
		// AggregateError от параллельных попыток держит причину в errors.
		if (Array.isArray(errors)) {
			pending.push(...errors);
		}
		if (cause !== undefined) {
			pending.push(cause);
		}
	}

	return false;
}

/** Короткая причина сбоя для UI и логов: код, иначе имя, иначе текст сообщения. */
export function describeNetworkFailure(error: unknown): string {
	const seen = new Set<unknown>();
	let current: unknown = error;

	while (current !== null && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);
		const { code, name, message, cause } = current as {
			code?: unknown; name?: unknown; message?: unknown; cause?: unknown;
		};

		if (typeof code === 'string' && code.length > 0) {
			return code;
		}
		if (cause === undefined) {
			// 'Error' и 'TypeError' — служебные имена (последнее как раз у fetch-сбоев), по ним
			// пользователю ничего не понятно: показываем текст сообщения.
			if (typeof name === 'string' && name.length > 0 && name !== 'Error' && name !== 'TypeError') {
				return name;
			}
			return typeof message === 'string' && message.length > 0 ? message : String(error);
		}
		current = cause;
	}

	return String(error);
}

/* --------------------------------- роутер ------------------------------------ */

export interface IAuraRouterState {
	groups: IAuraApiGroup[];
	keys: IAuraApiKey[];
	/** курсор round-robin по группам */
	cursors: Map<string, number>;
}

/** Ключ пригоден: не в cooldown, не мёртв, модель доступна (если запрошена). */
export function isKeyEligible(key: IAuraApiKey, now: number, modelId?: string): boolean {
	if (key.cooldownUntil !== undefined && key.cooldownUntil > now) {
		return false;
	}
	if (key.health.status === 'unauthorized' || key.health.status === 'forbidden') {
		return false;
	}
	if (modelId !== undefined) {
		const model = key.models.find(m => m.id === modelId);
		if (model && (model.available === 'no' || !model.enabledForChat)) {
			return false;
		}
	}
	return true;
}

/** Группы по приоритету (0 — высший), стабильная сортировка. */
export function sortedGroups(groups: IAuraApiGroup[]): IAuraApiGroup[] {
	return [...groups].sort((a, b) => a.priority - b.priority);
}

/** Взвешенный round-robin внутри группы: вероятность пропорциональна weight. */
export function pickWeightedKey(eligible: IAuraApiKey[], cursor: number): { key: IAuraApiKey; nextCursor: number } | undefined {
	if (eligible.length === 0) {
		return undefined;
	}
	const total = eligible.reduce((sum, k) => sum + Math.max(1, k.weight), 0);
	const slot = ((cursor % total) + total) % total;
	let acc = 0;
	for (const k of eligible) {
		acc += Math.max(1, k.weight);
		if (slot < acc) {
			return { key: k, nextCursor: cursor + 1 };
		}
	}
	return { key: eligible[eligible.length - 1], nextCursor: cursor + 1 };
}

/**
 * resolve(modelId): группы по priority → внутри группы взвешенный round-robin,
 * ключи в cooldown и мёртвые (401/403) пропускаются. Чат жив, пока жив хоть один ключ.
 */
export function resolveKey(state: IAuraRouterState, now: number, modelId?: string): IAuraApiKey | undefined {
	for (const group of sortedGroups(state.groups)) {
		const eligible = state.keys.filter(k => k.groupId === group.id && isKeyEligible(k, now, modelId));
		const picked = pickWeightedKey(eligible, state.cursors.get(group.id) ?? 0);
		if (picked) {
			state.cursors.set(group.id, picked.nextCursor);
			return picked.key;
		}
	}
	return undefined;
}

/* --------------------- живые замеры и пороги маршрутизации --------------------- */

/**
 * Пороги «умного» переключения живут в настройках, а не в константах: «медленно»
 * у локальной модели и у большого провайдера — разные числа.
 */
export const API_KEYS_SLOW_FIRST_TOKEN_SETTING = 'apiKeys.router.slowFirstTokenMs';
export const API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING = 'apiKeys.router.firstTokenTimeoutMs';
export const API_KEYS_STREAM_GAP_SETTING = 'apiKeys.router.streamGapMs';
export const API_KEYS_SLOW_KEY_FACTOR_SETTING = 'apiKeys.router.slowKeyFactor';
export const API_KEYS_SLOW_FLOOR_SETTING = 'apiKeys.router.slowFloorMs';

/** Префикс новых id настроек плагина. */
export const API_KEYS_SETTING_PREFIX = 'apiKeys.';
/** Прежний префикс («auraApi»): значения, сохранённые до переименования, читаются как fallback. */
export const LEGACY_SETTING_PREFIX = 'auraApi.';

/** Старые id для настройки, переименованной при смене брендинга (обычно один). */
export function legacySettingIds(id: string): string[] {
	return id.startsWith(API_KEYS_SETTING_PREFIX)
		? [LEGACY_SETTING_PREFIX + id.slice(API_KEYS_SETTING_PREFIX.length)]
		: [];
}

/**
 * Значение настройки с учётом переименования: сначала новый id, при пустом значении — прежний.
 * Так пользовательский системный промпт и пороги маршрутизации переживают смену id.
 */
export function readSettingWithFallback(read: (key: string) => unknown, id: string): unknown {
	const filled = (value: unknown): boolean => value !== undefined && value !== null && value !== '';
	const value = read(id);
	if (filled(value)) {
		return value;
	}
	for (const legacyId of legacySettingIds(id)) {
		const legacy = read(legacyId);
		if (filled(legacy)) {
			return legacy;
		}
	}
	return value;
}

/**
 * Стартовый порог первого токена: работает, пока ни по одному ключу нет замеров.
 * 0 — выключить наблюдение за скоростью живых ответов целиком.
 */
export const DEFAULT_SLOW_FIRST_TOKEN_MS = 3_000;
/** Ответа нет вовсе дольше этого — попытка прерывается, запрос уходит на другой ключ. */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 45_000;
/** Молчание посреди ответа дольше этого — поток прерывается с понятным сообщением. */
export const DEFAULT_STREAM_GAP_MS = 45_000;
/** Сколько медленных ответов подряд выводят ключ из автовыбора. */
export const SLOW_STREAK_LIMIT = 2;
/**
 * Во сколько раз медленнее лучшего ключа — уже «медленно». Сравнение идёт между ключами,
 * поэтому одни и те же миллисекунды на быстром канале и на медленном прокси значат разное.
 */
export const DEFAULT_SLOW_KEY_FACTOR = 2.5;
/** Ниже этого порога «медленно» не считаем вовсе: иначе шум решает за нас и ключи мигают. */
export const DEFAULT_SLOW_FLOOR_MS = 800;
/** Сколько последних замеров держим по ключу: медиана по окну устойчивее одиночного выброса. */
export const LATENCY_WINDOW = 10;

export interface IAuraRouterLimits {
	slowFirstTokenMs: number;
	firstTokenTimeoutMs: number;
	streamGapMs: number;
	slowKeyFactor: number;
	slowFloorMs: number;
}

/** Пороги из настроек с дефолтами: мусор в настройке не должен ломать маршрутизацию. */
export function routerLimits(read: (key: string) => unknown): IAuraRouterLimits {
	// Читаем через fallback: значения, сохранённые до переименования id, продолжают работать.
	const readValue = (key: string): unknown => readSettingWithFallback(read, key);
	const num = (key: string, fallback: number): number => {
		const raw = readValue(key);
		const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
		return Number.isFinite(parsed) ? parsed : fallback;
	};
	return {
		slowFirstTokenMs: num(API_KEYS_SLOW_FIRST_TOKEN_SETTING, DEFAULT_SLOW_FIRST_TOKEN_MS),
		firstTokenTimeoutMs: num(API_KEYS_FIRST_TOKEN_TIMEOUT_SETTING, DEFAULT_FIRST_TOKEN_TIMEOUT_MS),
		streamGapMs: num(API_KEYS_STREAM_GAP_SETTING, DEFAULT_STREAM_GAP_MS),
		slowKeyFactor: num(API_KEYS_SLOW_KEY_FACTOR_SETTING, DEFAULT_SLOW_KEY_FACTOR),
		slowFloorMs: num(API_KEYS_SLOW_FLOOR_SETTING, DEFAULT_SLOW_FLOOR_MS),
	};
}

/* --------------------------- медианы и адаптивный порог ------------------------ */

/** Окно последних замеров ключа: свежие в конце, длиннее LATENCY_WINDOW не растёт. */
export function pushLatencySample(samples: readonly number[] | undefined, firstTokenMs: number): number[] {
	const next = [...(samples ?? []), firstTokenMs];
	return next.length > LATENCY_WINDOW ? next.slice(next.length - LATENCY_WINDOW) : next;
}

/** Медиана замеров: одиночный выброс (холодный старт, всплеск сети) её не сдвинет. */
export function medianLatency(samples: readonly number[] | undefined): number | undefined {
	if (!samples || samples.length === 0) {
		return undefined;
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Лучший (самый быстрый) медианный ключ из набора — база сравнения для остальных. */
export function bestMedianLatency(samplesByKey: ReadonlyArray<readonly number[] | undefined>): number | undefined {
	const medians = samplesByKey.map(medianLatency).filter((ms): ms is number => ms !== undefined);
	return medians.length > 0 ? Math.min(...medians) : undefined;
}

/**
 * Адаптивный порог «медленно» для живого ответа: относительно лучшего известного ключа.
 * Пока замеров нет — работает стартовый slowFirstTokenMs (и 0 полностью выключает наблюдение).
 * Пол нужен, чтобы на быстром канале шум в сотню миллисекунд не считался медленностью.
 */
export function slowThresholdMs(
	bestMedianMs: number | undefined,
	limits: { slowFirstTokenMs: number; slowKeyFactor: number; slowFloorMs: number },
): number {
	if (!(limits.slowFirstTokenMs > 0)) {
		return limits.slowFirstTokenMs;
	}
	if (bestMedianMs === undefined || !(bestMedianMs > 0)) {
		return limits.slowFirstTokenMs;
	}
	const factor = Math.max(1, limits.slowKeyFactor);
	return Math.max(limits.slowFloorMs, Math.round(bestMedianMs * factor));
}

/** Человеческое объяснение решения — в trace и в подсказках интерфейса. */
export function describeSlowDecision(firstTokenMs: number, thresholdMs: number, bestMedianMs: number | undefined): string {
	return `первый токен ${firstTokenMs} мс > ${thresholdMs} мс`
		+ (bestMedianMs !== undefined ? ` (лучший ключ — медиана ${bestMedianMs} мс)` : ' (замеров по другим ключам пока нет)');
}

export interface IAuraLatencyUpdate {
	/** серия медленных ответов после этого замера */
	slowStreak: number;
	/** ключ уходит из автовыбора: набрал серию медленных ответов */
	exclude: boolean;
	/** снять прежнее исключение — ответ снова быстрый */
	clearExclusion: boolean;
}

/**
 * Живой замер (время до первого токена) → как менять состояние ключа.
 * Быстрый ответ обнуляет серию и снимает исключение, поставленное по задержке;
 * исключение по пингу-зонду снимает только следующая проверка ключа.
 */
export function nextLatencyUpdate(
	previousStreak: number,
	firstTokenMs: number,
	thresholdMs: number,
	excludedReason?: 'ping' | 'latency',
): IAuraLatencyUpdate {
	if (!(thresholdMs > 0)) {
		return { slowStreak: previousStreak, exclude: false, clearExclusion: false };
	}
	if (firstTokenMs > thresholdMs) {
		const slowStreak = Math.max(0, previousStreak) + 1;
		return { slowStreak, exclude: slowStreak >= SLOW_STREAK_LIMIT, clearExclusion: false };
	}
	return { slowStreak: 0, exclude: false, clearExclusion: excludedReason === 'latency' };
}

export interface IAuraKeySpeedHint {
	/** живой замер первого токена (точнее пинга) */
	latencyMs?: number;
	/** пинг из проверки ключа */
	pingMs?: number;
}

/**
 * Есть ли среди оставшихся ключей заведомо более быстрый. Нужен, чтобы не бросать
 * модели, которые долго «думают» (reasoning), вслепую: переключаемся только там,
 * где у замены уже есть измерение в пределах порога.
 */
export function hasFasterAlternative(current: IAuraKeySpeedHint, rest: readonly IAuraKeySpeedHint[], thresholdMs: number): boolean {
	if (!(thresholdMs > 0)) { return false; }
	const fastest = (hint: IAuraKeySpeedHint): number | undefined => hint.latencyMs ?? hint.pingMs;
	const currentMs = fastest(current);
	return rest.some(hint => {
		const ms = fastest(hint);
		return ms !== undefined && ms <= thresholdMs && (currentMs === undefined || ms < currentMs);
	});
}

/** Человеческая причина вместо невнятного «network error» при молчании потока. */
export function describeStreamStall(phase: 'first-token' | 'gap', waitedMs: number): string {
	const seconds = Math.max(1, Math.round(waitedMs / 1000));
	return phase === 'first-token' ? `нет первого токена за ${seconds} с` : `поток молчит дольше ${seconds} с`;
}

/** Failover: применить исход запроса к ключу (cooldown/статус). */
export function applyRequestOutcome(key: IAuraApiKey, status: number, now: number, error?: string): void {
	const cooldownMs = cooldownMsForStatus(status);
	if (cooldownMs > 0) {
		key.cooldownUntil = cooldownMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : now + cooldownMs;
	}
	key.health = {
		status: classifyHttpStatus(status),
		checkedAt: now,
		error,
		latencyMs: key.health.latencyMs,
	};
}
