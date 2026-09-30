import * as vscode from 'vscode';
import { UiLanguage } from './language';

export type { UiLanguage };
export type KeyTier = 'high' | 'mid' | 'low';
export type ApprovalPolicy = 'auto-readonly' | 'confirm-writes' | 'confirm-all';

export interface TierRule {
	/** Подстрока для совпадения по name/baseUrl/model ключа */
	match?: string;
	/** Диапазон командного приоритета (0-1000), включительно */
	priorityFrom?: number;
	priorityTo?: number;
	tier: KeyTier;
}

/** Одна команда проверки проекта для петли самолечения (Этап 4.2). */
export interface CheckCommand {
	command: string;
	/** Таймаут на команду, мс. */
	timeoutMs: number;
}

/** Цена модели: доллары США за 1M токенов входа/выхода (Этап 5.1). */
export interface ModelPrice {
	input: number;
	output: number;
}

/** Пер-модельное переопределение цены: match — подстрока имени модели. */
export interface ModelPriceRule extends ModelPrice {
	match: string;
}

/**
 * Бюджет запуска и узла (Этап 5.1): 0 — без лимита. Цены задаются по тирам,
 * пер-модельные правила важнее; неизвестная модель считается как high-тир.
 */
export interface BudgetConfig {
	runTokens: number;
	runCost: number;
	nodeTokens: number;
	nodeCost: number;
	prices: Record<KeyTier, ModelPrice>;
	modelPrices: ModelPriceRule[];
}

export interface OrchestratorConfig {
	tierRules: TierRule[];
	tierOverrides: Record<string, KeyTier>;
	approvals: ApprovalPolicy;
	maxParallelWorkers: number;
	/** Сколько агентов одновременно может идти через один ключ (0 — без предела). */
	maxAgentsPerKey: number;
	escalationThreshold: number;
	terminalAllowlist: string[];
	uiLanguage: UiLanguage;
	/** Ретраев у провалившейся верификации до сдачи (evaluator-optimizer). */
	maxVerifyRetries: number;
	/** Команда проверки для verify-ноды ('' — только эвристика по тексту результата). */
	verifyCommand: string;
	/** Автозабор задач доски тимы с меткой [agent] из колонки «В очереди». */
	teamAutoGrab: boolean;
	/** Сколько задач автозабора держать в очереди (оркестратор идёт по одной за раз). */
	teamAutoGrabLimit: number;
	/** Путь к git-бинарнику (используется для worktree/merge, Этап 4). */
	gitPath: string;
	/** Команды проверок проекта для самолечения (lint/typecheck/test), Этап 4.2. */
	checks: CheckCommand[];
	/** Жёсткий лимит итераций правка→проверка внутри воркера (Этап 4.2). */
	maxFixIterations: number;
	/** Бюджет токенов/денег на запуск и узел + цены моделей (Этап 5.1). */
	budget: BudgetConfig;
	/** Трейсинг спанов (Этап 5.2): файл в .aura, опциональный OTLP-endpoint. */
	trace: TraceConfig;
}

/** Настройки трейсинга (Этап 5.2). */
export interface TraceConfig {
	enabled: boolean;
	/** Включить запись JSONL в .aura/orchestrator/traces (в дополнение к буферу). */
	file: boolean;
	/** OTLP/HTTP endpoint, напр. http://localhost:4318. Пусто — без экспорта. */
	otlpEndpoint: string;
	maxSpans: number;
}

/** Дефолтные проверки проекта, если пользователь не задал свои. */
export const DEFAULT_CHECKS: CheckCommand[] = [
	{ command: 'npm run lint', timeoutMs: 120_000 },
	{ command: 'npx tsc --noEmit', timeoutMs: 180_000 },
	{ command: 'npm test', timeoutMs: 180_000 },
];

/** Дефолтные цены за 1M токенов: используются, когда пользователь не задал свои. */
export const DEFAULT_PRICES: Record<KeyTier, ModelPrice> = {
	high: { input: 15, output: 75 },
	mid: { input: 3, output: 15 },
	low: { input: 0.5, output: 1.5 },
};

/** Бюджет по умолчанию: лимиты выключены, цены — дефолтные по тирам. */
export const DEFAULT_BUDGET: BudgetConfig = {
	runTokens: 0,
	runCost: 0,
	nodeTokens: 0,
	nodeCost: 0,
	prices: DEFAULT_PRICES,
	modelPrices: [],
};

