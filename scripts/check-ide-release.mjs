#!/usr/bin/env node
/*
 * Проверка релиза Aura IDE перед публикацией — без сервера и без сети.
 *
 * Ловит ровно те ошибки, из-за которых обновление в фоне либо не предлагается,
 * либо ломает установку:
 *   1. продукт на хосте живёт в раскладке %LOCALAPPDATA%\Programs\IDE\<commit-10>\resources\app
 *      (папки с хешем коммита) — проверяем её прямо в собранном приложении;
 *   2. установщик user-setup содержит тот же коммит, что и приложение (иначе
 *      клиенты эту версию уже «имеют» и обновление не показывается);
 *   3. установщик собран из user-install (иначе фонового обновления нет);
 *   4. sha256 и размер установщика берутся из реального файла — ровно они
 *      уходят в latest.json, и именно их сверяет клиент перед установкой.
 *
 * Запуск: node scripts/check-ide-release.mjs
 * Выход: 0 — можно публиковать, 1 — причина напечатана и понятна.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const app = join(dirname(root), 'VSCode-win32-x64');
const setup = join(root, '.build', 'win32-x64', 'user-setup', 'IDESetup.exe');

const fail = message => {
	console.error(`FAIL  ${message}`);
	process.exitCode = 1;
};
const ok = message => console.log(`PASS  ${message}`);
const readProduct = path => JSON.parse(readFileSync(path, 'utf8'));

// При win32VersionedUpdate приложение лежит в <app>\<commit-10>\resources\app,
// без него — в <app>\resources\app. Ищем product.json в обеих раскладках.
const findProduct = () => {
	const flat = join(app, 'resources', 'app', 'product.json');
	if (existsSync(flat)) { return flat; }
	if (!existsSync(app)) { return undefined; }
	for (const entry of readdirSync(app, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{10}$/i.test(entry.name)) { continue; }
		const candidate = join(app, entry.name, 'resources', 'app', 'product.json');
		if (existsSync(candidate)) { return candidate; }
	}
	return undefined;
};

// ---------- Сборка приложения ----------

const builtProduct = findProduct();
if (!existsSync(builtProduct)) {
	fail(`нет собранного приложения: ${app} (npm run gulp vscode-win32-x64)`);
} else {
	const product = readProduct(builtProduct);
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

	if (product.win32VersionedUpdate !== true) {
		fail('product.json: win32VersionedUpdate не включён — фоновые обновления на Windows отключены');
	} else {
		ok('win32VersionedUpdate включён');
	}
	if (!product.commit || !/^[0-9a-f]{40}$/i.test(product.commit)) {
		fail(`product.json: нет валидного commit (${product.commit})`);
	} else if (product.commit !== head) {
		fail(`приложение собрано не из HEAD: коммит сборки ${product.commit.slice(0, 10)}, HEAD ${head.slice(0, 10)} — пересоберите`);
	} else {
		ok(`коммит сборки совпадает с HEAD (${head.slice(0, 10)})`);
	}
	if (product.target !== 'user') {
		console.log(`note  target=${product.target ?? 'нет'} — фоновое обновление работает только с user-install IDESetup.exe`);
	}

	// Раскладка с папкой коммита: <app>\<commit-10>\resources\app\out
	if (product.commit) {
		const versioned = join(app, product.commit.slice(0, 10), 'resources', 'app', 'out');
		if (existsSync(versioned)) {
			ok(`раскладка с папкой коммита: ${product.commit.slice(0, 10)}`);
		} else {
			fail(`нет папки ${product.commit.slice(0, 10)}\\resources\\app — приложение собрано без win32VersionedUpdate, сборку надо повторить`);
		}
	}
}

// ---------- Установщик ----------

if (!existsSync(setup)) {
	fail(`нет установщика: ${setup} (npm run gulp vscode-win32-x64-user-setup)`);
} else {
	const sha = createHash('sha256').update(readFileSync(setup)).digest('hex');
	const size = statSync(setup).size;
	const setupProduct = join(dirname(setup), 'product.json');

	console.log(`      sha256=${sha}`);
	console.log(`      size=${size}`);
	if (existsSync(setupProduct)) {
		const inside = readProduct(setupProduct);
		const expected = existsSync(builtProduct) ? readProduct(builtProduct).commit : undefined;
		if (expected && inside.commit !== expected) {
			fail(`установщик от другой сборки: ${String(inside.commit).slice(0, 10)} ≠ ${String(expected).slice(0, 10)}`);
		} else {
			ok(`установщик собран из того же коммита (${String(inside.commit).slice(0, 10)})`);
		}
		if (inside.target !== 'user') {
			fail(`установщик target=${inside.target ?? 'нет'}, а нужен user (IDESetup.exe) — иначе нет фонового обновления`);
		} else {
			ok('установщик user-install');
		}
	} else {
		fail('рядом с установщиком нет product.json — нельзя сверить коммит и target');
	}
}

if (process.exitCode) {
	console.error('\nПубликовать нельзя — сначала исправьте то, что выше.');
} else {
	console.log('\nМожно публиковать: bash scripts/publish-ide-update.sh --upload');
}
