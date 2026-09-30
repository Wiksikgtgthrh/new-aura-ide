/*---------------------------------------------------------------------------------------------
 *  Тиры моделей: где модель живёт (низкий/средний/высокий) и как это переживает рестарт IDE.
 *
 *  Модель — это ключ банка IDE (`apiKeys/<id ключа>`) или строка командного банка.
 *  Тиры не приходят из источника: их назначает пользователь, а до первого назначения —
 *  эвристика по названию модели (mini/flash/haiku → низкий, opus/pro/large → высокий).
 *
 *  Выбор пользователя хранится в globalState под ключом `orchestrator.tier.<source>:<id>`
 *  и потому переживает перезапуск окна. Модуль не импортирует vscode — проверяется
 *  node-тестами (test/tierStore.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export type KeyTier = 'high' | 'mid' | 'low';
export type ModelSource = 'personal' | 'team';

/** Минимум, который нужен от globalState (vscode.Memento подходит как есть). */
export interface TierMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

/** Подсказки «дешёвой» модели: по ним ключ уходит на низкий тир, пока не переопределён. */
const LOW_HINTS = ['mini', 'flash', 'haiku', 'lite', 'nano', 'small', '8b', 'instant'];
/** Подсказки «тяжёлой» модели: рассуждения и длинный контекст. */
const HIGH_HINTS = ['opus', 'pro', 'o3', 'o4', 'large', '70b', '405b', 'sonnet', 'reason'];

/** Ключ хранения тира: источник разделяет одноимённые ключи личного и командного банка. */
export function tierKey(source: ModelSource, modelId: string): string {
	return `orchestrator.tier.${source}:${modelId}`;
}

/**
 * Тир по названию модели, пока пользователь не выбрал свой. Порядок важен: «mini pro»
 * — это семейство с дорогим и дешёвым вариантом, и дешёвый признак точнее.
 */
export function defaultTierForModel(name: string): KeyTier {
	const haystack = String(name ?? '').toLowerCase();
	if (LOW_HINTS.some(hint => haystack.includes(hint))) {
		return 'low';
	}
	if (HIGH_HINTS.some(hint => haystack.includes(hint))) {
		return 'high';
	}
	return 'mid';
}

export interface TierStoreOptions {
	/** Явные переопределения из настроек (по id ключа) — выше всего остального. */
	overrides?: Record<string, KeyTier>;
}

/**
 * Хранилище тиров: явные настройки → выбор пользователя в globalState → эвристика.
 * Все чтения синхронные: реестр ключей спрашивает тир при каждой сборке списка.
 */
export class TierStore {
	private overrides: Record<string, KeyTier>;

	constructor(private readonly memento: TierMemento, options: TierStoreOptions = {}) {
		this.overrides = options.overrides ?? {};
	}

	/** Обновить переопределения из настроек (смена конфигурации). */
	setOverrides(overrides: Record<string, KeyTier> | undefined): void {
		this.overrides = overrides ?? {};
	}

	/** Тир модели: настройки «id ключа» важнее сохранённого выбора, тот — эвристики. */
	tierFor(source: ModelSource, modelId: string, name: string, priority?: number): KeyTier {
		const byId = this.overrides[modelId];
		if (isTier(byId)) {
			return byId;
		}
		const stored = this.memento.get<KeyTier>(tierKey(source, modelId));
		if (isTier(stored)) {
			return stored;
		}
		const heuristic = defaultTierForModel(name);
		if (heuristic !== 'mid') {
			return heuristic;
		}
		// Командный приоритет 0-1000 — запасная подсказка, когда имя ни о чём не говорит.
		if (priority !== undefined) {
			if (priority <= 100) {
				return 'high';
			}
			if (priority > 500) {
				return 'low';
			}
		}
		return 'mid';
	}

	/** Только сохранённый человеком тир, без эвристики (реестр решает порядок правил сам). */
	storedTier(source: ModelSource, modelId: string): KeyTier | undefined {
		const stored = this.memento.get<KeyTier>(tierKey(source, modelId));
		return isTier(stored) ? stored : undefined;
	}

	/** Сохранить выбор пользователя: переживает перезапуск окна (globalState). */
	async setTier(source: ModelSource, modelId: string, tier: KeyTier): Promise<void> {
		await this.memento.update(tierKey(source, modelId), tier);
	}

	/** Есть ли сохранённый выбор пользователя (для подписи «задан вручную»). */
	isUserSet(source: ModelSource, modelId: string): boolean {
		return isTier(this.memento.get<KeyTier>(tierKey(source, modelId)));
	}
}

export function isTier(value: unknown): value is KeyTier {
	return value === 'high' || value === 'mid' || value === 'low';
}
