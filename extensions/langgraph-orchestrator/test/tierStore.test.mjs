// Тиры моделей: эвристика по имени, приоритет правил и хранение в globalState.
// Модуль написан без vscode — грузим через esbuild, как keys.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { transformSync } = require('esbuild');

function loadTs(relativePath) {
	const file = path.join(root, relativePath);
	const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
	const module = { exports: {} };
	new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
		module.exports, require, module, file, path.dirname(file)
	);
	return module.exports;
}

const { TierStore, tierKey, defaultTierForModel, isTier } = loadTs('src/llm/tierStore.ts');

/** Подмена globalState: одно хранилище на «сессию», общее между двумя сторами. */
function memoryMemento() {
	const map = new Map();
	return {
		get: key => map.get(key),
		update: (key, value) => { map.set(key, value); return Promise.resolve(); },
		raw: map,
	};
}

// ---------- эвристика ----------

test('defaultTierForModel: дешёвые имена — низкий тир', () => {
	for (const name of ['gpt-4o-mini', 'gemini-flash', 'claude-haiku', 'qwen-lite', 'llama-8b']) {
		assert.equal(defaultTierForModel(name), 'low', name);
	}
});

test('defaultTierForModel: тяжёлые имена — высокий тир', () => {
	for (const name of ['claude-opus', 'gpt-4o-pro', 'o3', 'mistral-large', 'llama-70b']) {
		assert.equal(defaultTierForModel(name), 'high', name);
	}
});

test('defaultTierForModel: «mini pro» решается в пользу дешёвого варианта', () => {
	assert.equal(defaultTierForModel('gemini-2.5-pro-mini'), 'low');
});

test('defaultTierForModel: неизвестное имя — средний тир', () => {
	assert.equal(defaultTierForModel(''), 'mid');
	assert.equal(defaultTierForModel('some-custom-model'), 'mid');
});

// ---------- хранение ----------

test('tierKey: источник разделяет одноимённые ключи', () => {
	assert.equal(tierKey('personal', 'kimi-k3'), 'orchestrator.tier.personal:kimi-k3');
	assert.equal(tierKey('team', 'kimi-k3'), 'orchestrator.tier.team:kimi-k3');
	assert.notEqual(tierKey('personal', 'x'), tierKey('team', 'x'));
});

test('TierStore: без выбора пользователя работает эвристика', () => {
	const store = new TierStore(memoryMemento());
	assert.equal(store.tierFor('personal', 'k1', 'gpt-4o-mini'), 'low');
	assert.equal(store.tierFor('personal', 'k2', 'claude-opus'), 'high');
});

test('TierStore: командный приоритет — запасная подсказка', () => {
	const store = new TierStore(memoryMemento());
	assert.equal(store.tierFor('team', 't1', 'unknown-key', 50), 'high');
	assert.equal(store.tierFor('team', 't2', 'unknown-key', 800), 'low');
	assert.equal(store.tierFor('team', 't3', 'unknown-key', 300), 'mid');
});

test('TierStore: сохранённый выбор важнее эвристики и приоритета', () => {
	const store = new TierStore(memoryMemento());
	assert.equal(store.tierFor('personal', 'k1', 'gpt-4o-mini'), 'low');
	return store.setTier('personal', 'k1', 'high').then(() => {
		assert.equal(store.tierFor('personal', 'k1', 'gpt-4o-mini'), 'high');
		assert.equal(store.isUserSet('personal', 'k1'), true);
	});
});

test('TierStore: выбор переживает пересоздание стора (рестарт IDE)', async () => {
	const memento = memoryMemento();
	const first = new TierStore(memento);
	await first.setTier('team', 'team-key-1', 'low');
	// Тот же globalState, новый стор — как после перезапуска окна.
	const second = new TierStore(memento);
	assert.equal(second.tierFor('team', 'team-key-1', 'claude-opus'), 'low');
	assert.equal(second.isUserSet('team', 'team-key-1'), true);
});

test('TierStore: переопределения из настроек важнее сохранённого выбора', async () => {
	const memento = memoryMemento();
	const store = new TierStore(memento);
	await store.setTier('personal', 'k1', 'low');
	store.setOverrides({ k1: 'high' });
	assert.equal(store.tierFor('personal', 'k1', 'x'), 'high');
});

test('TierStore: мусор в хранилище игнорируется', () => {
	const memento = memoryMemento();
	memento.raw.set(tierKey('personal', 'k1'), 'ultra');
	const store = new TierStore(memento);
	assert.equal(store.storedTier('personal', 'k1'), undefined);
	assert.equal(store.tierFor('personal', 'k1', 'mini'), 'low');
});

test('isTier: только три допустимых тира', () => {
	assert.equal(isTier('high'), true);
	assert.equal(isTier('mid'), true);
	assert.equal(isTier('low'), true);
	assert.equal(isTier('HIGH'), false);
	assert.equal(isTier(undefined), false);
});
