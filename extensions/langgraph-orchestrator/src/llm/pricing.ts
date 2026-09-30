/*---------------------------------------------------------------------------------------------
 *  Цены моделей (Этап 5.1). Расчёт стоимости держим в extension host: сайдкар видит
 *  только токены и уже посчитанную стоимость, но не таблицу цен.
 *--------------------------------------------------------------------------------------------*/

import { BudgetConfig, KeyTier, ModelPrice } from '../util/config';

/** Плоская таблица цен: цены по тирам + пер-модельные правила (по подстроке). */
export interface PriceTable {
	tiers: Record<KeyTier, ModelPrice>;
	models: Array<{ match: string } & ModelPrice>;
}

export function priceTableOf(budget: BudgetConfig): PriceTable {
	return {
		tiers: {
			high: { ...budget.prices.high },
			mid: { ...budget.prices.mid },
			low: { ...budget.prices.low },
		},
		models: budget.modelPrices.map(rule => ({ match: rule.match, input: rule.input, output: rule.output })),
	};
}

/**
 * Цена модели: пер-модельное правило важнее цены тира. Неизвестная модель
 * считается как high-тир — это осознанно консервативная оценка расходов.
 */
export function priceFor(table: PriceTable, model: string, tier: KeyTier): ModelPrice {
	const name = String(model || '').toLowerCase();
	for (const rule of table.models) {
		if (rule.match && name.includes(rule.match)) {
			return { input: rule.input, output: rule.output };
		}
	}
	return table.tiers[tier] ?? table.tiers.high;
}

/** Стоимость по токенам, $: цены заданы за 1M токенов. */
export function costOf(usage: { inputTokens: number; outputTokens: number }, price: ModelPrice): number {
	const input = Number(usage.inputTokens) || 0;
	const output = Number(usage.outputTokens) || 0;
	return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
}
