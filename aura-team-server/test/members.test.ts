/*---------------------------------------------------------------------------------------------
 *  Команда: приглашения и состав участников.
 *
 *  Проверяем то, на что жаловались с живой панели: «Отозвать» и «Новый код»
 *  оставляли прежний код рабочим, а убрать участника из команды было нечем.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-team-members-'));
process.env.AURA_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
process.env.AURA_JWT_SECRET = 'test-only-jwt-secret-with-at-least-32-characters';

const setup = async () => {
	const [{ createServer }, { database, grantAdmin }, { accessToken }, { hash }] = await Promise.all([
		import('../src/server.js'), import('../src/database.js'), import('../src/security.js'), import('@node-rs/argon2')
	]);
	const app = await createServer();
	const password = await hash('long-test-password');
	const makeUser = async (id: string, displayName: string) => {
		database.prepare('INSERT INTO users(id,email,display_name,password_hash,verified_at,created_at) VALUES(?,?,?,?,?,?)')
			.run(id, `${id}@example.com`, displayName, password, 'now', 'now');
		return `Bearer ${await accessToken(id)}`;
	};
	return { app, database, grantAdmin, makeUser };
};

test('новый код приглашения гасит предыдущий, а старый больше не принимают', async () => {
	const { app, makeUser } = await setup();
	const owner = await makeUser('inv-owner', 'Owner');
	const guest = await makeUser('inv-guest', 'Guest');
	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: owner }, payload: { name: 'Invites' } });
	const teamId = team.json().id as string;

	const first = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites`, headers: { authorization: owner } });
	const second = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites`, headers: { authorization: owner } });
	const oldCode = first.json().code as string;
	const newCode = second.json().code as string;

	// Активный код — последний созданный (до того, как его погасили входом).
	const current = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/invite`, headers: { authorization: owner } });
	const oldAccepted = await app.inject({ method: 'POST', url: '/v1/invites/accept', headers: { authorization: guest }, payload: { code: oldCode } });
	const newAccepted = await app.inject({ method: 'POST', url: '/v1/invites/accept', headers: { authorization: guest }, payload: { code: newCode } });
	const usedUp = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/invite`, headers: { authorization: owner } });

	assert.deepEqual({
		codesDiffer: oldCode !== newCode,
		currentCode: current.json().code,
		oldAccepted: oldAccepted.statusCode,
		newAccepted: newAccepted.statusCode,
		codeAfterUse: usedUp.json().code
	}, { codesDiffer: true, currentCode: newCode, oldAccepted: 400, newAccepted: 200, codeAfterUse: null });
	await app.close();
});

test('отозванный код перестаёт работать и не возвращается в GET /invite', async () => {
	const { app, makeUser } = await setup();
	const owner = await makeUser('rev-owner', 'Owner');
	const guest = await makeUser('rev-guest', 'Guest');
	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: owner }, payload: { name: 'Revoke' } });
	const teamId = team.json().id as string;
	const created = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites`, headers: { authorization: owner } });
	const code = created.json().code as string;

	const revoked = await app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/invite`, headers: { authorization: owner } });
	const current = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/invite`, headers: { authorization: owner } });
	const accepted = await app.inject({ method: 'POST', url: '/v1/invites/accept', headers: { authorization: guest }, payload: { code } });

	assert.deepEqual({
		revoked: revoked.statusCode,
		codeAfterRevoke: current.json().code,
		accepted: accepted.statusCode
	}, { revoked: 200, codeAfterRevoke: null, accepted: 400 });
	await app.close();
});

test('приглашение выдаёт выбранную роль: и код, и персональное приглашение', async () => {
	const { app, database, makeUser } = await setup();
	const owner = await makeUser('role-owner', 'Owner');
	const maintainer = await makeUser('role-maint', 'Maint');
	const guest = await makeUser('role-guest', 'Guest');
	await makeUser('role-invited', 'Invited');
	await makeUser('role-other', 'Other');

	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: owner }, payload: { name: 'Roles' } });
	const teamId = team.json().id as string;
	database.prepare("INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,'maintainer')").run('role-maint', teamId);
	const roleOf = (userId: string) => (database.prepare('SELECT role FROM memberships WHERE user_id=? AND team_id=?').get(userId, teamId) as { role: string } | undefined)?.role ?? null;

	// Код на роль зрителя: панель показывает роль вместе с кодом, вступивший получает именно её.
	const code = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites`, headers: { authorization: owner }, payload: { role: 'viewer' } });
	const current = await app.inject({ method: 'GET', url: `/v1/teams/${teamId}/invite`, headers: { authorization: owner } });
	const accepted = await app.inject({ method: 'POST', url: '/v1/invites/accept', headers: { authorization: guest }, payload: { code: code.json().code } });

	// Персональное приглашение с ролью: владелец может позвать совладельцем, совладелец — нет.
	const byOwner = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites/send`, headers: { authorization: owner }, payload: { userId: 'role-invited', role: 'maintainer' } });
	const byMaintainer = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites/send`, headers: { authorization: maintainer }, payload: { userId: 'role-other', role: 'maintainer' } });
	const ownerRole = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites`, headers: { authorization: owner }, payload: { role: 'owner' } });
	// Без роли — как раньше: разработчик.
	const plain = await app.inject({ method: 'POST', url: `/v1/teams/${teamId}/invites/send`, headers: { authorization: owner }, payload: { userId: 'role-other' } });

	assert.deepEqual({
		codeStatus: code.statusCode,
		codeRole: code.json().role,
		listedRole: current.json().role,
		accepted: accepted.statusCode,
		guestRole: roleOf('role-guest'),
		byOwner: byOwner.statusCode,
		invitedRole: roleOf('role-invited'),
		byMaintainer: byMaintainer.statusCode,
		ownerRole: ownerRole.statusCode,
		plain: plain.statusCode,
		otherRole: roleOf('role-other')
	}, {
		codeStatus: 201,
		codeRole: 'viewer',
		listedRole: 'viewer',
		accepted: 200,
		guestRole: 'viewer',
		byOwner: 201,
		invitedRole: 'maintainer',
		byMaintainer: 403,
		ownerRole: 400,
		plain: 201,
		otherRole: 'dev'
	});
	await app.close();
});

test('кик участника: владелец убирает всех кроме владельца, совладелец — dev/viewer, админ — из любой команды', async () => {
	const { app, database, grantAdmin, makeUser } = await setup();
	const owner = await makeUser('kick-owner', 'Owner');
	const maintainer = await makeUser('kick-maint', 'Maint');
	const otherMaintainer = await makeUser('kick-maint2', 'Maint Two');
	const dev = await makeUser('kick-dev', 'Dev');
	const otherDev = await makeUser('kick-dev2', 'Dev Two');
	const viewer = await makeUser('kick-viewer', 'Watcher');
	const admin = await makeUser('kick-admin', 'Admin');
	grantAdmin('kick-admin', 'тест платформенной админки');

	const team = await app.inject({ method: 'POST', url: '/v1/teams', headers: { authorization: owner }, payload: { name: 'Kick' } });
	const teamId = team.json().id as string;
	const addMember = (id: string, role: string) => database.prepare('INSERT OR REPLACE INTO memberships(user_id,team_id,role) VALUES(?,?,?)').run(id, teamId, role);
	addMember('kick-maint', 'maintainer');
	addMember('kick-maint2', 'maintainer');
	addMember('kick-dev', 'dev');
	addMember('kick-dev2', 'dev');
	addMember('kick-viewer', 'viewer');

	const remove = (authorization: string, memberId: string) => app.inject({ method: 'DELETE', url: `/v1/teams/${teamId}/members/${memberId}`, headers: { authorization } });

	const viewerTries = await remove(viewer, 'kick-dev');
	const maintainerRemovesDev = await remove(maintainer, 'kick-dev');
	const maintainerTriesMaintainer = await remove(maintainer, 'kick-maint2');
	const ownerRemovesMaintainer = await remove(owner, 'kick-maint');
	const selfRemoval = await remove(owner, 'kick-owner');
	const adminRemovesDev = await remove(admin, 'kick-dev2');
	const adminTriesOwner = await remove(admin, 'kick-owner');
	const members = database.prepare('SELECT user_id FROM memberships WHERE team_id=?').all(teamId).map(row => (row as { user_id: string }).user_id).sort();

	assert.equal(Boolean(otherMaintainer), true);
	assert.deepEqual({
		viewerTries: viewerTries.statusCode,
		maintainerRemovesDev: maintainerRemovesDev.statusCode,
		maintainerTriesMaintainer: maintainerTriesMaintainer.statusCode,
		ownerRemovesMaintainer: ownerRemovesMaintainer.statusCode,
		selfRemoval: selfRemoval.statusCode,
		adminRemovesDev: adminRemovesDev.statusCode,
		adminTriesOwner: adminTriesOwner.statusCode,
		members
	}, {
		viewerTries: 403,
		maintainerRemovesDev: 204,
		maintainerTriesMaintainer: 403,
		ownerRemovesMaintainer: 204,
		selfRemoval: 400,
		adminRemovesDev: 204,
		adminTriesOwner: 400,
		members: ['kick-maint2', 'kick-owner', 'kick-viewer']
	});
	await app.close();
});
