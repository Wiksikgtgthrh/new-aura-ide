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

// Удаление задачи идёт запросом без полезной нагрузки, но с заголовком
// content-type: application/json — Fastify по умолчанию отвечает на это 400
// «Body cannot be empty when content-type is set to 'application/json'»,
// и задача оставалась на доске («задачи не удаляются»).
test('пустое тело с content-type: application/json не ломает удаление и восстановление задачи', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `delete-owner-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Delete Owner', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;
	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization }, payload: { name: 'Delete Team' } });
	const teamId = team.json().id as string;
	const created = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/tasks`, headers: { authorization }, payload: { title: 'Удалить меня' } });
	const taskId = created.json().id as string;
	const removed = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/tasks/${taskId}`, headers: { authorization, 'content-type': 'application/json' } });
	const trash = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/tasks/trash`, headers: { authorization } });
	const restored = await app.inject({ method: 'PATCH', url: `/v1/teams/${teamId}/tasks/${taskId}/restore`, headers: { authorization, 'content-type': 'application/json' }, payload: '{}' });
	const board = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/board`, headers: { authorization } });
	// Заодно: подмена парсера не должна ослабить разбор — битый JSON всё ещё 400,
	// а обычное тело (второе название) читается как раньше.
	const renamed = await app.inject({ method: 'PATCH', url: `/v1/teams/${teamId}/tasks/${taskId}`, headers: { authorization, 'content-type': 'application/json' }, payload: { title: 'Новое имя' } });
	const broken = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/tasks`, headers: { authorization, 'content-type': 'application/json' }, payload: '{' });
	assert.deepEqual({
		removed: removed.statusCode,
		inTrash: trash.json().length,
		restored: restored.statusCode,
		onBoard: board.json().tasks.length,
		title: renamed.json().title,
		brokenJson: broken.statusCode,
	}, { removed: 200, inTrash: 1, restored: 200, onBoard: 1, title: 'Новое имя', brokenJson: 400 });
	await app.close();
});

// Группы ключей: клиент зовёт /key-groups с самого начала, но маршрутов не было —
// запрос получал 404, и группы существовали только в демо-режиме.
test('группы ключей: создание, привязка, чужая группа и удаление', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const owner = `group-owner-${Date.now()}`;
	const dev = `group-dev-${Date.now()}`;
	for (const [id, name] of [[owner, 'Owner'], [dev, 'Dev']] as const) {
		database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(id, `${id}@example.com`, name, await hash('long-test-password'), 'now', 'now');
	}
	const ownerAuthorization = `Bearer ${await accessToken(owner)}`;
	const devAuthorization = `Bearer ${await accessToken(dev)}`;
	const teamId = (await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: ownerAuthorization }, payload: { name: 'Group Team' } })).json().id as string;
	database.prepare('INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,?)').run(dev, teamId, 'dev');
	const created = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/key-groups`, headers: { authorization: ownerAuthorization }, payload: { name: 'Основная', priority: 1 } });
	const groupId = created.json().id as string;
	const deniedDev = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/key-groups`, headers: { authorization: devAuthorization }, payload: { name: 'От dev' } });
	const duplicate = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/key-groups`, headers: { authorization: ownerAuthorization }, payload: { name: 'Основная' } });
	const key = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys`, headers: { authorization: ownerAuthorization }, payload: { provider: 'openai', value: 'sk-group-test-value', label: 'В группе', groupId } });
	const foreign = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/keys`, headers: { authorization: ownerAuthorization }, payload: { provider: 'openai', value: 'sk-foreign-group', label: 'Чужая группа', groupId: 'no-such-group' } });
	const groups = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/key-groups`, headers: { authorization: devAuthorization } })).json() as Array<{ id: string; keyCount: number }>;
	const removed = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/key-groups/${groupId}`, headers: { authorization: ownerAuthorization } });
	const keysAfter = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/keys`, headers: { authorization: ownerAuthorization } })).json() as Array<{ groupId: string | null }>;
	const groupsAfter = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/key-groups`, headers: { authorization: ownerAuthorization } })).json() as unknown[];
	const twice = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/key-groups/${groupId}`, headers: { authorization: ownerAuthorization } });
	assert.deepEqual({
		created: created.statusCode,
		deniedForDev: deniedDev.statusCode,
		duplicate: duplicate.statusCode,
		keyBound: key.json().groupId === groupId,
		foreignRejected: foreign.statusCode,
		listed: groups.length,
		keyCount: groups[0]?.keyCount,
		removed: removed.statusCode,
		keysSurvive: keysAfter.length,
		keysUnbound: keysAfter.every(row => row.groupId === null),
		groupsEmpty: groupsAfter.length,
		deletedTwice: twice.statusCode,
	}, {
		created: 201,
		deniedForDev: 403,
		duplicate: 409,
		keyBound: true,
		foreignRejected: 400,
		listed: 1,
		keyCount: 1,
		removed: 200,
		keysSurvive: 1,
		keysUnbound: true,
		groupsEmpty: 0,
		deletedTwice: 404,
	});
	await app.close();
});

