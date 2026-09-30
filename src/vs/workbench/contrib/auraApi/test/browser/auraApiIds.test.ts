/*---------------------------------------------------------------------------------------------
 *  API Keys — согласованность идентификаторов с другими плагинами.
 *  Команды (`apiKeys.*`) и vendor языковых моделей (`apiKeys`) — договор между тремя
 *  расширениями: если id переименовали в одном месте, остальные обязаны узнать об этом.
 *  Компилятор такое не поймает (строки), поэтому проверяем статически — ровно на этом
 *  и спотыкается переименование.
 *  Запуск: ./scripts/test.sh (mocha, suite/test-глобалы).
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

function read(relative: string): string {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/** Файлы плагина (без тестов) — там не должно остаться прежнего названия. */
function pluginFiles(relativeDir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(fileURLToPath(new URL(relativeDir, import.meta.url)))) {
		const next = `${relativeDir}${entry}`;
		if (statSync(fileURLToPath(new URL(next, import.meta.url))).isDirectory()) {
			if (entry !== 'test') {
				out.push(...pluginFiles(`${next}/`));
			}
		} else if (/\.(ts|css)$/.test(entry) && !entry.endsWith('.test.ts')) {
			out.push(next);
		}
	}
	return out;
}

/**
 * Id команд, объявленные плагином ключей (по скомпилированному модулю — как видит IDE).
 * Кавычки могут быть и одинарными, и двойными: транспилер не обязан их сохранять.
 */
function declaredCommandIds(): Set<string> {
	const compiled = read('../../browser/auraApi.contribution.js');
	return new Set([...compiled.matchAll(/["'](apiKeys\.[A-Za-z]+)["']/g)].map(m => m[1]));
}

/** Id команд, которые зовут другие плагины. */
function usedCommandIds(source: string): string[] {
	return [...source.matchAll(/["']apiKeys\.([A-Za-z]+)["']/g)].map(m => `apiKeys.${m[1]}`);
}

// out/ повторяет структуру src/, поэтому один и тот же относительный путь ведёт к корню репозитория
// и в исходниках, и в собранных тестах: src|out / vs / workbench / contrib / auraApi / test / browser.
const REPO_ROOT = '../../../../../../../';

const OTHER_PLUGINS: ReadonlyArray<{ name: string; file: string }> = [
	{ name: 'aura-team', file: `${REPO_ROOT}extensions/aura-team/src/extension.ts` },
	{ name: 'langgraph-orchestrator (реестр ключей)', file: `${REPO_ROOT}extensions/langgraph-orchestrator/src/keys/registry.ts` },
	{ name: 'langgraph-orchestrator (хост панели)', file: `${REPO_ROOT}extensions/langgraph-orchestrator/src/host.ts` },
];

suite('API Keys — идентификаторы и договор с другими плагинами', () => {

	test('все команды apiKeys.*, которые зовут другие плагины, объявлены плагином ключей', () => {
		const declared = declaredCommandIds();
		const missing: string[] = [];
		for (const plugin of OTHER_PLUGINS) {
			for (const id of usedCommandIds(read(plugin.file))) {
				if (!declared.has(id)) {
					missing.push(`${plugin.name}: ${id}`);
				}
			}
		}

		assert.deepStrictEqual({
			missing,
			declaresExportKeysList: declared.has('apiKeys.exportKeysList'),
			declaresExportKey: declared.has('apiKeys.exportKey'),
			declaresAddTeamProxy: declared.has('apiKeys.addTeamProxy'),
			// Оркестратор читает живость ключей и умеет просить перепроверку.
			declaresExportStatuses: declared.has('apiKeys.exportStatuses'),
			declaresCheckKeys: declared.has('apiKeys.checkKeys'),
			noLegacyIds: [...declared].filter(id => id.startsWith('apiKeys.') && id.includes('aura')).length,
		}, {
			missing: [],
			declaresExportKeysList: true,
			declaresExportKey: true,
			declaresAddTeamProxy: true,
			declaresExportStatuses: true,
			declaresCheckKeys: true,
			noLegacyIds: 0,
		});
	});

	test('vendor языковых моделей одинаков у плагина ключей и у оркестратора', () => {
		const providerSource = read('../../browser/auraApiChatProvider.js');
		const declaredVendor = /API_KEYS_VENDOR = ["']([^"']+)["']/.exec(providerSource)?.[1];
		// Оркестратор пишет vendor и строкой, и константой — константу ищем в его же модуле:
		// тест обязан ловить и подмену значения константы, а не только литерал.
		const orchestratorVendorConstant = /API_KEYS_VENDOR_ID = ["']([^"']+)["']/.exec(
			read(`${REPO_ROOT}extensions/langgraph-orchestrator/src/keys/modelId.ts`))?.[1];
		const orchestratorVendors = [
			...read(`${REPO_ROOT}extensions/langgraph-orchestrator/src/llm/routerProxy.ts`).matchAll(/vendor: (?:["']([^"']+)["']|API_KEYS_VENDOR_ID)/g),
			...read(`${REPO_ROOT}extensions/langgraph-orchestrator/src/keys/registry.ts`).matchAll(/vendor: (?:["']([^"']+)["']|API_KEYS_VENDOR_ID)/g),
		].map(m => m[1] ?? orchestratorVendorConstant ?? 'vendor missing');

		assert.deepStrictEqual({
			declaredVendor,
			orchestratorVendors,
			orchestratorVendorConstant,
			// Прежний vendor как значение остаться не должен (строки с legacy-* id — отдельные константы).
			legacyVendorLeft: /["']auraApi["']/.test(providerSource),
		}, {
			declaredVendor: 'apiKeys',
			orchestratorVendors: ['apiKeys', 'apiKeys'],
			orchestratorVendorConstant: 'apiKeys',
			legacyVendorLeft: false,
		});
	});

	test('в исходниках плагина не осталось прежнего названия «Aura API»', () => {
		const leftovers = pluginFiles('../../').flatMap(file => read(file).split('\n')
			.map((line, index) => ({ file, line: index + 1, text: line }))
			.filter(entry => entry.text.includes('Aura API'))
			.map(entry => `${entry.file}:${entry.line}`));

		assert.deepStrictEqual(leftovers, [], 'видимые строки и комментарии «Aura API» должны быть переименованы');
	});
});
