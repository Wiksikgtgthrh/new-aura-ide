/*---------------------------------------------------------------------------------------------
 *  Профили бюджета (Этап 5.1+). Именованный набор лимитов и цен: пользователь
 *  сохраняет несколько наборов и переключает их из панели одним кликом.
 *  Встроенные пресеты (economy/normal/max) доступны всегда и не удаляются.
 *  Значения проходят через normalizeBudget — чужие/битые данные санитизируются.
 *--------------------------------------------------------------------------------------------*/

import { BudgetConfig, KeyTier, ModelPrice, ModelPriceRule, normalizeBudget } from './config';

export interface BudgetProfile {
	/** Стабильное имя-идентификатор. */
	name: string;
	limits: { runTokens: number; runCost: number; nodeTokens: number; nodeCost: number };
	prices: Record<KeyTier, ModelPrice>;
	modelPrices: ModelPriceRule[];
	/** Встроенный пресет: показывается всегда и не удаляется. */
	builtin?: boolean;
}

/** Встроенные пресеты: экономный, обычный, максимум (названия локализует панель). */
export const BUILTIN_PROFILES: BudgetProfile[] = [
	{
		name: 'economy',
		builtin: true,
		limits: { runTokens: 250_000, runCost: 1.5, nodeTokens: 60_000, nodeCost: 0.25 },
		prices: { high: { input: 5, output: 25 }, mid: { input: 1, output: 4 }, low: { input: 0.2, output: 0.8 } },
		modelPrices: [],
	},
	{
		name: 'normal',
		builtin: true,
		limits: { runTokens: 0, runCost: 10, nodeTokens: 0, nodeCost: 0 },
		prices: { high: { input: 15, output: 75 }, mid: { input: 3, output: 15 }, low: { input: 0.5, output: 1.5 } },
		modelPrices: [],
	},
	{
		name: 'max',
		builtin: true,
		// Максимум: без лимитов, цены стандартные — потолок задаёт только кошелёк.
		limits: { runTokens: 0, runCost: 0, nodeTokens: 0, nodeCost: 0 },
		prices: { high: { input: 15, output: 75 }, mid: { input: 3, output: 15 }, low: { input: 0.5, output: 1.5 } },
		modelPrices: [],
	},
];

/** Снимок текущего бюджета в профиль. */
export function profileFromBudget(name: string, budget: BudgetConfig): BudgetProfile {
	return {
		name,
		limits: {
			runTokens: budget.runTokens,
			runCost: budget.runCost,
			nodeTokens: budget.nodeTokens,
			nodeCost: budget.nodeCost,
		},
		prices: {
			high: { ...budget.prices.high },
			mid: { ...budget.prices.mid },
			low: { ...budget.prices.low },
		},
		modelPrices: budget.modelPrices.map(rule => ({ ...rule })),
	};
}

/** Профиль → конфиг бюджета; значения нормализуются как обычная настройка. */
export function budgetFromProfile(profile: BudgetProfile): BudgetConfig {
	return normalizeBudget({
		runTokens: profile.limits.runTokens,
		runCost: profile.limits.runCost,
		nodeTokens: profile.limits.nodeTokens,
		nodeCost: profile.limits.nodeCost,
		prices: profile.prices,
		modelPrices: profile.modelPrices,
	});
}

/** Поиск профиля по имени: пользовательские важнее встроенных. */
export function findProfile(profiles: BudgetProfile[], name: string): BudgetProfile | undefined {
	return profiles.find(profile => profile.name === name);
}

/** Разбор списка профилей из globalState: мусор пропускаем, дубликаты имён — нет. */
export function normalizeProfiles(value: unknown): BudgetProfile[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: BudgetProfile[] = [];
	const seen = new Set(BUILTIN_PROFILES.map(profile => profile.name));
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const name = String((item as { name?: unknown }).name ?? '').trim();
		if (!name || seen.has(name)) {
			continue;
		}
		seen.add(name);
		const raw = item as Record<string, unknown>;
		// Лимиты могут лежать как во вложенном limits, так и плоско (старый формат).
		const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits as Record<string, unknown> : raw;
		const budget = normalizeBudget({ ...limits, prices: raw.prices, modelPrices: raw.modelPrices });
		out.push({ ...profileFromBudget(name, budget) });
	}
	return out;
}

/** Все доступные профили: встроенные пресеты, затем пользовательские. */
export function allProfiles(userProfiles: BudgetProfile[]): BudgetProfile[] {
	return [...BUILTIN_PROFILES.map(profile => ({ ...profile })), ...userProfiles];
}
