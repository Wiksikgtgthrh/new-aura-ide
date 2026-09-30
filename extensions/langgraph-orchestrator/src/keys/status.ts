/*---------------------------------------------------------------------------------------------
 *  Статус ключа: правила слияния трёх источников правды.
 *
 *  1. Ядро API Keys (команда apiKeys.exportStatuses) — живость, классификация HTTP,
 *     cooldown после лимита, медиана первого токена, признаки «медленный».
 *  2. Командный банк (auraTeam.getState) — ключи команды с их ping и признаком «выключен».
 *  3. Локальные сбои текущего запуска оркестратора (401/403/429/сеть) и ручное
 *     исключение ключа из панели.
 *
 *  Модуль не импортирует vscode — проверяется node-тестами (test/key-status.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export type KeyStatus = 'ok' | 'cooldown' | 'dead' | 'slow' | 'excluded' | 'unknown';

/** Словарь ядра (auraApiModel.AuraHealthStatus) — держим точной копией. */
export type AuraHealthStatus = 'ok' | 'unauthorized' | 'forbidden' | 'ratelimited' | 'notfound' | 'down' | 'unknown';

/** Форма строки команды apiKeys.exportStatuses (без секретов). */
export interface CoreKeyStatus {
	health?: AuraHealthStatus;
	ok?: boolean;
	checking?: boolean;
	cooldownUntil?: number;
	pingMs?: number;
	error?: string;
	excludedHighPing?: boolean;
	excludedReason?: 'ping' | 'latency';
	latencyMs?: number;
	authenticityPct?: number | null;
	securityPct?: number | null;
	lastChecked?: number;
}

/** Форма ключа командного банка (auraTeam.getState → keys[]). */
export interface TeamKeyStatus {
	ok?: boolean | null;
	pingMs?: number | null;
	disabledAt?: string;
	lastCheckedAt?: string | null;
}

/** Локальное (переживающее refresh) состояние: что оркестратор знает сам. */
export interface KeyRuntimeState {
	/** Ключ выведен из работы вручную из панели. */
	excludedManually?: boolean;
	/** Cooldown после 429 или сетевого сбоя (ms epoch). */
	cooldownUntil?: number;
	/** 401/403 — до ручного возврата в строй. */
	dead?: boolean;
	lastError?: string;
}

export interface KeyStatusInput {
	now: number;
	/** Модель ключа видна в vscode.lm — ключ можно вызвать прямо сейчас. */
	modelUsable: boolean;
	runtime?: KeyRuntimeState;
	core?: CoreKeyStatus;
	team?: TeamKeyStatus;
}

export interface ResolvedKeyState {
	status: KeyStatus;
	cooldownUntil?: number;
	pingMs?: number;
	lastError?: string;
	health?: AuraHealthStatus;
	latencyMs?: number;
	authenticityPct?: number | null;
	securityPct?: number | null;
	lastChecked?: number;
	checking: boolean;
	excludedReason?: 'ping' | 'latency';
}

/** Сколько ключ отдыхает после лимита (429) и после сетевого сбоя. */
export const COOLDOWN_RATELIMIT_MS = 60_000;
export const COOLDOWN_NETWORK_MS = 30_000;

export const EXCLUDED_MANUALLY_MESSAGE = 'ключ выключен в панели оркестратора';
export const DISABLED_IN_TEAM_MESSAGE = 'ключ выключен в командном банке';

/** Единственное место, где решается, что показывать в колонке «Статус». */
export function resolveKeyState(input: KeyStatusInput): ResolvedKeyState {
	const { now, runtime, core, team } = input;
	const runtimeCooldown = runtime?.cooldownUntil && runtime.cooldownUntil > now ? runtime.cooldownUntil : undefined;
	const resolved: ResolvedKeyState = {
		status: 'unknown',
		cooldownUntil: runtimeCooldown,
		pingMs: core?.pingMs ?? team?.pingMs ?? undefined,
		lastError: undefined,
		health: core?.health,
		latencyMs: core?.latencyMs,
		authenticityPct: core?.authenticityPct,
		securityPct: core?.securityPct,
		lastChecked: core?.lastChecked,
		checking: core?.checking === true,
		excludedReason: core?.excludedReason,
	};

	// 1. Ручное исключение — сильнее любых источников: это решение человека.
	if (runtime?.excludedManually) {
		return { ...resolved, status: 'excluded', cooldownUntil: undefined, lastError: EXCLUDED_MANUALLY_MESSAGE };
	}
	// 2. Cooldown текущего запуска (429 или сетевой сбой) — ждём, пока он истечёт.
	if (resolved.cooldownUntil) {
		return { ...resolved, status: 'cooldown', lastError: runtime?.lastError };
	}
	// 3. Отказ ключа (401/403): ядро считает его мёртвым до ручной перепроверки.
	if (runtime?.dead) {
		return { ...resolved, status: 'dead', cooldownUntil: undefined, lastError: runtime.lastError };
	}
	// 4. Ядро вывело ключ из автовыбора по скорости первого токена.
	if (core?.excludedHighPing || core?.excludedReason === 'latency') {
		return { ...resolved, status: 'slow', lastError: core.error };
	}
	// 5. Классификация ядра по HTTP-коду проверки ключа.
	const byHealth = stateFromHealth(core, now);
	if (byHealth) {
		return { ...resolved, ...byHealth };
	}
	// 6. Ключ жив: ядро видит модель (health «ok») либо модель видна в vscode.lm.
	if (core?.health === 'ok' || core?.ok === true || input.modelUsable) {
		return { ...resolved, status: 'ok', lastError: core?.error };
	}
	// 7. Командный банк как последний источник: он видит ключ, а вендор — нет.
	if (team && (team.disabledAt || team.ok === false)) {
		return { ...resolved, status: 'dead', cooldownUntil: undefined, lastError: core?.error ?? DISABLED_IN_TEAM_MESSAGE };
	}
	return { ...resolved, status: 'unknown', lastError: core?.error };
}

/** Классификация ядра по health: 401/403/404 — мёртв, 429 и сеть — пауза. */
function stateFromHealth(core: CoreKeyStatus | undefined, now: number): Pick<ResolvedKeyState, 'status' | 'cooldownUntil' | 'lastError'> | undefined {
	const health = core?.health;
	if (!health || health === 'unknown' || health === 'ok') {
		return undefined;
	}
	if (health === 'unauthorized' || health === 'forbidden' || health === 'notfound') {
		return { status: 'dead', cooldownUntil: undefined, lastError: core?.error };
	}
	const window = health === 'ratelimited' ? COOLDOWN_RATELIMIT_MS : COOLDOWN_NETWORK_MS;
	const until = core?.cooldownUntil && core.cooldownUntil > now ? core.cooldownUntil : now + window;
	return { status: 'cooldown', cooldownUntil: until, lastError: core?.error };
}

/**
 * Локальный вывод по тексту ошибки вызова модели: 401/403 — ключ мёртв,
 * 429 — лимит, остальное (сеть, таймауты) — короткая пауза.
 */
export function runtimeFromError(error: unknown, now: number): KeyRuntimeState {
	const message = error instanceof Error ? error.message : String(error ?? '');
	if (/\b(401|403|unauthorized|forbidden|not\s*found|404)\b/i.test(message)) {
		return { dead: true, lastError: message };
	}
	if (/\b(429|rate.?limit|too many|quota)\b/i.test(message)) {
		return { cooldownUntil: now + COOLDOWN_RATELIMIT_MS, lastError: message };
	}
	return { cooldownUntil: now + COOLDOWN_NETWORK_MS, lastError: message };
}
