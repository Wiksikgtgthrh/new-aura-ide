/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-team-test-'));
process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

test('owner creates a team and a task', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run('owner', 'owner@example.com', 'Owner', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken('owner')}`;
	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Aura' } });
	const task = await app.inject({ method: 'POST', url: `/v1/teams/${team.json().id}/tasks`, headers: { authorization }, payload: { title: 'Ship MVP' } });
	const board = await app.inject({ method: 'GET', url: `/v1/teams/${team.json().id}/board`, headers: { authorization } });
	assert.deepEqual({ team: team.statusCode, task: task.statusCode, tasks: board.json().tasks.length }, { team: 201, task: 201, tasks: 1 });
	await app.close();
});

test('team key list exposes only masked metadata and model token rejects another model', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `key-owner-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Key Owner', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;
	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Key Team' } });
	const teamId = team.json().id as string;
	const secret = 'sk-live-secret-value-never-returned';
	const created = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys`, headers: { authorization }, payload: { provider: 'openai', value: secret, label: 'Primary', priority: 10, accessRole: 'dev' } });
	const listed = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/keys`, headers: { authorization } });
	const credential = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/proxy-tokens`, headers: { authorization }, payload: { provider: 'openai', model: 'gpt-4o-mini' } });
	const denied = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/proxy/openai/v1/chat/completions`, headers: { authorization: `Bearer ${credential.json().token}` }, payload: { model: 'gpt-4o', messages: [] } });
	assert.deepEqual({
		created: created.statusCode,
		listed: listed.statusCode,
		leaked: listed.body.includes(secret),
		hint: listed.json()[0].keyHint,
		priority: listed.json()[0].priority,
		wrongModel: denied.statusCode,
	}, { created: 201, listed: 200, leaked: false, hint: 'sk-…rned', priority: 10, wrongModel: 403 });
	await app.close();
});
