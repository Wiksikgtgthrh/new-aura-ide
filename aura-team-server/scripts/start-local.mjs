/*---------------------------------------------------------------------------------------------
 *  Aura Team — запуск локального сервера с автогенерацией JWT-секрета.
 *  Секрет хранится в data/.jwt-secret (создаётся при первом запуске).
 *  Использование:
 *    node scripts/start-local.mjs          — запустить сервер (порт 3210)
 *    node scripts/start-local.mjs --check  — только проверить, что сервер отвечает (exit 0/1)
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(serverRoot, 'data');
const secretFile = join(dataDir, '.jwt-secret');
const masterKeyFile = join(dataDir, '.master-key');
const port = Number(process.env.AURA_PORT ?? 3210);
const healthUrl = `http://127.0.0.1:${port}/health`;

async function alive() {
	try {
		const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
		return response.ok;
	} catch {
		return false;
	}
}

async function main() {
	if (process.argv.includes('--check')) {
		process.exit((await alive()) ? 0 : 1);
	}

	// Уже работает — ничего не запускаем.
	if (await alive()) {
		console.log(`[aura-team] server already running at ${healthUrl}`);
		return;
	}

	// JWT-секрет: генерируем один раз и сохраняем рядом с БД.
	mkdirSync(dataDir, { recursive: true });
	let secret = '';
	if (existsSync(secretFile)) {
		secret = readFileSync(secretFile, 'utf8').trim();
	}
	if (!secret || secret.length < 32) {
		secret = randomBytes(48).toString('base64');
		writeFileSync(secretFile, secret, { mode: 0o600 });
		console.log('[aura-team] generated new JWT secret -> data/.jwt-secret');
	}
	// Мастер-ключ шифрования API-ключей — тоже один раз (иначе нельзя расшифровать старые ключи).
	let masterKey = '';
	if (existsSync(masterKeyFile)) {
		masterKey = readFileSync(masterKeyFile, 'utf8').trim();
	}
	if (!masterKey || Buffer.from(masterKey, 'base64').length !== 32) {
		masterKey = randomBytes(32).toString('base64');
		writeFileSync(masterKeyFile, masterKey, { mode: 0o600 });
		console.log('[aura-team] generated new master key -> data/.master-key');
	}

	// Сборка, если dist/ ещё нет.
	const entry = join(serverRoot, 'dist', 'server.js');
	if (!existsSync(entry)) {
		console.log('[aura-team] dist/ not found, building...');
		const tsc = spawn(process.execPath, [join(serverRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(serverRoot, 'tsconfig.json')], { stdio: 'inherit', cwd: serverRoot });
		const status = await new Promise(resolve => tsc.on('exit', code => resolve(code ?? 1)));
		if (status !== 0) { process.exit(status); }
	}

	console.log(`[aura-team] starting local server on port ${port}...`);
	const child = spawn(process.execPath, [entry], {
		env: { ...process.env, AURA_JWT_SECRET: secret, AURA_MASTER_KEY: masterKey, AURA_HOST: '127.0.0.1', AURA_PORT: String(port) },
		stdio: 'inherit',
		cwd: serverRoot
	});
	child.on('exit', code => process.exit(code ?? 0));
}

main().catch(error => {
	console.error('[aura-team] failed to start:', error);
	process.exit(1);
});
