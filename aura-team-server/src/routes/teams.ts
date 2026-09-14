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

	app.post<{ Params: { teamId: string } }>('/v1/teams/:teamId/invites', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'maintainer'); } catch (error) { mapAccessError(error); }
		const code = token(9).slice(0, 12).toUpperCase();
		database.prepare("INSERT INTO invites(id,team_id,code_hash,role,expires_at,created_by) VALUES(?,?,?,'dev',?,?)")
			.run(id(), request.params.teamId, digest(code), new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), user);
		audit(user, 'invite.create', request.params.teamId, 'invite');
		return reply.code(201).send({ code, expiresIn: 604800 });
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
		const projects = database.prepare('SELECT id,team_id AS teamId,name,git_url AS gitUrl,archive_id AS archiveId,default_branch AS defaultBranch FROM projects WHERE team_id=?').all(request.params.teamId);
		const tasks = database.prepare('SELECT t.id,t.team_id AS teamId,t.title,t.description,t.status,t.assignee_id AS assigneeId,u.display_name AS assigneeName,t.position,t.due_at AS dueAt FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.team_id=? ORDER BY t.status,t.position').all(request.params.teamId);
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
		database.prepare('INSERT INTO projects(id,team_id,name,git_url,default_branch,created_at) VALUES(?,?,?,?,?,?)').run(project.id, request.params.teamId, project.name, project.gitUrl, project.defaultBranch, new Date().toISOString());
		audit(user, 'project.create', request.params.teamId, 'project', project.id);
		broadcast(request.params.teamId, 'project.changed');
		return reply.code(201).send(project);
	});

	app.post<{ Params: { teamId: string }; Body: { title?: string; description?: string; assigneeId?: string; dueAt?: string; status?: string } }>('/v1/teams/:teamId/tasks', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		if (!request.body.title?.trim()) { return reply.badRequest('Task title is required'); }
		const status = request.body.status ?? 'todo';
		if (!['backlog', 'todo', 'doing', 'review', 'done'].includes(status)) { return reply.badRequest('Invalid task status'); }
		if (request.body.assigneeId && !isMember(request.body.assigneeId, request.params.teamId)) { return reply.badRequest('Assignee must belong to this team'); }
		const taskId = id(); const now = new Date().toISOString();
		database.prepare('INSERT INTO tasks(id,team_id,title,description,status,assignee_id,position,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM tasks WHERE team_id=? AND status=?),?,?,?,?)')
			.run(taskId, request.params.teamId, request.body.title.trim(), request.body.description?.trim() ?? '', status, request.body.assigneeId ?? user, request.params.teamId, status, request.body.dueAt ?? null, user, now, now);
		audit(user, 'task.create', request.params.teamId, 'task', taskId);
		broadcast(request.params.teamId, 'task.changed');
		return reply.code(201).send(database.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
	});

	app.patch<{ Params: { teamId: string; taskId: string }; Body: { status?: string; position?: number; assigneeId?: string | null } }>('/v1/teams/:teamId/tasks/:taskId', async (request, reply) => {
		const user = await userId(request);
		try { requireRole(user, request.params.teamId, 'dev'); } catch (error) { mapAccessError(error); }
		const allowed = ['backlog', 'todo', 'doing', 'review', 'done'];
		if (request.body.status && !allowed.includes(request.body.status)) { return reply.badRequest('Invalid task status'); }
		if (request.body.assigneeId && !isMember(request.body.assigneeId, request.params.teamId)) { return reply.badRequest('Assignee must belong to this team'); }
		const result = database.prepare('UPDATE tasks SET status=COALESCE(@status,status),position=COALESCE(@position,position),assignee_id=CASE WHEN @hasAssignee=1 THEN @assignee ELSE assignee_id END,updated_at=@now WHERE id=@id AND team_id=@team')
			.run({ status: request.body.status ?? null, position: request.body.position ?? null, hasAssignee: Object.hasOwn(request.body, 'assigneeId') ? 1 : 0, assignee: request.body.assigneeId ?? null, now: new Date().toISOString(), id: request.params.taskId, team: request.params.teamId });
		if (result.changes !== 1) { return reply.notFound(); }
		audit(user, 'task.update', request.params.teamId, 'task', request.params.taskId, request.body);
		broadcast(request.params.teamId, 'task.changed');
		return database.prepare('SELECT * FROM tasks WHERE id=?').get(request.params.taskId);
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