// Лента событий: элемент должен нести id строки аудита (иначе UI не может её удалить),
// а удалять запись вправе только owner/maintainer.
test('событие ленты удаляется только владельцем или админом', async () => {
	const [{ createServer }, { database }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const owner = `activity-owner-${Date.now()}`;
	const dev = `activity-dev-${Date.now()}`;
	for (const [id, name] of [[owner, 'Owner'], [dev, 'Dev']] as const) {
		database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(id, `${id}@example.com`, name, await hash('long-test-password'), 'now', 'now');
	}
	const ownerAuthorization = `Bearer ${await accessToken(owner)}`;
	const devAuthorization = `Bearer ${await accessToken(dev)}`;
	const teamId = (await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: ownerAuthorization }, payload: { name: 'Activity Team' } })).json().id as string;
	database.prepare('INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,?)').run(dev, teamId, 'dev');
	await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/tasks`, headers: { authorization: ownerAuthorization }, payload: { title: 'Событие' } });
	const listed = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/activity`, headers: { authorization: ownerAuthorization } });
	const first = listed.json()[0] as { id?: number; action: string };
	const denied = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/activity/${first.id}`, headers: { authorization: devAuthorization } });
	const stillThere = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/activity`, headers: { authorization: ownerAuthorization } })).json() as Array<{ id?: number }>;
	const removed = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/activity/${first.id}`, headers: { authorization: ownerAuthorization } });
	const after = (await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/activity`, headers: { authorization: ownerAuthorization } })).json() as Array<{ id?: number; action: string }>;
	const twice = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/activity/${first.id}`, headers: { authorization: ownerAuthorization } });
	assert.deepEqual({
		hasId: typeof first.id === 'number' && first.id > 0,
		deniedForDev: denied.statusCode,
		stillThere: stillThere.some(event => event.id === first.id),
		removed: removed.statusCode,
		goneAfterDelete: !after.some(event => event.id === first.id),
		deleteAudited: after.some(event => event.action === 'activity.delete'),
		deletedTwice: twice.statusCode,
	}, {
		hasId: true,
		deniedForDev: 403,
		stillThere: true,
		removed: 200,
		goneAfterDelete: true,
		deleteAudited: true,
		deletedTwice: 404,
	});
	await app.close();
});

test('entitlements: закрыты по умолчанию и выдаются по аккаунту', async () => {
	const [{ createServer }, { database, entitlementsOf, setEntitlement }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const user = `entitled-${Date.now()}`;
	database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(user, `${user}@example.com`, 'Entitled', await hash('long-test-password'), 'now', 'now');
	const authorization = `Bearer ${await accessToken(user)}`;

	// Свежий аккаунт: право не выдаётся ни регистрацией, ни командой.
	const before = await app.inject({ method: 'GET', url: '/v1/me/entitlements', headers: { authorization } });
	const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization } });
	const anonymous = await app.inject({ method: 'GET', url: '/v1/me/entitlements' });

	setEntitlement(user, 'aggg52', true, 'внешнее ядро AGGG 5.2');
	const after = await app.inject({ method: 'GET', url: '/v1/me/entitlements', headers: { authorization } });
	setEntitlement(user, 'aggg52', true, 'повторная выдача не дублирует');
	const twice = entitlementsOf(user).length;
	setEntitlement(user, 'aggg52', false);

	assert.deepEqual({
		emptyByDefault: before.json().features,
		stillEmptyInSession: me.json().entitlements,
		requiresAuth: anonymous.statusCode,
		granted: after.json().features,
		noDuplicates: twice,
		revoked: entitlementsOf(user).length,
	}, {
		emptyByDefault: [],
		stillEmptyInSession: [],
		requiresAuth: 401,
		granted: ['aggg52'],
		noDuplicates: 1,
		revoked: 0,
	});
	await app.close();
});

/* ------------------------------------------------------------------ */
/* Админ-доступ: код администратора, выдача прав аккаунтам и командам.  */
/* ------------------------------------------------------------------ */

test('админка: одноразовый код, командная выдача по ролям, отзыв и защита от чужих', async () => {
	const [{ createServer }, db, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const stamp = Date.now();
	const boss = `admin-boss-${stamp}`;
	const dev = `admin-dev-${stamp}`;
	const outsider = `admin-outsider-${stamp}`;
	for (const [id, name] of [[boss, 'Boss'], [dev, 'Dev'], [outsider, 'Outsider']] as const) {
		db.database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)').run(id, `${id}@example.com`, name, await hash('long-test-password'), 'now', 'now');
	}
	const bossAuth = `Bearer ${await accessToken(boss)}`;
	const devAuth = `Bearer ${await accessToken(dev)}`;
	const outsiderAuth = `Bearer ${await accessToken(outsider)}`;
	const teamId = (await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: bossAuth }, payload: { name: 'Licensed Team' } })).json().id as string;
	db.database.prepare('INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,?)').run(dev, teamId, 'dev');

	// До погашения кода админки ни у кого нет, и раздел закрыт на сервере.
	const notAdminYet = await app.inject({ method: 'GET', url: '/v1/admin/grants', headers: { authorization: outsiderAuth } });
	const wrongCode = await app.inject({ method: 'POST', url: '/v1/admin/redeem', headers: { authorization: outsiderAuth }, payload: { code: 'AUR-NOT-A-CODE' } });
	const redeem = await app.inject({ method: 'POST', url: '/v1/admin/redeem', headers: { authorization: bossAuth }, payload: { code: 'AUR-L2SY6CAL' } });
	const reusable = await app.inject({ method: 'POST', url: '/v1/admin/redeem', headers: { authorization: outsiderAuth }, payload: { code: 'AUR-L2SY6CAL' } });
	const outsiderMe = await app.inject({ method: 'GET', url: '/v1/admin/me', headers: { authorization: outsiderAuth } });

	// Чужому нельзя выдавать права даже с валидным входом.
	const deniedGrant = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: outsiderAuth }, payload: { feature: 'aggg52', kind: 'account', targetId: outsider } });
	const unknownFeature = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg999', kind: 'account', targetId: outsider } });
	const missingTarget = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg52', kind: 'account', targetId: 'no-such-user' } });

	// Команда получает право только для роли не ниже указанной.
	const teamGrant = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg52', kind: 'team', targetId: teamId, minRole: 'maintainer' } });
	const bossEntitlements = (await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: bossAuth } })).json().entitlements as Array<{ feature: string; source: string; teamName?: string }>;
	const devEntitlements = (await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: devAuth } })).json().entitlements as unknown[];
	const bossMe = (await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: bossAuth } })).json() as { admin?: boolean };

	// Ядро 5.2 отдаётся по праву; без права — 403, без каталога на сервере — 404.
	const coreForDev = await app.inject({ method: 'GET', url: '/v1/aggg/agent', headers: { authorization: devAuth } });
	const coreForBoss = await app.inject({ method: 'GET', url: '/v1/aggg/agent', headers: { authorization: bossAuth } });

	// Персональная выдача аккаунту: право видно с источником «account».
	const accountGrant = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg52', kind: 'account', targetId: outsider, note: 'вручную' } });
	const outsiderEntitlements = (await app.inject({ method: 'GET', url: '/v1/me/entitlements', headers: { authorization: outsiderAuth } })).json().features as string[];
	const directory = (await app.inject({ method: 'GET', url: '/v1/admin/directory', headers: { authorization: bossAuth } })).json() as { users: Array<{ id: string; features: string[] }>; teams: Array<{ id: string; grants: unknown[] }> };
	const revoke = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg52', kind: 'account', targetId: outsider, revoke: true } });
	const afterRevoke = (await app.inject({ method: 'GET', url: '/v1/me/entitlements', headers: { authorization: outsiderAuth } })).json().features as string[];
	const teamRevoke = await app.inject({ method: 'POST', url: '/v1/admin/grants', headers: { authorization: bossAuth }, payload: { feature: 'aggg52', kind: 'team', targetId: teamId, minRole: 'maintainer', revoke: true } });

	assert.deepEqual({
		deniedBeforeRedeem: notAdminYet.statusCode,
		wrongCode: wrongCode.statusCode,
		redeem: redeem.statusCode,
		redeemedAdmin: redeem.json().admin,
		codeBurned: reusable.statusCode,
		adminInSession: bossMe.admin,
		outsiderNotAdmin: outsiderMe.json().admin,
		deniedGrant: deniedGrant.statusCode,
		unknownFeature: unknownFeature.statusCode,
		missingTarget: missingTarget.statusCode,
		teamGrant: teamGrant.statusCode,
		ownerInherits: bossEntitlements.find(row => row.feature === 'aggg52')?.source,
		ownerTeamName: bossEntitlements.find(row => row.feature === 'aggg52')?.teamName,
		devDoesNotInherit: devEntitlements.length,
		coreForDev: coreForDev.statusCode,
		coreForBossWithoutCatalog: coreForBoss.statusCode,
		accountGrant: accountGrant.statusCode,
		outsiderFeatures: outsiderEntitlements,
		directoryShowsGrant: directory.users.find(row => row.id === outsider)?.features,
		directoryTeamGrant: directory.teams.find(row => row.id === teamId)?.grants,
		revoke: revoke.statusCode,
		afterRevoke,
		teamRevoke: teamRevoke.statusCode,
	}, {
		deniedBeforeRedeem: 403,
		wrongCode: 400,
		redeem: 200,
		redeemedAdmin: true,
		codeBurned: 400,
		adminInSession: true,
		outsiderNotAdmin: false,
		deniedGrant: 403,
		unknownFeature: 400,
		missingTarget: 404,
		teamGrant: 200,
		ownerInherits: 'team',
		ownerTeamName: 'Licensed Team',
		devDoesNotInherit: 0,
		coreForDev: 403,
		coreForBossWithoutCatalog: 404,
		accountGrant: 200,
		outsiderFeatures: ['aggg52'],
		directoryShowsGrant: ['aggg52'],
		directoryTeamGrant: [{ feature: 'aggg52', minRole: 'maintainer' }],
		revoke: 200,
		afterRevoke: [],
		teamRevoke: 200,
	});
	await app.close();
});
