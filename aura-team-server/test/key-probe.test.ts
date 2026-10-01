/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-team-probe-'));
process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

test('joinProviderUrl не дублирует /v1 и сохраняет путь шлюза', async () => {
	const { joinProviderUrl, normalizeBaseUrl } = await import('../src/routes/keys.js');
	assert.equal(joinProviderUrl('https://api.openai.com', '/v1/models').toString(), 'https://api.openai.com/v1/models');
	assert.equal(joinProviderUrl('https://openrouter.ai/api/v1', '/v1/models').toString(), 'https://openrouter.ai/api/v1/models');
	assert.equal(joinProviderUrl('https://gw.example.com/proxy', '/v1/chat/completions').toString(), 'https://gw.example.com/proxy/v1/chat/completions');
	assert.equal(normalizeBaseUrl('http://example.com'), false);
	assert.equal(normalizeBaseUrl('http://localhost:8080/v1/'), 'http://localhost:8080/v1');
	assert.equal(normalizeBaseUrl(''), null);
});

test('проверка ключа: рабочий ключ через шлюз с путём — ok, 429 — ok с лимитом, 401 — отклонён', async () => {
	const seen: string[] = [];
	const upstream = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
		seen.push(`${req.method} ${req.url}`);
		const auth = String(req.headers.authorization ?? '');
		if (auth === 'Bearer sk-limited') { res.writeHead(429).end('{}'); return; }
		if (auth !== 'Bearer sk-good') { res.writeHead(401).end('{}'); return; }
		if (req.url === '/gw/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}'); return; }
		res.writeHead(404).end();
	});
	await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
	const port = (upstream.address() as AddressInfo).port;
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `probe-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Probe', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;
	const teamId = (await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Probe' } })).json().id as string;
	const baseUrl = `http://localhost:${port}/gw/v1`;
	const add = async (value: string) => (await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys`, headers: { authorization }, payload: { provider: 'openai', value, label: value, baseUrl, model: 'gpt-4o-mini' } })).json().id as string;
	const good = await add('sk-good');
	await add('sk-limited');
	await add('sk-bad');
	const bad = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys`, headers: { authorization }, payload: { provider: 'openai', value: 'x', baseUrl: 'http://evil.example.com' } });
	const results = (await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys/check`, headers: { authorization } })).json() as Array<{ keyId: string; ok: boolean; status: number; limited?: boolean; error?: string }>;
	const listed = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/keys`, headers: { authorization } })).json() as Array<{ id: string; label: string; ok: unknown; baseUrl: string; model: string; lastError: string | null }>;
	upstream.close();
	await app.close();
	const byLabel = Object.fromEntries(listed.map(k => [k.label, k]));
	assert.equal(bad.statusCode, 400);
	assert.ok(seen.includes('GET /gw/v1/models'), `путь шлюза сохранён: ${seen.join(', ')}`);
	assert.equal(results.find(r => r.keyId === good)?.ok, true);
	assert.equal(byLabel['sk-good'].ok, true, 'ok приходит boolean, а не 1');
	assert.equal(byLabel['sk-limited'].ok, true);
	assert.match(String(byLabel['sk-limited'].lastError), /429/);
	assert.equal(byLabel['sk-bad'].ok, false);
	assert.match(String(byLabel['sk-bad'].lastError), /401/);
	assert.equal(byLabel['sk-good'].baseUrl, baseUrl);
	assert.equal(byLabel['sk-good'].model, 'gpt-4o-mini');
});
