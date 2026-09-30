/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-team-admin-'));
process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

// Повторная регистрация того же email раньше перезаписывала пароль и активировала
// чужой аккаунт — это был готовый способ угона. Пароль меняется только изнутри
// аккаунта, а существующий email получает отказ.
test('повторная регистрация не переприсваивает существующий аккаунт', async () => {
	const [{ createServer }, { database }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js')
	]);
	const app = await createServer();
	const email = `takeover-${Date.now()}@example.com`;
	const first = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'honest-password', displayName: 'Owner' } });
	const second = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'attacker-password', displayName: 'Attacker' } });
	const honestLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'honest-password' } });
	const attackerLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: 'attacker-password' } });
	const stored = database.prepare('SELECT display_name AS displayName FROM users WHERE email=?').get(email) as { displayName: string };
	assert.deepEqual({
		created: first.statusCode,
		secondRejected: second.statusCode,
		honestCanLogin: honestLogin.statusCode,
		attackerCannotLogin: attackerLogin.statusCode,
		nameUnchanged: stored.displayName,
	}, {
		created: 201,
		secondRejected: 409,
		honestCanLogin: 200,
		attackerCannotLogin: 401,
		nameUnchanged: 'Owner',
	});
	await app.close();
});

// Админские маршруты закрыты и без токена, и для обычного аккаунта: спрятанный
// в интерфейсе раздел — удобство, а не защита, поэтому отказ приходит с сервера.
test('админские маршруты требуют вход и статус администратора', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `plain-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Plain', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;
	const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/directory' });
	const directory = await app.inject({ method: 'GET', url: '/v1/admin/directory', headers: { authorization } });
	const features = await app.inject({ method: 'GET', url: '/v1/admin/features', headers: { authorization } });
	const grant = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization }, payload: { feature: 'aggg52', kind: 'account', targetId: user } });
	const entitlements = await app.inject({ method: 'GET', url: '/v1/me/entitlements', headers: { authorization } });
	assert.deepEqual({
		anonymous: anonymous.statusCode,
		directory: directory.statusCode,
		features: features.statusCode,
		grant: grant.statusCode,
		stillEmpty: entitlements.json().features,
	}, {
		anonymous: 401,
		directory: 403,
		features: 403,
		grant: 403,
		stillEmpty: [],
	});
	await app.close();
});

// Поиск цели выдачи — на сервере: интерфейс шлёт запрос, а не листает весь
// каталог, поэтому фильтр по названию команды и по имени/почте участника
// должен работать именно здесь.
test('поиск цели выдачи фильтрует команды и участников', async () => {
	const [{ createServer }, { database, grantAdmin }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const boss = `search-boss-${Date.now()}`;
	const mate = `search-mate-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(boss, `${boss}@example.com`, 'Boss', await hash('long-test-password'), 'now', 'now');
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(mate, 'petrov@example.com', 'Пётр Петров', await hash('long-test-password'), 'now', 'now');
	grantAdmin(boss, 'test');
	const authorization = `Bearer ${await accessToken(boss)}`;
	// Создатель команды сразу её владелец — отдельная запись участия была бы дублем.
	await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Alpha Squad' } });
	await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Beta Squad' } });

	const byTeam = (await app.inject({ method: 'GET', url: '/v1/admin/directory?q=alpha', headers: { authorization } })).json() as { users: unknown[]; teams: Array<{ name: string; members: number }> };
	const byEmail = (await app.inject({ method: 'GET', url: '/v1/admin/directory?q=petrov', headers: { authorization } })).json() as { users: Array<{ email: string }> };
	const byName = (await app.inject({ method: 'GET', url: '/v1/admin/directory?q=' + encodeURIComponent('петров'), headers: { authorization } })).json() as { users: Array<{ displayName: string }> };
	const empty = (await app.inject({ method: 'GET', url: '/v1/admin/directory?q=nothing-matches-here', headers: { authorization } })).json() as { users: unknown[]; teams: unknown[] };

	assert.deepEqual({
		teamFound: byTeam.teams.map(team => team.name),
		teamCount: byTeam.teams[0]?.members,
		byEmail: byEmail.users.map(user => user.email),
		byName: byName.users.map(user => user.displayName),
		nothingFound: empty.users.length + empty.teams.length,
	}, {
		teamFound: ['Alpha Squad'],
		teamCount: 1,
		byEmail: ['petrov@example.com'],
		byName: ['Пётр Петров'],
		nothingFound: 0,
	});
	await app.close();
});

// Ядро 5.2 не лежит у клиента: сервер отдаёт его только по праву. Без каталога
// на сервере честный 404 «поставки нет», а не пустой 200.
test('ядро AGGG отдаётся по праву из каталога сервера', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `core-holder-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Holder', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;

	const denied = await app.inject({ method: 'GET', url: '/v1/aggg/agent', headers: { authorization } });
	database.prepare('INSERT INTO entitlements(user_id,feature,note,granted_at) VALUES(?,?,?,?)').run(user, 'aggg52', 'test', 'now');
	const withoutCatalog = await app.inject({ method: 'GET', url: '/v1/aggg/agent', headers: { authorization } });

	// Каталог поставки: ровно те файлы, по которым клиент опознаёт агента.
	const root = mkdtempSync(join(tmpdir(), 'aggg-agent-'));
	mkdirSync(join(root, 'harness'), { recursive: true });
	writeFileSync(join(root, 'VERSION'), '5.2.0');
	writeFileSync(join(root, 'CLAUDE.md'), '# AGGG\n');
	writeFileSync(join(root, 'harness', 'core.txt'), 'Правила AGGG 5.2');
	const { config } = await import('../src/config.js');
	config.agggCorePath = root;
	const delivered = await app.inject({ method: 'GET', url: '/v1/aggg/agent', headers: { authorization } });
	const body = delivered.json() as { version: string; digest: string; files: Record<string, string> };
	assert.deepEqual({
		denied: denied.statusCode,
		withoutCatalog: withoutCatalog.statusCode,
		delivered: delivered.statusCode,
		version: body.version,
		hasCore: body.files['harness/core.txt'],
		hasVersion: body.files['VERSION'],
		hasManifest: body.files['CLAUDE.md'],
		digestLength: body.digest.length,
	}, {
		denied: 403,
		withoutCatalog: 404,
		delivered: 200,
		version: '5.2',
		hasCore: 'Правила AGGG 5.2',
		hasVersion: '5.2.0',
		hasManifest: '# AGGG\n',
		digestLength: 64,
	});
	await app.close();
});
