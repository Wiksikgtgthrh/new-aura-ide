/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FastifyInstance } from 'fastify';
import { mapAccessError, requireRole, userId } from '../access.js';
import { audit, database } from '../database.js';
import { broadcast } from '../realtime.js';
import { onlineUserIds } from '../realtime.js';
import { digest, id, token } from '../security.js';

export async function teamRoutes(app: FastifyInstance): Promise<void> {
	app.get('/v1/me', async request => {
		const user = await userId(request);
		const profile = database.prepare('SELECT id,email,display_name AS displayName FROM users WHERE id=?').get(user);
		const teams = database.prepare('SELECT t.id,t.name,m.role FROM teams t JOIN memberships m ON m.team_id=t.id WHERE m.user_id=? ORDER BY t.name').all(user);
		return { user: profile, teams };
	});

	app.post<{ Body: { name?: string } }>('/v1/teams', async (request, reply) => {
		const user = await userId(request);
		const name = request.body.name?.trim();
		if (!name) { return reply.badRequest('Team name is required'); }
		const teamId = id();
		database.transaction(() => {
			database.prepare('INSERT INTO teams(id,name,created_by,created_at) VALUES(?,?,?,?)').run(teamId, name, user, new Date().toISOString());
			database.prepare("INSERT INTO memberships(user_id,team_id,role) VALUES(?,?,'owner')").run(user, teamId);
			audit(user, 'team.create', teamId, 'team', teamId);
		})();
		return reply.code(201).send({ id: teamId, name, role: 'owner' });
	});

	// Активный инвайт-код команды: создаётся один раз и живёт, пока не пересоздан.
	// (Раньше каждый клик «Пригласить» создавал новый код, а старый оставался валидным.)
	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/invite', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const existing = database.prepare("SELECT id, code_hash, expires_at FROM invites WHERE team_id=? AND used_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(request.params.teamId, new Date().toISOString()) as { id: string; code_hash: string; expires_at: string } | undefined;
		if (existing) {
			const reveal = database.prepare("SELECT value FROM invite_reveals WHERE invite_id=?").get(existing.id) as { value: string } | undefined;
			if (reveal) { return { code: reveal.value, expiresAt: existing.expires_at, canRevoke: true }; }
		}
		return { code: null, expiresAt: null, canRevoke: true };
	});

	app.post<{ Params: { teamId: string } }>('/v1/teams/:teamId/invites', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const code = token(9).slice(0, 12).toUpperCase();
		const inviteId = id();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
		database.transaction(() => {
			database.prepare("INSERT INTO invites(id,team_id,code_hash,role,expires_at,created_by) VALUES(?,?,?,'dev',?,?)")
				.run(inviteId, request.params.teamId, digest(code), expiresAt, user);
			// Храним открытым текстом только текущий код, чтобы GET /invite мог его вернуть.
			database.prepare('INSERT OR REPLACE INTO invite_reveals(invite_id,team_id,value) VALUES(?,?,?)').run(inviteId, request.params.teamId, code);
			audit(user, 'invite.create', request.params.teamId, 'invite');
		})();
		return reply.code(201).send({ code, expiresAt });
	});

	// Пересоздать код: старый инвайт отзывается и перестаёт работать.
	app.delete<{ Params: { teamId: string } }>('/v1/teams/:teamId/invite', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		database.transaction(() => {
			database.prepare("UPDATE invites SET used_at=?, used_by=? WHERE team_id=? AND used_at IS NULL AND expires_at>?").run(new Date().toISOString(), user, request.params.teamId, new Date().toISOString());
			database.prepare('DELETE FROM invite_reveals WHERE team_id=?').run(request.params.teamId);
		})();
		audit(user, 'invite.revoke', request.params.teamId, 'invite');
		return { ok: true };
	});

	// Все пользователи платформы (для «Пригласить»): поиск по имени/email, без email тех, кто не в команде.
	app.get<{ Params: { teamId: string }; Querystring: { q?: string } }>('/v1/teams/:teamId/directory', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const q = (request.query.q ?? '').trim().toLowerCase();
		const like = `%${q}%`;
		const rows = database.prepare(`
			SELECT u.id, u.display_name AS displayName,
				CASE WHEN m.user_id IS NOT NULL THEN u.email ELSE NULL END AS email,
				CASE WHEN m.user_id IS NOT NULL THEN 1 ELSE 0 END AS inTeam
			FROM users u
			LEFT JOIN memberships m ON m.user_id = u.id AND m.team_id = ?
			WHERE (? = '' OR LOWER(u.display_name) LIKE ? OR LOWER(u.email) LIKE ?)
			ORDER BY inTeam DESC, u.display_name
			LIMIT 50
		`).all(request.params.teamId, q, like, like) as Array<{ id: string; displayName: string; email: string | null; inTeam: number }>;
		return rows;
	});

	app.post<{ Body: { code?: string } }>('/v1/invites/accept', async (request, reply) => {
		const user = await userId(request);
		const codeHash = digest(request.body.code?.trim().toUpperCase() ?? '');
		const invite = database.prepare('SELECT id,team_id,role FROM invites WHERE code_hash=? AND expires_at>? AND used_at IS NULL').get(codeHash, new Date().toISOString()) as { id: string; team_id: string; role: string } | undefined;
		if (!invite) { return reply.badRequest('Invite is invalid or expired'); }
		const accepted = database.transaction(() => {
			const claim = database.prepare('UPDATE invites SET used_by=?,used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?').run(user, new Date().toISOString(), invite.id, new Date().toISOString());
			if (claim.changes !== 1) { return false; }
			database.prepare('INSERT OR IGNORE INTO memberships(user_id,team_id,role) VALUES(?,?,?)').run(user, invite.team_id, invite.role);
			audit(user, 'invite.accept', invite.team_id, 'invite', invite.id);
			return true;
		}).immediate();
		if (!accepted) { return reply.conflict('Invite was already used'); }
		broadcast(invite.team_id, 'membership.changed');
		return { ok: true };
	});

	app.get<{ Params: { teamId: string } }>('/v1/teams/:teamId/board', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const online = onlineUserIds(request.params.teamId);
		const members = (database.prepare('SELECT u.id,u.display_name AS displayName,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.display_name').all(request.params.teamId) as { id: string; displayName: string; email: string; role: string }[]).map(member => ({ ...member, online: online.has(member.id) }));
		const projects = database.prepare('SELECT id,team_id AS teamId,name,git_url AS gitUrl,archive_id AS archiveId,owner_id AS ownerId,default_branch AS defaultBranch FROM projects WHERE team_id=?').all(request.params.teamId);
		const tasks = database.prepare('SELECT t.id,t.team_id AS teamId,t.title,t.description,t.status,t.assignee_id AS assigneeId,u.display_name AS assigneeName,t.position,t.due_at AS dueAt FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.team_id=? AND t.deleted_at IS NULL ORDER BY t.status,t.position').all(request.params.teamId);
		return { members, projects, tasks };
	});

	app.patch<{ Params: { teamId: string; memberId: string }; Body: { role?: string } }>('/v1/teams/:teamId/members/:memberId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'owner'); } catch (error) { mapAccessError(error); }
		if (!['maintainer', 'dev', 'viewer'].includes(request.body.role ?? '')) { return reply.badRequest('Invalid role; ownership transfer is a separate operation'); }
		const result = database.prepare("UPDATE memberships SET role=? WHERE user_id=? AND team_id=? AND role!='owner'").run(request.body.role, request.params.memberId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'membership.role', request.params.teamId, 'user', request.params.memberId, { role: request.body.role });
		broadcast(request.params.teamId, 'membership.changed');
		return { ok: true };
	});

	app.post<{ Params: { teamId: string }; Body: { name?: string; gitUrl?: string; defaultBranch?: string } }>('/v1/teams/:teamId/projects', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		if (!request.body.name?.trim() || !request.body.gitUrl?.trim()) { return reply.badRequest('Project name and Git URL are required'); }
		const project = { id: id(), name: request.body.name.trim(), gitUrl: request.body.gitUrl.trim(), defaultBranch: request.body.defaultBranch?.trim() || 'main' };
		database.prepare('INSERT INTO projects(id,team_id,name,git_url,owner_id,default_branch,created_at) VALUES(?,?,?,?,?,?,?)').run(project.id, request.params.teamId, project.name, project.gitUrl, user, project.defaultBranch, new Date().toISOString());
		audit(user, 'project.create', request.params.teamId, 'project', project.id);
		broadcast(request.params.teamId, 'project.changed');
		return reply.code(201).send(project);
	});

	app.patch<{ Params: { teamId: string; projectId: string }; Body: { ownerMemberId?: string } }>('/v1/teams/:teamId/projects/:projectId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'owner'); } catch (error) { mapAccessError(error); }
		if (!request.body.ownerMemberId || !isMember(request.body.ownerMemberId, request.params.teamId)) { return reply.badRequest('Owner must belong to this team'); }
		const result = database.prepare('UPDATE projects SET owner_id=? WHERE id=? AND team_id=?').run(request.body.ownerMemberId, request.params.projectId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'project.transfer', request.params.teamId, 'project', request.params.projectId, { ownerMemberId: request.body.ownerMemberId });
		broadcast(request.params.teamId, 'project.changed');
		return { ok: true };
	});

	app.post<{ Params: { teamId: string }; Body: { title?: string; description?: string; assigneeId?: string; dueAt?: string; status?: string } }>('/v1/teams/:teamId/tasks', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		if (!request.body.title?.trim()) { return reply.badRequest('Task title is required'); }
		const status = request.body.status ?? 'todo';
		if (!['todo', 'doing', 'review', 'done'].includes(status)) { return reply.badRequest('Invalid task status'); }
		if (request.body.assigneeId && !isMember(request.body.assigneeId, request.params.teamId)) { return reply.badRequest('Assignee must belong to this team'); }
		const taskId = id(); const now = new Date().toISOString();
		database.prepare('INSERT INTO tasks(id,team_id,title,description,status,assignee_id,position,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM tasks WHERE team_id=? AND status=?),?,?,?,?)')
			.run(taskId, request.params.teamId, request.body.title.trim(), request.body.description?.trim() ?? '', status, request.body.assigneeId ?? user, request.params.teamId, status, request.body.dueAt ?? null, user, now, now);
		audit(user, 'task.create', request.params.teamId, 'task', taskId);
		broadcast(request.params.teamId, 'task.changed');
		return reply.code(201).send(database.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
	});

	app.patch<{ Params: { teamId: string; taskId: string }; Body: { status?: string; position?: number; assigneeId?: string | null; title?: string; description?: string; dueAt?: string } }>('/v1/teams/:teamId/tasks/:taskId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const allowed = ['todo', 'doing', 'review', 'done'];
		if (request.body.status && !allowed.includes(request.body.status)) { return reply.badRequest('Invalid task status'); }
		if (request.body.assigneeId && !isMember(request.body.assigneeId, request.params.teamId)) { return reply.badRequest('Assignee must belong to this team'); }
		const result = database.prepare("UPDATE tasks SET status=COALESCE(@status,status),position=COALESCE(@position,position),assignee_id=CASE WHEN @hasAssignee=1 THEN @assignee ELSE assignee_id END,title=COALESCE(@title,title),description=COALESCE(@description,description),due_at=COALESCE(@dueAt,due_at),updated_at=@now WHERE id=@id AND team_id=@team")
			.run({ status: request.body.status ?? null, position: request.body.position ?? null, hasAssignee: Object.hasOwn(request.body, 'assigneeId') ? 1 : 0, assignee: request.body.assigneeId ?? null, title: request.body.title?.trim() || null, description: typeof request.body.description === 'string' ? request.body.description : null, dueAt: request.body.dueAt ?? null, now: new Date().toISOString(), id: request.params.taskId, team: request.params.teamId });
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'task.update', request.params.teamId, 'task', request.params.taskId, request.body);
		broadcast(request.params.teamId, 'task.changed');
		return database.prepare('SELECT * FROM tasks WHERE id=?').get(request.params.taskId);
	});

	// Реордер колонки канбана: в транзакции проставляем позиции 0..n по присланному порядку id.
	app.post<{ Params: { teamId: string }; Body: { status?: string; orderedIds?: string[] } }>('/v1/teams/:teamId/tasks/reorder', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const { status, orderedIds } = request.body ?? {};
		if (!status || !['todo', 'doing', 'review', 'done'].includes(status) || !Array.isArray(orderedIds) || orderedIds.length === 0) { return reply.badRequest('status and orderedIds are required'); }
		const reorder = database.transaction((ids: string[]) => {
			ids.forEach((id, index) => database.prepare("UPDATE tasks SET status=@status, position=@pos, updated_at=@now WHERE id=@id AND team_id=@team AND deleted_at IS NULL")
				.run({ status, pos: index, now: new Date().toISOString(), id, team: request.params.teamId }));
		});
		reorder(orderedIds);
		audit(user, 'task.reorder', request.params.teamId, 'task', orderedIds[0], { status, count: orderedIds.length });
		broadcast(request.params.teamId, 'task.changed');
		return { ok: true };
	});

	// Удаление задачи (мягкое): своя задача — любая роль dev+, чужая — maintainer+.
	app.delete<{ Params: { teamId: string; taskId: string } }>('/v1/teams/:teamId/tasks/:taskId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const task = database.prepare('SELECT id, created_by FROM tasks WHERE id=? AND team_id=? AND deleted_at IS NULL').get(request.params.taskId, request.params.teamId) as { id: string; created_by: string } | undefined;
		if (!task) { return reply.notFound(); }
		if (task.created_by !== user) {
			try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		}
		database.prepare("UPDATE tasks SET deleted_at=?, updated_at=? WHERE id=? AND team_id=?").run(new Date().toISOString(), new Date().toISOString(), request.params.taskId, request.params.teamId);
		audit(user, 'task.delete', request.params.teamId, 'task', request.params.taskId);
		broadcast(request.params.teamId, 'task.changed');
		return { ok: true };
	});

	// Восстановление мягко удалённой задачи («Отменить» после удаления).
	app.patch<{ Params: { teamId: string; taskId: string } }>('/v1/teams/:teamId/tasks/:taskId/restore', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const result = database.prepare("UPDATE tasks SET deleted_at=NULL, updated_at=? WHERE id=? AND team_id=? AND deleted_at IS NOT NULL").run(new Date().toISOString(), request.params.taskId, request.params.teamId);
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'task.restore', request.params.teamId, 'task', request.params.taskId);
		broadcast(request.params.teamId, 'task.changed');
		return { ok: true };
	});

	app.get<{ Params: { teamId: string }; Querystring: { limit?: string } }>('/v1/teams/:teamId/activity', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const limit = Math.min(Math.max(Number(request.query.limit ?? 20) || 20, 1), 100);
		const events = database.prepare(`
			SELECT a.action, a.target_type AS targetType, a.target_id AS targetId, a.details, a.created_at AS createdAt,
				u.id AS userId, u.display_name AS userName,
				t.title AS taskTitle
			FROM audit_log a
			JOIN users u ON u.id = a.user_id
			LEFT JOIN tasks t ON a.target_type = 'task' AND t.id = a.target_id
			WHERE a.team_id = ?
			ORDER BY a.id DESC LIMIT ?
		`).all(request.params.teamId, limit) as Array<{ action: string; targetType?: string; targetId?: string; details: string; createdAt: string; userId: string; userName: string; taskTitle?: string }>;
		let details: Record<string, unknown> = {};
		return events.map(event => {
			try { details = JSON.parse(event.details ?? '{}'); } catch { details = {}; }
			return { action: event.action, targetType: event.targetType, targetId: event.targetId, details, createdAt: event.createdAt, userId: event.userId, userName: event.userName, taskTitle: event.taskTitle };
		});
	});

	app.get<{ Params: { teamId: string }; Querystring: { limit?: string } }>('/v1/teams/:teamId/summary', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const online = onlineUserIds(request.params.teamId);
		const members = (database.prepare('SELECT u.id,u.display_name AS displayName,u.email,m.role,m.last_seen_at AS lastSeenAt FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=? ORDER BY u.display_name').all(request.params.teamId) as { id: string; displayName: string; email: string; role: string; lastSeenAt?: string | null }[]).map(member => ({ ...member, online: online.has(member.id) }));
		const myTasks = database.prepare("SELECT id,title,status,due_at AS dueAt FROM tasks WHERE team_id=? AND assignee_id=? AND status!='done' AND deleted_at IS NULL ORDER BY due_at IS NULL, due_at LIMIT ?").all(request.params.teamId, user, Math.min(Math.max(Number(request.query.limit ?? 10) || 10, 1), 50));
		const projects = database.prepare('SELECT id,name,default_branch AS defaultBranch,git_url AS gitUrl FROM projects WHERE team_id=? ORDER BY name').all(request.params.teamId);
		return { members, myTasks, projects };
	});

	// Коммиты, связанные с задачей (по #id в сообщении) — для карточки задачи.
	app.get<{ Params: { teamId: string; taskId: string } }>('/v1/teams/:teamId/tasks/:taskId/commits', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		return database.prepare(`
			SELECT tc.commit_hash AS hash, tc.repository_url AS repositoryUrl, tc.created_at AS createdAt,
				u.display_name AS author
			FROM task_commits tc JOIN users u ON u.id = tc.author_id
			WHERE tc.task_id = ?
			ORDER BY tc.created_at DESC LIMIT 20
		`).all(request.params.taskId);
	});

	// История изменений задачи из audit_log: кто, что и когда менял (статус, исполнитель, дедлайн…).
	app.get<{ Params: { teamId: string; taskId: string } }>('/v1/teams/:teamId/tasks/:taskId/history', async request => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'viewer'); } catch (error) { mapAccessError(error); }
		const rows = database.prepare(`
			SELECT a.action, a.details, a.created_at AS createdAt, u.display_name AS userName
			FROM audit_log a JOIN users u ON u.id = a.user_id
			WHERE a.target_type = 'task' AND a.target_id = ?
			ORDER BY a.id DESC LIMIT 30
		`).all(request.params.taskId) as Array<{ action: string; details: string; createdAt: string; userName: string }>;
		return rows.map(row => {
			let details: Record<string, unknown> = {};
			try { details = JSON.parse(row.details ?? '{}'); } catch { details = {}; }
			return { action: row.action, details, createdAt: row.createdAt, userName: row.userName };
		});
	});

	app.post<{ Params: { teamId: string }; Body: { commitHash?: string; repositoryUrl?: string; message?: string } }>('/v1/teams/:teamId/commits', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const match = request.body.message?.match(/(?:^|\s)#([0-9a-f-]{6,36})(?:\s|$)/i);
		if (!match || !request.body.commitHash || !request.body.repositoryUrl) { return reply.code(204).send(); }
		const task = database.prepare('SELECT id FROM tasks WHERE team_id=? AND (id=? OR id LIKE ?)').get(request.params.teamId, match[1], `${match[1]}%`) as { id: string } | undefined;
		if (!task) { return reply.notFound('Task reference in commit message was not found'); }
		database.prepare('INSERT OR IGNORE INTO task_commits(task_id,commit_hash,repository_url,author_id,created_at) VALUES(?,?,?,?,?)').run(task.id, request.body.commitHash, request.body.repositoryUrl, user, new Date().toISOString());
		audit(user, 'task.commit_link', request.params.teamId, 'task', task.id, { commitHash: request.body.commitHash });
		return reply.code(201).send({ taskId: task.id });
	});
}

function isMember(userId: string, teamId: string): boolean {
	return Boolean(database.prepare('SELECT 1 FROM memberships WHERE user_id=? AND team_id=?').get(userId, teamId));
}
