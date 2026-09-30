// Каталог моделей: сборка из личного и командного источников, тиры и фильтр по тиру.
// modelCatalog импортирует tierStore, поэтому грузим его бандлом esbuild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = require('esbuild');

/** Сборка TS-модуля с зависимостями в один CJS-бандл и его исполнение в памяти. */
function loadTsBundled(relativePath) {
	const file = path.join(root, relativePath);
	const result = esbuild.buildSync({
		entryPoints: [file],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node20',
		write: false,
	});
	const code = result.outputFiles[0].text;
	const module = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
		module.exports, require, module, file, path.dirname(file)
	);
	return module.exports;
}

const { buildCatalogModels, modelsInTier, catalogSourceCounts, ModelCatalog } = loadTsBundled('src/llm/modelCatalog.ts');
const { TierStore } = loadTsBundled('src/llm/tierStore.ts');

function memoryMemento() {
	const map = new Map();
	return { get: key => map.get(key), update: (key, value) => { map.set(key, value); return Promise.resolve(); } };
}

const PERSONAL = { id: 'kimi-k3', source: 'personal', name: 'kimi-k3', model: 'kimi-k3', tier: 'high', status: 'ok', selectable: true, pingMs: 120, activeCalls: 1 };
const PERSONAL_LOW = { id: 'glm-mini', source: 'personal', name: 'glm-mini', model: 'glm-mini', tier: 'low', status: 'ok', selectable: true, pingMs: 300, activeCalls: 0 };
const TEAM = { id: 'team-t1', source: 'team', name: 'Team · gpt-4o', model: 'gpt-4o', tier: 'mid', status: 'unknown', selectable: false, pingMs: undefined, activeCalls: 0 };

test('buildCatalogModels: единый id включает источник', () => {
	const models = buildCatalogModels([PERSONAL, TEAM]);
	assert.deepEqual(models.map(m => m.id), ['personal:kimi-k3', 'team:team-t1']);
	assert.equal(models[1].keyId, 'team-t1');
	assert.equal(models[0].source, 'personal');
});

test('buildCatalogModels: пустой тир считается эвристикой по имени', () => {
	const models = buildCatalogModels([{ ...PERSONAL, tier: undefined }, { ...PERSONAL, id: 'x', name: 'claude-opus', tier: undefined }]);
	assert.equal(models[0].tier, 'mid');
	assert.equal(models[1].tier, 'high');
});

test('buildCatalogModels: имя по умолчанию — имя, иначе модель, иначе id', () => {
	const models = buildCatalogModels([
		{ ...PERSONAL, name: '' },
		{ ...PERSONAL, id: 'z', name: '', model: '', tier: 'mid' },
	]);
	assert.equal(models[0].displayName, 'kimi-k3');
	assert.equal(models[1].displayName, 'z');
});

test('modelsInTier: только живые и вызываемые, сначала свободные', () => {
	const models = buildCatalogModels([
		{ ...PERSONAL_LOW, activeCalls: 2 },
		{ ...PERSONAL_LOW, id: 'fast', activeCalls: 0, pingMs: 500 },
		{ ...PERSONAL_LOW, id: 'busy', activeCalls: 1 },
		{ ...PERSONAL_LOW, id: 'dead', status: 'dead' },
		{ ...TEAM, tier: 'low' },
	]);
	const low = modelsInTier(models, 'low');
	assert.deepEqual(low.map(m => m.id), ['personal:fast', 'personal:busy', 'personal:glm-mini']);
});

test('catalogSourceCounts: считает оба источника', () => {
	const models = buildCatalogModels([PERSONAL, PERSONAL_LOW, TEAM]);
	assert.deepEqual(catalogSourceCounts(models), { personal: 2, team: 1 });
});

test('ModelCatalog: тир строится через TierStore (сохранённый выбор важнее строки)', async () => {
	const memento = memoryMemento();
	const store = new TierStore(memento);
	await store.setTier('team', 'team-t1', 'high');
	const catalog = new ModelCatalog(() => [PERSONAL, TEAM], store);
	const tiers = Object.fromEntries(catalog.list().map(m => [m.id, m.tier]));
	assert.equal(tiers['team:team-t1'], 'high');
	// Личный ключ без выбора человека пересчитывается эвристикой (kimi — не mini/flash).
	assert.equal(tiers['personal:kimi-k3'], 'mid');
	assert.deepEqual(catalog.counts(), { personal: 1, team: 1 });
});

test('ModelCatalog: без TierStore тир берётся из строки', () => {
	const catalog = new ModelCatalog(() => [PERSONAL, PERSONAL_LOW, TEAM]);
	assert.deepEqual(catalog.byTier('low').map(m => m.id), ['personal:glm-mini']);
});
