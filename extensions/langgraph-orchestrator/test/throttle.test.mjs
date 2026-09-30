// Троттлинг отправки состояния (src/util/throttle.ts): чистая логика, грузим через esbuild,
// как teamSync.test.mjs. Проверяем именно то, на чём он держится: ведущее ребро, схлопывание
// пачки, отправка последнего состояния и отмена по dispose.
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

const { createThrottle, STATE_PUSH_INTERVAL_MS } = loadTs('src/util/throttle.ts');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('первый вызов после тишины уходит сразу (клик по «Пауза» не ждёт окна)', () => {
	let fired = 0;
	const throttle = createThrottle(50, () => { fired++; });
	throttle.schedule();
	assert.equal(fired, 1, 'ведущее ребро: без ожидания');
	throttle.cancel();
});

test('пачка вызовов схлопывается в одну отправку', async () => {
	let fired = 0;
	const throttle = createThrottle(30, () => { fired++; });
	throttle.schedule();                       // сразу
	for (let i = 0; i < 20; i++) { throttle.schedule(); }   // пачка в окне
	assert.equal(fired, 1, 'в окне ничего не отправилось');
	await tick(60);
	assert.equal(fired, 2, 'пачка дала ровно одну отложенную отправку, а не двадцать');
	throttle.cancel();
});

test('отложенная отправка уходит после окна, даже если новых вызовов не было', async () => {
	let fired = 0;
	// Интервал заметно больше шага теста, иначе второй вызов был бы ведущим ребром, а не хвостом.
	const throttle = createThrottle(60, () => { fired++; });
	throttle.schedule();                    // сразу
	throttle.schedule();                    // в окне — откладывается
	assert.equal(fired, 1, 'второй вызов отложен');
	await tick(120);
	assert.equal(fired, 2, 'отложенное состояние всё-таки доехало (панель не залипает)');
	throttle.cancel();
});

test('cancel по dispose гасит отложенную отправку', async () => {
	let fired = 0;
	const throttle = createThrottle(60, () => { fired++; });
	throttle.schedule();                    // сразу
	throttle.schedule();                    // отложено
	throttle.cancel();
	await tick(120);
	assert.equal(fired, 1, 'после dispose панель больше не дёргается');
});

test('интервал по умолчанию не ноль и не больше кадра', () => {
	assert.ok(STATE_PUSH_INTERVAL_MS > 0 && STATE_PUSH_INTERVAL_MS <= 100, `STATE_PUSH_INTERVAL_MS = ${STATE_PUSH_INTERVAL_MS}`);
});
