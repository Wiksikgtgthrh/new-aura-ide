import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** budgetProfiles.ts тянет config.ts, а тот — vscode. Собираем CJS и глушим vscode. */
function loadProfiles() {
	const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
	const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aura-profiles-')), 'profiles.cjs');
	esbuild.buildSync({
		entryPoints: [path.join(root, 'src', 'util', 'budgetProfiles.ts')],
		bundle: true,
		external: ['vscode'],
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		outfile,
	});
	const original = Module._load;
	Module._load = function (request, parent, isMain) {
		if (request === 'vscode') { return {}; }
		return original.call(this, request, parent, isMain);
	};
	try {
		return require(outfile);
	} finally {
		Module._load = original;
	}
}

const { BUILTIN_PROFILES, allProfiles, budgetFromProfile, findProfile, normalizeProfiles, profileFromBudget } = loadProfiles();

test('профили: встроенные пресеты economy/normal/max помечены builtin', () => {
	assert.deepEqual(BUILTIN_PROFILES.map(profile => profile.name), ['economy', 'normal', 'max']);
	assert.ok(BUILTIN_PROFILES.every(profile => profile.builtin === true));
	const economy = BUILTIN_PROFILES[0];
	assert.ok(economy.limits.runTokens > 0 && economy.limits.nodeTokens > 0, 'экономный профиль с лимитами');
});

test('профили: allProfiles ставит встроенные первыми, затем пользовательские', () => {
	const user = profileFromBudget('мой', { runTokens: 5, runCost: 1, nodeTokens: 2, nodeCost: 0.1, prices: { high: { input: 1, output: 2 }, mid: { input: 1, output: 2 }, low: { input: 1, output: 2 } }, modelPrices: [] });
	const all = allProfiles([user]);
	assert.deepEqual(all.slice(0, 3).map(profile => profile.name), ['economy', 'normal', 'max']);
	assert.equal(all[3].name, 'мой');
	assert.equal(all[3].builtin, undefined);
});

test('профили: снимок и применение сохраняют лимиты, цены и правила', () => {
	const budget = {
		runTokens: 1234, runCost: 5.5, nodeTokens: 300, nodeCost: 0.25,
		prices: { high: { input: 10, output: 20 }, mid: { input: 3, output: 6 }, low: { input: 1, output: 2 } },
		modelPrices: [{ match: 'kimi', input: 2, output: 8 }],
	};
	const profile = profileFromBudget('snap', budget);
	assert.equal(profile.name, 'snap');
	assert.deepEqual(profile.limits, { runTokens: 1234, runCost: 5.5, nodeTokens: 300, nodeCost: 0.25 });
	assert.deepEqual(profile.modelPrices, [{ match: 'kimi', input: 2, output: 8 }]);
	const restored = budgetFromProfile(profile);
	assert.equal(restored.runTokens, 1234);
	assert.equal(restored.prices.high.output, 20);
	assert.deepEqual(restored.modelPrices, [{ match: 'kimi', input: 2, output: 8 }]);
});

test('профили: budgetFromProfile санитизирует мусор и отрицательные значения', () => {
	const restored = budgetFromProfile({
		name: 'bad',
		limits: { runTokens: -5, runCost: 'x', nodeTokens: 10, nodeCost: 0 },
		prices: { high: { input: -1, output: 3 }, mid: { input: 0, output: 0 }, low: { input: 0, output: 0 } },
		modelPrices: [],
	});
	assert.equal(restored.runTokens, 0, 'отрицательный лимит → без лимита');
	assert.equal(restored.runCost, 0, 'не-число → без лимита');
	assert.equal(restored.nodeTokens, 10);
	assert.ok(restored.prices.high.input >= 0, 'отрицательная цена не проходит');
});

test('профили: normalizeProfiles отбрасывает мусор и имена встроенных', () => {
	const out = normalizeProfiles([
		{ name: 'моя', limits: { runTokens: 1000 }, prices: { high: { input: 1, output: 2 } }, modelPrices: [{ match: 'kimi', input: 1, output: 2 }] },
		{ name: 'economy', limits: { runTokens: 1 } },
		{ name: '   ' },
		null,
		'мусор',
		{ name: 'моя', limits: { runTokens: 2 } },
	]);
	assert.equal(out.length, 1, 'оставлен только один валидный пользовательский профиль');
	assert.equal(out[0].name, 'моя');
	assert.equal(out[0].limits.runTokens, 1000);
	assert.equal(out[0].modelPrices.length, 1);
	assert.equal(findProfile(allProfiles(out), 'economy').builtin, true, 'встроенный профиль доступен');
});
