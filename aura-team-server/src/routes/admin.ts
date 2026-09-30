/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { mapAccessError, requireAdmin, userId } from '../access.js';
import { accountEntitlements, admins, audit, database, grantAdmin, isAdmin, redeemAdminCode, revokeAdmin, setEntitlement, setTeamEntitlement, teamEntitlements } from '../database.js';
import { FEATURE_IDS, GATED_FEATURES, featureOf, ROLES, type Role } from '../features.js';

interface DirectoryUser { id: string; email: string; displayName: string; features: string[]; }
interface DirectoryTeam { id: string; name: string; members: number; grants: Array<{ feature: string; minRole: string }>; }

/**
 * Админ-панель: выдача закрытых возможностей аккаунтам и командам.
 *
 * Право проверяется на сервере в каждом маршруте (`requireAdmin`), поэтому
 * спрятанный в интерфейсе раздел ничего не защищает, а только не мешает:
 * подделанный клиент получит 403, а попытка попадёт в аудит.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {

	// Погашение кода администратора. Код одноразовый: хранится хэшем, после
	// использования помечается — повторная попытка получает тот же отказ,
	// что и неизвестный код, чтобы нельзя было перебором отличить «использован».
	app.post<{ Body: { code?: string } }>('/v1/admin/redeem', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
		const user = await userId(request);
		const code = String(request.body.code ?? '').trim();
		if (!code) { return reply.badRequest('Enter the admin access code'); }
		if (!redeemAdminCode(code, user)) {
			audit(user, 'admin.redeem.failed', undefined, 'admin', user);
			return reply.badRequest('Access code is invalid or already used');
		}
		return { admin: true, features: FEATURE_IDS };
	});

	// Каталог закрытых возможностей: клиент не решает, что существует.
	app.get('/v1/admin/features', async request => {
		const user = await userId(request);
		try { requireAdmin(user); } catch (error) { mapAccessError(error); }
		return { features: GATED_FEATURES, roles: ROLES, admins: admins() };
	});

	// Кого можно выбрать целью: аккаунты (с их правами) и команды (с участием и выдачами).
	app.get<{ Querystring: { q?: string } }>('/v1/admin/directory', async request => {
		const user = await userId(request);
		try { requireAdmin(user); } catch (error) { mapAccessError(error); }
		const needle = String(request.query.q ?? '').trim();
		const query = needle.toLowerCase();
		const like = `%${query}%`;
		// SQLite делает регистронезависимым lower() только для ASCII: «петров» не
		// нашёл бы «Пётр Петров». Кириллицу добираем отдельным проходом по каталогу,
		// ограниченному разумным пределом, и объединяем с результатом SQL.
		const asciiOnly = /^[\x20-\x7e]*$/.test(needle);
		const matches = (value: string | null | undefined): boolean => String(value ?? '').toLowerCase().includes(query);

		type UserRow = { id: string; email: string; displayName: string };
		let users = database.prepare(
			`SELECT id, email, display_name AS displayName FROM users
			 WHERE (? = '' OR lower(email) LIKE ? OR lower(display_name) LIKE ?)
			 ORDER BY display_name LIMIT 200`
		).all(query, like, like) as UserRow[];
		if (!asciiOnly && query) {
			const all = database.prepare('SELECT id, email, display_name AS displayName FROM users ORDER BY display_name LIMIT 2000').all() as UserRow[];
			const merged = new Map(users.map(row => [row.id, row]));
			for (const row of all) { if (matches(row.displayName) || matches(row.email)) { merged.set(row.id, row); } }
			users = [...merged.values()].slice(0, 200);
		}
		const granted = new Map<string, string[]>();
		for (const row of accountEntitlements()) {
			granted.set(row.userId, [...(granted.get(row.userId) ?? []), row.feature]);
		}
		const directoryUsers: DirectoryUser[] = users.map(row => ({ ...row, features: granted.get(row.id) ?? [] }));

		type TeamRow = { id: string; name: string; members: number };
		let teams = database.prepare(
			`SELECT t.id, t.name, (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id) AS members
			FROM teams t WHERE (? = '' OR lower(t.name) LIKE ?) ORDER BY t.name LIMIT 200`
		).all(query, like) as TeamRow[];
		if (!asciiOnly && query) {
			const all = database.prepare(
				`SELECT t.id, t.name, (SELECT COUNT(*) FROM memberships m WHERE m.team_id = t.id) AS members
				FROM teams t ORDER BY t.name LIMIT 2000`
			).all() as TeamRow[];
			const merged = new Map(teams.map(row => [row.id, row]));
			for (const row of all) { if (matches(row.name)) { merged.set(row.id, row); } }
			teams = [...merged.values()].slice(0, 200);
		}
		const teamGrants = new Map<string, Array<{ feature: string; minRole: string }>>();
		for (const row of teamEntitlements()) {
			teamGrants.set(row.teamId, [...(teamGrants.get(row.teamId) ?? []), { feature: row.feature, minRole: row.minRole }]);
		}
		const directoryTeams: DirectoryTeam[] = teams.map(row => ({ ...row, grants: teamGrants.get(row.id) ?? [] }));
		return { users: directoryUsers, teams: directoryTeams, features: GATED_FEATURES, roles: ROLES };
	});

	// Текущие права: аккаунты и команды раздельно — у команды ещё и порог роли.
	app.get('/v1/admin/grants', async request => {
		const user = await userId(request);
		try { requireAdmin(user); } catch (error) { mapAccessError(error); }
		return { account: accountEntitlements(), team: teamEntitlements() };
	});

	// Выдать или отозвать право. Одна ручка на оба случая: интерфейс шлёт revoke.
	app.post<{ Body: { feature?: string; kind?: string; targetId?: string; minRole?: string; note?: string; revoke?: boolean } }>('/v1/admin/grants', async (request, reply) => {
		const user = await userId(request);
		try { requireAdmin(user); } catch (error) { mapAccessError(error); }
		const feature = featureOf(request.body.feature);
		if (!feature) { return reply.badRequest(`Unknown feature. Known: ${FEATURE_IDS.join(', ')}`); }
		const kind = request.body.kind === 'team' ? 'team' : request.body.kind === 'account' ? 'account' : undefined;
		if (!kind) { return reply.badRequest('kind must be account or team'); }
		const targetId = String(request.body.targetId ?? '').trim();
		if (!targetId) { return reply.badRequest('targetId is required'); }
		const revoke = request.body.revoke === true;
		const note = String(request.body.note ?? '').trim().slice(0, 200) || feature.title;

		if (kind === 'account') {
			const target = database.prepare('SELECT id, email FROM users WHERE id=?').get(targetId) as { id: string; email: string } | undefined;
			if (!target) { return reply.notFound('Account not found'); }
			setEntitlement(targetId, feature.id, !revoke, note);
			audit(user, revoke ? 'entitlement.revoke' : 'entitlement.grant', undefined, 'account', targetId, { feature: feature.id, email: target.email });
			return { ok: true, kind, feature: feature.id, targetId, revoked: revoke };
		}

		const team = database.prepare('SELECT id, name FROM teams WHERE id=?').get(targetId) as { id: string; name: string } | undefined;
		if (!team) { return reply.notFound('Team not found'); }
		const minRole = (request.body.minRole ?? feature.defaultMinRole) as Role;
		if (!ROLES.includes(minRole)) { return reply.badRequest(`minRole must be one of: ${ROLES.join(', ')}`); }
		setTeamEntitlement(targetId, feature.id, minRole, !revoke, note);
		audit(user, revoke ? 'entitlement.revoke' : 'entitlement.grant', targetId, 'team', targetId, { feature: feature.id, minRole, team: team.name });
		return { ok: true, kind, feature: feature.id, targetId, minRole, revoked: revoke };
	});

	// Выдать админку другому аккаунту и снять её. Последнего админа снять нельзя:
	// иначе права на закрытые возможности станет некому выдавать.
	app.post<{ Body: { email?: string; revoke?: boolean; note?: string } }>('/v1/admin/admins', async (request, reply) => {
		const user = await userId(request);
		try { requireAdmin(user); } catch (error) { mapAccessError(error); }
		const email = String(request.body.email ?? '').trim().toLowerCase();
		const target = database.prepare('SELECT id, email FROM users WHERE email=?').get(email) as { id: string; email: string } | undefined;
		if (!target) { return reply.notFound('Account not found'); }
		if (request.body.revoke === true) {
			if (target.id === user) { return reply.badRequest('You cannot revoke your own admin rights'); }
			if (!revokeAdmin(target.id)) { return reply.badRequest('The last admin cannot be revoked'); }
			audit(user, 'admin.revoke', undefined, 'admin', target.id, { email: target.email });
			return { ok: true, admin: false, email: target.email };
		}
		if (isAdmin(target.id)) { return { ok: true, admin: true, email: target.email }; }
		grantAdmin(target.id, String(request.body.note ?? '').trim().slice(0, 200) || `granted by ${user}`);
		audit(user, 'admin.grant', undefined, 'admin', target.id, { email: target.email });
		return { ok: true, admin: true, email: target.email };
	});

	// Проверка собственного статуса: интерфейс решает, показывать ли раздел.
	app.get('/v1/admin/me', async request => {
		const user = await userId(request);
		return { admin: isAdmin(user), features: FEATURE_IDS };
	});
}