export function readConfig(): OrchestratorConfig {
	const cfg = vscode.workspace.getConfiguration('langgraphOrchestrator');
	const tiers = cfg.get<{ rules?: TierRule[] }>('tiers', { rules: [] });
	return {
		tierRules: Array.isArray(tiers?.rules) ? tiers.rules : [],
		tierOverrides: cfg.get<Record<string, KeyTier>>('tierOverrides', {}),
		approvals: cfg.get<ApprovalPolicy>('approvals', 'confirm-writes'),
		maxParallelWorkers: cfg.get<number>('maxParallelWorkers', 3),
		maxAgentsPerKey: cfg.get<number>('maxAgentsPerKey', 0),
		escalationThreshold: cfg.get<number>('escalationThreshold', 2),
		terminalAllowlist: cfg.get<string[]>('terminalAllowlist', []),
		// По умолчанию 'auto': панель следует общему переключателю Aura (aura.language),
		// а без него — языку IDE. Явные 'ru'/'en' в настройке остаются выбором пользователя
		// и приоритетнее общего переключателя.
		uiLanguage: cfg.get<UiLanguage>('uiLanguage', 'auto'),
		maxVerifyRetries: cfg.get<number>('maxVerifyRetries', 2),
		verifyCommand: cfg.get<string>('verifyCommand', ''),
		teamAutoGrab: cfg.get<boolean>('teamAutoGrab', false),
		teamAutoGrabLimit: cfg.get<number>('teamAutoGrabLimit', 2),
		gitPath: cfg.get<string>('gitPath', 'git'),
		checks: normalizeChecks(cfg.get<CheckCommand[]>('checks')),
		maxFixIterations: Math.max(1, cfg.get<number>('maxFixIterations', 3)),
		budget: normalizeBudget(cfg.get('budget')),
		trace: normalizeTrace(cfg.get('trace')),
	};
}

/** Настройка trace: включена по умолчанию, файл пишется только по желанию. */
export function normalizeTrace(value: unknown): TraceConfig {
	const raw = (value ?? {}) as Record<string, unknown>;
	const maxSpans = Number(raw.maxSpans);
	return {
		enabled: raw.enabled !== false,
		file: raw.file === true,
		otlpEndpoint: typeof raw.otlpEndpoint === 'string' ? raw.otlpEndpoint.trim() : '',
		maxSpans: Number.isFinite(maxSpans) && maxSpans > 0 ? Math.min(5000, Math.floor(maxSpans)) : 500,
	};
}

/** Лимит бюджета: 0 и мусор — «без лимита», отрицательные значения не проходят. */
function positiveLimit(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizePrice(value: unknown, fallback: ModelPrice): ModelPrice {
	const raw = (value ?? {}) as Partial<ModelPrice>;
	const input = Number(raw.input);
	const output = Number(raw.output);
	return {
		input: Number.isFinite(input) && input >= 0 ? input : fallback.input,
		output: Number.isFinite(output) && output >= 0 ? output : fallback.output,
	};
}

/** Настройка budget: терпима к мусору — битые поля заменяются дефолтами. */
export function normalizeBudget(value: unknown): BudgetConfig {
	const raw = (value ?? {}) as Record<string, unknown>;
	const pricesRaw = (raw.prices ?? {}) as Record<string, unknown>;
	const modelRules = Array.isArray(raw.modelPrices) ? raw.modelPrices : [];
	return {
		runTokens: positiveLimit(raw.runTokens),
		runCost: positiveLimit(raw.runCost),
		nodeTokens: positiveLimit(raw.nodeTokens),
		nodeCost: positiveLimit(raw.nodeCost),
		prices: {
			high: normalizePrice(pricesRaw.high, DEFAULT_PRICES.high),
			mid: normalizePrice(pricesRaw.mid, DEFAULT_PRICES.mid),
			low: normalizePrice(pricesRaw.low, DEFAULT_PRICES.low),
		},
		modelPrices: modelRules
			.map(rule => ({ match: String((rule as ModelPriceRule)?.match ?? '').trim().toLowerCase(), ...normalizePrice(rule, DEFAULT_PRICES.high) }))
			.filter(rule => rule.match !== ''),
	};
}

/** Настройка checks: пустой/битый список — используем дефолты, а не падаем. */
function normalizeChecks(value: CheckCommand[] | undefined): CheckCommand[] {
	if (!Array.isArray(value) || value.length === 0) {
		return DEFAULT_CHECKS.slice();
	}
	const checks = value
		.map(item => ({ command: String(item?.command ?? '').trim(), timeoutMs: Number(item?.timeoutMs) || 120_000 }))
		.filter(item => item.command !== '');
	return checks.length ? checks : DEFAULT_CHECKS.slice();
}

export async function writeTierOverride(keyId: string, tier: KeyTier): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('langgraphOrchestrator');
	const current = cfg.get<Record<string, KeyTier>>('tierOverrides', {});
	await cfg.update('tierOverrides', { ...current, [keyId]: tier }, vscode.ConfigurationTarget.Global);
}

const TIER_ORDER: KeyTier[] = ['high', 'mid', 'low'];

export function lowerTier(tier: KeyTier): KeyTier | undefined {
	const idx = TIER_ORDER.indexOf(tier);
	return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : undefined;
}

export function higherTier(tier: KeyTier): KeyTier | undefined {
	const idx = TIER_ORDER.indexOf(tier);
	return idx > 0 ? TIER_ORDER[idx - 1] : undefined;
}
