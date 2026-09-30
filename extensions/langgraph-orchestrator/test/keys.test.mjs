// Реестр ключей: сопоставление id ключа с моделью вендора API Keys и правила статуса.
// Оба модуля написаны без vscode — грузим их через esbuild, как team-tool.test.mjs.
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

const { modelIdForKey, keyIdFromModelId, keyIdsFromModelIds, modelForKey } = loadTs('src/keys/modelId.ts');
const { resolveKeyState, runtimeFromError, COOLDOWN_RATELIMIT_MS, COOLDOWN_NETWORK_MS } = loadTs('src/keys/status.ts');

// ---------- id моделей ----------

test('modelIdForKey: id модели — это apiKeys/<ключ>', () => {
	assert.equal(modelIdForKey('kimi-k3'), 'apiKeys/kimi-k3');
});

test('keyIdFromModelId: снимает только префикс вендора', () => {
	assert.equal(keyIdFromModelId('apiKeys/kimi-k3'), 'kimi-k3');
	assert.equal(keyIdFromModelId('apiKeys/team/kt-1'), 'kt-1');
	assert.equal(keyIdFromModelId('copilot/gpt-4o'), 'copilot/gpt-4o');
	assert.equal(keyIdFromModelId(''), '');
	assert.equal(keyIdFromModelId(undefined), '');
});

test('modelForKey: находит модель по id ключа (а не по сырому id)', () => {
	const models = [{ id: 'apiKeys/kimi-k3', name: 'kimi-k3' }, { id: 'apiKeys/glm-5', name: 'glm-5' }];
	assert.equal(modelForKey(models, 'kimi-k3')?.name, 'kimi-k3');
	assert.equal(modelForKey(models, 'glm-5')?.id, 'apiKeys/glm-5');
	assert.equal(modelForKey(models, 'нет-такого'), undefined);
});

test('keyIdsFromModelIds: чужие вендоры не попадают в реестр', () => {
	const ids = keyIdsFromModelIds(['apiKeys/kimi-k3', 'copilot/gpt-4o', 'apiKeys/glm-5']);
	assert.deepEqual([...ids].sort(), ['glm-5', 'kimi-k3']);
});

// ---------- правила статуса ----------

const NOW = 1_700_000_000_000;
const base = { now: NOW, modelUsable: true };

test('статус: ручное исключение сильнее всех источников', () => {
	const state = resolveKeyState({
		...base,
		runtime: { excludedManually: true },
		core: { health: 'ok', ok: true },
		team: { ok: true },
	});
	assert.equal(state.status, 'excluded');
	assert.ok(state.lastError.includes('панели'));
});

test('статус: cooldown запуска действует, пока не истёк', () => {
	const runtime = { cooldownUntil: NOW + 30_000, lastError: '429' };
	assert.equal(resolveKeyState({ ...base, runtime, core: { health: 'ok' } }).status, 'cooldown');
	assert.equal(resolveKeyState({ ...base, now: NOW + 60_000, runtime, core: { health: 'ok' } }).status, 'ok');
});

test('статус: отказ ключа (401) держится до ручного возврата', () => {
	const state = resolveKeyState({ ...base, runtime: { dead: true, lastError: 'HTTP 401' }, core: { health: 'ok', ok: true } });
	assert.equal(state.status, 'dead');
	assert.equal(state.lastError, 'HTTP 401');
});

test('статус: ключ, выведенный ядром по скорости, — «медленный»', () => {
	assert.equal(resolveKeyState({ ...base, core: { ok: false, excludedHighPing: true } }).status, 'slow');
	assert.equal(resolveKeyState({ ...base, core: { ok: false, excludedReason: 'latency' } }).status, 'slow');
});

test('статус: классификация ядра по HTTP', () => {
	assert.equal(resolveKeyState({ ...base, core: { health: 'unauthorized', ok: false } }).status, 'dead');
	assert.equal(resolveKeyState({ ...base, core: { health: 'forbidden', ok: false } }).status, 'dead');
	const limited = resolveKeyState({ ...base, core: { health: 'ratelimited', ok: false } });
	assert.equal(limited.status, 'cooldown');
	assert.equal(limited.cooldownUntil, NOW + COOLDOWN_RATELIMIT_MS);
	const down = resolveKeyState({ ...base, core: { health: 'down', ok: false } });
	assert.equal(down.cooldownUntil, NOW + COOLDOWN_NETWORK_MS);
	const given = resolveKeyState({ ...base, core: { health: 'ratelimited', ok: false, cooldownUntil: NOW + 5_000 } });
	assert.equal(given.cooldownUntil, NOW + 5_000, 'cooldown ядра уважается, если он ещё в будущем');
});

test('статус: живость из ядра или из vscode.lm', () => {
	assert.equal(resolveKeyState({ ...base, core: { health: 'ok' } }).status, 'ok');
	assert.equal(resolveKeyState({ now: NOW, modelUsable: true }).status, 'ok');
});

test('статус: ключ командного банка без модели — не «жив», а выключен/неизвестен', () => {
	const disabled = resolveKeyState({ now: NOW, modelUsable: false, team: { disabledAt: '2026-01-01', ok: false } });
	assert.equal(disabled.status, 'dead');
	assert.ok(disabled.lastError.includes('командном банке'));
	assert.equal(resolveKeyState({ now: NOW, modelUsable: false, team: { ok: null } }).status, 'unknown');
});

test('статус: пинг и метрики берутся из ядра, командный банк — запасной источник', () => {
	const fromCore = resolveKeyState({ ...base, core: { health: 'ok', pingMs: 120, latencyMs: 900, authenticityPct: 100, securityPct: 80, lastChecked: NOW } });
	assert.equal(fromCore.pingMs, 120);
	assert.equal(fromCore.latencyMs, 900);
	assert.equal(fromCore.lastChecked, NOW);
	assert.equal(resolveKeyState({ now: NOW, modelUsable: true, team: { pingMs: 350 } }).pingMs, 350);
});

test('runtimeFromError: 401/403 — мёртв, 429 — минута, сеть — полминуты', () => {
	assert.equal(runtimeFromError('HTTP 401: ключ отклонён', NOW).dead, true);
	assert.equal(runtimeFromError('403 forbidden', NOW).dead, true);
	assert.equal(runtimeFromError('429 Too Many Requests', NOW).cooldownUntil, NOW + COOLDOWN_RATELIMIT_MS);
	assert.equal(runtimeFromError('fetch failed: ECONNRESET', NOW).cooldownUntil, NOW + COOLDOWN_NETWORK_MS);
	assert.equal(runtimeFromError('unauthorized', NOW).dead, true, 'текст без кода тоже опознаётся');
});
