/*---------------------------------------------------------------------------------------------
 *  Каталог моделей: единый список того, чем может работать оркестратор.
 *
 *  Два источника, и оба обязаны быть видны в панели:
 *   1. Личный банк — модели, зарегистрированные ядром API Keys (`apiKeys/<ключ>`).
 *      Именно их можно вызвать через vscode.lm.
 *   2. Командный банк — ключи команды из aura-team. Их модели вызываются прокси
 *      командного банка, поэтому локально они не «selectable», но нужны в списке.
 *
 *  Модуль не импортирует vscode: он собирает каталог из уже нормализованных строк,
 *  и проверяется node-тестами (test/modelCatalog.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { KeyTier, ModelSource, TierStore, defaultTierForModel } from './tierStore';

/** Минимум, который каталогу нужен от строки реестра ключей. */
export interface CatalogKeyInput {
	id: string;
	source: ModelSource;
	name: string;
	model: string;
	tier: KeyTier;
	status: string;
	selectable: boolean;
	pingMs?: number;
	activeCalls?: number;
}

/** Строка реестра ключей: источник в нём называется 'local', в каталоге — 'personal'. */
export interface CatalogKeyRow {
	id: string;
	source: 'local' | 'team';
	name: string;
	model: string;
	tier: KeyTier;
	status: string;
	selectable: boolean;
	pingMs?: number;
	activeCalls: number;
}

/** Приведение строк реестра к входу каталога: 'local' становится 'personal'. */
export function toCatalogInputs(rows: CatalogKeyRow[]): CatalogKeyInput[] {
	return rows.map(row => ({ ...row, source: row.source === 'team' ? 'team' : 'personal' }));
}

export interface CatalogModel {
	/** Стабильный идентификатор: `<source>:<keyId>` — им же адресуется тир. */
	id: string;
	keyId: string;
	displayName: string;
	model: string;
	source: ModelSource;
	tier: KeyTier;
	status: string;
	/** Модель можно вызвать прямо сейчас (есть в vscode.lm). */
	selectable: boolean;
	pingMs?: number;
	activeCalls: number;
}

/**
 * Сборка каталога из строк реестра. Тиры берутся из строки, а если она пустая —
 * пересчитываются эвристикой, чтобы каталог был самодостаточным.
 */
export function buildCatalogModels(keys: CatalogKeyInput[]): CatalogModel[] {
	return keys.map(key => ({
		id: `${key.source}:${key.id}`,
		keyId: key.id,
		displayName: key.name || key.model || key.id,
		model: key.model || '',
		source: key.source,
		tier: key.tier ?? defaultTierForModel(`${key.name} ${key.model}`),
		status: key.status,
		selectable: key.selectable,
		pingMs: key.pingMs,
		activeCalls: key.activeCalls ?? 0,
	}));
}

/** Модели одного тира: живые и не в cooldown, в порядке пригодности к вызову. */
export function modelsInTier(models: CatalogModel[], tier: KeyTier): CatalogModel[] {
	return models
		.filter(model => model.tier === tier && model.selectable)
		.filter(model => model.status === 'ok' || model.status === 'unknown')
		.sort((a, b) => {
			if (a.activeCalls !== b.activeCalls) {
				return a.activeCalls - b.activeCalls;
			}
			return (a.pingMs ?? Number.MAX_SAFE_INTEGER) - (b.pingMs ?? Number.MAX_SAFE_INTEGER);
		});
}

/** Сводка по источникам для фильтра в панели: сколько личных и сколько командных. */
export function catalogSourceCounts(models: CatalogModel[]): Record<ModelSource, number> {
	return models.reduce<Record<ModelSource, number>>((acc, model) => {
		acc[model.source] = (acc[model.source] ?? 0) + 1;
		return acc;
	}, { personal: 0, team: 0 });
}

/**
 * Каталог поверх реестра ключей: не хранит состояние, а пересобирается из списка.
 * Реестр остаётся источником правды по статусам, каталог — по «что и на каком тире».
 */
export class ModelCatalog {
	constructor(private readonly listKeys: () => CatalogKeyInput[], private readonly tierStore?: TierStore) {}

	list(): CatalogModel[] {
		const models = buildCatalogModels(this.listKeys());
		if (!this.tierStore) {
			return models;
		}
		return models.map(model => ({ ...model, tier: this.tierStore!.tierFor(model.source, model.keyId, `${model.displayName} ${model.model}`) }));
	}

	byTier(tier: KeyTier): CatalogModel[] {
		return modelsInTier(this.list(), tier);
	}

	counts(): Record<ModelSource, number> {
		return catalogSourceCounts(this.list());
	}
}
