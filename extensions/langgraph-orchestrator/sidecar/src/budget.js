'use strict';

/**
 * Бюджет запуска и узла (Этап 5.1). Чистые хелперы без состояния: граф вызывает их,
 * чтобы решить — остановить узел (needs_human) или весь запуск (interrupt).
 * 0 в любом поле означает «без лимита».
 */

function positive(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Нормализация лимитов из параметров запуска: мусор и отрицательные — в 0. */
function normalizeLimits(raw) {
	const src = raw && typeof raw === 'object' ? raw : {};
	return {
		runTokens: positive(src.runTokens),
		runCost: positive(src.runCost),
		nodeTokens: positive(src.nodeTokens),
		nodeCost: positive(src.nodeCost),
	};
}

function hasRunLimit(limits) {
	return limits.runTokens > 0 || limits.runCost > 0;
}

function hasNodeLimit(limits) {
	return limits.nodeTokens > 0 || limits.nodeCost > 0;
}

/** Превышение лимита узла: по токенам и/или по деньгам. */
function nodeOverLimit(limits, usage) {
	const tokens = Number(usage && usage.tokens) || 0;
	const cost = Number(usage && usage.cost) || 0;
	return {
		tokens: limits.nodeTokens > 0 && tokens >= limits.nodeTokens,
		cost: limits.nodeCost > 0 && cost >= limits.nodeCost,
		any: (limits.nodeTokens > 0 && tokens >= limits.nodeTokens) || (limits.nodeCost > 0 && cost >= limits.nodeCost),
	};
}

/** Превышение лимита всего запуска (сумма по всем узлам). */
function runOverLimit(limits, budget) {
	const tokens = Number(budget && budget.tokens) || 0;
	const cost = Number(budget && budget.cost) || 0;
	return {
		tokens: limits.runTokens > 0 && tokens >= limits.runTokens,
		cost: limits.runCost > 0 && cost >= limits.runCost,
		any: (limits.runTokens > 0 && tokens >= limits.runTokens) || (limits.runCost > 0 && cost >= limits.runCost),
	};
}

/** Цена в человекочитаемом виде: копейки не теряем, но и хвост не тянем. */
function formatCost(cost) {
	const value = Number(cost) || 0;
	return `$${value.toFixed(4)}`;
}

/** «12 340 токенов / $0.0456» — единая строка расхода для логов и заголовков. */
function formatBudget(budget) {
	return `${Math.round(Number(budget && budget.tokens) || 0)} токенов / ${formatCost(budget && budget.cost)}`;
}

/** Причина остановки узла: что именно исчерпано. */
function nodeBudgetNote(limits, usage) {
	const over = nodeOverLimit(limits, usage);
	if (over.cost && over.tokens) {
		return 'лимит узла: токены и стоимость';
	}
	if (over.cost) {
		return 'лимит узла: стоимость';
	}
	if (over.tokens) {
		return 'лимит узла: токены';
	}
	return '';
}

/** Заголовок interrupt'а при исчерпании бюджета запуска. */
function runBudgetTitle(language, budget, limits) {
	const used = formatBudget(budget);
	const cap = limits.runTokens > 0
		? `${limits.runTokens} токенов${limits.runCost > 0 ? ` / ${formatCost(limits.runCost)}` : ''}`
		: formatCost(limits.runCost);
	return language === 'en'
		? `Run budget exhausted (used ${used}, limit ${cap}). Continue anyway?`
		: `Бюджет запуска исчерпан (израсходовано ${used}, лимит ${cap}). Продолжать?`;
}

module.exports = {
	normalizeLimits,
	hasRunLimit,
	hasNodeLimit,
	nodeOverLimit,
	runOverLimit,
	formatCost,
	formatBudget,
	nodeBudgetNote,
	runBudgetTitle,
};
